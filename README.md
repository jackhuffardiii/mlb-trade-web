# The Trade Web

An interactive graph of every Major League Baseball trade since 2015 — 2,393 transactions and
5,667 assets, indexed and cross-linked so you can follow a deal past the day it was made.

Three linked views over one dataset:

1. **Trade Web** — a force-directed graph of the 30 clubs. Edge weight is the number of trades
   between a pair inside the active filters. Tap a line for that pairing's ledger, tap a club for
   its own. Tapping through to a club's **player web** replaces the league graph with that club's
   incoming and outgoing players as headshot nodes.
2. **Chain Explorer** — "what did he become." Pick a player and a trade; the graph follows the
   return package forward: who came back, who each of them later became, and where the thread goes
   cold. An "acquired via" breadcrumb sits above the root, and truncated branches can be expanded
   another four hops at a time.
3. **Team Flows** — one club's ledger inside the filters: acquired on the left, sent away on the
   right, grouped by trade, over a summary strip (trades, players in, players out, top partner).

A season-range filter and a club filter apply across all three views, and the search box
(`/` to focus) deep-links a player into the Chain Explorer or a club into Team Flows.

## Screenshot

<!-- TODO: replace with a capture of the league web and a club's player web -->
![The Trade Web](docs/screenshot.png)

## Data

Everything comes from MLB's public [Stats API](https://statsapi.mlb.com/) `transactions` endpoint,
filtered to trade-type transactions from 2015-01-01 forward and normalized into one file:

```
public/data/trades.json      # ~1.5 MB, committed so the app is a pure static deploy
```

Each trade carries its id, date, the API's description, the club ids involved, and one row per
asset moved (`player`, `cash`, `ptbnl`, `other`), with `fromTeamId` / `toTeamId`. The app builds
its indexes — player → trades, club → trades, club-pair → trades — in the browser at load.

To refresh:

```bash
node scripts/fetch-trades.mjs
```

## Chain algorithm

Forward chain for a player *P* leaving club *A* in trade *T*:

- *A*'s **return package** is every asset in *T* with `toTeamId === A`.
- For each returned player *Q*, the **next hop** is the earliest trade strictly after `T.date` in
  which *Q* appears; the same rule then applies to *Q*'s outgoing row in that trade.
- Cash, players to be named later, and other considerations are leaves.
- Cycles are guarded by a visited set of `(personId, tradeId)`; depth defaults to four hops with a
  per-branch expand affordance.

The logic lives in `src/chain.js` and `src/data.js`, both DOM-free so they can be tested directly:

```bash
node scripts/test-chains.mjs
```

## Develop

```bash
npm install
npm run dev        # vite dev server on :5173
npm run build      # static build to dist/
npm run preview    # serve dist/ on :4173
```

Vanilla ES modules, no framework. `d3` is the only runtime dependency (force layout, zoom, drag,
scales). Deploys to Vercel as a static site with no configuration — `dist/` is the output and
`public/data/trades.json` is served as a static asset.

## Network and assets

The app makes exactly two kinds of requests: its own bundle and `data/trades.json` from its own
origin, and player headshots from `https://midfield.mlbstatic.com/v1/people/{personId}/spots/120`.
Headshots are created only for nodes actually rendered (and lazily for list chips), so opening a
club's player web fetches ~150 images rather than the 4,432 players in the dataset. Ids without a
portrait return MLB's generic silhouette, and a failed image falls back to an initialed disc.

There are no font, icon, or logo CDNs. Type is a system serif/mono pairing, and clubs are
identified by a hardcoded color and abbreviation (`src/teams.js`) rather than logo images.

## Disclaimer

Data is sourced from MLB's public Stats API. This project is not affiliated with, endorsed by, or
connected to Major League Baseball or any MLB club. Club names, abbreviations and colors are used
descriptively to identify the transactions in the data.

Built by Jack Huffard — [github.com/jackhuffardiii](https://github.com/jackhuffardiii)
