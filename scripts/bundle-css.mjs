#!/usr/bin/env node
/**
 * Collapse Yomu's exported stylesheets into one file.
 *
 * A stylesheet blocks the first paint by definition: the browser will not draw
 * until it knows what the page looks like. The export carries 19 of them in
 * every page's head, all first-party, all shipped together, none of which ever
 * changes apart from the others -- 19 requests standing between a visitor and
 * anything on screen.
 *
 * Runs BEFORE scripts/optimize-export.py, and that order is the point. The
 * optimizer's route-aware helpers (yomu-titlecard.css, yomu-mori-chat.css,
 * yomu-library.css, yomu-hero-plus.css) are injected afterwards and stay
 * individual links, so every release contract that greps a page for them, and
 * the fixture server that re-injects them for the runtime gauntlet, keep
 * working untouched. Bundling what the export already wrote is the part that
 * carries no coupling.
 *
 * ONE bundle shared by every page, not one per route: the routes overlap almost
 * completely, so per-route bundles would make a visitor moving from Home to
 * Find download the same bytes twice. This is fetched once and answers the rest.
 *
 * Rules it holds itself to, because a cascade that changes order is a redesign
 * nobody asked for:
 *
 *   - Concatenation order is the document order almost every page already uses.
 *     The export disagrees with itself on two pages, and rather than assume
 *     that is harmless, every pair those pages invert must be proven unable to
 *     override the other. An overlap is a hard failure, not a warning.
 *   - Only same-origin `/yomu-*.css` links are touched. The Expo export's
 *     hashed stylesheet, Google Fonts and Source Fabric's own CSS stay put.
 *   - The bundle takes the position of the page's FIRST such link, so it stays
 *     after the Expo stylesheet and keeps winning over it -- which is the whole
 *     reason yomu-overrides.css is loaded where it is.
 *   - The individual files stay on disk. The release gauntlets fetch them by
 *     name, and so can anyone debugging a rule.
 *
 * The bundle is named for a hash of its inputs, so a stale one cannot outlive a
 * CSS edit: the name changes, the pages point at the new name, the old file goes.
 *
 *   node scripts/bundle-css.mjs           build it and rewire the pages
 *   node scripts/bundle-css.mjs --check   prove a safe bundle exists, write nothing
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist-app');
const CHECK = process.argv.includes('--check');

const LINK = /<link\b[^>]*>/gi;
const HREF = /\bhref="([^"]+)"/i;
const IS_STYLESHEET = /\brel="stylesheet"/i;
const OURS = /^\/yomu-[A-Za-z0-9._-]+\.css$/;
const BUNDLE_FILE = /^yomu-app-[0-9a-f]{12}\.css$/;

function htmlFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...htmlFiles(full));
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out.sort();
}

/** Every `/yomu-*.css` link in the page, in document order, with its raw tag. */
function sheetsOf(html) {
  const found = [];
  for (const tag of html.match(LINK) ?? []) {
    if (!IS_STYLESHEET.test(tag)) continue;
    const href = tag.match(HREF)?.[1];
    if (href && OURS.test(href)) found.push({ tag, href });
  }
  return found;
}

/* --- proving a reorder is inert ------------------------------------------
 *
 * The export does not agree with itself: most pages load yomu-skin.css second,
 * while more.html and shelf.html load it near the end. One bundle has to pick
 * an order, so for every pair the pages disagree about, this asks whether the
 * two files can see each other at all.
 *
 * Two stylesheets only care about their relative order where one can override
 * the other at equal weight: the same selector setting the same property, or
 * the same @keyframes name. Where they share neither, the cascade cannot tell
 * which came first, and the disagreement is a formatting accident rather than
 * a decision. Anything that does overlap is a decision, and this refuses to
 * guess at it.
 *
 * The parse is deliberately blunt -- it ignores @media nesting, so a rule
 * inside a query and the same rule outside one count as a collision. Over-
 * reporting costs a bundle; under-reporting costs a redesign.
 */
const CSS_CACHE = new Map();

