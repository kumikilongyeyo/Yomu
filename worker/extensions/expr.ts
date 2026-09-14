/**
 * The value layer of a declarative adapter.
 *
 * A descriptor never carries code. It carries *paths* into a JSON document and
 * a short list of named transforms to apply to whatever the path found. Both
 * are pure data, so a hostile descriptor can at worst produce a wrong string --
 * it can never reach the Worker's globals, make a request of its own, or run.
 */

export type Transform =
  | { trim: true }
  | { lower: true }
  | { upper: true }
  | { first: true }
  | { number: true }
  | { prefix: string }
  | { suffix: string }
  | { join: string }
  | { replace: string; with: string; flags?: string }
  | { regex: string; group?: number; flags?: string }
  | { split: string; index?: number }
  | { resolve: true }
  | { date: 'unix' | 'unixms' | 'iso' }
  | { map: Record<string, string> }
  | { default: string | number }
  | { slice: [number, number?] }
  | { pluck: string };

export interface FieldSpec {
  /** Dotted JSON path, e.g. `md_covers[0].b2key`. Omit to use the item itself. */
  path?: string;
  /** CSS selector, relative to the list item (html parsers only). */
  selector?: string;
  /** Attribute to read instead of text content (html parsers only). */
  attr?: string;
  /** Literal template, e.g. `https://x/{{id}}.jpg`, evaluated against sibling fields. */
  template?: string;
  /** Collect every match rather than the first -- for genres, tags, alt titles. */
  many?: boolean;
  /** Resolve `path` against the whole document rather than the current record.
   *  Needed when a list's items depend on a value that sits beside the list. */
  root?: boolean;
  transform?: Transform[];
}

const MAX_STRING = 200_000;

/**
 * Walk a path into a JSON document. Supports dotted keys, `[0]` indices, and
 * `[key=value]` predicates that pick the first matching element of an array --
 * enough to read MangaDex-shaped payloads like
 * `relationships[type=cover_art].attributes.fileName`.
 * Returns undefined rather than throwing on anything unexpected.
 */
export function readPath(root: unknown, path?: string): unknown {
  if (path == null || path === '' || path === '$') return root;
  let value: any = root;
  const tokens = path.match(/[^.\[\]]+|\[[^\]]*\]/g) ?? [];
  for (const token of tokens) {
    if (value == null) return undefined;
    if (token.startsWith('[')) {
      const inner = token.slice(1, -1);
      if (/^\d+$/.test(inner)) {
        value = Array.isArray(value) ? value[Number(inner)] : undefined;
        continue;
      }
      const eq = inner.indexOf('=');
      if (eq === -1) return undefined;
      const key = inner.slice(0, eq).trim();
      const want = inner.slice(eq + 1).trim();
      value = Array.isArray(value)
        ? value.find((el) => el != null && String((el as any)[key]) === want)
        : undefined;
      continue;
    }
    const key = token.trim();
    if (key === '') continue;
    value = Array.isArray(value) && /^\d+$/.test(key) ? value[Number(key)] : value[key];
  }
  return value;
}

const toText = (value: unknown): string => {
  if (value == null) return '';
  if (typeof value === 'string') return value.slice(0, MAX_STRING);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(toText).filter(Boolean).join(', ').slice(0, MAX_STRING);
  return '';
};

