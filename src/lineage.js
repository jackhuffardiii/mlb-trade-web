// Club trade trees ("asset lineage"). Pure functions over the index from
// data.js -- no DOM and no d3, so scripts/test-lineage.mjs can exercise the
// whole algorithm under plain node.
//
// The question this answers is not "where did this player end up" (that is the
// Chain Explorer) but "what did this club turn this asset into, and what did it
// give up to get him in the first place". Everything here is scoped to one club:
//
//   * a trade is a hyperedge -- inputs are the assets that LEFT the club,
//     outputs are the assets that ARRIVED, regardless of how many counterparties
//     the transaction had;
//   * a player is the thread between two hyperedges: he arrives in trade E and
//     later leaves in trade E', so E -> E' is a "span" link;
//   * a connected run of spans is one lineage. Because ancestry is traced all
//     the way back, several headline deals usually collapse into a single saga,
//     which is exactly what the grid is supposed to show.

import { formatDate } from './data.js';
import { tradeSentence } from './chain.js';

/** Dataset sort order: date, then id. Every "earliest after" lookup uses it. */
export function compareTrades(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.id - b.id;
}

/* ------------------------------------------------------------------ scoring */

/**
 * Composite rank: `size + DEPTH_WEIGHT * (depth - 1)`.
 *
 * `size` counts asset occurrences on this club's side of the lineage and
 * `depth` counts generations, so the two are on different scales: the median
 * club trade only touches ~1.2 assets per side, while a generation costs a
 * whole extra hop through the roster. DEPTH_WEIGHT = 4 prices one extra
 * generation at roughly four assets -- about three trades' worth of volume --
 * so a long thin lineage (acquire, flip, flip, flip) can out-rank a single fat
 * eight-player swap, but a genuinely enormous deal is not buried by a chain of
 * one-for-ones. Both inputs matter and neither dominates.
 */
export const DEPTH_WEIGHT = 4;

export function compositeScore(stats) {
  return stats.size + DEPTH_WEIGHT * (stats.depth - 1);
}

/**
 * Order components for display. Every comparator falls through to the same
 * deterministic tiebreak chain (size, depth, trade count, earliest date, key)
 * so the ranking is stable across rebuilds.
 */
export function sortLineages(components, mode = 'composite') {
  const primary =
    mode === 'size'
      ? (c) => c.stats.size
      : mode === 'depth'
        ? (c) => c.stats.depth
        : (c) => c.score;

  return components.slice().sort((a, b) => {
    const pa = primary(a);
    const pb = primary(b);
    if (pa !== pb) return pb - pa;
    if (a.stats.size !== b.stats.size) return b.stats.size - a.stats.size;
    if (a.stats.depth !== b.stats.depth) return b.stats.depth - a.stats.depth;
    if (a.stats.trades !== b.stats.trades) return b.stats.trades - a.stats.trades;
    if (a.stats.firstDate !== b.stats.firstDate) return a.stats.firstDate < b.stats.firstDate ? -1 : 1;
    return Number(a.key) - Number(b.key);
  });
}

/* -------------------------------------------------------------- club assets */

/**
 * Every asset row on this club's side of one trade, split by direction.
 * A 3+ club trade is flattened: anything leaving the club is an input and
 * anything arriving is an output, whoever the counterparty happened to be.
 */
function clubAssets(trade, teamId) {
  const out = [];
  const into = [];
  for (const asset of trade.assets) {
    const arriving = asset.toTeamId === teamId;
    const leaving = asset.fromTeamId === teamId;
    // A row that both leaves and arrives at the same club is a data artefact,
    // not a move; ignoring it keeps the spans honest.
    if (arriving === leaving) continue;
    const target = arriving ? into : out;
    target.push({
      id: `${trade.id}:${arriving ? 'in' : 'out'}:${target.length}`,
      tradeId: trade.id,
      date: trade.date,
      direction: arriving ? 'in' : 'out',
      personId: asset.kind === 'player' ? asset.personId : null,
      name: asset.name || null,
      kind: asset.kind,
      counterpartyTeamId: arriving ? asset.fromTeamId : asset.toTeamId,
      spanId: null,
      open: true,
      openKind: null,
    });
  }
  return { in: into, out };
}

/* -------------------------------------------------------------------- spans */

/**
 * Pair each arrival of a player with the departure that ended that stint.
 *
 * Walking both lists in lockstep and consuming each departure once is what
 * makes a re-acquisition produce two independent spans (first in -> first out,
 * second in -> second out) instead of cross-linking the first arrival to the
 * last departure. A departure with no earlier arrival is where the data runs
 * out -- drafted, signed, or acquired before 2015.
 */
function pairSpans(ins, outs) {
  const pairs = [];
  let j = 0;
  for (const arrival of ins) {
    while (j < outs.length && compareTrades(outs[j], arrival) <= 0) j++;
    if (j >= outs.length) break;
    pairs.push([arrival, outs[j]]);
    j++;
  }
  return pairs;
}

