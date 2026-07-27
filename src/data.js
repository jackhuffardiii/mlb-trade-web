// Data loading + indexing. Deliberately DOM-free so scripts/test-chains.mjs can
// import buildIndex() under plain node.

export const KIND_LABEL = {
  player: 'player',
  cash: 'cash',
  ptbnl: 'PTBNL',
  other: 'considerations',
};

export function pairKey(a, b) {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function push(map, key, value) {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

/**
 * @param {object} raw parsed public/data/trades.json
 * @returns index used by every view and by the chain algorithm
 */
export function buildIndex(raw) {
  const teams = raw.teams.slice().sort((a, b) => a.name.localeCompare(b.name));
  const teamsById = new Map(raw.teams.map((t) => [t.id, t]));

  // Trades arrive date-ascending; re-sort defensively (stable tiebreak on id) so
  // every downstream "earliest after" / "latest before" lookup is trustworthy.
  const trades = raw.trades
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));

  const tradesById = new Map();
  const playerIndex = new Map(); // personId -> {personId, name, trades:[tradeId] (date asc)}
  const pairMatrix = new Map(); // "a-b" -> [tradeId]
  const teamTrades = new Map(); // teamId -> [tradeId] (date asc)

  for (const trade of trades) {
    tradesById.set(trade.id, trade);

    const seenPeople = new Set();
    const pairs = new Set();

    for (const asset of trade.assets) {
      if (asset.kind === 'player' && asset.personId != null) {
        let p = playerIndex.get(asset.personId);
        if (!p) {
          p = { personId: asset.personId, name: asset.name, trades: [] };
          playerIndex.set(asset.personId, p);
        }
        if (!p.name && asset.name) p.name = asset.name;
        if (!seenPeople.has(asset.personId)) {
          seenPeople.add(asset.personId);
          p.trades.push(trade.id);
        }
      }
      // A pair is credited only when assets actually moved between those two
      // clubs -- this is what keeps 3+ team trades honest.
      if (asset.fromTeamId != null && asset.toTeamId != null && asset.fromTeamId !== asset.toTeamId) {
        pairs.add(pairKey(asset.fromTeamId, asset.toTeamId));
      }
    }

    for (const key of pairs) push(pairMatrix, key, trade.id);
    for (const teamId of trade.teamIds) push(teamTrades, teamId, trade.id);
  }

  const years = trades.map((t) => Number(t.date.slice(0, 4)));
  const index = {
    generated: raw.generated,
    range: raw.range,
    teams,
    teamsById,
    trades,
    tradesById,
    playerIndex,
    pairMatrix,
    teamTrades,
    minYear: Math.min(...years),
    maxYear: Math.max(...years),
    assetCount: trades.reduce((n, t) => n + t.assets.length, 0),
  };
  return index;
}

export async function loadData(url = 'data/trades.json') {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  return buildIndex(await res.json());
}

/* ------------------------------------------------------------------ helpers */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2023-12-07" -> "Dec 7, 2023". String math on purpose: no timezone drift. */
export function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
}

export function formatDateLong(iso) {
  const LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  const [y, m, d] = iso.split('-');
  return `${LONG[Number(m) - 1]} ${Number(d)}, ${y}`;
}

export function tradeYear(trade) {
  return Number(trade.date.slice(0, 4));
}

export function assetLabel(asset) {
  if (asset.kind === 'player') return asset.name || 'Unnamed player';
  return KIND_LABEL[asset.kind] || asset.kind;
}