/** Compile a regex defensively: a bad pattern yields null instead of throwing. */
function safeRegex(pattern: string, flags?: string): RegExp | null {
  if (pattern.length > 400) return null;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

export function applyTransforms(input: unknown, transforms: Transform[] | undefined, baseUrl?: string): unknown {
  let value: unknown = input;
  for (const step of transforms ?? []) {
    if ('pluck' in step) {
      // Lift one field out of each object in an array: `genres[].name`.
      value = Array.isArray(value)
        ? value.map((el) => (el && typeof el === 'object' ? (el as any)[step.pluck] : el)).filter((v) => v != null)
        : value;
    } else if ('first' in step) {
      value = Array.isArray(value) ? value[0] : value;
    } else if ('join' in step) {
      value = Array.isArray(value) ? value.map(toText).filter(Boolean).join(step.join) : toText(value);
    } else if ('trim' in step) {
      value = toText(value).replace(/\s+/g, ' ').trim();
    } else if ('lower' in step) {
      value = toText(value).toLowerCase();
    } else if ('upper' in step) {
      value = toText(value).toUpperCase();
    } else if ('number' in step) {
      const n = Number(String(toText(value)).replace(/[^0-9.\-]/g, ''));
      value = Number.isFinite(n) ? n : undefined;
    } else if ('prefix' in step) {
      const t = toText(value);
      value = t ? step.prefix + t : '';
    } else if ('suffix' in step) {
      const t = toText(value);
      value = t ? t + step.suffix : '';
    } else if ('replace' in step) {
      const re = safeRegex(step.replace, step.flags ?? 'g');
      value = re ? toText(value).replace(re, step.with) : value;
    } else if ('regex' in step) {
      const re = safeRegex(step.regex, step.flags);
      const m = re ? re.exec(toText(value)) : null;
      value = m ? (m[step.group ?? 1] ?? m[0]) : undefined;
    } else if ('split' in step) {
      const parts = toText(value).split(step.split);
      value = step.index == null ? parts : parts[step.index < 0 ? parts.length + step.index : step.index];
    } else if ('slice' in step) {
      value = toText(value).slice(step.slice[0], step.slice[1]);
    } else if ('resolve' in step) {
      const t = toText(value);
      try {
        value = t && baseUrl ? new URL(t, baseUrl).toString() : t;
      } catch {
        value = t;
      }
    } else if ('date' in step) {
      const t = toText(value);
      if (!t) {
        value = undefined;
      } else if (step.date === 'unix') {
        const n = Number(t);
        value = Number.isFinite(n) ? n * 1000 : undefined;
      } else if (step.date === 'unixms') {
        const n = Number(t);
        value = Number.isFinite(n) ? n : undefined;
      } else {
        const n = Date.parse(t);
        value = Number.isFinite(n) ? n : undefined;
      }
    } else if ('map' in step) {
      const t = toText(value).toLowerCase();
      value = step.map[t] ?? step.map['*'] ?? undefined;
    } else if ('default' in step) {
      const empty = value == null || value === '' || (typeof value === 'number' && !Number.isFinite(value));
      if (empty) value = step.default;
    }
  }
  return value;
}

/** Substitute `{{name}}` placeholders from a flat variable bag. */
export function fillTemplate(template: string, vars: Record<string, string | number | undefined>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const v = vars[key];
    return v == null ? '' : String(v);
  });
}

/** Resolve one field against an already-extracted record plus its raw source. */
export function resolveField(
  spec: FieldSpec,
  raw: unknown,
  extracted: Record<string, unknown>,
  baseUrl?: string,
  rootDoc?: unknown,
): unknown {
  const input =
    spec.template != null
      ? fillTemplate(
          spec.template,
          Object.fromEntries(Object.entries(extracted).map(([k, v]) => [k, v as any])),
        )
      : readPath(spec.root ? rootDoc : raw, spec.path);
  return applyTransforms(input, spec.transform, baseUrl);
}

export const asString = (v: unknown): string | undefined => {
  const t = toText(v);
  return t ? t : undefined;
};

export const asNumber = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  const n = Number(String(toText(v)).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
};

export const asStringArray = (v: unknown): string[] | undefined => {
  if (Array.isArray(v)) {
    const out = v.map((x) => toText(x).trim()).filter(Boolean);
    return out.length ? out : undefined;
  }
  const t = toText(v).trim();
  if (!t) return undefined;
  return t.split(/\s*,\s*/).filter(Boolean);
};
