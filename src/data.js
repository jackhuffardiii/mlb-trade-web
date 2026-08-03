// Data loading + indexing. Deliberately DOM-free so scripts/test-chains.mjs can
// import buildIndex() under plain node.

export const KIND_LABEL = {
  player: 'player',
  cash: 'cash',
  ptbnl: 'PTBNL',
  other: 'considerations',
};

/** The glyph standing in for a non-player asset on a graph node or a pill. */
export const KIND_GLYPH = { cash: '$', ptbnl: 'PT', other: '≈' };

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
  // 'no-cache' means revalidate, not refetch. The dataset is rewritten daily by
  // the refresh workflow, so a returning visitor must not be served a stale copy
  // -- which is exactly what 'force-cache' did: it uses a stored response without
  // revalidating, overriding the server's own max-age=0, must-revalidate. The
  // conditional request costs one round trip and returns 304 with no body when
  // the data hasn't moved.
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  return buildIndex(await res.json());
}

/**
 * Season stat lines, fetched once on first use and shared thereafter. This file
 * is ~590 KB over the wire, several times trades.json, so it is deliberately NOT
 * part of the boot path -- only a panel that actually shows a player pays for it.
 * 'no-cache' for the same reason as loadData: it is rewritten by the refresh job.
 */
let playersPromise = null;

export function loadPlayers(url = 'data/players.json') {
  playersPromise ??= fetch(url, { cache: 'no-cache' })
    .then((res) => {
      if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
      return res.json();
    })
    .then((raw) => raw.players || {})
    .catch((err) => {
      playersPromise = null; // let a later panel retry rather than fail forever
      throw err;
    });
  return playersPromise;
}

/** Savant percentile rankings, same lazy contract as loadPlayers(). */
let savantPromise = null;

export function loadSavant(url = 'data/savant.json') {
  savantPromise ??= fetch(url, { cache: 'no-cache' })
    .then((res) => {
      if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
      return res.json();
    })
    .catch((err) => {
      savantPromise = null;
      throw err;
    });
  return savantPromise;
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

export function assetLabel(asset) {
  if (asset.kind === 'player') return asset.name || 'Unnamed player';
  return KIND_LABEL[asset.kind] || asset.kind;
}
