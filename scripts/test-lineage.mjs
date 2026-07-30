// Club trade-tree checks. Runs under plain node: src/data.js, src/chain.js and
// src/lineage.js are deliberately DOM-free so the algorithm can be tested
// without a browser.
//
//   node scripts/test-lineage.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildIndex } from '../src/data.js';
import {
  buildLineages,
  compareTrades,
  compositeScore,
  lineageForTrade,
  sortLineages,
} from '../src/lineage.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, '..', 'public', 'data', 'trades.json'), 'utf8'));
const index = buildIndex(raw);

let failures = 0;

function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}

const abbr = (id) => index.teamsById.get(id)?.abbreviation || `#${id}`;

/* == a. span pairing on a genuine re-acquisition ========================== */

console.log('--- a. span pairing (acquired, flipped, re-acquired, flipped) ---');

/**
 * Exhaustive search: for every (club, player) pair, walk that player's moves in
 * dataset order and look for in / out / in / out. No hardcoded answer -- if the
 * dataset ever loses this case the search says so out loud.
 */
function findReacquisitions() {
  const seq = new Map(); // `${teamId}:${personId}` -> [{dir, id, date}]
  const push = (teamId, personId, row) => {
    const key = `${teamId}:${personId}`;
    const list = seq.get(key) || [];
    list.push(row);
    seq.set(key, list);
  };
  for (const trade of index.trades) {
    for (const asset of trade.assets) {
      if (asset.kind !== 'player' || asset.personId == null) continue;
      if (asset.toTeamId != null) {
        push(asset.toTeamId, asset.personId, { dir: 'in', id: trade.id, date: trade.date });
      }
      if (asset.fromTeamId != null) {
        push(asset.fromTeamId, asset.personId, { dir: 'out', id: trade.id, date: trade.date });
      }
    }
  }
  const found = [];
  for (const [key, rows] of seq) {
    rows.sort(compareTrades);
    const pattern = rows.map((r) => r.dir[0]).join('');
    if (!pattern.includes('ioio')) continue;
    const [teamId, personId] = key.split(':').map(Number);
    found.push({ teamId, personId, rows, pattern });
  }
  return found;
}

const reacquisitions = findReacquisitions();
check(
  'exhaustive search finds at least one re-acquisition case',
  reacquisitions.length > 0,
  `${reacquisitions.length} case(s) across all 30 clubs and ${index.playerIndex.size} players`
);

for (const found of reacquisitions) {
  const player = index.playerIndex.get(found.personId);
  const start = found.rows.findIndex((r, i) =>
    found.rows.slice(i, i + 4).map((x) => x.dir[0]).join('') === 'ioio'
  );
  const [in1, out1, in2, out2] = found.rows.slice(start, start + 4);
  const label = `${player.name} / ${abbr(found.teamId)}`;

  console.log(
    `      ${label}: in ${in1.date} (#${in1.id}) -> out ${out1.date} (#${out1.id}) ` +
      `-> in ${in2.date} (#${in2.id}) -> out ${out2.date} (#${out2.id})`
  );

  const components = buildLineages(index, found.teamId);
  const spans = components
    .flatMap((c) => c.links)
    .filter((l) => l.personId === found.personId)
    .sort((a, b) => (a.fromDate < b.fromDate ? -1 : 1));

  check(
    `${label}: exactly two independent spans`,
    spans.length === 2,
    spans.map((s) => `${s.fromTradeId}->${s.toTradeId}`).join(', ') || 'none'
  );
  check(
    `${label}: first span is first-in -> first-out`,
    spans[0] && spans[0].fromTradeId === in1.id && spans[0].toTradeId === out1.id,
    spans[0] ? `${spans[0].fromTradeId}->${spans[0].toTradeId}` : 'missing'
  );
  check(
    `${label}: second span is second-in -> second-out`,
    spans[1] && spans[1].fromTradeId === in2.id && spans[1].toTradeId === out2.id,
    spans[1] ? `${spans[1].fromTradeId}->${spans[1].toTradeId}` : 'missing'
  );
  check(
    `${label}: no cross-pairing (first-in never links to the later departure)`,
    !spans.some((s) => s.fromTradeId === in1.id && s.toTradeId === out2.id) &&
      !spans.some((s) => s.fromTradeId === in2.id && s.toTradeId === out1.id),
    'checked both cross combinations'
  );
}

/* == b. Washington's Juan Soto lineage ==================================== */

