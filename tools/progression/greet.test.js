/**
 * What Mori says, and to whom.
 *
 * The corpus is a shipped artefact with a thousand rows in it, so these
 * tests run against the real file rather than a fixture: a parser that
 * handles three invented lines and chokes on the other 997 is not tested.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { parse, render, GENERIC, ARTIFACT, POOLS } =
  await import('../../dist-app/yomu-greet.js');

/** The shipped corpus, loaded the way the browser loads it. */
const corpus = (() => {
  const source = fs.readFileSync(new URL('../../dist-app/yomu-greetings.js', import.meta.url), 'utf8');
  const scope = { window: {} };
  new Function('window', source).call(scope, scope.window);
  return scope.window.YOMU_GREETINGS;
})();

/* --- the corpus itself --------------------------------------------------- */

test('the corpus is present and shaped as the builder writes it', () => {
  assert.equal(corpus.v, '1.1.0');
  assert.equal(corpus.lines.length, 1000);
  for (const row of corpus.lines) {
    assert.ok(typeof row[0] === 'string' && row[0].length, 'has text');
    assert.match(row[1], /^[nfwd]$/, 'tone is one of four');
    assert.match(row[2], /^[maels]$/, 'daypart is one of four');
    if (row[3] !== undefined) assert.match(row[3], /^[cstr]+$/, 'gates are known');
  }
});

test('every daypart has enough lines to avoid repeating', () => {
  const counts = {};
  for (const [, , time] of corpus.lines) counts[time] = (counts[time] || 0) + 1;
  for (const bucket of ['m', 'a', 'e', 'l']) {
    assert.ok(counts[bucket] > 100, bucket + ' has ' + counts[bucket] + ' lines');
  }
});

/* --- dayparts ------------------------------------------------------------ *
 *
 * The bucket is yomu-shell.js's, not this file's: it already handled the
 * wrap past midnight, and a second copy here drifted from it immediately --
 * the version that lived in yomu-greet.js called 02:00 morning. The rule is
 * asserted against the shell so the two cannot part company again. */

const shellBucket = (() => {
  const source = fs.readFileSync(new URL('../../dist-app/yomu-shell.js', import.meta.url), 'utf8');
  const body = /function timeBucket\(\) \{([\s\S]*?)\n  \}/.exec(source);
  if (!body) throw new Error('timeBucket has moved or been renamed in yomu-shell.js');
  /* The body opens with `const hour = new Date().getHours();`. Drop that
     line rather than substituting into it -- rewriting the initialiser
     leaves `const hour = hour` beside the injected parameter. */
  return new Function('hour', body[1].replace(/const hour\s*=\s*new Date\(\)\.getHours\(\);/, ''));
})();

test('late night wraps past midnight rather than reading as morning', () => {
  assert.equal(shellBucket(0), 'l');
  assert.equal(shellBucket(2), 'l');
  assert.equal(shellBucket(4), 'l');
  assert.equal(shellBucket(23), 'l');
});

test('the rest of the day buckets as written', () => {
  assert.equal(shellBucket(7), 'm');
  assert.equal(shellBucket(11), 'm');
  assert.equal(shellBucket(12), 'a');
  assert.equal(shellBucket(17), 'a');
  assert.equal(shellBucket(18), 'e');
  assert.equal(shellBucket(21), 'e');
});

test('the shell still exposes what the pet needs from it', () => {
  const source = fs.readFileSync(new URL('../../dist-app/yomu-shell.js', import.meta.url), 'utf8');
  for (const name of ['greeting', 'readerName', 'timeBucket', 'readerGenres', 'greetingOnScreen']) {
    assert.ok(
      new RegExp('\\b' + name + '\\b').test(source.slice(source.indexOf('window.YomuShell'), source.indexOf('window.YomuShell') + 700)),
      'YomuShell exports ' + name,
    );
  }
});

/* --- parsing the address ------------------------------------------------- */

