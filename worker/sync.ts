/**
 * Yomu Sync — the document, the code, and the merge.
 *
 * Everything Yomu knows lives in localStorage, which is per browser by
 * definition. Sync means the Worker holds state for the first time. This file
 * is that state's shape and the rules for combining two copies of it; the HTTP
 * surface is in routes-sync.ts.
 *
 * Kept separate from the routes because the merge is the part that goes wrong
 * quietly. A route that 500s is reported in a minute. A merge that silently
 * drags a reader back thirty chapters, or resurrects a series they deleted, is
 * found weeks later and by then both copies are wrong. These are pure
 * functions over plain objects so they can be reasoned about, and tested,
 * without a KV binding or a request.
 *
 * Three rules, and the reasoning for each is on the function that implements
 * it:
 *   progress  furthest wins, not latest        (mergeProgress)
 *   removals  tombstoned, never just absent    (mergeLibrary)
 *   sources   union, always                    (mergeSources)
 */

export const SCHEMA = 'yomu.sync/1';

/** How long a removal is remembered. After this a tombstone is dropped and a
 *  device that has been offline longer than this will resurrect the title.
 *  Ninety days is far past the point where "I deleted this" is still true. */
export const TOMBSTONE_MS = 90 * 24 * 60 * 60 * 1000;

/** A pairing code is meant to be read off a screen and used immediately. */
export const PAIRING_TTL_S = 600;

export interface LibraryEntry {
  id: string;
  sourceId: string;
  title?: string;
  cover?: string;
  author?: string;
  category?: string;
  status?: string;
  total?: number;
  latestChapter?: string;
  hidden?: boolean;
  /** When the device that is pushing saved this title, by its own clock.
   *  This is what a tombstone is compared against, so it is the field that
   *  decides whether a delete sticks. See mergeLibrary. */
  addedAt?: number;
  /** The saved-at the merge settled on. Derived, not sent. */
  at: number;
}

export interface ProgressEntry {
  seriesId: string;
  sourceId?: string;
  chapterId: string;
  /** Parsed from the chapter label when the client could read one. Absent for
   *  positions recorded before the client tracked it, which is why the merge
   *  has to cope with not knowing. */
  chapterNumber?: number;
  page?: number;
  pages?: number;
  /** Chapter ids finished. Unioned, never replaced: finishing is monotonic. */
  read?: string[];
  updatedAt: number;
}

export interface DeviceEntry {
  name: string;
  lastSeen: number;
}

/**
 * Who the reader is, as far as the greeting needs to know.
 *
 * The name and nothing else identifying: pairing restored somebody's shelf
 * and their place in it and then called them "Reader", which is the one part
 * of the app that is supposed to know them.
 *
 * `avatar` is a preset id -- one of the five illustrated readers -- and never
 * a photo. Your Yomu tells people in as many words that a photo of their own
 * "stays on this device ... never uploaded to Yomu or shared with your
 * circle", and a promise printed on the screen is not something a sync
 * feature gets to quietly revise. A photo is downscaled to a 256px data URL
 * and would be the largest thing in this document by an order of magnitude
 * anyway.
 */
export interface ProfileEntry {
  name?: string;
  /** A preset avatar id, e.g. "04_undead_knight_reader". Never a photo. */
  avatar?: string;
  updatedAt: number;
}

/**
 * Enough to rebuild a source row on a device that has never seen it.
 *
 * An id alone is not enough, which is the trap: a fresh install's source list
 * contains only the built-ins, so "mangadex is enabled" can be acted on but
 * "flamecomics is enabled" names a row that does not exist and is silently
 * dropped. The whole point of syncing sources is the install where you have
 * none of them yet.
 *
 * `url` rides along because every source that reaches here has a public one --
 * an API origin, or a same-origin /api/ path. The two places a private address
 * could hide are both outside this: the Mihon tunnel is a Worker secret and
 * never in the client's list at all, and the user-configured generic source
 * lives in yomu.v1.source-config, which is deliberately not synced.
 */
export interface SourceEntry {
  id: string;
  label?: string;
  category?: string;
  kind?: string;
  url?: string;
  at: number;
}

