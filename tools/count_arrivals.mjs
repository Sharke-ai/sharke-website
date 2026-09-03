// Identified human arrivals on the marketing pages. READ ONLY: lists and reads the
// Netlify Blobs store "page-events" and writes nothing anywhere.
//
//   node tools/count_arrivals.mjs                      # everything in the store
//   node tools/count_arrivals.mjs --since 2026-09-01   # from a date forward
//   node tools/count_arrivals.mjs --page gd --source subdrip1
//   node tools/count_arrivals.mjs --selftest           # classifier only, no network
//
// Queue row E5 asks for "a number you can defend for identified HUMAN arrivals, with
// machine traffic excluded and the exclusion rule stated". So the rule is stated here,
// in the instrument, before any number exists:
//
//   ⭐ A VISITOR COUNTS AS HUMAN ONLY IF IT FIRED A SCROLL-DEPTH EVENT (s25/s50/s75/s90)
//     AS WELL AS A VIEW. A crawler or a link scanner loads the page and never scrolls.
//
// It is deliberately conservative and it is stated up front rather than tuned afterwards
// to produce a comfortable figure. It UNDERCOUNTS: a real person who reads the top of the
// page and leaves without scrolling 25% is counted as a machine. That direction is the
// safe one for a claim about how many humans arrived.
//
// ⛔ THREE THINGS THIS INSTRUMENT REFUSES TO DO, each of which is a way the number lies:
//
// 1. It never reports a count from a truncated listing. If the store hands back a
//    pagination cursor it keeps following it, and if it ever stops early it RAISES
//    instead of returning what it has.
// 2. It never merges the empty-visitor rows into either bucket. Events written before
//    the visitor id existed, and any Do-Not-Track-adjacent row that arrives without one,
//    cannot be grouped into people at all. They are counted and reported on their own
//    line, because folding them into "machine" would flatter the human number and
//    folding them into "human" would inflate it.
// 3. It never speaks for the pre-2026-08-03 history. That lives in a DIFFERENT store
//    ("analytics") as per-page-per-date counters with no visitor id, so it can only ever
//    be a pageview count. The widely quoted "312 /ed views since 08-03, overwhelmingly
//    machine" is that kind of figure and must not be restated as arrivals.
import { getStore } from '@netlify/blobs';
import fs from 'fs';

const SCROLL_EVENTS = new Set(['s25', 's50', 's75', 's90']);

// ---------------------------------------------------------------- the classifier
// Pure, so --selftest can prove it fails before any run is believed.
export function classify(eventsByVisitor) {
  const out = { human: 0, machine: 0, unattributable: 0 };
  for (const [visitor, events] of eventsByVisitor) {
    if (!visitor) { out.unattributable += events.length; continue; }
    if (events.some((e) => SCROLL_EVENTS.has(e))) out.human += 1;
    else out.machine += 1;
  }
  return out;
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
}

