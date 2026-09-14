/**
 * HTML extraction for declarative adapters.
 *
 * Built on the Workers-native streaming HTMLRewriter rather than a DOM library:
 * it never materialises a tree, so a 2 MB listing page costs almost nothing in
 * CPU or memory, which is what keeps an adapter inside the Worker's limits.
 *
 * Scoping trick: HTMLRewriter visits nodes in document order, so a handler on
 * the list selector can open a fresh record, and handlers on
 * `<list> <field>` descendant selectors write into whichever record is
 * currently open. First non-empty write per field wins.
 */
import type { FieldSpec } from './expr';

export interface HtmlListSpec {
  list?: string;
  fields: Record<string, FieldSpec>;
  /** Cap on records returned. Chapter lists legitimately run to thousands. */
  limit?: number;
}

const DEFAULT_MAX_ITEMS = 200;
const HARD_MAX_ITEMS = 3000;
const SELF = new Set(['', '.', ':scope', 'self']);

/**
 * Extract records from an HTML response.
 * With `list`, returns one record per matching element; without it, returns a
 * single document-scoped record (used for detail pages).
 */
export async function extractHtml(
  response: Response,
  spec: HtmlListSpec,
  baseUrl: string,
  vars: Record<string, string | number | undefined> = {},
): Promise<Record<string, string | string[]>[]> {
  const maxItems = Math.min(Math.max(spec.limit ?? DEFAULT_MAX_ITEMS, 1), HARD_MAX_ITEMS);
  const items: Record<string, string | string[]>[] = [];
  const scoped = !!spec.list;
  let current: Record<string, string | string[]> | null = scoped ? null : {};
  if (!scoped) items.push(current!);

  // Text arrives in chunks; buffer per (record, field) until the node ends.
  const buffers = new Map<string, string>();
  const bufKey = (field: string) => `${items.length}:${field}`;

  const write = (field: string, value: string | null | undefined) => {
    if (!current || value == null) return;
    const v = value.replace(/\s+/g, ' ').trim();
    if (!v) return;
    if (spec.fields[field]?.many) {
      const bucket = (current[field] as string[] | undefined) ?? [];
      if (bucket.length < 60 && !bucket.includes(v)) bucket.push(v);
      current[field] = bucket;
      return;
    }
    if (!current[field]) current[field] = v;
  };

  let rewriter = new HTMLRewriter();

  if (scoped) {
    rewriter = rewriter.on(spec.list!, {
      element(el) {
        if (items.length >= maxItems) return;
        current = {};
        items.push(current);
        // Self-referential fields (an attribute on the item element itself).
        for (const [name, f] of Object.entries(spec.fields)) {
          if (f.selector != null && SELF.has(f.selector) && f.attr) write(name, el.getAttribute(f.attr));
        }
      },
    });
  }

  for (const [name, f] of Object.entries(spec.fields)) {
    if (f.template != null) continue; // resolved later, from sibling fields
    const sel = f.selector ?? '';
    if (scoped && SELF.has(sel) && f.attr) continue; // already handled above
    const full = scoped ? (SELF.has(sel) ? spec.list! : `${spec.list} ${sel}`) : sel || 'html';

    let handler: { element?: (e: Element) => void; text?: (t: Text) => void };
    if (f.attr) {
      handler = {
        element(el) {
          write(name, el.getAttribute(f.attr!));
        },
      };
    } else {
      handler = {
        text(chunk) {
          if (!current) return;
          const key = bufKey(name);
          const next = (buffers.get(key) ?? '') + chunk.text;
          if (next.length > 20_000) {
            buffers.set(key, next.slice(0, 20_000));
            return;
          }
          buffers.set(key, next);
          if (chunk.lastInTextNode) {
            write(name, next);
            buffers.set(key, '');
          }
        },
      };
    }
    try {
      rewriter = rewriter.on(full, handler as any);
    } catch {
      // An unsupported selector disables that one field, never the whole parse.
    }
  }

  // Driving the stream to completion is what actually runs the handlers.
  await rewriter.transform(response).arrayBuffer();

  const { fillTemplate, applyTransforms } = await import('./expr');
  for (const item of items) {
    // Transforms first: a template field reads its siblings' *final* values,
    // so `{{id}}` means the extracted id, not the raw href it came from.
    for (const [name, f] of Object.entries(spec.fields)) {
      if (f.template != null || item[name] == null) continue;
      if (f.many && Array.isArray(item[name])) {
        const mapped = (item[name] as string[])
          .map((v) => applyTransforms(v, f.transform, baseUrl))
          .filter((v): v is string | number => v != null && String(v) !== '')
          .map(String);
        if (mapped.length) item[name] = mapped;
        else delete item[name];
        continue;
      }
      const out = applyTransforms(item[name], f.transform, baseUrl);
      if (out == null || String(out) === '') delete item[name];
      else item[name] = String(out);
    }
    for (const [name, f] of Object.entries(spec.fields)) {
      if (f.template == null) continue;
      const filled = fillTemplate(f.template, {
        ...vars,
        ...Object.fromEntries(Object.entries(item).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])),
      });
      const out = applyTransforms(filled, f.transform, baseUrl);
      if (out != null && String(out)) item[name] = String(out);
    }
  }
  return items.filter((i) => Object.keys(i).length > 0);
}