export interface SyncDoc {
  schema: typeof SCHEMA;
  revision: number;
  updatedAt: number;
  createdAt: number;
  library: Record<string, LibraryEntry>;
  /** titleKey -> when it was removed. The whole reason a delete sticks. */
  removed: Record<string, number>;
  progress: Record<string, ProgressEntry>;
  /** sourceId -> the row needed to recreate it, plus when it was first seen. */
  sources: Record<string, SourceEntry>;
  devices: Record<string, DeviceEntry>;
  /** Opt-in, and off unless a device says otherwise. */
  searchHistory?: string[];
  /** Last writer wins, by its own clock. One name per library. */
  profile?: ProfileEntry;
}

/** What a client sends up. Every field optional: a device that has not loaded
 *  its library yet must be able to push a position without erasing anything. */
export interface SyncPatch {
  library?: LibraryEntry[];
  removed?: string[];
  progress?: ProgressEntry[];
  sources?: SourceEntry[];
  searchHistory?: string[];
  profile?: ProfileEntry;
  /** Turning the setting off: drop what is stored rather than just stopping.
   *  An opt-in that leaves the old data behind was never really opt-in. */
  forgetSearchHistory?: boolean;
}

export const titleKey = (sourceId: string, id: string) => `${sourceId}:${id}`;

export function emptyDoc(now: number): SyncDoc {
  return {
    schema: SCHEMA,
    revision: 0,
    updatedAt: now,
    createdAt: now,
    library: {},
    removed: {},
    progress: {},
    sources: {},
    devices: {},
  };
}

/* ------------------------------------------------------------------ *
 * The code
 *
 * Crockford base32: the alphabet without I, L, O and U. The first three go
 * because they are indistinguishable from 1, 1 and 0 on a screen and in
 * speech, and U goes so that a random ten characters cannot spell anything
 * anyone has to read out. Ten characters is fifty bits.
 *
 * This is the credential. There is no password to pair with it and no reset
 * flow behind it, so it is generated from crypto.getRandomValues and never
 * from Math.random, and rejection sampling keeps the distribution flat rather
 * than letting a modulo bias eat entropy the scheme cannot spare.
 * ------------------------------------------------------------------ */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // 32 symbols