// ---------------------------------------------------------------- self-test
function selftest() {
  const cases = [
    ['scrolled past 25%, so a person', [['v1', ['view', 's25']]], { human: 1, machine: 0, unattributable: 0 }],
    ['view only, so a machine', [['v1', ['view']]], { human: 0, machine: 1, unattributable: 0 }],
    ['view many times, still never scrolled, still a machine',
      [['v1', ['view', 'view', 'view', 'view']]], { human: 0, machine: 1, unattributable: 0 }],
    ['deep scroll only', [['v1', ['s90']]], { human: 1, machine: 0, unattributable: 0 }],
    ['one person, many events, counted ONCE',
      [['v1', ['view', 's25', 's50', 's75', 's90', 'cta_hero']]], { human: 1, machine: 0, unattributable: 0 }],
    ['a click without a scroll is NOT promoted to human',
      [['v1', ['view', 'cta_hero']]], { human: 0, machine: 1, unattributable: 0 }],
    ['⭐ empty visitor id is its own bucket, never folded into either',
      [['', ['view', 's25', 's90']]], { human: 0, machine: 0, unattributable: 3 }],
    ['mixed population',
      [['v1', ['view', 's50']], ['v2', ['view']], ['', ['view']], ['v3', ['view', 's25']]],
      { human: 2, machine: 1, unattributable: 1 }],
    ['no events at all', [], { human: 0, machine: 0, unattributable: 0 }],
  ];
  let bad = 0;
  for (const [name, input, want] of cases) {
    const got = classify(new Map(input));
    const ok = got.human === want.human && got.machine === want.machine
      && got.unattributable === want.unattributable;
    if (!ok) bad += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  human=${got.human} machine=${got.machine} ` +
      `unattributable=${got.unattributable}  (want ${want.human}/${want.machine}/` +
      `${want.unattributable})  ${name}`);
  }
  console.log('');
  if (bad) { console.log(`FAILED: ${bad} case(s).`); process.exit(1); }
  console.log('ALL PASS. The classifier separates a scroller from a loader and refuses to');
  console.log('guess at a visitor it cannot identify, so a run of this tool means something.');
  process.exit(0);
}

if (process.argv.includes('--selftest')) selftest();

// ---------------------------------------------------------------- the live read
const cfgPath = process.env.APPDATA + '/netlify/Config/config.json';
if (!fs.existsSync(cfgPath)) {
  console.error('FAIL: no netlify CLI config at ' + cfgPath + '. Run `netlify login`.');
  process.exit(1);
}
const token = Object.values(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).users)[0].auth.token;
const siteID = JSON.parse(fs.readFileSync('.netlify/state.json', 'utf8')).siteId;
const store = getStore({ name: 'page-events', siteID, token });

const since = arg('since');
const onlyPage = arg('page');
const onlySource = arg('source');

// GUARD 1: follow every page of the listing, and raise rather than return a partial.
let keys = [];
let cursor;
let rounds = 0;
do {
  const res = await store.list(cursor ? { cursor } : {});
  keys = keys.concat(res.blobs.map((b) => b.key));
  cursor = res.cursor;
  rounds += 1;
  if (rounds > 500) {
    console.error(`FAIL: listing still paginating after ${rounds} rounds and ${keys.length} ` +
      'keys. Refusing to report a count from a loop that hit its cap.');
    process.exit(1);
  }
} while (cursor);

const wanted = keys.filter((k) => {
  const [date, page] = k.split('/');
  if (since && date < since) return false;
  if (onlyPage && page !== onlyPage) return false;
  return true;
});

console.log(`store "page-events": ${keys.length} event blobs total, ${wanted.length} in scope`);
console.log(`scope: ${since ? 'since ' + since : 'all dates'}` +
  `${onlyPage ? ', page ' + onlyPage : ''}${onlySource ? ', source ' + onlySource : ''}`);

// Fetch bodies with bounded concurrency. The visitor id lives inside the blob, not the key.
const rows = [];
let failed = 0;
const CONC = 24;
for (let i = 0; i < wanted.length; i += CONC) {
  const slice = wanted.slice(i, i + CONC);
  const got = await Promise.all(slice.map(async (k) => {
    try { return await store.get(k, { type: 'json' }); } catch { failed += 1; return null; }
  }));
  for (const r of got) if (r) rows.push(r);
}
// GUARD 2: a partial read is not a result.
if (failed) {
  console.error(`FAIL: ${failed} of ${wanted.length} blob reads failed. A partial sweep is ` +
    'not a count.');
  process.exit(1);
}

const scoped = onlySource ? rows.filter((r) => (r.source || '') === onlySource) : rows;

const byVisitor = new Map();
for (const r of scoped) {
  const v = r.visitor || '';
  if (!byVisitor.has(v)) byVisitor.set(v, []);
  byVisitor.get(v).push(r.event);
}
const verdict = classify(byVisitor);

// Per page and per source, so an arrival can be attributed to the email that produced it.
const perPage = new Map();
const perSource = new Map();
for (const [v, events] of byVisitor) {
  if (!v) continue;
  const human = events.some((e) => SCROLL_EVENTS.has(e));
  const mine = scoped.filter((r) => (r.visitor || '') === v);
  for (const key of new Set(mine.map((r) => r.page))) {
    const cur = perPage.get(key) || { human: 0, machine: 0 };
    cur[human ? 'human' : 'machine'] += 1;
    perPage.set(key, cur);
  }
  for (const key of new Set(mine.map((r) => r.source || '(none)'))) {
    const cur = perSource.get(key) || { human: 0, machine: 0 };
    cur[human ? 'human' : 'machine'] += 1;
    perSource.set(key, cur);
  }
}

console.log('');
console.log('RULE: a visitor is human only if it fired a scroll event (s25/s50/s75/s90) as');
console.log('      well as a view. Stated before the number, and it undercounts on purpose.');
console.log('');
console.log(`  identified HUMAN arrivals : ${verdict.human}`);
console.log(`  machine visitors          : ${verdict.machine}`);
console.log(`  events with NO visitor id : ${verdict.unattributable}  (cannot be grouped into` +
  ' people at all, so they are neither, and never folded into either)');
console.log('');
console.log('  by page (distinct visitors):');
for (const [k, v] of [...perPage].sort((a, b) => b[1].human - a[1].human)) {
  console.log(`    ${String(k).padEnd(14)} human ${String(v.human).padStart(5)}   machine ${String(v.machine).padStart(6)}`);
}
console.log('');
console.log('  by source (distinct visitors):');
for (const [k, v] of [...perSource].sort((a, b) => b[1].human - a[1].human)) {
  console.log(`    ${String(k).padEnd(14)} human ${String(v.human).padStart(5)}   machine ${String(v.machine).padStart(6)}`);
}
console.log('');
console.log('⛔ This covers the "page-events" store only, which starts 2026-08-03. Anything');
console.log('   earlier is in the "analytics" store as counters with no visitor id and can');
console.log('   only ever be a pageview count, never an arrival count.');