/* --------------------------------------------------------------- components */

function findRoot(parent, x) {
  let r = x;
  while (parent.get(r) !== r) r = parent.get(r);
  return r;
}

/**
 * Longest-path generation for every trade in one component.
 *
 * Spans always point forward in time (asserted where links are built, below),
 * and `tradeIds` arrives sorted by `compareTrades` -- the same order the spans
 * move in -- so that order IS a topological order. One forward pass relaxing
 * `gen[to] = max(gen[to], gen[from] + 1)` is enough; no cycle can occur.
 */
function assignGenerations(tradeIds, links) {
  const outgoing = new Map(tradeIds.map((id) => [id, []]));
  for (const link of links) outgoing.get(link.fromTradeId).push(link.toTradeId);

  const gen = new Map(tradeIds.map((id) => [id, 0]));
  for (const id of tradeIds) {
    for (const next of outgoing.get(id)) gen.set(next, Math.max(gen.get(next), gen.get(id) + 1));
  }
  return gen;
}

/* ------------------------------------------------------------------ marquee */

/**
 * The 1-3 assets worth putting a face and a caption on.
 *
 * Structural, not editorial: a player scores for being the thread between two
 * trades (spanWeight), for showing up more than once (occurrences), and for
 * being on one side of a lopsided package (reach = the biggest return that ever
 * came back the other way in a trade he was part of). That last term is what
 * surfaces a headliner who was homegrown and therefore has no span at all.
 */
const SPAN_WEIGHT = 2.2;
const REACH_WEIGHT = 0.9;