export function generateCode(length = 10): string {
  let out = '';
  const buffer = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buffer);
    for (const byte of buffer) {
      // 256 is not a multiple of 32 -- it is, exactly 8 -- so every byte maps
      // evenly and there is nothing to reject. Kept explicit so that changing
      // the alphabet length does not silently introduce a bias.
      if (byte >= 256 - (256 % ALPHABET.length)) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * Accept what a human might type.
 *
 * Crockford's decoding rules: case-insensitive, and O/I/L are read as the
 * digits they look like rather than rejected. Separators are dropped, so
 * "yomu-7k4qp-m2x9t", "7K4QP M2X9T" and "7K4QPM2X9T" are the same code.
 */
export function normalizeCode(raw: string): string | null {
  const cleaned = String(raw || '')
    .toUpperCase()
    .replace(/^YOMU[-\s]*/, '')
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (cleaned.length !== 10) return null;
  for (const character of cleaned) if (!ALPHABET.includes(character)) return null;
  return cleaned;
}

/** The form shown on screen. Grouped so the eye can hold it. */
export const formatCode = (code: string) =>
  `YOMU-${code.slice(0, 5)}-${code.slice(5)}`;

/* ------------------------------------------------------------------ *
 * Merge
 * ------------------------------------------------------------------ */

/**
 * Progress: furthest wins, not latest.
 *
 * Last-write-wins is the instinct and it is wrong here. Finish chapter 40 on
 * the PC, open the phone that still thinks it is on 12, and the phone's push
 * is the later write -- so last-write-wins throws away twenty-eight chapters
 * and looks exactly like data loss, because it is.
 *
 * So: the higher chapter number wins. Within one chapter, the further page.
 * Only when neither side knows its chapter number does the timestamp decide,
 * and that is a fallback for positions stored before the client recorded the
 * number, not the rule.
 *
 * Re-reading is the case this gets wrong, and deliberately: it is rare, and an
 * explicit "reset progress" serves it better than a merge rule that quietly
 * loses forty chapters for everyone else. Finished chapters are unioned
 * regardless -- having read something is not a position and does not compete.
 */
export function mergeProgress(a: ProgressEntry | undefined, b: ProgressEntry | undefined): ProgressEntry | undefined {
  if (!a) return b;
  if (!b) return a;

  const read = [...new Set([...(a.read ?? []), ...(b.read ?? [])])];

  let ahead: ProgressEntry;
  if (a.chapterNumber != null && b.chapterNumber != null && a.chapterNumber !== b.chapterNumber) {
    ahead = a.chapterNumber > b.chapterNumber ? a : b;
  } else if (a.chapterId === b.chapterId) {
    ahead = (a.page ?? 0) >= (b.page ?? 0) ? a : b;
  } else if (a.chapterNumber != null && b.chapterNumber == null) {
    ahead = a;
  } else if (b.chapterNumber != null && a.chapterNumber == null) {
    ahead = b;
  } else {
    ahead = a.updatedAt >= b.updatedAt ? a : b;
  }

  return { ...ahead, read, updatedAt: Math.max(a.updatedAt, b.updatedAt) };
}

/**
 * Library: union, minus anything with a newer tombstone.
 *
 * This is the bug every naive sync ships with. If the merge is a plain union
 * of two libraries, then removing a series on the phone and syncing from the
 * PC -- which still has it -- puts it straight back, and it reads as the app
 * ignoring you. A removal has to be recorded as a removal.
 *
 * Getting that right needs one more thing than a tombstone, and it is the part
 * that is easy to miss. A tombstone answers "was this deleted?", but the
 * question at merge time is "was it deleted *after* it was saved?" -- because
 * deleting a title and later deciding to save it again has to work too.
 *
 * So the comparison is against `addedAt`: when the pushing device saved the
 * title, by its own clock. A device echoing a library it has held since
 * before the delete sends an old `addedAt` and the tombstone wins. A device
 * that genuinely re-saved sends a fresh one and the title comes back. Using
 * the server's first-sight time instead cannot tell those apart: the row has
 * been deleted by then, so a re-push looks new and every stale device
 * resurrects what every other device just removed.
 *
 * A push with no `addedAt` at all is treated as old. That is the safe way to
 * be wrong -- a title that needs saving again rather than one that will not
 * stay deleted -- and it only lasts as long as the tombstone.
 */
export function mergeLibrary(
  base: Record<string, LibraryEntry>,
  incoming: LibraryEntry[] | undefined,
  removed: Record<string, number>,
  now: number,
): Record<string, LibraryEntry> {
  const out: Record<string, LibraryEntry> = { ...base };

  for (const entry of incoming ?? []) {
    if (!entry || !entry.id || !entry.sourceId) continue;
    const key = titleKey(entry.sourceId, entry.id);
    const existing = out[key];
    // The latest save across devices: if any of them saved it after the
    // removal, that is the one that should decide.
    const saved = Math.max(existing?.at ?? 0, Number(entry.addedAt) || 0);
    out[key] = { ...existing, ...entry, at: saved };
  }

  for (const [key, removedAt] of Object.entries(removed)) {
    const entry = out[key];
    if (entry && entry.at <= removedAt) delete out[key];
  }

  // Anything that survived with no age at all is new and un-tombstoned; give
  // it one now so it is not compared against zero for the rest of its life.
  for (const entry of Object.values(out)) if (!entry.at) entry.at = now;
  return out;
}

/** Tombstones from this push, plus the ones still inside the window. */
export function mergeRemovals(
  base: Record<string, number>,
  incoming: string[] | undefined,
  now: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, at] of Object.entries(base)) {
    if (now - at < TOMBSTONE_MS) out[key] = at;
  }
  for (const key of incoming ?? []) if (typeof key === 'string' && key) out[key] = now;
  return out;
}

/**
 * Sources: union, always.
 *
 * Enabling a source is additive and low stakes, and re-ticking twelve sources
 * on every new device is the worst part of a new install. Disabling does not
 * propagate: there is no tombstone here on purpose, because the reason to
 * disable a source on one device is usually about that device.
 *
 * What each device is actually willing to show is decided by the 18+ gate,
 * which does not sync at all.
 */
