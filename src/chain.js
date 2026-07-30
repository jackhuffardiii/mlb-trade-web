// The chain algorithm. Pure functions over the index from data.js -- no DOM, so
// scripts/test-chains.mjs can exercise it directly under node.
//
// Forward chain ("what did he become"): a player P leaves team A in trade T.
// A's return package is every asset in T with toTeamId === A. Each returned
// player Q is then followed to the earliest trade strictly after T.date in which
// Q appears, and the same rule is applied to Q's outgoing row there. Cash, PTBNLs
// and other considerations are leaves.

import { assetLabel, KIND_LABEL } from './data.js';

export const DEFAULT_DEPTH = 4;

/** Every asset the given team received in this trade. */
export function returnPackage(trade, teamId) {
  return trade.assets.filter((a) => a.toTeamId === teamId);
}

/**
 * The row describing this person moving *out* of a club in this trade.
 * Prefers the row leaving `preferFrom` when the player somehow appears twice.
 */
export function outgoingRow(trade, personId, preferFrom) {
  const rows = trade.assets.filter((a) => a.personId === personId);
  if (!rows.length) return null;
  if (preferFrom != null) {
    const exact = rows.find((a) => a.fromTeamId === preferFrom);
    if (exact) return exact;
  }
  return rows[0];
}

/** Earliest trade strictly after `afterDate` containing this player. */
export function nextTradeFor(index, personId, afterDate) {
  const player = index.playerIndex.get(personId);
  if (!player) return null;
  for (const tradeId of player.trades) {
    const trade = index.tradesById.get(tradeId);
    if (trade && trade.date > afterDate) return trade;
  }
  return null;
}

/**
 * "Acquired via": the latest trade before `beforeDate` in which this player
 * arrived at `teamId`. May not exist (drafted, signed, called up).
 */
export function previousAcquisition(index, personId, teamId, beforeDate) {
  const player = index.playerIndex.get(personId);
  if (!player) return null;
  for (let i = player.trades.length - 1; i >= 0; i--) {
    const trade = index.tradesById.get(player.trades[i]);
    if (!trade || trade.date >= beforeDate) continue;
    const arrived = trade.assets.some((a) => a.personId === personId && a.toTeamId === teamId);
    if (arrived) return trade;
  }
  return null;
}

/**
 * A readable sentence for a trade, falling back to one derived from its assets
 * when the source description is empty (trade 714233 is the only such row today).
 */
export function tradeSentence(index, trade) {
  if (trade.description && trade.description.trim()) return trade.description.trim();
  const byTeam = new Map();
  for (const asset of trade.assets) {
    const list = byTeam.get(asset.fromTeamId) || [];
    list.push(assetLabel(asset));
    byTeam.set(asset.fromTeamId, list);
  }
  const clauses = [];
  for (const [fromId, items] of byTeam) {
    const from = index.teamsById.get(fromId);
    clauses.push(`${from ? from.name : `Team ${fromId}`} sent ${listOut(items)}`);
  }
  return clauses.length
    ? `${clauses.join('; ')}. (Description not published by the MLB Stats API; reconstructed from the transaction's assets.)`
    : 'No details published for this transaction.';
}

function listOut(items) {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function nodeKey(personId, tradeId, salt) {
  return `${personId ?? 'x'}:${tradeId}:${salt}`;
}

/**
 * Build the nodes for everything `teamId` received in `trade`, following each
 * returned player forward.
 *
 * @param {object} ctx {index, visited:Set, maxDepth}
 */
function packageNodes(ctx, trade, teamId, depth) {
  return returnPackage(trade, teamId).map((asset, i) => {
    const node = {
      id: nodeKey(asset.personId, trade.id, i),
      kind: asset.kind,
      personId: asset.personId,
      name: asset.name,
      label: assetLabel(asset),
      depth,
      // How this asset arrived.
      arrivalTradeId: trade.id,
      arrivalDate: trade.date,
      fromTeamId: asset.fromTeamId,
      toTeamId: asset.toTeamId,
      // How it was later moved on (filled below for players).
      pivot: null,
      children: [],
      expandable: false,
      terminal: null,
    };

    if (asset.kind !== 'player' || asset.personId == null) {
      node.terminal = 'non-player';
      return node;
    }

    const next = nextTradeFor(ctx.index, asset.personId, trade.date);
    if (!next) {
      node.terminal = 'held';
      return node;
    }

    const visitKey = `${asset.personId}:${next.id}`;
    if (ctx.visited.has(visitKey)) {
      node.terminal = 'cycle';
      return node;
    }

    const row = outgoingRow(next, asset.personId, teamId);
    if (!row || row.fromTeamId == null || row.fromTeamId === row.toTeamId) {
      node.terminal = 'held';
      return node;
    }

    node.pivot = {
      tradeId: next.id,
      date: next.date,
      fromTeamId: row.fromTeamId,
      toTeamId: row.toTeamId,
    };

    if (depth >= ctx.maxDepth) {
      node.expandable = true;
      return node;
    }

    ctx.visited.add(visitKey);
    node.children = packageNodes(ctx, next, row.fromTeamId, depth + 1);
    return node;
  });
}

/**
 * Root the forward chain on a player leaving a club in a specific trade.
 * @param {object} index
 * @param {{personId:number, tradeId:number, maxDepth?:number}} opts
 */
export function buildChain(index, { personId, tradeId, maxDepth = DEFAULT_DEPTH }) {
  const trade = index.tradesById.get(tradeId);
  if (!trade) return null;
  const row = outgoingRow(trade, personId);
  if (!row) return null;

  const player = index.playerIndex.get(personId);
  const visited = new Set([`${personId}:${trade.id}`]);
  const ctx = { index, visited, maxDepth };

  const root = {
    id: nodeKey(personId, trade.id, 'root'),
    root: true,
    kind: 'player',
    personId,
    name: row.name || (player && player.name) || 'Unknown player',
    label: row.name || (player && player.name) || 'Unknown player',
    depth: 0,
    arrivalTradeId: null,
    arrivalDate: null,
    fromTeamId: row.fromTeamId,
    toTeamId: row.toTeamId,
    pivot: {
      tradeId: trade.id,
      date: trade.date,
      fromTeamId: row.fromTeamId,
      toTeamId: row.toTeamId,
    },
    children: packageNodes(ctx, trade, row.fromTeamId, 1),
    expandable: false,
    terminal: null,
  };

  root.acquiredVia = previousAcquisition(index, personId, row.fromTeamId, trade.date);
  root.visited = visited;
  return root;
}

/**
 * Grow one truncated branch by `extraDepth` more hops, in place.
 * Returns true when the node actually gained children.
 */
export function expandNode(index, root, node, extraDepth = DEFAULT_DEPTH) {
  if (!node.expandable || !node.pivot) return false;
  const next = index.tradesById.get(node.pivot.tradeId);
  if (!next) return false;
  const visited = root.visited || new Set();
  visited.add(`${node.personId}:${next.id}`);
  const ctx = { index, visited, maxDepth: node.depth + extraDepth };
  node.children = packageNodes(ctx, next, node.pivot.fromTeamId, node.depth + 1);
  node.expandable = false;
  return true;
}

export { KIND_LABEL };
