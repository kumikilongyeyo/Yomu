/**
 * Shared shelves — the first Yomu surface a non-user can see.
 *
 * A read-only link: covers, titles and the reader's time-capsule notes. No
 * progress, no read data, no account, and nothing that identifies the reader
 * beyond the name they typed for the shelf. It is the top of the funnel.
 *
 * Shape and rules only; storage and HTTP are in routes-shelf.ts. Writes are
 * rare (publish once, update on demand) so a shelf fits the KV budget the
 * sync and circle features already share.
 */

export const SHELF_SCHEMA = 'yomu.shelf/1';
export const MAX_ITEMS = 300;
export const MAX_NOTE = 240;

export interface ShelfItem {
  title: string;
  cover?: string;
  note?: string;
  category?: string;
}

export interface ShelfDoc {
  schema: typeof SHELF_SCHEMA;
  revision: number;
  name: string;
  items: ShelfItem[];
  at: number;
  /** The publisher's proof. Never returned by a read. */
  token: string;
}

/* Control characters other than tab and newline are stripped, then all
   whitespace folds to one space. */
const text = (raw: unknown, max: number) =>
  String(raw ?? '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** Only an http(s) address, and a sane length. A data: URL is a photo. */
function coverOf(raw: unknown): string | undefined {
  const value = text(raw, 500);
  if (!/^https?:\/\//i.test(value)) return undefined;
  try { new URL(value); } catch { return undefined; }
  return value;
}

export function sanitiseName(raw: unknown): string {
  return text(raw, 60) || 'A Yomu shelf';
}

export function sanitiseItems(raw: unknown): ShelfItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ShelfItem[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const title = text((row as any).title, 120);
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    const item: ShelfItem = { title };
    const cover = coverOf((row as any).cover);
    if (cover) item.cover = cover;
    const note = text((row as any).note, MAX_NOTE);
    if (note) item.note = note;
    const category = text((row as any).category, 24).toLowerCase();
    if (/^[a-z-]+$/.test(category)) item.category = category;
    out.push(item);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/** What a reader of the link is told. The token stays home. */
export const publicShelf = (doc: ShelfDoc, code: string) => ({
  code,
  name: doc.name,
  items: doc.items,
  count: doc.items.length,
  at: doc.at,
  revision: doc.revision,
});