export function mergeSources(
  base: Record<string, SourceEntry>,
  incoming: SourceEntry[] | undefined,
  now: number,
): Record<string, SourceEntry> {
  const out: Record<string, SourceEntry> = {};

  // Tolerate the first shape this shipped with, which stored only the time a
  // source was first enabled. Those rows carry no descriptor, so they are kept
  // as bare ids and filled in by the next device that pushes a real one.
  for (const [id, value] of Object.entries(base ?? {})) {
    out[id] = typeof value === 'number' ? { id, at: value } : value;
  }

  for (const entry of incoming ?? []) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
    const existing = out[entry.id];
    out[entry.id] = {
      ...existing,
      ...entry,
      // First-seen, so a source does not keep resetting its own age, and a
      // later push cannot blank a label an earlier one supplied.
      at: existing?.at ?? now,
    };
  }
  return out;
}

/** Apply one device's patch to the document. Returns a new document. */
/**
 * Newest clock wins, per field.
 *
 * Per field rather than wholesale because the two are set in different places
 * and a device can legitimately know one and not the other: a client that
 * sends only a name must not blank an avatar another device chose. An absent
 * field in the newer patch leaves the older value standing; an empty string
 * is how you clear one on purpose.
 */
export function mergeProfile(
  a: ProfileEntry | undefined,
  b: ProfileEntry | undefined,
  now: number,
): ProfileEntry | undefined {
  if (!b) return a;
  const next: ProfileEntry = { updatedAt: Number(b.updatedAt) || now };
  const older = a && (Number(a.updatedAt) || 0) > next.updatedAt ? b : a;
  const newer = older === a ? b : a;

  /* Validation happens while choosing, not after it. Rejecting the newer
     value and then stopping would drop the field entirely -- so a client that
     sent a photo where a preset belongs would not merely fail to set one, it
     would delete the preset already there. Fall through to the older value
     instead. An empty string still passes, because clearing on purpose is a
     thing somebody is allowed to do. */
  const pick = (field: 'name' | 'avatar', ok: (value: string) => boolean) => {
    for (const source of [newer, older]) {
      const value = source && source[field];
      if (typeof value === 'string' && ok(value)) return value;
    }
    return undefined;
  };

  const name = pick('name', () => true);
  // A preset id, not a data URL: anything else is somebody's photo taking a
  // route it was promised it would not take.
  const avatar = pick('avatar', (value) => /^[a-z0-9_-]{0,64}$/i.test(value));
  if (typeof name === 'string') next.name = name.slice(0, 40);
  if (typeof avatar === 'string') next.avatar = avatar;
  next.updatedAt = Math.max(Number(a?.updatedAt) || 0, Number(b.updatedAt) || now);
  return next;
}

export function applyPatch(doc: SyncDoc, patch: SyncPatch, now: number): SyncDoc {
  const removed = mergeRemovals(doc.removed, patch.removed, now);
  const library = mergeLibrary(doc.library, patch.library, removed, now);

  const progress = { ...doc.progress };
  for (const entry of patch.progress ?? []) {
    if (!entry || !entry.seriesId || !entry.chapterId) continue;
    const merged = mergeProgress(progress[entry.seriesId], {
      ...entry,
      updatedAt: Number(entry.updatedAt) || now,
    });
    if (merged) progress[entry.seriesId] = merged;
  }

  return {
    ...doc,
    library,
    removed,
    progress,
    sources: mergeSources(doc.sources, patch.sources, now),
    ...(patch.profile ? { profile: mergeProfile(doc.profile, patch.profile, now) } : {}),
    // Absent means "this device is not sharing", which must not erase what
    // another device shares -- so only an explicit forget clears it.
    ...(patch.forgetSearchHistory
      ? { searchHistory: undefined }
      : patch.searchHistory
        ? { searchHistory: [...new Set([...patch.searchHistory, ...(doc.searchHistory ?? [])])].slice(0, 100) }
        : {}),
    revision: doc.revision + 1,
    updatedAt: now,
  };
}
