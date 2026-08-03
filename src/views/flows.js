// View III -- Team Flows.
//
// Two modes over one club:
//
//   Trees (default) -- the club's trade trees. A small-multiples grid of its
//   deepest, biggest asset lineages; click one and it opens full-canvas in the
//   same visual language as the Chain Explorer. A lineage reads left to right:
//   the oldest ancestry the data can see, then each trade event, then what the
//   club turned the return into next.
//
//   Ledger -- the original view: everything acquired on the left, everything
//   sent away on the right, grouped by trade, with a summary strip.

import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from 'd3';

import { formatDate, KIND_GLYPH, KIND_LABEL } from '../data.js';
import { tradeSentence } from '../chain.js';
import { buildLineages, openNote, sortLineages } from '../lineage.js';
import { legible, rgba, teamColor } from '../teams.js';
import {
  assetNode,
  attachDrag,
  clubNode,
  fitToNodes,
  headerInset,
  linkGroup,
  makeCanvas,
  playerNode,
  setFocus,
  setLinkPath,
} from '../graph.js';
import {
  assetPill,
  clear,
  clubChip,
  el,
  headshotURL,
  hideTip,
  jumpToChain,
  moveTip,
  openPanel,
  playerDossier,
  renderTradeList,
  showTip,
  svgEl,
} from '../ui.js';
import { inYears, setState, state } from '../state.js';

const GRID_LIMIT = 12;
const COLUMN = 150; // half a generation: trades sit on odd columns, assets on even
const ROW = 78;
const SORT_LABEL = { composite: 'Composite', size: 'Biggest', depth: 'Deepest' };