function fingerprint(href) {
  const cached = CSS_CACHE.get(href);
  if (cached) return cached;

  const raw = fs.readFileSync(path.join(DIST, href.slice(1)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const keyframes = new Set();
  const declarations = new Set();

  /* Lift @keyframes out first: their `0%` and `to` steps are not selectors and
     only collide with another block of the same name. */
  let body = '';
  for (let i = 0; i < raw.length; i += 1) {
    const at = raw.startsWith('@', i) && /^@(-webkit-)?keyframes\s+([A-Za-z0-9_-]+)/.exec(raw.slice(i));
    if (!at) { body += raw[i]; continue; }
    keyframes.add(at[2]);
    let depth = 0;
    let j = i + at[0].length;
    for (; j < raw.length; j += 1) {
      if (raw[j] === '{') depth += 1;
      else if (raw[j] === '}' && (depth -= 1) === 0) break;
    }
    i = j;
  }

  for (const rule of body.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const selectors = rule[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
    const properties = rule[2].split(';').map((d) => d.split(':')[0].trim().toLowerCase()).filter(Boolean);
    for (const selector of selectors) for (const property of properties) declarations.add(`${selector}|${property}`);
  }

  const result = { keyframes, declarations };
  CSS_CACHE.set(href, result);
  return result;
}

/** Where two stylesheets can override one another, listed so a failure names it. */
function overlaps(a, b) {
  const left = fingerprint(a);
  const right = fingerprint(b);
  const found = [];
  for (const name of left.keyframes) if (right.keyframes.has(name)) found.push(`@keyframes ${name}`);
  for (const key of left.declarations) if (right.declarations.has(key)) found.push(key.split('|').join(' { ') + ' }');
  return found;
}

/**
 * The order the bundle uses: whichever sequence the most pages already agree on.
 *
 * Deriving one from pairwise "a before b" votes looked tidy and was wrong -- the
 * export's two odd pages differ in a dozen places at once, so the votes form one
 * long cycle with no single pair to blame, and the algorithm has nothing to
 * resolve. Taking the majority sequence whole is both simpler and truer to the
 * intent: keep what almost every page already does, and make the minority prove
 * it does not care.
 */
function canonicalOrder(pages) {
  const groups = new Map();
  for (const page of pages) {
    const key = page.sheets.map((sheet) => sheet.href).join(' ');
    const group = groups.get(key) ?? { order: page.sheets.map((sheet) => sheet.href), pages: [] };
    group.pages.push(page.file);
    groups.set(key, group);
  }

  const ranked = [...groups.values()].sort((a, b) => b.pages.length - a.pages.length || a.order.length - b.order.length);
  const canonical = ranked[0];

  for (const group of ranked.slice(1)) {
    const missing = group.order.filter((href) => !canonical.order.includes(href));
    if (missing.length) {
      throw new Error(
        `${path.relative(ROOT, group.pages[0])} loads ${missing.join(', ')}, which the majority of pages do not. ` +
          'One bundle cannot serve both; bundle those pages separately or align the export.',
      );
    }
  }

  return { order: canonical.order, groups: ranked };
}

/**
 * A page that loads the bundle gets the canonical order, so any pair it used to
 * load the other way round is now inverted. Each inversion has to be inert: the
 * two files must be unable to override one another, or the cascade this page
 * renders with is not the cascade it was written against.
 */
function assertSafeForPages(order, groups) {
  const rank = new Map(order.map((href, i) => [href, i]));
  let inversions = 0;

  for (const group of groups.slice(1)) {
    const where = path.relative(ROOT, group.pages[0]);
    for (let i = 0; i < group.order.length; i += 1) {
      for (let j = i + 1; j < group.order.length; j += 1) {
        const first = group.order[i];
        const second = group.order[j];
        if (rank.get(first) < rank.get(second)) continue;

        inversions += 1;
        const clashes = overlaps(first, second);
        if (clashes.length) {
          throw new Error(
            `${where} loads ${first} before ${second}; the bundle has them the other way round, and they can ` +
              `override each other on ${clashes.slice(0, 3).join(', ')}. Align the export before bundling.`,
          );
        }
      }
    }
  }
  return inversions;
}

function build(order) {
  const parts = [
    '/* Yomu stylesheet bundle -- generated by scripts/bundle-css.mjs.',
    '   Every file below still ships on its own; this is the copy the pages load,',
    '   in the exact order they used to load them in. Do not edit it by hand. */',
    '',
  ];
  const hash = createHash('sha256');
  for (const href of order) {
    const css = fs.readFileSync(path.join(DIST, href.slice(1)), 'utf8');
    hash.update(href).update('\0').update(css).update('\0');
    parts.push(`/* ==== ${href} ==== */`, css.replace(/﻿/g, ''), '');
  }
  return { css: parts.join('\n'), name: `yomu-app-${hash.digest('hex').slice(0, 12)}.css` };
}

/** Swap a page's individual links for the bundle, in the first one's place. */
function rewrite(html, sheets, name) {
  let out = html.replace(sheets[0].tag, `<link rel="stylesheet" href="/${name}">`);
  for (const sheet of sheets.slice(1)) out = out.replace(sheet.tag, '');
  return out;
}

function main() {
  const pages = htmlFiles(DIST)
    .map((file) => ({ file, html: fs.readFileSync(file, 'utf8') }))
    .map((page) => ({ ...page, sheets: sheetsOf(page.html) }))
    .filter((page) => page.sheets.length);

  if (!pages.length) {
    console.log('CSS bundle: no page links an exported Yomu stylesheet; nothing to do.');
    return;
  }

  const { order, groups } = canonicalOrder(pages);
  const inversions = assertSafeForPages(order, groups);
  const { css, name } = build(order);
  const note = inversions
    ? `, realigning ${groups.length - 1} page order${groups.length === 2 ? '' : 's'} across ` +
      `${inversions} pair${inversions === 1 ? '' : 's'}, each proven unable to override the other`
    : '';

  if (CHECK) {
    console.log(
      `CSS bundle would be safe: ${order.length} stylesheets -> /${name} ` +
        `(${Math.round(Buffer.byteLength(css) / 1024)}KB) across ${pages.length} pages${note}. Nothing written.`,
    );
    return;
  }

  fs.writeFileSync(path.join(DIST, name), css, 'utf8');
  const stale = fs.readdirSync(DIST).filter((entry) => BUNDLE_FILE.test(entry) && entry !== name);
  for (const entry of stale) fs.rmSync(path.join(DIST, entry));
  for (const page of pages) fs.writeFileSync(page.file, rewrite(page.html, page.sheets, name), 'utf8');

  console.log(
    `CSS bundle: ${order.length} stylesheets -> /${name} ` +
      `(${Math.round(Buffer.byteLength(css) / 1024)}KB), ${pages.length} pages rewired${note}` +
      `${stale.length ? `, ${stale.length} stale bundle(s) removed` : ''}.`,
  );
}

main();