function pickMarquee(assets, links, tradeAssets) {
  const byPerson = new Map();
  const rowFor = (personId, name) => {
    let row = byPerson.get(personId);
    if (!row) byPerson.set(personId, (row = { personId, name, spans: 0, occurrences: 0, reach: 0 }));
    else if (!row.name && name) row.name = name;
    return row;
  };

  for (const asset of assets) {
    if (asset.kind !== 'player' || asset.personId == null) continue;
    const sides = tradeAssets.get(asset.tradeId);
    const opposite = asset.direction === 'in' ? sides.out.length : sides.in.length;
    const row = rowFor(asset.personId, asset.name);
    row.occurrences += 1;
    row.reach = Math.max(row.reach, opposite);
  }
  for (const link of links) {
    if (link.personId == null) continue;
    rowFor(link.personId, link.name).spans += 1;
  }

  return [...byPerson.values()]
    .map((row) => ({
      personId: row.personId,
      name: row.name,
      score: SPAN_WEIGHT * row.spans + row.occurrences + REACH_WEIGHT * row.reach,
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 3);
}

/* -------------------------------------------------------------------- build */

/**
 * Every lineage for one club, ranked.
 *
 * @param {object} index the index from buildIndex()
 * @param {number} teamId
 * @param {{sort?: string}} [options]
 * @returns {Array} components, each:
 *   {key, teamId, trades[], assets[], links[], stats, marquee[], score}
 */
export function buildLineages(index, teamId, { sort = 'composite' } = {}) {
  const trades = (index.teamTrades.get(teamId) || [])
    .map((id) => index.tradesById.get(id))
    .filter(Boolean)
    .sort(compareTrades);

  if (!trades.length) return [];

  /* 1. this club's side of every trade it touched */
  const tradeAssets = new Map(); // tradeId -> {in:[], out:[]}
  const assetById = new Map();
  for (const trade of trades) {
    const sides = clubAssets(trade, teamId);
    tradeAssets.set(trade.id, sides);
    for (const row of [...sides.out, ...sides.in]) assetById.set(row.id, row);
  }

  /* 2. arrivals and departures per player, in dataset order */
  const arrivals = new Map(); // personId -> [{...assetRow, date, id}]
  const departures = new Map();
  for (const trade of trades) {
    const sides = tradeAssets.get(trade.id);
    for (const row of sides.in) {
      if (row.personId == null) continue;
      const list = arrivals.get(row.personId) || [];
      list.push(row);
      arrivals.set(row.personId, list);
    }
    for (const row of sides.out) {
      if (row.personId == null) continue;
      const list = departures.get(row.personId) || [];
      list.push(row);
      departures.set(row.personId, list);
    }
  }

  /* 3. spans */
  const links = [];
  for (const [personId, ins] of arrivals) {
    const outs = departures.get(personId);
    if (!outs || !outs.length) continue;
    for (const [arrival, departure] of pairSpans(ins, outs)) {
      const link = {
        id: `${arrival.id}->${departure.id}`,
        personId,
        name: arrival.name || departure.name || 'Unknown player',
        fromTradeId: arrival.tradeId,
        toTradeId: departure.tradeId,
        fromDate: arrival.date,
        toDate: departure.date,
        inAssetId: arrival.id,
        outAssetId: departure.id,
      };
      if (compareTrades(arrival, departure) >= 0) {
        throw new Error(`lineage: span ${link.id} does not move forward in time`);
      }
      arrival.spanId = link.id;
      arrival.open = false;
      departure.spanId = link.id;
      departure.open = false;
      links.push(link);
    }
  }

  // Whatever is still open is a genuine end of the thread. The dataset holds
  // trades only, so a player never traded again is "not traded since" -- he may
  // well have left in free agency, which this data cannot see.
  for (const row of assetById.values()) {
    if (!row.open) continue;
    if (row.kind !== 'player' || row.personId == null) row.openKind = 'non-player';
    else row.openKind = row.direction === 'in' ? 'not-traded-since' : 'no-earlier-trade';
  }

  /* 4. connected components over spans, undirected */
  const parent = new Map(trades.map((t) => [t.id, t.id]));
  for (const link of links) {
    const a = findRoot(parent, link.fromTradeId);
    const b = findRoot(parent, link.toTradeId);
    if (a !== b) parent.set(a, b);
  }

  const groups = new Map(); // rootId -> [trade]
  for (const trade of trades) {
    const root = findRoot(parent, trade.id);
    const list = groups.get(root) || [];
    list.push(trade);
    groups.set(root, list);
  }

  const linksByRoot = new Map();
  for (const link of links) {
    const root = findRoot(parent, link.fromTradeId);
    const list = linksByRoot.get(root) || [];
    list.push(link);
    linksByRoot.set(root, list);
  }

  /* 5. shape each component */
  const components = [];
  for (const [root, groupTrades] of groups) {
    groupTrades.sort(compareTrades);
    const groupLinks = linksByRoot.get(root) || [];
    const tradeIds = groupTrades.map((t) => t.id);
    const gen = assignGenerations(tradeIds, groupLinks);

    const assets = [];
    const tradeRows = groupTrades.map((trade) => {
      const sides = tradeAssets.get(trade.id);
      assets.push(...sides.out, ...sides.in);
      const counterparties = trade.teamIds.filter((id) => id !== teamId);
      return {
        id: trade.id,
        date: trade.date,
        year: Number(trade.date.slice(0, 4)),
        generation: gen.get(trade.id),
        counterparties,
        // The club that exchanged the most with us -- the one worth labelling
        // when a three-way deal only has room for a single chip.
        primaryCounterparty: primaryCounterparty(sides, counterparties),
        description: tradeSentence(index, trade),
        reconstructed: !(trade.description && trade.description.trim()),
        inAssetIds: sides.in.map((r) => r.id),
        outAssetIds: sides.out.map((r) => r.id),
      };
    });

    const depth = tradeRows.reduce((n, t) => Math.max(n, t.generation), 0) + 1;
    const stats = {
      // One entry per asset row on this club's side: a player who arrives and is
      // later flipped counts as two occurrences, which is the point.
      size: assets.length,
      depth,
      trades: tradeRows.length,
      players: new Set(assets.filter((a) => a.personId != null).map((a) => a.personId)).size,
      firstDate: groupTrades[0].date,
      lastDate: groupTrades[groupTrades.length - 1].date,
      yearMin: Number(groupTrades[0].date.slice(0, 4)),
      yearMax: Number(groupTrades[groupTrades.length - 1].date.slice(0, 4)),
      counterparties: new Set(tradeRows.flatMap((t) => t.counterparties)).size,
    };

    components.push({
      // Stable across rebuilds and filter changes: the lowest trade id in the
      // component. History records this, so it has to survive a re-render.
      key: String(Math.min(...tradeIds)),
      teamId,
      trades: tradeRows,
      assets,
      links: groupLinks,
      stats,
      score: compositeScore(stats),
      marquee: pickMarquee(assets, groupLinks, tradeAssets),
    });
  }

  return sortLineages(components, sort);
}

function primaryCounterparty(sides, counterparties) {
  if (counterparties.length <= 1) return counterparties[0] ?? null;
  const tally = new Map();
  for (const row of [...sides.in, ...sides.out]) {
    if (row.counterpartyTeamId == null) continue;
    tally.set(row.counterpartyTeamId, (tally.get(row.counterpartyTeamId) || 0) + 1);
  }
  return counterparties.reduce((best, id) => ((tally.get(id) || 0) > (tally.get(best) || 0) ? id : best));
}

/* ----------------------------------------------------------------- helpers */

/** The component holding a given trade, or null. */
export function lineageForTrade(components, tradeId) {
  return components.find((c) => c.trades.some((t) => t.id === tradeId)) || null;
}

/** Human copy for an asset whose thread ends here. Kept honest on purpose. */
export function openNote(asset) {
  if (asset.openKind === 'not-traded-since') return `Not traded since ${formatDate(asset.date)}`;
  if (asset.openKind === 'no-earlier-trade') return 'No earlier trade on record';
  return null;
}
