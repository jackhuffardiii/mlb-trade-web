// Chain-algorithm checks. Runs under plain node: src/data.js and src/chain.js are
// deliberately DOM-free so the logic can be tested without a browser.
//
//   node scripts/test-chains.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildIndex } from '../src/data.js';
import { buildChain, nextTradeFor, outgoingRow, returnPackage, tradeSentence } from '../src/chain.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, '..', 'public', 'data', 'trades.json'), 'utf8'));
const index = buildIndex(raw);

let failures = 0;

function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}

/* -- 1. The Soto trade's return package ----------------------------------- */

const SOTO_TRADE = 734714;
const PADRES = 135;
const YANKEES = 147;
const WHITE_SOX = 145;
const SOTO = 665742;

const sotoTrade = index.tradesById.get(SOTO_TRADE);
check('trade 734714 is indexed', !!sotoTrade, sotoTrade ? sotoTrade.date : 'missing');

const sotoRow = outgoingRow(sotoTrade, SOTO);
check(
  'Juan Soto moves 135 -> 147 in trade 734714',
  sotoRow && sotoRow.fromTeamId === PADRES && sotoRow.toTeamId === YANKEES,
  sotoRow ? `${sotoRow.fromTeamId} -> ${sotoRow.toTeamId}` : 'no row'
);

const back = returnPackage(sotoTrade, PADRES);
const players = back.filter((a) => a.kind === 'player');
check('return package to SD has exactly 5 player assets', players.length === 5, `got ${players.length}`);

const EXPECTED = ['Michael King', 'Kyle Higashioka', 'Randy Vásquez', 'Jhony Brito', 'Drew Thorpe'];
const got = players.map((a) => a.name).sort();
check(
  'return package is King, Higashioka, Vásquez, Brito, Thorpe',
  JSON.stringify(got) === JSON.stringify([...EXPECTED].sort()),
  got.join(', ')
);

/* -- 2. Drew Thorpe's next hop -------------------------------------------- */

const THORPE = 689672;
const nextHop = nextTradeFor(index, THORPE, sotoTrade.date);
check('Drew Thorpe has a next hop after 2023-12-07', !!nextHop, nextHop ? nextHop.date : 'none');
check(
  "Thorpe's next trade is dated 2024-03-13",
  nextHop && nextHop.date === '2024-03-13',
  nextHop ? nextHop.date : 'none'
);

const thorpeRow = nextHop ? outgoingRow(nextHop, THORPE, PADRES) : null;
check(
  'Thorpe is dealt to team 145 (CWS) in that trade',
  thorpeRow && thorpeRow.toTeamId === WHITE_SOX,
  thorpeRow ? `to ${thorpeRow.toTeamId}` : 'no row'
);

/* -- 3. The chain builder wires those together ---------------------------- */

const chain = buildChain(index, { personId: SOTO, tradeId: SOTO_TRADE });
check('buildChain returns a root for Soto', !!chain, chain ? chain.name : 'null');
check(
  'root has 5 children (the return package)',
  chain && chain.children.length === 5,
  chain ? String(chain.children.length) : 'n/a'
);

const thorpeNode = chain && chain.children.find((c) => c.personId === THORPE);
check(
  'Thorpe node pivots to 2024-03-13 / team 145',
  thorpeNode && thorpeNode.pivot && thorpeNode.pivot.date === '2024-03-13' && thorpeNode.pivot.toTeamId === WHITE_SOX,
  thorpeNode && thorpeNode.pivot ? `${thorpeNode.pivot.date} -> ${thorpeNode.pivot.toTeamId}` : 'no pivot'
);

const thorpeReturn = thorpeNode ? thorpeNode.children.map((c) => c.label) : [];
check(
  'following Thorpe returns the Dylan Cease package',
  thorpeReturn.includes('Dylan Cease'),
  thorpeReturn.join(', ') || 'no children'
);

/* -- 4. The one trade with no published description ----------------------- */

const blank = index.tradesById.get(714233);
const sentence = blank ? tradeSentence(index, blank) : '';
check(
  'trade 714233 gets an asset-derived description',
  sentence.includes('José Castillo') && sentence.includes('reconstructed'),
  sentence.slice(0, 90)
);

/* -- 5. Cycle guard ------------------------------------------------------- */

let deepest = 0;
(function measure(node, depth) {
  deepest = Math.max(deepest, depth);
  for (const child of node.children || []) measure(child, depth + 1);
})(chain, 0);
check('default chain depth is capped at 4 hops', deepest <= 4, `deepest = ${deepest}`);

console.log(`\n${failures ? `${failures} FAILING` : 'ALL ASSERTIONS PASSED'}`);
process.exit(failures ? 1 : 0);
