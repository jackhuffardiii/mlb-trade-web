// Player-data checks for public/data/players.json.
//
//   node scripts/test-players.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const playersPath = join(here, '..', 'public', 'data', 'players.json');
const tradesPath = join(here, '..', 'public', 'data', 'trades.json');

const rawPlayers = readFileSync(playersPath, 'utf8');
const parsedPlayers = JSON.parse(rawPlayers);
const players = parsedPlayers.players || {};
const tradesData = JSON.parse(readFileSync(tradesPath, 'utf8'));

let failures = 0;

function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}

/* -- 1. Isaac Paredes teamless-total trap ---------------------------------- */

const PAREDES = '670623';
const paredes = players[PAREDES];
check('Isaac Paredes (670623) is present in players.json', !!paredes, paredes ? '' : 'MISSING — fetch 670623 first');

if (paredes) {
  const rows2024 = (paredes.hitting || []).filter((r) => r.season === 2024);
  check('Paredes has exactly two 2024 hitting rows', rows2024.length === 2, `got ${rows2024.length}`);

  const byTeam = new Map(rows2024.map((r) => [r.teamId, r]));
  check('Paredes 2024 team 139 row has pa 429', byTeam.get(139)?.pa === 429, `got ${byTeam.get(139)?.pa}`);
  check('Paredes 2024 team 112 row has pa 212', byTeam.get(112)?.pa === 212, `got ${byTeam.get(112)?.pa}`);
  check(
    'no teamless-total row (pa 641) present for Paredes 2024',
    !rows2024.some((r) => r.pa === 641),
    rows2024.map((r) => `${r.teamId}:${r.pa}`).join(', ')
  );
} else {
  check('Paredes 2024 team 139 row has pa 429', false, 'skipped — player missing');
  check('Paredes 2024 team 112 row has pa 212', false, 'skipped — player missing');
  check('no teamless-total row (pa 641) present for Paredes 2024', false, 'skipped — player missing');
}

/* -- 2. Every season >= 2015 ------------------------------------------------ */

let minSeasonSeen = Infinity;
for (const entry of Object.values(players)) {
  for (const row of [...(entry.hitting || []), ...(entry.pitching || [])]) {
    if (row.season < minSeasonSeen) minSeasonSeen = row.season;
  }
}
check('every season across all players is >= 2015', minSeasonSeen >= 2015, `min season seen = ${minSeasonSeen}`);

/* -- 3. Canonical ordering --------------------------------------------------- */

const keys = Object.keys(players);
let keysAscending = true;
for (let i = 1; i < keys.length; i++) {
  if (!(Number(keys[i - 1]) < Number(keys[i]))) {
    keysAscending = false;
    break;
  }
}
check('player ids are in ascending numeric order', keysAscending, `n=${keys.length}`);

let rowsSorted = true;
for (const entry of Object.values(players)) {
  for (const group of [entry.hitting, entry.pitching]) {
    if (!group) continue;
    for (let i = 1; i < group.length; i++) {
      const a = group[i - 1];
      const b = group[i];
      const ok = a.season < b.season || (a.season === b.season && a.teamId < b.teamId);
      if (!ok) {
        rowsSorted = false;
        break;
      }
    }
  }
}
check('hitting/pitching rows sorted by (season, teamId) ascending', rowsSorted);

/* -- 4. Idempotent serialization --------------------------------------------- */

const reserialized = JSON.stringify(parsedPlayers, null, 2);
check('re-serializing parsed file reproduces raw bytes exactly', reserialized === rawPlayers, `raw len=${rawPlayers.length}, reserialized len=${reserialized.length}`);

/* -- 5. Every player id exists in trades.json -------------------------------- */

const tradeIds = new Set();
for (const trade of tradesData.trades || []) {
  for (const asset of trade.assets || []) {
    if (asset.kind === 'player' && asset.personId != null) tradeIds.add(asset.personId);
  }
}
const allInTrades = keys.every((k) => tradeIds.has(Number(k)));
check('every player id in players.json exists in trades.json', allInTrades);

console.log(`\n${failures ? `${failures} FAILING` : 'ALL ASSERTIONS PASSED'}`);
process.exit(failures ? 1 : 0);
