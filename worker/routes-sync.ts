/**
 * HTTP surface for Yomu Sync.
 *
 * The merge lives in sync.ts; this is storage, identity and rate limiting.
 *
 * Two codes, not one, and the difference matters:
 *
 *   library code   permanent, ten characters, the credential for a library.
 *                  Whoever holds it has the library. Shown in Settings so it
 *                  can always be looked up, and replaceable with regenerate.
 *   pairing code   short lived, ten minutes, redeemable once. What the QR
 *                  encodes and what gets read off a screen across a desk.
 *
 * Without the second one, pairing means showing the permanent credential on a
 * monitor and hoping nobody photographs it. With it, the thing on screen is
 * worthless ten minutes later.
 *
 * KV's free tier allows 1,000 writes a day and 100,000 reads, which is what
 * shapes the client: batch locally, push on a debounce. Reads are effectively
 * free, so pulling is cheap and pushing is not.
 */
import type { Env } from './index';
import {
  PAIRING_TTL_S,
  applyPatch,
  emptyDoc,
  formatCode,
  generateCode,
  normalizeCode,
} from './sync';
import type { SyncDoc, SyncPatch } from './sync';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Never cached, anywhere. This is one person's library, and the code is
      // in the request body -- an intermediary holding a copy would be holding
      // the credential and the data together.
      'cache-control': 'no-store, private',
    },
  });

const bad = (message: string, status = 400) => json({ error: message }, status);

const libKey = (code: string) => `lib:${code}`;
const pairKey = (code: string) => `pair:${code}`;

/* --- rate limiting ------------------------------------------------------ *
 *
 * The code is the whole credential, so guessing it is the attack. Fifty bits
 * makes that hopeless at any sane rate -- the job here is only to keep the
 * rate sane. A counter per IP per minute, expired by KV rather than swept.
 *
 * Counted on the routes that test a code. Pushing and pulling need a code you
 * already have, and rate limiting those would throttle a real device.
 * ---------------------------------------------------------------------- */

const ATTEMPTS_PER_MINUTE = 12;

async function tooManyAttempts(env: Env, request: Request): Promise<boolean> {
  const who = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const key = `rl:${who}:${Math.floor(Date.now() / 60000)}`;
  const seen = Number((await env.SYNC.get(key)) ?? '0');
  if (seen >= ATTEMPTS_PER_MINUTE) return true;
  await env.SYNC.put(key, String(seen + 1), { expirationTtl: 120 });
  return false;
}

/* --- documents ---------------------------------------------------------- */

async function readDoc(env: Env, code: string): Promise<SyncDoc | null> {
  const raw = await env.SYNC.get(libKey(code), 'json');
  return raw && typeof raw === 'object' ? (raw as SyncDoc) : null;
}

const writeDoc = (env: Env, code: string, doc: SyncDoc) =>
  env.SYNC.put(libKey(code), JSON.stringify(doc));

/** A device id is the server's to mint. A client that picks its own can
 *  collide with another device and inherit its row in the device list. */
const newDeviceId = () => crypto.randomUUID();

function touchDevice(doc: SyncDoc, deviceId: string, name: string | undefined, now: number): SyncDoc {
  const existing = doc.devices[deviceId];
  return {
    ...doc,
    devices: {
      ...doc.devices,
      [deviceId]: {
        name: (name || existing?.name || 'A device').slice(0, 40),
        lastSeen: now,
      },
    },
  };
}

/** What a device is allowed to see about the pairing: names and clocks, never
 *  another device's id, which is not needed to unpair from the list. */
const publicDoc = (doc: SyncDoc, code: string) => ({
  code,
  display: formatCode(code),
  revision: doc.revision,
  updatedAt: doc.updatedAt,
  library: Object.values(doc.library),
  progress: Object.values(doc.progress),
  sources: Object.values(doc.sources).map(({ at, ...row }) => row),
  removed: Object.keys(doc.removed),
  ...(doc.searchHistory ? { searchHistory: doc.searchHistory } : {}),
  ...(doc.profile ? { profile: doc.profile } : {}),
  devices: Object.entries(doc.devices)
    .map(([id, device]) => ({ id, name: device.name, lastSeen: device.lastSeen }))
    .sort((a, b) => b.lastSeen - a.lastSeen),
});

async function body(request: Request): Promise<Record<string, any>> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : {};
  } catch {
    return {};
  }
}

/* --- routes -------------------------------------------------------------- */

