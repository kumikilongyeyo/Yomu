/**
 * Yomu Circles — a reading circle for about ten people you know.
 *
 * This is deliberately not a comments system for the internet. Almost every
 * cost in that design comes from being public: a reports queue, filtering,
 * appeals, impersonation-proof identity, and the permanent tax of spam. Strip
 * the public part and what is left is small -- and one piece of it is the
 * reason to build it at all.
 *
 * SPOILERS ARE THE ACTUAL PROBLEM AT THIS SIZE
 *
 * Ten friends reading the same series at ten different speeds is a minefield,
 * and it is what ruins a shared reading circle in practice. So the rule is:
 * a comment is visible only to members who have reached that chapter. Someone
 * on 12 never sees the thread on 40 -- they see that it exists and is waiting.
 *
 * That gate is the whole reason the server needs each member's position, and
 * it is worth being honest that this is what joining a circle costs: the
 * circle learns how far along you are in the series it talks about. Nothing
 * else about your library crosses over. It is a high-water chapter number per
 * series and no more.
 *
 * THE CODE IS NOT YOUR SYNC CODE
 *
 * The line to get right before anything else. A sync code pairs your own
 * devices and carries full write access to your library. A circle code lets
 * other people write comments and nothing else. Same mechanism, different key,
 * different permissions -- and they must never be the same string, or everyone
 * you invited to the circle would own your library. createCircleCode refuses
 * any code that already names a library, so that is a guarantee rather than a
 * probability.
 */
import { generateCode } from './sync';

export const CIRCLE_SCHEMA = 'yomu.circle/1';

/** Ten people, and a little room. Past this it is a different product. */
export const MAX_MEMBERS = 25;
export const MAX_COMMENT_CHARS = 1200;
/** Per series, oldest dropped first. No real circle approaches this. */
export const MAX_COMMENTS_PER_SERIES = 2000;

export interface Member {
  name: string;
  joinedAt: number;
  lastSeen: number;
  /**
   * The badge this member has equipped, drawn beside their name on every
   * comment. A preset id only ("tower-climber:3", "century") -- the same
   * rule as the synced avatar: the server stores something it can validate
   * by pattern and never anything a client drew.
   */
  badge?: string;
}

export interface CircleDoc {
  schema: typeof CIRCLE_SCHEMA;
  revision: number;
  createdAt: number;
  name: string;
  ownerId: string;
  members: Record<string, Member>;
  /**
   * memberId -> seriesKey -> furthest chapter number reached.
   *
   * A high-water mark, never lowered: re-reading a series from the start must
   * not re-hide conversations you have already been part of.
   */
  progress: Record<string, Record<string, number>>;
  /** When each mark last advanced, same shape. Only the race reads it, to
   *  find who moved furthest this week. Absent on circles from before. */
  progressAt?: Record<string, Record<string, number>>;
  /** The reading race: anonymous ticks are always on; this adds a leader
   *  badge for the week. Owner's switch. */
  race?: boolean;
}

export interface Comment {
  id: string;
  memberId: string;
  /** Snapshotted at post time, so a member who leaves keeps their name on
   *  what they said. Deleting half a conversation reads worse than a name
   *  that no longer resolves to anyone. */
  name: string;
  chapter: number;
  text: string;
  at: number;
  /** Member ids, not a counter. No race to reason about, and at ten people
   *  knowing *who* agreed is worth more than knowing how many did. */
  likes: string[];
  /**
   * memberId -> sticker id. One reaction per member, replaceable.
   *
   * Stickers are earned by reading (the progression store grants them), so
   * a rare one under a comment says something a heart cannot. The server
   * cannot see who has earned what -- progress is on the device -- so the
   * picker is what enforces "only stickers you own"; the server enforces
   * the gate, which is the part that matters for spoilers.
   */
  reactions?: Record<string, string>;
}

/** One document per series per circle: one read answers a whole series, both
 *  the comments you may see and the count of the ones you may not. */
export interface SeriesThread {
  schema: typeof CIRCLE_SCHEMA;
  comments: Comment[];
}

export const seriesKey = (sourceId: string, seriesId: string) => `${sourceId}:${seriesId}`;

export function emptyCircle(name: string, ownerId: string, now: number): CircleDoc {
  return {
    schema: CIRCLE_SCHEMA,
    revision: 0,
    createdAt: now,
    name: name.slice(0, 60) || 'Reading circle',
    ownerId,
    members: {},
    progress: {},
  };
}

/**
 * How far a member has got in one series.
 *
 * Absent means zero, which hides everything above chapter zero -- the right
 * default for someone who has not opened the series: they see that there is a
 * conversation and nothing of what is in it.
 */