export function createFlowsView(host, index) {
  clear(host);

  // Document mode (grid + ledger) lives in the scroller; the expanded tree
  // takes the whole view over and turns the scroller off.
  const shell = el('div', { class: 'flows-shell' });
  host.append(shell);

  let canvas = null;
  let breadcrumb = null;
  let note = null;
  let sim = null;
  let nodes = [];
  let links = [];
  let renderedTeam = null;
  let openKey = null; // the component currently on the canvas

  const cache = { teamId: null, components: null };

  function lineages(teamId) {
    if (cache.teamId !== teamId) {
      cache.teamId = teamId;
      cache.components = buildLineages(index, teamId);
    }
    return cache.components;
  }

  /* ----------------------------------------------------------- club choice */

  // Resolved once and kept local. Writing the fallback back into state from
  // inside a render would either recurse through setState or (as it did) skip
  // the notify and leave history recording a club that isn't on screen.
  let busiestTeam = null;

  function pickDefaultTeam() {
    if (state.flowsTeam != null) return state.flowsTeam;
    if (state.team != null) return state.team;
    if (busiestTeam != null) return busiestTeam;
    let bestCount = -1;
    for (const [teamId, trades] of index.teamTrades) {
      if (trades.length > bestCount) {
        bestCount = trades.length;
        busiestTeam = teamId;
      }
    }
    return busiestTeam;
  }

  function choose(nextId) {
    // A pinned club filter follows the ledger; an unpinned one stays unpinned.
    setState({
      flowsTeam: nextId,
      team: state.team == null ? null : nextId,
      flowsTree: null,
    });
  }

  /* ------------------------------------------------------------ filtering */

  /**
   * Which lineages the current filters admit. The season range is a selector
   * over whole components -- a component qualifies if ANY of its trades falls
   * in the window -- never a truncation, because a half-shown lineage would
   * misstate what the club actually turned into what.
   */
  function visibleLineages(teamId) {
    const all = lineages(teamId);
    const pinned = state.team != null && state.team !== teamId ? state.team : null;
    return all.filter((c) => {
      const inWindow = c.trades.some((t) => inYears({ date: t.date }));
      if (!inWindow) return false;
      if (pinned == null) return true;
      return c.trades.some((t) => t.counterparties.includes(pinned));
    });
  }

  function filterActive(teamId) {
    return (
      state.yearMin !== index.minYear ||
      state.yearMax !== index.maxYear ||
      (state.team != null && state.team !== teamId)
    );
  }

  /* ---------------------------------------------------------------- update */

  function update() {
    const teamId = pickDefaultTeam();
    if (teamId == null) return;

    const trees = state.flowsMode !== 'ledger';
    const target =
      trees && state.flowsTree != null
        ? lineages(teamId).find((c) => c.key === state.flowsTree)
        : null;

    if (target) {
      renderTree(teamId, target);
      return;
    }

    closeCanvas();
    shell.style.display = '';
    if (renderedTeam !== teamId) host.scrollTop = 0;
    renderedTeam = teamId;
    if (trees) renderGrid(teamId);
    else renderLedger(teamId);
  }

  /* ------------------------------------------------------- shared chrome */

  function header(teamId, lit) {
    return el('header', { class: 'flows-head', style: { '--club-lit': lit } }, [
      titlePicker(teamId, lit),
      el('div', { class: 'flows-controls' }, [
        modeToggle(),
        el(
          'button',
          {
            class: 'ghost-btn',
            type: 'button',
            onClick: () => setState({ view: 'web', webMode: 'team', webTeam: teamId }),
          },
          ['Player web →']
        ),
        el(
          'button',
          {
            class: 'ghost-btn',
            type: 'button',
            onClick: () => setState({ team: state.team === teamId ? null : teamId }),
          },
          [state.team === teamId ? 'Clear club filter' : 'Pin as club filter']
        ),
      ]),
    ]);
  }

  /** Trees / Ledger. The ledger is the original view, kept whole behind this. */
  function modeToggle() {
    const wrap = el('div', { class: 'mode-toggle', role: 'group', 'aria-label': 'Club view' });
    for (const [key, label] of [
      ['trees', 'Trees'],
      ['ledger', 'Ledger'],
    ]) {
      wrap.append(
        el(
          'button',
          {
            class: 'mode-btn',
            type: 'button',
            'aria-pressed': String((state.flowsMode !== 'ledger' ? 'trees' : 'ledger') === key),
            onClick: () => setState({ flowsMode: key, flowsTree: null }),
          },
          [label]
        )
      );
    }
    return wrap;
  }

  function sortToggle() {
    const wrap = el('div', { class: 'mode-toggle', role: 'group', 'aria-label': 'Rank lineages by' });
    for (const key of ['composite', 'size', 'depth']) {
      wrap.append(
        el(
          'button',
          {
            class: 'mode-btn',
            type: 'button',
            'aria-pressed': String((state.flowsSort || 'composite') === key),
            title:
              key === 'composite'
                ? 'Assets and generations together'
                : key === 'size'
                  ? 'Most assets'
                  : 'Most generations',
            onClick: () => setState({ flowsSort: key }),
          },
          [SORT_LABEL[key]]
        )
      );
    }
    return wrap;
  }

  function stat(label, value, sub) {
    return el('div', { class: 'stat' }, [
      el('dt', {}, label),
      el('dd', {}, [String(value), sub ? el('small', {}, sub) : null]),
    ]);
  }

  /* ------------------------------------------------------------ trees grid */

  function renderGrid(teamId) {
    const lit = legible(teamColor(teamId));
    clear(shell);
    shell.style.setProperty('--club-lit', lit);

    const visible = sortLineages(visibleLineages(teamId), state.flowsSort || 'composite');
    const total = lineages(teamId).length;
    const shown = visible.slice(0, GRID_LIMIT);

    const deepest = visible.reduce((n, c) => Math.max(n, c.stats.depth), 0);
    const biggest = visible.reduce((n, c) => Math.max(n, c.stats.size), 0);
    const tradeCount = visible.reduce((n, c) => n + c.stats.trades, 0);

    const summary = el('dl', { class: 'summary' }, [
      stat('Lineages', visible.length, `${total} in all`),
      stat('Trades', tradeCount, `${state.yearMin}–${state.yearMax}`),
      stat('Deepest', deepest || '—', 'generations'),
      stat('Biggest', biggest || '—', 'assets'),
    ]);

    const lede = el('div', { class: 'trees-lede' }, [
      el('div', { class: 'trees-rank' }, [
        el('span', { class: 'trees-rank-label' }, 'Rank by'),
        sortToggle(),
      ]),
      el(
        'p',
        { class: 'trees-note' },
        filterActive(teamId)
          ? 'Filters choose which lineages appear; an opened tree always shows its complete ancestry and descent.'
          : 'Each card is one lineage: what the club gave up, what came back, and what the return was turned into next.'
      ),
    ]);

    const grid = el('div', { class: 'tree-grid' });
    if (!shown.length) {
      grid.append(el('p', { class: 'empty-note' }, 'No lineages in this window.'));
    } else {
      shown.forEach((component, i) => grid.append(treeCard(teamId, component, i)));
    }

    shell.append(header(teamId, lit), summary, lede, grid);
  }

  function treeCard(teamId, component, i) {
    const lit = legible(teamColor(teamId));
    const { stats } = component;
    const span = stats.yearMin === stats.yearMax ? `${stats.yearMin}` : `${stats.yearMin}–${stats.yearMax}`;

    const faces = el(
      'div',
      { class: 'tree-faces' },
      component.marquee
        .filter((m) => m.personId != null)
        .slice(0, 3)
        .map((m) =>
          el('img', {
            class: 'tree-face',
            src: headshotURL(m.personId),
            alt: '',
            loading: 'lazy',
            decoding: 'async',
            referrerpolicy: 'no-referrer',
          })
        )
    );

    const names = component.marquee.map((m) => m.name);
    const caption = names.length
      ? names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`
      : 'Considerations only';

    return el(
      'button',
      {
        class: 'tree-card',
        type: 'button',
        style: { '--club-lit': lit, animationDelay: `${Math.min(i, 11) * 30}ms` },
        title: `Open this lineage`,
        onClick: () => setState({ flowsTree: component.key, flowsMode: 'trees' }),
      },
      [
        el('div', { class: 'tree-card-figure' }, [miniature(teamId, component)]),
        el('div', { class: 'tree-card-body' }, [
          faces.children.length ? faces : null,
          el('h3', { class: 'tree-card-title' }, caption),
          el('div', { class: 'tree-card-meta' }, [
            el('span', {}, `${stats.size} assets`),
            el('span', {}, `${stats.depth} gen`),
            el('span', {}, `${stats.trades} trade${stats.trades === 1 ? '' : 's'}`),
            el('span', {}, span),
          ]),
        ]),
      ]
    );
  }

  /**
   * The card figure. Same structural layout as the full canvas, drawn small:
   * trade events as club-colored discs, assets as hairline dots, no labels --
   * the silhouette is the information at this size.
   */
  function miniature(teamId, component) {
    const layout = layoutLineage(component);
    const W = 300;
    const H = 118;
    const PAD = 13;
    const cols = layout.maxCol + 1;
    const xStep = cols > 1 ? Math.min(46, (W - 2 * PAD) / (cols - 1)) : 0;
    const x0 = (W - xStep * (cols - 1)) / 2;
    const extent = Math.max(layout.maxRow - layout.minRow, 0.001);
    const yStep = Math.min(17, (H - 2 * PAD) / extent);

    for (const node of layout.nodes) {
      node.mx = x0 + node.col * xStep;
      node.my = H / 2 + node.row * yStep;
    }

    const svg = svgEl('svg', {
      class: 'mini',
      viewBox: `0 0 ${W} ${H}`,
      preserveAspectRatio: 'xMidYMid meet',
      'aria-hidden': 'true',
    });
    const clubLit = legible(teamColor(teamId));

    for (const link of layout.links) {
      const a = layout.byId.get(link.source);
      const b = layout.byId.get(link.target);
      if (!a || !b) continue;
      const color = link.flow === 'in' ? clubLit : legible(teamColor(link.teamId));
      const mid = (a.mx + b.mx) / 2;
      svg.append(
        svgEl('path', {
          d: `M${a.mx},${a.my}C${mid},${a.my} ${mid},${b.my} ${b.mx},${b.my}`,
          fill: 'none',
          stroke: rgba(color, 0.42),
          'stroke-width': 1,
        })
      );
    }

    for (const node of layout.nodes) {
      if (node.type === 'trade') {
        const color = legible(teamColor(node.trade.primaryCounterparty));
        svg.append(
          svgEl('circle', {
            cx: node.mx,
            cy: node.my,
            r: 5.5,
            fill: rgba(color, 0.24),
            stroke: color,
            'stroke-width': 1.3,
          })
        );
      } else {
        const player = node.asset.kind === 'player';
        svg.append(
          svgEl('circle', {
            cx: node.mx,
            cy: node.my,
            r: player ? 3.1 : 2.2,
            fill: player ? rgba(clubLit, 0.85) : 'none',
            stroke: rgba(clubLit, player ? 0.9 : 0.55),
            'stroke-width': 1,
            'stroke-dasharray': player ? null : '2 2',
          })
        );
      }
    }
    return svg;
  }

  /* --------------------------------------------------------------- ledger */

  function renderLedger(teamId) {
    const lit = legible(teamColor(teamId));

    // The club filter narrows the league, not this club's own ledger: if another
    // club is pinned, show only trades between the two.
    const trades = (index.teamTrades.get(teamId) || [])
      .map((id) => index.tradesById.get(id))
      .filter((t) => t && inYears(t) && (state.team == null || t.teamIds.includes(state.team)))
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    const acquired = [];
    const sent = [];
    let playersIn = 0;
    let playersOut = 0;
    const partners = new Map();

    for (const trade of trades) {
      const inAssets = trade.assets.filter((a) => a.toTeamId === teamId);
      const outAssets = trade.assets.filter((a) => a.fromTeamId === teamId);
      if (inAssets.length) acquired.push({ trade, assets: inAssets });
      if (outAssets.length) sent.push({ trade, assets: outAssets });
      playersIn += inAssets.filter((a) => a.kind === 'player').length;
      playersOut += outAssets.filter((a) => a.kind === 'player').length;
      for (const other of trade.teamIds) {
        if (other === teamId) continue;
        partners.set(other, (partners.get(other) || 0) + 1);
      }
    }

    const topPartner = [...partners.entries()].sort((a, b) => b[1] - a[1])[0];

    clear(shell);
    shell.style.setProperty('--club-lit', lit);

    const summary = el('dl', { class: 'summary' }, [
      stat('Trades', trades.length, `${state.yearMin}–${state.yearMax}`),
      stat('Players in', playersIn),
      stat('Players out', playersOut),
      stat(
        'Top partner',
        topPartner ? index.teamsById.get(topPartner[0]).abbreviation : '—',
        topPartner ? `${topPartner[1]} trades` : 'no trades in window'
      ),
    ]);

    const ledger = el('div', { class: 'ledger' }, [
      column('Acquired', acquired, teamId, 'in'),
      column('Sent away', sent, teamId, 'out'),
    ]);

    shell.append(header(teamId, lit), summary, ledger);
  }

  function column(title, rows, teamId, direction) {
    const body = el('div');
    if (!rows.length) {
      body.append(el('p', { class: 'empty-note' }, 'Nothing in this window.'));
    } else {
      rows.forEach((row, i) => {
        const counterparts = row.trade.teamIds.filter((id) => id !== teamId);
        body.append(
          el('article', { class: 'entry', style: { animationDelay: `${Math.min(i, 10) * 26}ms` } }, [
            el('div', { class: 'trade-meta' }, [
              el('span', { class: 'trade-date' }, formatDate(row.trade.date)),
              ...counterparts.map((id) =>
                clubChip(index, id, {
                  button: true,
                  onClick: () => choose(id),
                })
              ),
            ]),
            el(
              'div',
              { class: 'asset-row' },
              row.assets.map((asset) =>
                assetPill(index, asset, {
                  onPlayer: (a) => jumpToChain(a.personId, row.trade.id),
                })
              )
            ),
            el(
              'p',
              {
                class: 'trade-desc',
                style: { marginTop: '10px', marginBottom: 0, fontSize: '12px' },
              },
              shorten(tradeSentence(index, row.trade))
            ),
          ])
        );
      });
    }

    const total = rows.reduce((n, r) => n + r.assets.length, 0);
    return el('section', { class: `ledger-col ${direction}` }, [
      el('h3', {}, [title, el('span', {}, `${rows.length} trades · ${total} assets`)]),
      body,
    ]);
  }

  function shorten(text, max = 190) {
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  }

  /* ----------------------------------------------------------- tree layout */

  /**
   * One lineage as a layered graph, shared by the card figure and the canvas.
   *
   * Columns alternate: trades sit on odd columns (generation * 2 + 1) and assets
   * on the even columns either side, so a player who arrives in one trade and
   * leaves in another is a single node sitting *between* the two events. That is
   * the whole point of a trade tree, and it is why this is one node and not two.
   * Rows come from a few barycentre sweeps, which is enough to keep the strands
   * from crossing at card size; the force sim relaxes them on the canvas.
   */
  function layoutLineage(component) {
    const genOf = new Map(component.trades.map((t) => [t.id, t.generation]));
    const assetById = new Map(component.assets.map((a) => [a.id, a]));
    const nodes = [];
    const byId = new Map();
    const links = [];

    const add = (node) => {
      nodes.push(node);
      byId.set(node.id, node);
      return node;
    };

    for (const trade of component.trades) {
      add({ id: `t:${trade.id}`, type: 'trade', trade, col: trade.generation * 2 + 1 });
    }

    const spanned = new Set();
    for (const link of component.links) {
      spanned.add(link.inAssetId);
      spanned.add(link.outAssetId);
      const arrival = assetById.get(link.inAssetId);
      const departure = assetById.get(link.outAssetId);
      const node = add({
        id: `s:${link.id}`,
        type: 'asset',
        asset: arrival,
        exit: departure,
        col: genOf.get(link.fromTradeId) * 2 + 2,
      });
      links.push({
        id: `${node.id}:in`,
        source: `t:${link.fromTradeId}`,
        target: node.id,
        flow: 'in',
        teamId: arrival.counterpartyTeamId,
      });
      links.push({
        id: `${node.id}:out`,
        source: node.id,
        target: `t:${link.toTradeId}`,
        flow: 'out',
        teamId: departure.counterpartyTeamId,
      });
    }

    for (const asset of component.assets) {
      if (spanned.has(asset.id)) continue;
      const gen = genOf.get(asset.tradeId);
      const node = add({
        id: `a:${asset.id}`,
        type: 'asset',
        asset,
        exit: asset.direction === 'out' ? asset : null,
        col: asset.direction === 'in' ? gen * 2 + 2 : gen * 2,
      });
      if (asset.direction === 'in') {
        links.push({
          id: `${node.id}:in`,
          source: `t:${asset.tradeId}`,
          target: node.id,
          flow: 'in',
          teamId: asset.counterpartyTeamId,
        });
      } else {
        links.push({
          id: `${node.id}:out`,
          source: node.id,
          target: `t:${asset.tradeId}`,
          flow: 'out',
          teamId: asset.counterpartyTeamId,
        });
      }
    }

    /* ------ seating: sort each column by trade date/id, then centre it. The
       d3-force simulation on the canvas (see renderTree) relaxes crossings
       from there; this only has to be deterministic, not crossing-free. ---- */

    const columns = new Map();
    for (const node of nodes) {
      const list = columns.get(node.col) || [];
      list.push(node);
      columns.set(node.col, list);
    }
    const colKeys = [...columns.keys()].sort((a, b) => a - b);

    let minRow = Infinity;
    let maxRow = -Infinity;
    for (const key of colKeys) {
      const list = columns.get(key);
      list.sort((a, b) => {
        const dateA = a.type === 'trade' ? a.trade.date : a.asset.date;
        const dateB = b.type === 'trade' ? b.trade.date : b.asset.date;
        if (dateA !== dateB) return dateA < dateB ? -1 : 1;
        const idA = a.type === 'trade' ? a.trade.id : a.asset.tradeId;
        const idB = b.type === 'trade' ? b.trade.id : b.asset.tradeId;
        return idA - idB || a.id.localeCompare(b.id);
      });
      list.forEach((node, i) => {
        node.row = i - (list.length - 1) / 2;
        minRow = Math.min(minRow, node.row);
        maxRow = Math.max(maxRow, node.row);
      });
    }

    return {
      nodes,
      links,
      byId,
      maxCol: colKeys[colKeys.length - 1],
      minRow: Number.isFinite(minRow) ? minRow : 0,
      maxRow: Number.isFinite(maxRow) ? maxRow : 0,
    };
  }

  /* ---------------------------------------------------------- tree canvas */

  function ensureCanvas() {
    if (canvas) return canvas;
    canvas = makeCanvas(host);
    breadcrumb = el('div', { class: 'breadcrumb' });
    note = el('div', { class: 'canvas-note' });
    host.append(breadcrumb, note);
    canvas.svg.addEventListener('click', (event) => {
      if (event.target === canvas.svg) setFocus(canvas, {});
    });
    canvas.onResize = () => {
      if (openKey && nodes.length && sim) reflow();
    };
    return canvas;
  }

  /**
   * Take the canvas off the page entirely, not just its contents. It is
   * position:absolute/inset:0 with touch-action:none and a d3-zoom binding, so
   * an emptied-but-present canvas still sits on top of the grid and eats every
   * tap and scroll. ensureCanvas() builds a fresh one on the next open.
   */
  function closeCanvas() {
    if (!canvas) return;
    openKey = null;
    if (sim) sim.stop();
    sim = null;
    nodes = [];
    links = [];
    canvas.destroy();
    canvas = null;
    breadcrumb.remove();
    note.remove();
    breadcrumb = null;
    note = null;
    hideTip();
  }

  function renderTree(teamId, component) {
    ensureCanvas();
    host.scrollTop = 0;
    shell.style.display = 'none';

    renderTreeChrome(teamId, component);

    if (openKey === component.key) {
      if (sim) sim.alpha(0.3).restart();
      fit();
      return;
    }
    openKey = component.key;
    if (sim) sim.stop();
    clear(canvas.linkLayer);
    clear(canvas.nodeLayer);
    setFocus(canvas, {});

    const layout = layoutLineage(component);
    const clubLit = legible(teamColor(teamId));

    nodes = layout.nodes.map((node) => ({
      ...node,
      r: node.type === 'trade' ? 22 : node.asset.kind === 'player' ? 19 : 13,
    }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    links = layout.links
      .filter((l) => byId.has(l.source) && byId.has(l.target))
      .map((l) => ({
        ...l,
        source: byId.get(l.source),
        target: byId.get(l.target),
        color: l.flow === 'in' ? clubLit : legible(teamColor(l.teamId)),
      }));

    seatNodes();
    for (const node of nodes) {
      node.x = node.tx;
      node.y = node.ty;
    }

    renderNodes(teamId, component);

    sim = forceSimulation(nodes)
      .force('link', forceLink(links).id((d) => d.id).distance(COLUMN).strength(0.09))
      .force('charge', forceManyBody().strength(-240).distanceMax(400))
      .force('collide', forceCollide().radius((d) => d.r + 24).strength(1))
      .force('x', forceX((d) => d.tx).strength(0.9))
      .force('y', forceY((d) => d.ty).strength(0.3))
      .alpha(1)
      .alphaDecay(0.045)
      .on('tick', tick)
      .on('end', fit);
  }

  function renderNodes(teamId, component) {
    for (const link of links) {
      link.el = linkGroup({ color: link.color, width: 1.2, hit: false });
      if (link.flow === 'out') {
        for (const path of link.el.children) path.setAttribute('stroke-dasharray', '3 5');
      }
      canvas.linkLayer.append(link.el);
    }

    for (const node of nodes) {
      if (node.type === 'trade') {
        const other = index.teamsById.get(node.trade.primaryCounterparty);
        node.el = clubNode({
          teamId: node.trade.primaryCounterparty,
          abbreviation: other ? other.abbreviation : '??',
          r: node.r,
        });
        node.el.append(
          Object.assign(svgEl('text', { class: 'caption', y: node.r + 16 }), {
            textContent: formatDate(node.trade.date),
          })
        );
        if (node.trade.counterparties.length > 1) {
          node.el.append(
            Object.assign(svgEl('text', { class: 'caption dim', y: node.r + 28 }), {
              textContent: `+ ${node.trade.counterparties
                .filter((id) => id !== node.trade.primaryCounterparty)
                .map((id) => index.teamsById.get(id)?.abbreviation || id)
                .join(' ')}`,
            })
          );
        }
      } else if (node.asset.kind === 'player') {
        node.el = playerNode(canvas.defs, {
          personId: node.asset.personId,
          name: node.asset.name,
          teamId,
          r: node.r,
          caption: node.asset.name,
        });
        if (node.asset.openKind === 'no-earlier-trade') {
          // He got here some way this dataset cannot see -- drafted, signed, or
          // acquired before 2015. Dash the ring so the left edge of the tree
          // reads as "the record starts here", not "homegrown".
          node.el.querySelector('.ring')?.setAttribute('stroke-dasharray', '4 4');
        }
      } else {
        node.el = assetNode({
          glyph: KIND_GLYPH[node.asset.kind] || '·',
          teamId: node.asset.direction === 'in' ? teamId : node.asset.counterpartyTeamId,
          r: node.r,
          caption: KIND_LABEL[node.asset.kind] || node.asset.kind,
        });
      }

      node.el.addEventListener('pointerenter', (event) => onEnter(node, event));
      node.el.addEventListener('pointermove', (event) => moveTip(event.clientX, event.clientY));
      node.el.addEventListener('pointerleave', onLeave);
      node.el.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick(node, component);
      });
      canvas.nodeLayer.append(node.el);
    }

    attachDrag(canvas, nodes, () => sim);
  }

  function tick() {
    for (const link of links) {
      const a = link.source;
      const b = link.target;
      const mid = (a.x + b.x) / 2;
      setLinkPath(link.el, `M${a.x},${a.y}C${mid},${a.y} ${mid},${b.y} ${b.x},${b.y}`);
    }
    for (const node of nodes) {
      node.el.setAttribute('transform', `translate(${node.x},${node.y})`);
    }
  }

  function fit() {
    fitToNodes(canvas, nodes, { pad: 100, max: 1.1, min: 0.25 });
  }

  /** Column/row targets for the current node set. Shared by renderTree() and reflow(). */
  function seatNodes() {
    const inset = headerInset();
    const originX = canvas.size.width * 0.16;
    const originY = inset + (canvas.size.height - inset) * 0.5;
    for (const node of nodes) {
      node.tx = originX + node.col * COLUMN;
      node.ty = originY + node.row * ROW;
    }
  }

  function reflow() {
    seatNodes();
    sim.alpha(0.6).restart();
  }

  /* ------------------------------------------------------ tree interaction */

  function onEnter(node, event) {
    const near = new Set([node.el]);
    const nearLinks = [];
    for (const link of links) {
      if (link.source.id === node.id || link.target.id === node.id) {
        nearLinks.push(link.el);
        near.add(link.source.el);
        near.add(link.target.el);
      }
    }
    setFocus(canvas, { hotNodes: [node.el], nearNodes: [...near], nearLinks });

    if (node.type === 'trade') {
      const clubs = node.trade.counterparties
        .map((id) => index.teamsById.get(id)?.name || `Team ${id}`)
        .join(' · ');
      showTip(
        el('div', {}, [
          el('div', { style: { color: '#e8b44c', marginBottom: '6px' } }, `${clubs} · generation ${node.trade.generation + 1}`),
          el('div', {}, node.trade.description),
        ]),
        event.clientX,
        event.clientY,
        formatDate(node.trade.date)
      );
      return;
    }

    const asset = node.asset;
    const lines = [];
    if (asset.direction === 'in') {
      const from = index.teamsById.get(asset.counterpartyTeamId);
      lines.push(`Acquired from ${from ? from.name : '?'} · ${formatDate(asset.date)}`);
    } else {
      const to = index.teamsById.get(asset.counterpartyTeamId);
      lines.push(`Sent to ${to ? to.name : '?'} · ${formatDate(asset.date)}`);
    }
    if (node.exit && node.exit !== asset) {
      const to = index.teamsById.get(node.exit.counterpartyTeamId);
      lines.push(`Later flipped to ${to ? to.name : '?'} · ${formatDate(node.exit.date)}`);
    }
    const note = openNote(asset) || (node.exit && node.exit !== asset ? null : openNote(node.exit || {}));
    if (note) lines.push(note);

    const trade = index.tradesById.get(asset.tradeId);
    showTip(
      el('div', {}, [
        ...lines.map((line) => el('div', { style: { color: '#e8b44c', marginBottom: '6px' } }, line)),
        trade ? el('div', {}, tradeSentence(index, trade)) : null,
      ]),
      event.clientX,
      event.clientY,
      asset.name || KIND_LABEL[asset.kind] || asset.kind
    );
  }

  function onLeave() {
    hideTip();
    setFocus(canvas, {});
  }

  function onClick(node, component) {
    if (node.type === 'trade') {
      const trade = index.tradesById.get(node.trade.id);
      openPanel({
        kicker: `Generation ${node.trade.generation + 1} of ${component.stats.depth}`,
        title: formatDate(node.trade.date),
        sub: node.trade.counterparties
          .map((id) => index.teamsById.get(id)?.name || `Team ${id}`)
          .join(' · '),
        render: (body) => {
          const list = el('div');
          body.append(list);
          renderTradeList(index, list, [trade].filter(Boolean), {
            onPlayer: (asset) => jumpToChain(asset.personId, node.trade.id),
          });
        },
      });
      return;
    }

    const asset = node.asset;
    if (asset.kind !== 'player' || asset.personId == null) {
      const trade = index.tradesById.get(asset.tradeId);
      openPanel({
        kicker: 'Consideration',
        title: KIND_LABEL[asset.kind] || asset.kind,
        sub: formatDate(asset.date),
        render: (body) => {
          const list = el('div');
          body.append(list);
          renderTradeList(index, list, [trade].filter(Boolean));
        },
      });
      return;
    }

    const player = index.playerIndex.get(asset.personId);
    const trades = (player ? player.trades : [asset.tradeId])
      .map((id) => index.tradesById.get(id))
      .filter(Boolean);

    openPanel({
      kicker: 'Lineage asset',
      title: asset.name,
      sub: openNote(asset) || (node.exit && node.exit !== asset ? `Flipped ${formatDate(node.exit.date)}` : formatDate(asset.date)),
      render: (body) => {
        body.append(
          el('div', { class: 'asset-row', style: { margin: '4px 0 14px' } }, [
            el(
              'button',
              {
                class: 'ghost-btn accent',
                type: 'button',
                onClick: () => jumpToChain(asset.personId, asset.tradeId),
              },
              ['View chain →']
            ),
          ]),
          playerDossier(index, asset.personId, asset.tradeId)
        );
        const list = el('div');
        body.append(list);
        renderTradeList(index, list, trades, {
          onPlayer: (a) => jumpToChain(a.personId, null),
        });
      },
    });
  }

  /* --------------------------------------------------------- tree chrome */

  function renderTreeChrome(teamId, component) {
    clear(breadcrumb);
    clear(note);

    const team = index.teamsById.get(teamId);
    const lit = legible(teamColor(teamId));
    const { stats } = component;

    breadcrumb.append(
      el(
        'button',
        { class: 'ghost-btn', type: 'button', onClick: () => setState({ flowsTree: null }) },
        ['‹ All trees']
      ),
      el('span', { class: 'crumb', style: { '--club-lit': lit } }, [
        el('span', { class: 'crumb-label' }, team ? team.abbreviation : '—'),
        component.marquee.map((m) => m.name).join(' · ') || 'Considerations',
      ]),
      el('span', { class: 'crumb' }, [
        el('span', { class: 'crumb-label' }, 'Lineage'),
        `${stats.size} assets · ${stats.depth} generations · ${stats.trades} trades · ${stats.yearMin}–${stats.yearMax}`,
      ])
    );

    const lines = [
      el('div', {}, [el('b', {}, 'Oldest ancestry left'), ' → most recent right']),
      el('div', {}, 'Club discs are trade events · faces are this club’s assets'),
      el('div', {}, 'Tap a face for the player · tap a disc for the deal'),
    ];
    if (filterActive(teamId)) {
      lines.push(el('div', {}, 'Complete lineage shown — filters select trees, they never trim one'));
    }
    note.append(...lines);
  }

  /* ---------------------------------------------------------- club picker */

  /**
   * The club title is the selector. Clicking it drops a keyboard-navigable
   * listbox of all 30 clubs; the caret and hover underline are the affordance.
   */
  function titlePicker(teamId, lit) {
    const team = index.teamsById.get(teamId);
    const wrap = el('div', { class: 'club-picker' });

    const trigger = el(
      'button',
      {
        class: 'flows-team-btn',
        type: 'button',
        'aria-haspopup': 'listbox',
        'aria-expanded': 'false',
        title: 'Choose a club',
      },
      [
        el('span', { class: 'mark' }, team.abbreviation),
        el('span', { class: 'club-name' }, team.name),
        el('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'),
      ]
    );

    const menu = el('div', {
      class: 'club-menu',
      role: 'listbox',
      tabindex: '-1',
      'aria-label': 'Clubs',
    });

    const options = index.teams.map((option) => {
      const optionLit = legible(teamColor(option.id));
      return el(
        'button',
        {
          class: 'club-option',
          type: 'button',
          role: 'option',
          'aria-selected': String(option.id === teamId),
          dataset: { team: String(option.id) },
          style: { '--club-lit': optionLit },
          onClick: () => {
            close();
            choose(option.id);
          },
        },
        [
          el('span', { class: 'dot', style: { background: optionLit } }),
          el('span', { class: 'abbr' }, option.abbreviation),
          el('span', { class: 'club-option-name' }, option.name),
        ]
      );
    });
    menu.append(...options);

    let open = false;
    let active = Math.max(
      0,
      options.findIndex((o) => Number(o.dataset.team) === teamId)
    );

    const mark = () => {
      options.forEach((option, i) => {
        option.dataset.active = String(i === active);
      });
      // Scroll the menu itself rather than calling scrollIntoView, which would
      // also scroll the ledger behind it and drag the title under the chrome.
      const option = options[active];
      if (!option) return;
      const top = option.offsetTop;
      const bottom = top + option.offsetHeight;
      if (top < menu.scrollTop) menu.scrollTop = top;
      else if (bottom > menu.scrollTop + menu.clientHeight) {
        menu.scrollTop = bottom - menu.clientHeight;
      }
    };

    function close() {
      if (!open) return;
      open = false;
      delete wrap.dataset.open;
      trigger.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onOutside, true);
    }

    function onOutside(event) {
      if (!wrap.contains(event.target)) close();
    }

    function show() {
      if (open) return;
      // The ledger scrolls under the floating chrome; snap the title back into
      // the open before dropping a menu off it.
      host.scrollTop = 0;
      open = true;
      wrap.dataset.open = 'true';
      trigger.setAttribute('aria-expanded', 'true');
      mark();
      document.addEventListener('click', onOutside, true);
    }

    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      if (open) close();
      else show();
    });

    wrap.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && open) {
        event.stopPropagation();
        close();
        trigger.focus();
        return;
      }
      if (!open && (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ')) {
        if (document.activeElement === trigger && event.key === 'ArrowDown') {
          event.preventDefault();
          show();
          menu.focus();
        }
        return;
      }
      if (!open) return;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        active = (active + 1) % options.length;
        mark();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        active = (active - 1 + options.length) % options.length;
        mark();
      } else if (event.key === 'Home') {
        event.preventDefault();
        active = 0;
        mark();
      } else if (event.key === 'End') {
        event.preventDefault();
        active = options.length - 1;
        mark();
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const picked = options[active];
        close();
        if (picked) choose(Number(picked.dataset.team));
      }
    });

    for (const [i, option] of options.entries()) {
      option.addEventListener('mouseenter', () => {
        active = i;
        mark();
      });
    }

    wrap.style.setProperty('--club-lit', lit);
    wrap.append(el('h2', { class: 'flows-team' }, [trigger]), menu);
    return wrap;
  }

  /* ------------------------------------------------------------------- api */

  return { update };
}