export async function handleSync(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.SYNC) {
    return bad('Sync is not configured on this deployment.', 503);
  }

  const route = url.pathname.slice('/api/sync/'.length);
  const now = Date.now();

  if (request.method !== 'POST') return bad('Use POST.', 405);

  /* Make a library. The only route that does not take a code. */
  if (route === 'create') {
    const { deviceName } = await body(request);
    // Not retried on collision: at fifty bits the first draw is the answer,
    // and a loop here would hide a broken generator rather than fix it.
    const code = generateCode();
    if (await env.SYNC.get(libKey(code))) return bad('Please try again.', 503);

    const deviceId = newDeviceId();
    const doc = touchDevice(emptyDoc(now), deviceId, deviceName, now);
    await writeDoc(env, code, doc);
    return json({ deviceId, ...publicDoc(doc, code) });
  }

  /* Mint a short-lived pairing code for a library you already hold. */
  if (route === 'pair') {
    const { code: raw } = await body(request);
    const code = normalizeCode(raw);
    if (!code) return bad('That does not look like a Yomu code.');
    if (!(await readDoc(env, code))) return bad('No library with that code.', 404);

    const pairing = generateCode();
    await env.SYNC.put(pairKey(pairing), code, { expirationTtl: PAIRING_TTL_S });
    return json({
      pairingCode: pairing,
      display: formatCode(pairing),
      expiresAt: now + PAIRING_TTL_S * 1000,
    });
  }

  /* Exchange a pairing code for the library code, once. */
  if (route === 'redeem') {
    if (await tooManyAttempts(env, request)) return bad('Too many attempts. Wait a minute.', 429);
    const { pairingCode: raw, deviceName } = await body(request);
    const pairing = normalizeCode(raw);
    if (!pairing) return bad('That does not look like a pairing code.');

    const code = await env.SYNC.get(pairKey(pairing));
    if (!code) return bad('That pairing code has expired. Show a new one.', 404);
    // Redeemable once: a code read off a screen may have been read by more
    // than one camera.
    await env.SYNC.delete(pairKey(pairing));

    const doc = await readDoc(env, code);
    if (!doc) return bad('That library no longer exists.', 404);

    const deviceId = newDeviceId();
    const joined = touchDevice(doc, deviceId, deviceName, now);
    await writeDoc(env, code, joined);
    return json({ deviceId, ...publicDoc(joined, code) });
  }

  /* Join with the permanent code, for when a camera will not play. */
  if (route === 'join') {
    if (await tooManyAttempts(env, request)) return bad('Too many attempts. Wait a minute.', 429);
    const { code: raw, deviceName } = await body(request);
    const code = normalizeCode(raw);
    if (!code) return bad('That does not look like a Yomu code.');

    const doc = await readDoc(env, code);
    if (!doc) return bad('No library with that code.', 404);

    const deviceId = newDeviceId();
    const joined = touchDevice(doc, deviceId, deviceName, now);
    await writeDoc(env, code, joined);
    return json({ deviceId, ...publicDoc(joined, code) });
  }

  /* Read. Cheap -- KV allows a hundred reads for every write. */
  if (route === 'pull') {
    const { code: raw } = await body(request);
    const code = normalizeCode(raw);
    if (!code) return bad('That does not look like a Yomu code.');
    const doc = await readDoc(env, code);
    if (!doc) return bad('No library with that code.', 404);
    return json(publicDoc(doc, code));
  }

  /* Write. The expensive one, and the one the client debounces. */
  if (route === 'push') {
    const { code: raw, deviceId, deviceName, patch } = await body(request);
    const code = normalizeCode(raw);
    if (!code) return bad('That does not look like a Yomu code.');
    if (typeof deviceId !== 'string' || !deviceId) return bad('Missing device.');

    const doc = await readDoc(env, code);
    if (!doc) return bad('No library with that code.', 404);
    // An unknown device id means this device was unpaired while it was away.
    // Telling it so is what makes "Unpair" actually take effect rather than
    // being undone by the next push.
    if (!doc.devices[deviceId]) return bad('This device is no longer paired.', 401);

    const merged = touchDevice(applyPatch(doc, (patch ?? {}) as SyncPatch, now), deviceId, deviceName, now);
    await writeDoc(env, code, merged);
    return json(publicDoc(merged, code));
  }

  /* Drop a device. Its next push is refused and it falls back to local only. */
  if (route === 'unpair') {
    const { code: raw, target } = await body(request);
    const code = normalizeCode(raw);
    if (!code) return bad('That does not look like a Yomu code.');
    if (typeof target !== 'string' || !target) return bad('Missing device.');

    const doc = await readDoc(env, code);
    if (!doc) return bad('No library with that code.', 404);
    if (!doc.devices[target]) return json(publicDoc(doc, code));

    const devices = { ...doc.devices };
    delete devices[target];
    const next = { ...doc, devices, revision: doc.revision + 1, updatedAt: now };
    await writeDoc(env, code, next);
    return json(publicDoc(next, code));
  }

  /* Move the library to a new code and orphan every device but this one.
   * The answer to a code that got photographed. */
  if (route === 'regenerate') {
    const { code: raw, deviceId } = await body(request);
    const code = normalizeCode(raw);
    if (!code) return bad('That does not look like a Yomu code.');

    const doc = await readDoc(env, code);
    if (!doc) return bad('No library with that code.', 404);

    const next = generateCode();
    const keep = typeof deviceId === 'string' && doc.devices[deviceId]
      ? { [deviceId]: { ...doc.devices[deviceId], lastSeen: now } }
      : {};
    const moved: SyncDoc = { ...doc, devices: keep, revision: doc.revision + 1, updatedAt: now };

    // Written before the old key is dropped: if the delete fails the library
    // exists under both codes, which is recoverable. The other order loses it.
    await writeDoc(env, next, moved);
    await env.SYNC.delete(libKey(code));
    return json(publicDoc(moved, next));
  }

  /* Leave sync entirely and delete the stored copy. */
  if (route === 'destroy') {
    const { code: raw } = await body(request);
    const code = normalizeCode(raw);
    if (!code) return bad('That does not look like a Yomu code.');
    if (!(await readDoc(env, code))) return bad('No library with that code.', 404);
    await env.SYNC.delete(libKey(code));
    return json({ ok: true });
  }

  return bad('Unknown sync route.', 404);
}