export const reachedIn = (doc: CircleDoc, memberId: string, key: string): number =>
  doc.progress[memberId]?.[key] ?? 0;

/** Never lowered. Re-reading from chapter 1 must not re-hide chapter 40. */
export function recordProgress(
  doc: CircleDoc,
  memberId: string,
  key: string,
  chapter: number,
  now?: number,
): CircleDoc {
  if (!Number.isFinite(chapter) || chapter <= 0) return doc;
  const mine = doc.progress[memberId] ?? {};
  if ((mine[key] ?? 0) >= chapter) return doc;
  const stamps = doc.progressAt ?? {};
  return {
    ...doc,
    progress: { ...doc.progress, [memberId]: { ...mine, [key]: chapter } },
    ...(now ? { progressAt: { ...stamps, [memberId]: { ...(stamps[memberId] ?? {}), [key]: now } } } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * The reading race
 *
 * Built entirely from the marks the gate already holds. What leaves the
 * server is: how many members stand at each chapter (numbers, never who),
 * the names of members at or below your own mark (you could see them in
 * the thread anyway), and -- when the race is on -- the week's leader,
 * named only if you have reached where they are. Someone ahead of you is
 * "someone ahead", which says a chapter number exists and nothing else.
 * ------------------------------------------------------------------ */

export const RACE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface RaceView {
  on: boolean;
  mine: number;
  marks: { chapter: number; count: number }[];
  ahead: number;
  behind: number;
  alongside: number;
  known: { name: string; chapter: number }[];
  leader: { chapter: number; name: string | null; isYou: boolean } | null;
}

export function raceView(doc: CircleDoc, key: string, viewerId: string, now: number): RaceView {
  const mine = reachedIn(doc, viewerId, key);
  const marks = new Map<number, number>();
  const known: { name: string; chapter: number }[] = [];
  let ahead = 0, behind = 0, alongside = 0;

  for (const [id, member] of Object.entries(doc.members)) {
    const chapter = doc.progress[id]?.[key] ?? 0;
    if (chapter > 0) marks.set(chapter, (marks.get(chapter) ?? 0) + 1);
    if (id === viewerId) continue;
    if (chapter > mine) ahead++;
    else if (chapter < mine) behind++;
    else alongside++;
    if (chapter > 0 && chapter <= mine) known.push({ name: member.name, chapter });
  }
  known.sort((a, b) => b.chapter - a.chapter || a.name.localeCompare(b.name));

  let leader: RaceView['leader'] = null;
  if (doc.race) {
    for (const [id, member] of Object.entries(doc.members)) {
      const chapter = doc.progress[id]?.[key] ?? 0;
      const at = doc.progressAt?.[id]?.[key] ?? 0;
      if (!chapter || !at || now - at > RACE_WEEK_MS) continue;
      if (!leader || chapter > leader.chapter) {
        leader = { chapter, name: id === viewerId || chapter <= mine ? member.name : null, isYou: id === viewerId };
      }
    }
  }

  return {
    on: !!doc.race,
    mine,
    marks: [...marks].map(([chapter, count]) => ({ chapter, count })).sort((a, b) => a.chapter - b.chapter),
    ahead, behind, alongside, known, leader,
  };
}

export interface GatedView {
  /** Comments on chapters this member has reached, oldest first. */
  visible: Comment[];
  /** What is waiting further on: chapter -> how many. Counts only, never text
   *  and never who -- a name is a spoiler when it is on a chapter you have not
   *  reached and the thread is about who dies in it. */
  locked: Record<string, number>;
  lockedTotal: number;
}

/**
 * Split a series' comments into what this member may read and what they may
 * not.
 *
 * The comparison is `comment.chapter <= reached`, so finishing a chapter opens
 * its conversation and not the next one. Your own comments are always visible
 * to you: you wrote them, and hiding them because your recorded position
 * slipped behind would read as losing them.
 */
export function gate(thread: SeriesThread, reached: number, memberId: string): GatedView {
  const visible: Comment[] = [];
  const locked: Record<string, number> = {};
  let lockedTotal = 0;

  for (const comment of thread.comments) {
    if (comment.chapter <= reached || comment.memberId === memberId) {
      visible.push(comment);
      continue;
    }
    const at = String(comment.chapter);
    locked[at] = (locked[at] ?? 0) + 1;
    lockedTotal++;
  }

  visible.sort((a, b) => a.chapter - b.chapter || a.at - b.at);
  return { visible, locked, lockedTotal };
}

/**
 * Reactions grouped by sticker, with who left each -- names, never ids.
 * Sorted by count then sticker id, so two devices draw the same row.
 */
export function reactionSummary(comment: Comment, doc: CircleDoc, viewerId: string) {
  const groups = new Map<string, { sticker: string; count: number; names: string[]; mine: boolean }>();
  for (const [memberId, sticker] of Object.entries(comment.reactions ?? {})) {
    if (!sticker) continue;
    const group = groups.get(sticker) ?? { sticker, count: 0, names: [], mine: false };
    group.count++;
    const name = doc.members[memberId]?.name;
    if (name) group.names.push(name);
    if (memberId === viewerId) group.mine = true;
    groups.set(sticker, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.sticker.localeCompare(b.sticker));
}

/** Strip a comment down to what a reader is allowed to be told about it. */
export const publicComment = (comment: Comment, doc: CircleDoc, viewerId: string) => ({
  id: comment.id,
  chapter: comment.chapter,
  text: comment.text,
  at: comment.at,
  name: comment.name,
  /** Live, not snapshotted: a badge is what you are now, a name is what you
   *  said then. A member who left has no badge, the same way they have no
   *  presence. */
  badge: doc.members[comment.memberId]?.badge || '',
  mine: comment.memberId === viewerId,
  /** A member who has left keeps their name, greyed. */
  present: !!doc.members[comment.memberId],
  likes: comment.likes.length,
  likedByMe: comment.likes.includes(viewerId),
  likedBy: comment.likes.map((id) => doc.members[id]?.name).filter(Boolean),
  reactions: reactionSummary(comment, doc, viewerId),
  myReaction: comment.reactions?.[viewerId] ?? '',
});

/* ------------------------------------------------------------------ *
 * Badges and stickers
 * ------------------------------------------------------------------ */

/** "tower-climber:3", "century", "stage-sage". Lowercase, and only the
 *  characters the progression store puts in an id. */
export const BADGE_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
export const STICKER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/**
 * null means "not mentioned, leave it alone"; '' means "take it off".
 * Anything that fails the pattern is treated as not mentioned rather than
 * as a clear, for the same reason mergeProfile in sync.ts falls through:
 * a bad value must not delete a good one.
 */
export function sanitiseBadge(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw === '') return '';
  return BADGE_PATTERN.test(raw) ? raw : null;
}

export function sanitiseSticker(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') return '';
  return STICKER_PATTERN.test(raw) ? raw : '';
}

/** Same doc back when nothing changes, so the caller can skip the write. */
export function setBadge(doc: CircleDoc, memberId: string, badge: string | null): CircleDoc {
  if (badge === null) return doc;
  const member = doc.members[memberId];
  if (!member || (member.badge ?? '') === badge) return doc;
  const next = { ...member };
  if (badge) next.badge = badge;
  else delete next.badge;
  return { ...doc, members: { ...doc.members, [memberId]: next } };
}

/**
 * Toggle a reaction. Same sticker again takes it off; a different one
 * replaces it; '' removes whatever was there. Mutates the comment, like the
 * like route does, and says whether anything changed.
 */
export function react(comment: Comment, memberId: string, sticker: string): boolean {
  const reactions = comment.reactions ?? {};
  const current = reactions[memberId] ?? '';
  if (!sticker || current === sticker) {
    if (!current) return false;
    delete reactions[memberId];
  } else {
    reactions[memberId] = sticker;
  }
  comment.reactions = reactions;
  return true;
}

/**
 * How many comments this member may read and has not seen.
 *
 * `since` is the newest comment they last opened; anything after it, on a
 * chapter they have reached, that somebody else wrote. The gate is applied
 * before the clock, so a comment on chapter 40 never counts for someone on
 * chapter 12 -- a count is a spoiler too, when it appears the day a friend
 * reaches the chapter you are dreading.
 */
export function unreadCount(thread: SeriesThread, reached: number, memberId: string, since: number): number {
  let count = 0;
  for (const comment of thread.comments) {
    if (comment.memberId === memberId) continue;
    if (comment.chapter > reached) continue;
    if (comment.at > since) count++;
  }
  return count;
}

/**
 * A circle code that cannot also be a library code.
 *
 * Fifty bits makes an accidental collision vanishingly unlikely, but "unlikely"
 * is the wrong guarantee for the one rule that keeps a comment key from being a
 * library key. Checked, not assumed.
 */
export async function createCircleCode(
  exists: (code: string) => Promise<boolean>,
): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    if (!(await exists(code))) return code;
  }
  return null;
}

export function sanitiseText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+$/u, '')
    .replace(/^\s+/u, '')
    // Control characters other than newline and tab: nothing legitimate types
    // them and they make a comment render as something it is not.
    .replace(/[ --]/gu, '')
    .slice(0, MAX_COMMENT_CHARS);
}

export function sanitiseName(raw: unknown, fallback = 'Someone'): string {
  const name = sanitiseText(raw).replace(/\s+/gu, ' ').slice(0, 32);
  return name || fallback;
}