console.log('\n--- b. Washington Nationals (120) Juan Soto lineage ---');

const WSH = 120;
const SOTO_TRADE = 642337; // 2022-08-02, Soto + Bell to San Diego
const BELL_IN = 458975; // 2020-12-24, Bell acquired from Pittsburgh
const GORE_OUT = 882371; // 2026-01-22, Gore flipped to Texas

const wsh = buildLineages(index, WSH);
const sotoTree = lineageForTrade(wsh, SOTO_TRADE);
check('the 2022-08-02 Soto trade resolves to a component', !!sotoTree, sotoTree ? `key ${sotoTree.key}` : 'none');

const genOf = (tree, id) => tree?.trades.find((t) => t.id === id)?.generation;
const dateOf = (id) => index.tradesById.get(id)?.date;

for (const id of [BELL_IN, SOTO_TRADE, GORE_OUT]) {
  const row = sotoTree?.trades.find((t) => t.id === id);
  console.log(
    `      trade #${id}  ${dateOf(id)}  generation ${row ? row.generation : '-'}  ` +
      `vs ${(row?.counterparties || []).map(abbr).join('/') || '?'}`
  );
}

check(
  'component contains the Josh Bell acquisition from Pittsburgh (ancestry)',
  !!sotoTree && sotoTree.trades.some((t) => t.id === BELL_IN),
  `#${BELL_IN} ${dateOf(BELL_IN)}`
);
check(
  'component contains the MacKenzie Gore trade to Texas (descendant)',
  !!sotoTree && sotoTree.trades.some((t) => t.id === GORE_OUT),
  `#${GORE_OUT} ${dateOf(GORE_OUT)}`
);
check(
  'generations run ancestry -> Soto deal -> Gore deal',
  genOf(sotoTree, BELL_IN) === 0 &&
    genOf(sotoTree, SOTO_TRADE) === 1 &&
    genOf(sotoTree, GORE_OUT) === 2,
  `${genOf(sotoTree, BELL_IN)} / ${genOf(sotoTree, SOTO_TRADE)} / ${genOf(sotoTree, GORE_OUT)}`
);
check(
  'component depth is at least 3 generations',
  !!sotoTree && sotoTree.stats.depth >= 3,
  sotoTree ? `depth ${sotoTree.stats.depth}, ${sotoTree.stats.trades} trades, ${sotoTree.stats.size} assets` : 'n/a'
);
check(
  'the marquee names Soto, Bell and Gore',
  !!sotoTree &&
    ['Juan Soto', 'Josh Bell', 'MacKenzie Gore'].every((n) =>
      sotoTree.marquee.some((m) => m.name === n)
    ),
  sotoTree ? sotoTree.marquee.map((m) => m.name).join(', ') : 'n/a'
);
check(
  'leaf assets are labelled "not traded since", never "still on the roster"',
  !!sotoTree &&
    sotoTree.assets
      .filter((a) => a.open && a.direction === 'in' && a.kind === 'player')
      .every((a) => a.openKind === 'not-traded-since'),
  sotoTree
    ? `${sotoTree.assets.filter((a) => a.openKind === 'not-traded-since').length} open arrivals`
    : 'n/a'
);

/* == c. component dedup / completeness ==================================== */

console.log('\n--- c. component dedup and completeness (all 30 clubs) ---');

const DEDUP_SAMPLE = [120, 135, 139, 147, 111]; // WSH, SD, TB, NYY, BOS
let dedupFails = 0;

for (const team of index.teams) {
  const components = buildLineages(index, team.id);
  const seen = new Set();
  let duplicate = null;
  for (const c of components) {
    for (const t of c.trades) {
      if (seen.has(t.id)) duplicate = t.id;
      seen.add(t.id);
    }
  }
  const expected = new Set(index.teamTrades.get(team.id) || []);
  const missing = [...expected].filter((id) => !seen.has(id));
  const extra = [...seen].filter((id) => !expected.has(id));
  const ok = !duplicate && !missing.length && !extra.length;
  if (!ok) dedupFails++;
  if (DEDUP_SAMPLE.includes(team.id) || !ok) {
    check(
      `${team.abbreviation}: every trade in exactly one component`,
      ok,
      `${components.length} components, ${seen.size}/${expected.size} trades` +
        (duplicate ? `, DUPLICATE #${duplicate}` : '') +
        (missing.length ? `, MISSING ${missing.join(',')}` : '') +
        (extra.length ? `, EXTRA ${extra.join(',')}` : '')
    );
  }
}
check('all 30 clubs partition cleanly', dedupFails === 0, `${dedupFails} club(s) failed`);

