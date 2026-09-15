/**
 * HTTP surface for Yomu Circles.
 *
 * The rules and the gate live in circle.ts; this is storage, identity and the
 * two owner controls that are the entire moderation surface ten people need.
 *
 * Keys, and why they are split this way:
 *
 *   circle:<code>              members, names, and each member's high-water
 *                              chapter per series
 *   circle:<code>:s:<series>   every comment on one series
 *
 * One read of the second answers a whole series -- the comments you may see
 * and the count of the ones you may not -- and posting writes one series
 * rather than the whole circle. That matters twice over: KV allows a thousand
 * writes a day, and two people commenting on different series can no longer
 * overwrite each other.
 *
 * Identity is the member id, minted by the server on join. The circle code
 * gets you in; the member id is what says which of you it is. A code alone
 * cannot edit anyone's comment but its own holder's.
 */
import type { Env } from './index';
import {
  MAX_COMMENTS_PER_SERIES,
  MAX_MEMBERS,
  createCircleCode,
  emptyCircle,
  gate,
  publicComment,
  reachedIn,
  recordProgress,
  sanitiseName,
  sanitiseText,
  seriesKey,
  CIRCLE_SCHEMA,
} from './circle';
import type { CircleDoc, Comment, SeriesThread } from './circle';
import { formatCode, normalizeCode } from './sync';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, private',
    },
  });

const bad = (message: string, status = 400) => json({ error: message }, status);

const circleKey = (code: string) => `circle:${code}`;
const threadKey = (code: string, key: string) => `circle:${code}:s:${key}`;
const libKey = (code: string) => `lib:${code}`;

async function body(request: Request): Promise<Record<string, any>> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : {};
  } catch {
    return {};
  }
}

async function readCircle(env: Env, code: string): Promise<CircleDoc | null> {
  const raw = await env.SYNC.get(circleKey(code), 'json');
  return raw && typeof raw === 'object' ? (raw as CircleDoc) : null;
}

const writeCircle = (env: Env, code: string, doc: CircleDoc) =>
  env.SYNC.put(circleKey(code), JSON.stringify({ ...doc, revision: doc.revision + 1 }));

async function readThread(env: Env, code: string, key: string): Promise<SeriesThread> {
  const raw = await env.SYNC.get(threadKey(code, key), 'json');
  const thread = raw as SeriesThread | null;
  return thread && Array.isArray(thread.comments) ? thread : { schema: CIRCLE_SCHEMA, comments: [] };
}

const writeThread = (env: Env, code: string, key: string, thread: SeriesThread) =>
  env.SYNC.put(threadKey(code, key), JSON.stringify(thread));

/** The membership view. Never includes another member's id. */
const publicCircle = (doc: CircleDoc, code: string, viewerId: string) => ({
  code,
  display: formatCode(code),
  name: doc.name,
  revision: doc.revision,
  youAreOwner: doc.ownerId === viewerId,
  memberId: viewerId,
  members: Object.entries(doc.members)
    .map(([id, member]) => ({
      id,
      name: member.name,
      joinedAt: member.joinedAt,
      lastSeen: member.lastSeen,
      isOwner: id === doc.ownerId,
      isYou: id === viewerId,
    }))
    .sort((a, b) => Number(b.isOwner) - Number(a.isOwner) || a.joinedAt - b.joinedAt),
});

/** Resolve code + member in one step; every route past create needs both.
 *  Typed as a union rather than inferred, so `'error' in auth` narrows. */
type Auth =
  | { error: Response }
  | { error?: undefined; code: string; doc: CircleDoc; memberId: string };

async function authenticate(env: Env, payload: Record<string, any>): Promise<Auth> {
  const code = normalizeCode(payload.code);
  if (!code) return { error: bad('That does not look like a circle code.') };
  const doc = await readCircle(env, code);
  if (!doc) return { error: bad('No circle with that code.', 404) };
  const memberId = typeof payload.memberId === 'string' ? payload.memberId : '';
  if (!memberId || !doc.members[memberId]) {
    return { error: bad('You are not a member of this circle.', 401) };
  }
  return { code, doc, memberId };
}

const touch = (doc: CircleDoc, memberId: string, now: number): CircleDoc => ({
  ...doc,
  members: { ...doc.members, [memberId]: { ...doc.members[memberId], lastSeen: now } },
});

