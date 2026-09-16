/* Turn a greeting pack into the compact table yomu-shell.js reads.
 *
 * The pack ships tags, but they under-report: lines tagged `reader_meme`
 * still say "Daoist", untagged ones still say "Mortal". Gating on the tag
 * alone would hand a Romance is Crazy reader a qi-deviation joke, which is
 * the one thing this is meant to prevent. So the gate is computed from the
 * text, and the pack's own tags are folded in on top of it.
 *
 * Output: dist-app/yomu-greetings.js -> window.YOMU_GREETINGS
 * Run: node tools/build-greetings.mjs <pack.json>
 */
import fs from 'node:fs';

const src = process.argv[2];
if (!src) { console.error('usage: node tools/build-greetings.mjs <pack.json>'); process.exit(1); }

const pack = JSON.parse(fs.readFileSync(src, 'utf8'));
const lines = pack.greetings || [];
if (!lines.length) { console.error('no greetings in pack'); process.exit(1); }

/* Vocabulary that only makes sense to someone who reads the genre. A line
   matching any of these is locked until the library shows that genre. */
const LEX = {
  c: /\b(qi|dao|daoist|sect|junior|senior|mortal|elder|immortal|tribulation|meridian|cauldron|pill|core formation|courting death|heavenly|martial|cultivat)/i,
  s: /\b(system|s-rank|a-rank|b-rank|e-rank|f-rank|status window|level up|leveling|quest|skill tree|stat|player|dungeon|gate|hunter|awaken)/i,
  t: /\b(tower|floor|climb|ascend)/i,
  r: /\b(regress|returner|rewind|second life|do-over|timeline|reincarnat|another chance)/i,
};
const TAG = { cultivation: 'c', system: 's', tower: 't', regression: 'r' };
const TONE = { neutral: 'n', friendly: 'f', wholesome_meme: 'w', dark_sarcastic: 'd' };
const TIME = { morning: 'm', afternoon: 'a', evening: 'e', late_night: 'l' };

const out = [];
const stat = { safe: 0, locked: {} };

for (const g of lines) {
  const text = String(g.text || '').trim();
  if (!text) continue;
  const gates = new Set();
  for (const [key, re] of Object.entries(LEX)) if (re.test(text)) gates.add(key);
  for (const tag of g.tags || []) if (TAG[tag]) gates.add(TAG[tag]);

  const row = [text, TONE[g.tone] || 'n', TIME[g.time_of_day] || 'm'];
  if (gates.size) {
    row.push([...gates].sort().join(''));
    for (const k of gates) stat.locked[k] = (stat.locked[k] || 0) + 1;
  } else stat.safe++;
  out.push(row);
}

const body = 'window.YOMU_GREETINGS=' + JSON.stringify({
  v: pack.version || '0',
  lines: out,
}) + ';';

fs.writeFileSync('dist-app/yomu-greetings.js', body);
console.log(`greetings: ${out.length} lines, ${stat.safe} unlocked, locked ${JSON.stringify(stat.locked)}`);
console.log(`wrote dist-app/yomu-greetings.js (${(body.length / 1024).toFixed(1)} KB)`);