/* == d. acyclicity ======================================================== */

console.log('\n--- d. acyclicity of every span graph ---');

let dagFails = 0;
let checkedComponents = 0;
let checkedLinks = 0;

for (const team of index.teams) {
  let components;
  try {
    // buildLineages runs Kahn's algorithm internally and throws on a cycle.
    components = buildLineages(index, team.id);
  } catch (error) {
    dagFails++;
    check(`${team.abbreviation}: span graph is a DAG`, false, error.message);
    continue;
  }
  for (const c of components) {
    checkedComponents++;
    for (const link of c.links) {
      checkedLinks++;
      const from = c.trades.find((t) => t.id === link.fromTradeId);
      const to = c.trades.find((t) => t.id === link.toTradeId);
      // Independent of Kahn: every span must strictly advance in (date, id).
      if (!from || !to || compareTrades(from, to) >= 0 || from.generation >= to.generation) {
        dagFails++;
        check(
          `${team.abbreviation}: span ${link.id} advances in time and generation`,
          false,
          `${from?.date}#${from?.id} g${from?.generation} -> ${to?.date}#${to?.id} g${to?.generation}`
        );
      }
    }
  }
}
check(
  'every component of every club is a DAG',
  dagFails === 0,
  `${checkedComponents} components, ${checkedLinks} span links, ${dagFails} violations`
);

/* == e. ranking sanity ==================================================== */

console.log('\n--- e. ranking sanity ---');

let orderFails = 0;
let stabilityFails = 0;

for (const team of index.teams) {
  const components = buildLineages(index, team.id);
  const primary = {
    composite: (c) => c.score,
    size: (c) => c.stats.size,
    depth: (c) => c.stats.depth,
  };
  for (const mode of ['composite', 'size', 'depth']) {
    const ranked = sortLineages(components, mode);
    for (let i = 1; i < ranked.length; i++) {
      if (primary[mode](ranked[i - 1]) < primary[mode](ranked[i])) orderFails++;
    }
    // Same input, same output -- the tiebreak chain is fully deterministic.
    const again = sortLineages(buildLineages(index, team.id), mode).map((c) => c.key);
    if (again.join() !== ranked.map((c) => c.key).join()) stabilityFails++;
  }
}
check('composite / size / depth sorts are monotonic in their key', orderFails === 0, `${orderFails} inversions`);
check('every sort is stable across rebuilds', stabilityFails === 0, `${stabilityFails} unstable orderings`);

// Hand count, straight off the raw JSON, for Washington's top component.
const topWsh = sortLineages(wsh, 'composite')[0];
const handIds = topWsh.trades.map((t) => t.id);
let handAssets = 0;
for (const trade of raw.trades) {
  if (!handIds.includes(trade.id)) continue;
  for (const asset of trade.assets) {
    const arriving = asset.toTeamId === WSH;
    const leaving = asset.fromTeamId === WSH;
    if (arriving !== leaving) handAssets++;
  }
}
const handDepth = new Set(topWsh.trades.map((t) => t.generation)).size;
console.log(
  `      WSH top component key ${topWsh.key}: trades ${handIds.join(', ')} ` +
    `(${topWsh.marquee.map((m) => m.name).join(', ')})`
);
check(
  'WSH top component asset count matches a raw-JSON hand count',
  topWsh.stats.size === handAssets,
  `algorithm ${topWsh.stats.size}, hand count ${handAssets}`
);
check(
  'WSH top component depth equals its distinct generation count',
  topWsh.stats.depth === handDepth,
  `depth ${topWsh.stats.depth}, distinct generations ${handDepth}`
);
check(
  'WSH top component is the Soto lineage under all three sorts',
  ['composite', 'size', 'depth'].every((m) => sortLineages(wsh, m)[0].key === sotoTree.key),
  `key ${topWsh.key} vs Soto key ${sotoTree.key}`
);
check(
  'composite score matches the published formula',
  topWsh.score === compositeScore(topWsh.stats),
  `${topWsh.score} = ${topWsh.stats.size} + 4 * (${topWsh.stats.depth} - 1)`
);

console.log(`\n${failures ? `${failures} FAILING` : 'ALL ASSERTIONS PASSED'}`);
process.exit(failures ? 1 : 0);
