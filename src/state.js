// Shared global state: which view is showing, the season range, the club filter,
// and whatever the Chain Explorer is currently rooted on. Views subscribe to the
// keys they care about and re-render when those change.

const listeners = new Set();

export const state = {
  view: 'web', // 'web' | 'chain' | 'flows'
  yearMin: 2015,
  yearMax: 2026,
  team: null, // teamId or null for "all clubs"
  chain: null, // {personId, tradeId}
  chainMode: 'trade', // 'trade' = this deal's forward chain | 'career' = every trade, chronological
  flowsTeam: null, // teamId shown in the ledger view
  webMode: 'league', // 'league' | 'team' (the per-club player web)
  webTeam: null, // teamId whose player web is open
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Patch state and notify. `changed` is the set of keys that actually moved. */
export function setState(patch) {
  const changed = new Set();
  for (const [key, value] of Object.entries(patch)) {
    if (state[key] !== value) {
      state[key] = value;
      changed.add(key);
    }
  }
  if (!changed.size) return changed;
  for (const fn of listeners) fn(changed, state);
  return changed;
}

/* --------------------------------------------------------------- selectors */

export function inYears(trade, s = state) {
  const year = Number(trade.date.slice(0, 4));
  return year >= s.yearMin && year <= s.yearMax;
}

export function inTeamFilter(trade, s = state) {
  return s.team == null || trade.teamIds.includes(s.team);
}

/** The active filter: season range AND club filter, intersected. */
export function passes(trade, s = state) {
  return inYears(trade, s) && inTeamFilter(trade, s);
}

export function filteredTrades(index, s = state) {
  return index.trades.filter((t) => passes(t, s));
}