test('both line shapes parse', () => {
  const comma = parse('Good morning, Junior. Junior, you dare?');
  assert.equal(comma.address, 'Junior');
  assert.equal(comma.head, 'Good morning, ');

  const colon = parse('Tower climber: The hiatus wins again.');
  assert.equal(colon.address, 'Tower climber');
  assert.equal(colon.head, '');
});

test('a line with no address parses to nothing rather than guessing', () => {
  assert.equal(parse('Come catch up.'), null);
  assert.equal(parse('Pick something fun.'), null);
});

test('the parser finds an address in most of the real corpus', () => {
  const parsed = corpus.lines.filter(([text]) => parse(text)).length;
  /* Not all of them have one -- "Come catch up." is a whole line -- but if
     this ever drops sharply the parser has stopped matching a shape the
     generator emits, and substitution silently stops happening. */
  assert.ok(parsed > 600, parsed + ' of 1000 lines carry an address');
});

test('every address the parser finds is classified', () => {
  const unknown = new Set();
  for (const [text] of corpus.lines) {
    const parts = parse(text);
    if (!parts) continue;
    if (GENERIC.has(parts.address) || ARTIFACT.has(parts.address)) continue;
    unknown.add(parts.address);
  }
  /* What is left over must be genre nicknames, which is the third class and
     is deliberately open. This asserts the set has not quietly grown a UI
     noun the ARTIFACT list should have caught. */
  for (const address of unknown) {
    assert.ok(
      !/^(Library|Browse|Your|Recent|Saved|Reading list|Next chapter)/.test(address),
      address + ' looks like an artifact and is not listed as one',
    );
  }
});

/* --- substitution -------------------------------------------------------- */

test('a name replaces the address and keeps the punctuation', () => {
  assert.equal(
    render('Good morning, Junior. Junior, you dare?', 'Klyde'),
    'Good morning, Klyde. Junior, you dare?',
  );
  assert.equal(
    render('Tower climber: The hiatus wins again.', 'Klyde'),
    'Klyde: The hiatus wins again.',
  );
});

test('no name leaves the line exactly as written', () => {
  const line = 'Good morning, Junior. Junior, you dare?';
  assert.equal(render(line, ''), line);
  assert.equal(render(line, null), line);
});

test('a line with no address is returned untouched', () => {
  assert.equal(render('Come catch up.', 'Klyde'), 'Come catch up.');
});

test('substitution never throws on any real line', () => {
  for (const [text] of corpus.lines) {
    assert.equal(typeof render(text, 'Klyde'), 'string');
    assert.equal(typeof render(text, ''), 'string');
  }
});

test('an artifact address becomes a sentence once a name goes in', () => {
  // "Moonlit hours, Your queue. Enjoy a few panels." is not a sentence.
  const before = 'Moonlit hours, Your queue. Enjoy a few panels.';
  assert.ok(ARTIFACT.has(parse(before).address));
  assert.equal(render(before, 'Klyde'), 'Moonlit hours, Klyde. Enjoy a few panels.');
});

/* --- the pools the corpus does not cover --------------------------------- */

test('the line the design asks for by name is in the pool', () => {
  assert.ok(POOLS.welcome_back.includes('You came back. I kept your page.'));
});

test('every event the pet fires has something to say', () => {
  for (const type of ['welcome_back', 'tap', 'chapter_complete', 'milestone', 'source_warning']) {
    assert.ok(POOLS[type]?.length, type + ' has lines');
  }
});

test('milestone lines carry the title placeholder', () => {
  for (const line of POOLS.milestone) {
    assert.match(line, /\{title\}/, 'a milestone line names the milestone');
  }
});

test('no pool line is long enough to overflow the bubble', () => {
  /* The bubble is capped at 260px and wraps; past roughly this length it
     becomes a paragraph floating over the page. */
  for (const [type, lines] of Object.entries(POOLS)) {
    for (const line of lines) {
      assert.ok(line.length <= 72, type + ': "' + line + '" is ' + line.length + ' chars');
    }
  }
});