export async function handleCircle(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.SYNC) return bad('Circles are not configured on this deployment.', 503);
  if (request.method !== 'POST') return bad('Use POST.', 405);

  const route = url.pathname.slice('/api/circle/'.length);
  const now = Date.now();
  const payload = await body(request);

  /* Start a circle. The only route that does not take a code. */
  if (route === 'create') {
    const code = await createCircleCode(async (candidate) =>
      // Never a string that already names a library. This is the rule that
      // stops a comment key from being a library key.
      !!(await env.SYNC.get(libKey(candidate))) || !!(await env.SYNC.get(circleKey(candidate))));
    if (!code) return bad('Please try again.', 503);

    const memberId = crypto.randomUUID();
    const name = sanitiseName(payload.name, 'Owner');
    const doc = emptyCircle(sanitiseName(payload.circleName, 'Reading circle'), memberId, now);
    doc.members[memberId] = { name, joinedAt: now, lastSeen: now };
    await writeCircle(env, code, doc);
    return json(publicCircle({ ...doc, revision: doc.revision + 1 }, code, memberId));
  }

  /* Join with the circle code. Invite-only is the whole spam story. */
  if (route === 'join') {
    const code = normalizeCode(payload.code);
    if (!code) return bad('That does not look like a circle code.');
    const doc = await readCircle(env, code);
    if (!doc) return bad('No circle with that code.', 404);
    if (Object.keys(doc.members).length >= MAX_MEMBERS) {
      return bad('This circle is full.', 409);
    }
    const memberId = crypto.randomUUID();
    const joined: CircleDoc = {
      ...doc,
      members: {
        ...doc.members,
        [memberId]: { name: sanitiseName(payload.name), joinedAt: now, lastSeen: now },
      },
    };
    await writeCircle(env, code, joined);
    return json(publicCircle({ ...joined, revision: joined.revision + 1 }, code, memberId));
  }

  const auth = await authenticate(env, payload);
  if (auth.error) return auth.error;
  const { code, memberId } = auth;
  let doc = auth.doc;

  /* Who is here. */
  if (route === 'info') {
    await writeCircle(env, code, touch(doc, memberId, now));
    return json(publicCircle(doc, code, memberId));
  }

  /* One series: what you may read, and how much is waiting.
   *
   * The reader reports its own position on the way in, so the gate is current
   * without a second round trip -- and so that opening chapter 40 is what
   * unlocks chapter 40's thread, at the moment you get there. */
  if (route === 'read') {
    const key = seriesKey(String(payload.sourceId ?? ''), String(payload.seriesId ?? ''));
    if (key === ':') return bad('Which series?');

    const chapter = Number(payload.chapter);
    const before = doc;
    doc = recordProgress(doc, memberId, key, chapter);
    if (doc !== before) await writeCircle(env, code, touch(doc, memberId, now));

    const thread = await readThread(env, code, key);
    const view = gate(thread, reachedIn(doc, memberId, key), memberId);
    return json({
      circle: publicCircle(doc, code, memberId),
      reached: reachedIn(doc, memberId, key),
      comments: view.visible.map((c) => publicComment(c, doc, memberId)),
      locked: view.locked,
      lockedTotal: view.lockedTotal,
    });
  }

  /* Say something about a chapter. */
  if (route === 'post') {
    const key = seriesKey(String(payload.sourceId ?? ''), String(payload.seriesId ?? ''));
    if (key === ':') return bad('Which series?');
    const chapter = Number(payload.chapter);
    if (!Number.isFinite(chapter) || chapter <= 0) return bad('Which chapter?');
    const text = sanitiseText(payload.text);
    if (!text) return bad('Say something first.');

    // Posting about a chapter is reaching it. Without this, your own comment
    // would be the only thing you could see in a thread you just opened.
    doc = recordProgress(doc, memberId, key, chapter);
    await writeCircle(env, code, touch(doc, memberId, now));

    const thread = await readThread(env, code, key);
    const comment: Comment = {
      id: crypto.randomUUID(),
      memberId,
      name: doc.members[memberId].name,
      chapter,
      text,
      at: now,
      likes: [],
    };
    thread.comments.push(comment);
    // Oldest first out. A circle never reaches this; a loop in a client might.
    if (thread.comments.length > MAX_COMMENTS_PER_SERIES) {
      thread.comments = thread.comments.slice(-MAX_COMMENTS_PER_SERIES);
    }
    await writeThread(env, code, key, thread);

    const view = gate(thread, reachedIn(doc, memberId, key), memberId);
    return json({
      comments: view.visible.map((c) => publicComment(c, doc, memberId)),
      locked: view.locked,
      lockedTotal: view.lockedTotal,
    });
  }

  /* Agree with something. Toggling, and idempotent per member. */
  if (route === 'like') {
    const key = seriesKey(String(payload.sourceId ?? ''), String(payload.seriesId ?? ''));
    const id = String(payload.commentId ?? '');
    const thread = await readThread(env, code, key);
    const comment = thread.comments.find((c) => c.id === id);
    if (!comment) return bad('That comment is gone.', 404);
    // Not readable, not likeable: otherwise a like is a way to probe a thread
    // the gate is hiding.
    if (comment.chapter > reachedIn(doc, memberId, key) && comment.memberId !== memberId) {
      return bad('You have not reached that chapter yet.', 403);
    }
    comment.likes = comment.likes.includes(memberId)
      ? comment.likes.filter((m) => m !== memberId)
      : [...comment.likes, memberId];
    await writeThread(env, code, key, thread);
    return json({ comment: publicComment(comment, doc, memberId) });
  }

  /* Delete: your own always, anyone's if you started the circle. */
  if (route === 'delete') {
    const key = seriesKey(String(payload.sourceId ?? ''), String(payload.seriesId ?? ''));
    const id = String(payload.commentId ?? '');
    const thread = await readThread(env, code, key);
    const comment = thread.comments.find((c) => c.id === id);
    if (!comment) return json({ ok: true });
    if (comment.memberId !== memberId && doc.ownerId !== memberId) {
      return bad('That is not yours to delete.', 403);
    }
    thread.comments = thread.comments.filter((c) => c.id !== id);
    await writeThread(env, code, key, thread);
    return json({ ok: true });
  }

  /* Remove a member. Owner only, and the owner cannot remove themselves --
   * a circle with no owner has no way to moderate anything ever again. */
  if (route === 'remove') {
    if (doc.ownerId !== memberId) return bad('Only the circle owner can do that.', 403);
    const target = String(payload.target ?? '');
    if (!target || !doc.members[target]) return json(publicCircle(doc, code, memberId));
    if (target === doc.ownerId) return bad('You cannot remove yourself.', 400);

    const members = { ...doc.members };
    delete members[target];
    const progress = { ...doc.progress };
    delete progress[target];
    // Their comments stay, and publicComment marks them as no longer present.
    // Deleting half a conversation reads worse than a name that is greyed out.
    const next = { ...doc, members, progress };
    await writeCircle(env, code, next);
    return json(publicCircle(next, code, memberId));
  }

  /* Close the circle. Owner only, and it takes the conversations with it.
   *
   * The counterpart to "the owner cannot leave": without this the only way out
   * for whoever started it is to abandon a circle that keeps existing, and the
   * comments in it keep existing too. Somebody has to be able to end it.
   *
   * Every series thread goes as well as the membership. KV has no prefix
   * delete, so they are listed and removed -- a circle has a handful of these,
   * and the alternative is orphaned rows nobody can reach or clear. */
  if (route === 'destroy') {
    if (doc.ownerId !== memberId) return bad('Only the circle owner can close it.', 403);

    let cursor: string | undefined;
    do {
      const page: any = await env.SYNC.list({ prefix: `circle:${code}:s:`, cursor });
      for (const entry of page.keys) await env.SYNC.delete(entry.name);
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);

    await env.SYNC.delete(circleKey(code));
    return json({ ok: true });
  }

  /* Leave. The owner leaving would orphan the circle, so it is refused --
   * closing it is what they do instead. */
  if (route === 'leave') {
    if (doc.ownerId === memberId) {
      return bad('You started this circle. Close it, or remove the others.', 400);
    }
    const members = { ...doc.members };
    delete members[memberId];
    const progress = { ...doc.progress };
    delete progress[memberId];
    await writeCircle(env, code, { ...doc, members, progress });
    return json({ ok: true });
  }

  return bad('Unknown circle route.', 404);
}
