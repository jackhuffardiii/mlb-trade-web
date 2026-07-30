# The Trade Web

An interactive graph of every Major League Baseball trade since 2015 — 2,393 transactions and
5,667 assets, indexed and cross-linked so you can follow a deal past the day it was made.

Three linked views over one dataset:

1. **Trade Web** — a force-directed graph of the 30 clubs. Edge weight is the number of trades
   between a pair inside the active filters. Tap a line for that pairing's ledger, tap a club for
   its own. Tapping through to a club's **player web** replaces the league graph with that club's
   incoming and outgoing players as headshot nodes.
2. **Chain Explorer** — two views of a player, switched by a toggle:
   - *This trade* — "what did he become." The graph follows the return package forward: who came
     back, who each of them later became, and where the thread goes cold. An "acquired via"
     breadcrumb sits above the root, and truncated branches expand another four hops at a time.
   - *All trades* — the whole career as a left-to-right flow chart. The player is the spine, a
     glowing line segmented and labelled by the club he was on during each span; every trade is a
     stop, with what moved alongside him stacked above and what came back stacked below. Spacing is
     ordinal, not to scale, and a dashed segment marks a club change the trade data doesn't explain
     (free agency, waivers). The career view ignores the season and club filters by design.
3. **Team Flows** — one club's ledger inside the filters: acquired on the left, sent away on the
   right, grouped by trade, over a summary strip (trades, players in, players out, top partner).
   The club title is itself the selector — click it for a keyboard-navigable list of all 30 clubs.

A season-range filter and a club filter apply across the league views, and the search box
(`/` to focus) deep-links a player into the Chain Explorer or a club into Team Flows.

The ‹ › controls in the masthead walk your in-app navigation history (Alt+← / Alt+→). Every
destination is a stack entry — the view you're on, the club whose ledger or player web is open, the
player and mode in the Chain Explorer — so going back restores what you were looking at, not just
which tab was lit. Navigating somewhere new after going back truncates the forward stack, as you'd
expect. Season-range scrubbing is deliberately not recorded: a filter isn't a destination.

The layout is desktop-first: the graph is a full-bleed workspace, the controls sit in a compact top
bar, and the detail panel docks as a right-hand sidebar the workspace makes room for. Below 900px
it degrades — the panel becomes a bottom sheet and the ledger stacks — but the browser is the
intended home.

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

### Automated refresh

A scheduled GitHub Actions workflow (`.github/workflows/refresh-trades.yml`) runs
`scripts/fetch-trades.mjs` daily at 11:00 UTC (~7am ET, so it picks up the previous day's
transactions) and diffs the result against the committed dataset with `scripts/diff-trades.mjs`.
A commit lands on `main` only when trades were actually added, removed, or modified — the
`generated` timestamp and `range.end` don't count, so no-op days push nothing and trigger no
redeploy. If Vercel is connected to this repo, a real commit triggers a normal redeploy same as
any other push to `main`.

Trigger a run manually from the repo's **Actions** tab: select "Refresh trade data" →
**Run workflow**.

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
