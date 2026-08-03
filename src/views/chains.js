// View II -- Chain Explorer.
// "What did he become": the forward chain rendered as a left-to-right graph.
// A tidy pre-layout fixes each generation to a column and gives siblings target
// rows; the force sim then relaxes it, so it reads as a tree but behaves like
// the Obsidian-style canvas everywhere else in the app.

import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from 'd3';
import { buildChain, expandNode, tradeSentence, DEFAULT_DEPTH } from '../chain.js';
import { formatDate, KIND_GLYPH, KIND_LABEL } from '../data.js';
import { legible, teamColor } from '../teams.js';
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
  clear,
  el,
  hideTip,
  jumpToCompare,
  jumpToFlows,
  notableTrades,
  moveTip,
  openPanel,
  playerDossier,
  renderTradeList,
  showTip,
  svgEl,
  tradeCard,
} from '../ui.js';
import { setState, state } from '../state.js';

const COLUMN = 132; // half a generation: assets on even columns, trades on odd
const ROW = 76;

export function createChainView(host, index) {
  clear(host);

  const canvas = makeCanvas(host);
  const breadcrumb = el('div', { class: 'breadcrumb' });
  const note = el('div', { class: 'canvas-note' });
  const emptyState = el('div', { class: 'chain-empty' });
  host.append(breadcrumb, note, emptyState);

  let root = null;
  let nodes = [];
  let links = [];
  let sim = null;
  const collapsed = new Set();
  const posCache = new Map(); // node id -> {x,y}: collapsing a branch shouldn't teleport the rest

  canvas.svg.addEventListener('click', (event) => {
    if (event.target === canvas.svg) setFocus(canvas, {});
  });

  /* ------------------------------------------------------------- traversal */

  /**
   * Flatten the chain into a layered graph, same shape as the Team Flows tree:
   * assets sit on even columns and the trade that moved them on the odd column
   * between. The trade is the thing that actually happened, so it gets a node
   * rather than being implied by an edge.
   */
  function flatten() {
    nodes = [];
    links = [];
    let leafRow = 0;

    const join = (source, target, chainNode, dashed) =>
      links.push({
        id: `${source.id}->${target.id}`,
        source,
        target,
        color: legible(teamColor(chainNode.toTeamId ?? chainNode.fromTeamId)),
        width: dashed ? 0.8 : 1.2,
        dashed,
      });

    const walk = (chainNode, parent) => {
      const model = {
        id: chainNode.id,
        type: 'asset',
        chain: chainNode,
        col: chainNode.depth * 2,
        r: chainNode.root ? 27 : chainNode.kind === 'player' ? 19 : 13,
      };
      nodes.push(model);
      if (parent) join(parent, model, chainNode, chainNode.kind !== 'player');

      const kids = collapsed.has(chainNode.id) ? [] : chainNode.children || [];
      if (!kids.length) {
        model.row = leafRow++;
        return model.row;
      }

      // The deal that turned this asset into those children.
      const trade = chainNode.pivot ? index.tradesById.get(chainNode.pivot.tradeId) : null;
      let hub = model;
      if (trade) {
        hub = {
          id: `t:${chainNode.id}`,
          type: 'trade',
          trade,
          pivot: chainNode.pivot,
          col: chainNode.depth * 2 + 1,
          r: 21,
        };
        nodes.push(hub);
        join(model, hub, chainNode, false);
      }

      const rows = kids.map((kid) => walk(kid, hub));
      model.row = rows.reduce((a, b) => a + b, 0) / rows.length;
      if (hub !== model) hub.row = model.row;
      return model.row;
    };

    if (root) walk(root, null);
    return nodes;
  }

  /* ---------------------------------------------------------------- render */

  function badge(node, label, title, onClick) {
    const g = svgEl('g', { class: 'chain-badge', transform: `translate(${node.r + 4},${-node.r - 4})` });
    g.append(
      svgEl('circle', { r: 10, fill: '#0d1017', stroke: 'rgba(232,180,76,.6)', 'stroke-width': 1 })
    );
    const text = svgEl('text', {
      class: 'abbrev',
      fill: '#e8b44c',
      'font-size': 11,
      y: 0.5,
    });
    text.textContent = label;
    g.append(text);
    g.append(svgEl('circle', { r: 17, fill: 'transparent' }));
    g.style.cursor = 'pointer';
    const t = svgEl('title');
    t.textContent = title;
    g.append(t);
    g.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return g;
  }

  function render() {
    clear(canvas.linkLayer);
    clear(canvas.nodeLayer);

    for (const link of links) {
      link.el = linkGroup({ color: link.color, width: link.width, hit: false });
      if (link.dashed) {
        for (const path of link.el.children) path.setAttribute('stroke-dasharray', '2 6');
      }
      canvas.linkLayer.append(link.el);
    }

    for (const model of nodes) {
      if (model.type === 'trade') {
        // Same club-coloured disc the Team Flows tree uses for a trade event.
        const other = index.teamsById.get(model.pivot.toTeamId);
        model.el = clubNode({
          teamId: model.pivot.toTeamId,
          abbreviation: other ? other.abbreviation : '??',
          r: model.r,
        });
        model.el.append(
          Object.assign(svgEl('text', { class: 'caption', y: model.r + 16 }), {
            textContent: formatDate(model.trade.date),
          })
        );
        const extra = model.trade.teamIds.filter(
          (id) => id !== model.pivot.toTeamId && id !== model.pivot.fromTeamId
        );
        if (extra.length) {
          model.el.append(
            Object.assign(svgEl('text', { class: 'caption dim', y: model.r + 28 }), {
              textContent: `+ ${extra.map((id) => index.teamsById.get(id)?.abbreviation || id).join(' ')}`,
            })
          );
        }
        model.el.addEventListener('pointerenter', (event) => onEnter(model, event));
        model.el.addEventListener('pointermove', (event) => moveTip(event.clientX, event.clientY));
        model.el.addEventListener('pointerleave', onLeave);
        model.el.addEventListener('click', (event) => {
          event.stopPropagation();
          onClick(model);
        });
        canvas.nodeLayer.append(model.el);
        continue;
      }

      const c = model.chain;
      const receiving = c.toTeamId ?? c.fromTeamId;

      if (c.kind === 'player') {
        model.el = playerNode(canvas.defs, {
          personId: c.personId,
          name: c.name,
          teamId: receiving,
          r: model.r,
          caption: c.name,
        });
      } else {
        model.el = assetNode({
          glyph: KIND_GLYPH[c.kind] || '·',
          teamId: receiving,
          r: model.r,
          caption: KIND_LABEL[c.kind] || c.kind,
        });
      }

      if (c.children && c.children.length) {
        model.el.append(
          badge(model, collapsed.has(c.id) ? '+' : '−', 'Collapse or expand this branch', () => {
            if (collapsed.has(c.id)) collapsed.delete(c.id);
            else collapsed.add(c.id);
            build();
          })
        );
      } else if (c.expandable) {
        model.el.append(
          badge(model, '›', `Follow ${c.name} ${DEFAULT_DEPTH} more hops`, () => {
            if (expandNode(index, root, c, DEFAULT_DEPTH)) build();
          })
        );
      }

      model.el.addEventListener('pointerenter', (event) => onEnter(model, event));
      model.el.addEventListener('pointermove', (event) => moveTip(event.clientX, event.clientY));
      model.el.addEventListener('pointerleave', onLeave);
      model.el.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick(model);
      });
      canvas.nodeLayer.append(model.el);
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
    for (const model of nodes) {
      model.el.setAttribute('transform', `translate(${model.x},${model.y})`);
    }
  }

  function fit() {
    fitToNodes(canvas, nodes, { pad: 90, max: 1.15, min: 0.3 });
  }

  /** Column/row targets for the current node set. Shared by build() and reflow(). */
  function seatNodes() {
    const rows = nodes.map((n) => n.row);
    const midRow = (Math.max(...rows) + Math.min(...rows)) / 2;
    const inset = headerInset();
    const originX = canvas.size.width * 0.22;
    const originY = inset + (canvas.size.height - inset) * 0.52;
    for (const model of nodes) {
      model.tx = originX + model.col * COLUMN;
      model.ty = originY + (model.row - midRow) * ROW;
    }
  }

  function startSim() {
    sim = forceSimulation(nodes)
      .force('link', forceLink(links).id((d) => d.id).distance(COLUMN).strength(0.08))
      .force('charge', forceManyBody().strength(-260).distanceMax(420))
      .force('collide', forceCollide().radius((d) => d.r + 26).strength(1))
      .force('x', forceX((d) => d.tx).strength(0.85))
      .force('y', forceY((d) => d.ty).strength(0.28))
      .alpha(1)
      .alphaDecay(0.045)
      .on('tick', tick)
      .on('end', fit);
  }

  function build() {
    if (sim) sim.stop();
    for (const model of nodes) {
      if (Number.isFinite(model.x)) posCache.set(model.id, { x: model.x, y: model.y });
    }
    flatten();
    seatNodes();

    for (const model of nodes) {
      const saved = posCache.get(model.id);
      model.x = saved ? saved.x : model.tx;
      model.y = saved ? saved.y : model.ty;
    }

    render();

    startSim();
    renderChrome();
  }

  /* ------------------------------------------------------------ interaction */

  function tradeOf(chainNode) {
    const id = chainNode.pivot ? chainNode.pivot.tradeId : chainNode.arrivalTradeId;
    return id != null ? index.tradesById.get(id) : null;
  }

  function onEnter(model, event) {
    const near = new Set([model.el]);
    if (model.type === 'trade') {
      const nearLinks = [];
      for (const link of links) {
        if (link.source.id === model.id || link.target.id === model.id) {
          nearLinks.push(link.el);
          near.add(link.source.el);
          near.add(link.target.el);
        }
      }
      setFocus(canvas, { hotNodes: [model.el], nearNodes: [...near], nearLinks });
      const clubs = model.trade.teamIds
        .map((id) => index.teamsById.get(id)?.name || `Team ${id}`)
        .join(' · ');
      showTip(
        el('div', {}, [
          el('div', { style: { color: '#e8b44c', marginBottom: '6px' } }, clubs),
          el('div', {}, tradeSentence(index, model.trade)),
        ]),
        event.clientX,
        event.clientY,
        formatDate(model.trade.date)
      );
      return;
    }
    const nearLinks = [];
    for (const link of links) {
      if (link.source.id === model.id || link.target.id === model.id) {
        nearLinks.push(link.el);
        near.add(link.source.el);
        near.add(link.target.el);
      }
    }
    setFocus(canvas, { hotNodes: [model.el], nearNodes: [...near], nearLinks });

    const c = model.chain;
    const arrival = c.arrivalTradeId != null ? index.tradesById.get(c.arrivalTradeId) : null;
    const pivot = c.pivot ? index.tradesById.get(c.pivot.tradeId) : null;
    const shown = arrival || pivot;
    const lines = [];
    if (arrival) {
      const to = index.teamsById.get(c.toTeamId);
      lines.push(`Traded to ${to ? to.name : '?'} · ${formatDate(arrival.date)}`);
    }
    if (c.pivot && pivot) {
      const to = index.teamsById.get(c.pivot.toTeamId);
      lines.push(`Later flipped to ${to ? to.name : '?'} · ${formatDate(pivot.date)}`);
    }
    if (c.terminal === 'held') lines.push('No later trade on record.');
    if (c.terminal === 'cycle') lines.push('Chain loops back to a trade already shown.');

    const body = el('div', {}, [
      ...lines.map((line) => el('div', { style: { color: '#e8b44c', marginBottom: '6px' } }, line)),
      shown ? el('div', {}, tradeSentence(index, shown)) : null,
    ]);
    showTip(body, event.clientX, event.clientY, c.label || c.name);
  }

  function onLeave() {
    hideTip();
    setFocus(canvas, {});
  }

  function onClick(model) {
    if (model.type === 'trade') {
      openPanel({
        kicker: 'Trade',
        title: formatDate(model.trade.date),
        sub: model.trade.teamIds
          .map((id) => index.teamsById.get(id)?.abbreviation || id)
          .join(' ⇄ '),
        render: (body) => {
          body.append(
            el('div', { class: 'asset-row', style: { margin: '4px 0 14px' } }, [
              el(
                'button',
                {
                  class: 'ghost-btn accent',
                  type: 'button',
                  onClick: () => jumpToCompare(model.trade.id),
                },
                ['Compare returns →']
              ),
            ])
          );
          const list = el('div');
          body.append(list);
          renderTradeList(index, list, [model.trade], {
            onPlayer: (asset) => rootOn(asset.personId, model.trade.id),
          });
        },
      });
      return;
    }
    const c = model.chain;
    const trades = [];
    if (c.arrivalTradeId != null) trades.push(index.tradesById.get(c.arrivalTradeId));
    if (c.pivot) trades.push(index.tradesById.get(c.pivot.tradeId));

    openPanel({
      kicker: c.kind === 'player' ? 'Chain node' : 'Consideration',
      title: c.label || c.name,
      sub: c.pivot ? `Flipped ${formatDate(c.pivot.date)}` : c.arrivalDate ? formatDate(c.arrivalDate) : '',
      render: (body) => {
        if (c.kind === 'player' && c.personId != null) {
          body.append(
            el('div', { class: 'asset-row', style: { margin: '4px 0 14px' } }, [
              el(
                'button',
                {
                  class: 'ghost-btn accent',
                  type: 'button',
                  onClick: () => rootOn(c.personId, c.pivot ? c.pivot.tradeId : c.arrivalTradeId),
                },
                ['Start the chain here'],
              ),
              el(
                'button',
                { class: 'ghost-btn', type: 'button', onClick: () => jumpToFlows(c.toTeamId) },
                ['Club flows'],
              ),
            ]),
            playerDossier(index, c.personId, c.pivot ? c.pivot.tradeId : c.arrivalTradeId),
          );
        }
        const list = el('div');
        body.append(list);
        renderTradeList(index, list, trades.filter(Boolean), {
          onPlayer: (asset) => rootOn(asset.personId, findTradeId(asset, trades)),
        });
      },
    });
  }

  function findTradeId(asset, trades) {
    const hit = trades.filter(Boolean).find((t) => t.assets.includes(asset));
    if (hit) return hit.id;
    const player = index.playerIndex.get(asset.personId);
    return player ? player.trades[0] : null;
  }

  function rootOn(personId, tradeId) {
    setState({ chain: { personId, tradeId }, view: 'chain' });
  }

  /* ---------------------------------------------------------------- chrome */

  /** The two-state control shared by both modes. */
  function modeToggle() {
    const wrap = el('div', { class: 'mode-toggle', role: 'group', 'aria-label': 'Player view' });
    for (const [key, label] of [
      ['trade', 'This trade'],
      ['career', 'All trades'],
    ]) {
      wrap.append(
        el(
          'button',
          {
            class: 'mode-btn',
            type: 'button',
            'aria-pressed': String(state.chainMode === key),
            onClick: () => setState({ chainMode: key }),
          },
          [label]
        )
      );
    }
    return wrap;
  }

  function renderChrome() {
    clear(breadcrumb);
    clear(note);
    if (!root) return;
    breadcrumb.append(modeToggle());

    const player = index.playerIndex.get(root.personId);
    const pivotTrade = index.tradesById.get(root.pivot.tradeId);
    const from = index.teamsById.get(root.pivot.fromTeamId);
    const to = index.teamsById.get(root.pivot.toTeamId);

    if (root.acquiredVia) {
      const via = root.acquiredVia;
      breadcrumb.append(
        el(
          'button',
          {
            class: 'crumb',
            type: 'button',
            title: tradeSentence(index, via),
            onClick: () => rootOn(root.personId, via.id),
          },
          [
            el('span', { class: 'crumb-label' }, 'Acquired via'),
            `${from ? from.abbreviation : '?'} · ${formatDate(via.date)}`,
            el('span', {}, '↓'),
          ]
        )
      );
    } else {
      breadcrumb.append(
        el('span', { class: 'crumb' }, [
          el('span', { class: 'crumb-label' }, 'Acquired via'),
          'no earlier trade on record',
        ])
      );
    }

    if (player && player.trades.length > 1) {
      const picker = el('div', { class: 'hop-picker' });
      for (const tradeId of player.trades) {
        const trade = index.tradesById.get(tradeId);
        const row = trade.assets.find((a) => a.personId === root.personId);
        const clubId = row ? row.fromTeamId : trade.teamIds[0];
        const lit = legible(teamColor(clubId));
        picker.append(
          el(
            'button',
            {
              class: 'chip',
              type: 'button',
              style: {
                '--club-lit': lit,
                opacity: tradeId === root.pivot.tradeId ? 1 : 0.5,
              },
              title: tradeSentence(index, trade),
              onClick: () => rootOn(root.personId, tradeId),
            },
            [trade.date.slice(0, 7)]
          )
        );
      }
      breadcrumb.append(picker);
    }

    let players = 0;
    let others = 0;
    for (const model of nodes) {
      if (model.type === 'trade' || model.chain.root) continue;
      if (model.chain.kind === 'player') players++;
      else others++;
    }
    note.append(
      el('div', {}, [
        el('b', {}, root.name),
        ` → ${players} player${players === 1 ? '' : 's'}${others ? ` + ${others} considerations` : ''}`,
      ]),
      el(
        'div',
        {},
        `${from ? from.abbreviation : '?'} → ${to ? to.abbreviation : '?'} · ${formatDate(pivotTrade.date)}`
      ),
      el('div', {}, 'Tap a face for the trade · ›  follows the branch further')
    );
  }

  /* ------------------------------------------------- career timeline mode */

  /**
   * "All trades": every deal this player was ever in, as one flow chart rather
   * than a chronological spine. Same grammar as the single-trade view -- he sits
   * on the left, each trade is a box, and what the club got back for him hangs
   * off that box. Time is not an axis here; the shape is.
   */
  function buildCareer(personId) {
    if (sim) sim.stop();
    nodes = [];
    links = [];
    posCache.clear();
    clear(canvas.linkLayer);
    clear(canvas.nodeLayer);
    setFocus(canvas, {});

    const player = index.playerIndex.get(personId);
    if (!player || !player.trades.length) {
      renderEmpty();
      return;
    }
    emptyState.style.display = 'none';

    const first = index.tradesById.get(player.trades[0]);
    const firstRow = first?.assets.find((a) => a.personId === personId);
    const rootModel = {
      id: `career:${personId}`,
      type: 'asset',
      col: 0,
      r: 27,
      chain: {
        root: true,
        kind: 'player',
        personId,
        name: player.name,
        label: player.name,
        fromTeamId: firstRow?.fromTeamId ?? null,
        toTeamId: firstRow?.toTeamId ?? null,
        arrivalTradeId: null,
        pivot: null,
        children: [],
        terminal: null,
      },
    };
    nodes.push(rootModel);

    let leafRow = 0;
    const hubRows = [];

    for (const tradeId of player.trades) {
      const trade = index.tradesById.get(tradeId);
      if (!trade) continue;
      const mine = trade.assets.find((a) => a.personId === personId);
      if (!mine) continue;

      const hub = {
        id: `t:${tradeId}`,
        type: 'trade',
        trade,
        pivot: {
          tradeId,
          date: trade.date,
          fromTeamId: mine.fromTeamId,
          toTeamId: mine.toTeamId,
        },
        col: 1,
        r: 21,
      };
      nodes.push(hub);
      links.push({
        id: `${rootModel.id}->${hub.id}`,
        source: rootModel,
        target: hub,
        color: legible(teamColor(mine.toTeamId ?? mine.fromTeamId)),
        width: 1.2,
        dashed: false,
      });

      // What the club that gave him up got back in the same deal.
      const back = trade.assets.filter((a) => a !== mine && a.toTeamId === mine.fromTeamId);
      const rows = [];
      back.forEach((asset, i) => {
        const model = {
          id: `c:${tradeId}:${i}`,
          type: 'asset',
          col: 2,
          r: asset.kind === 'player' ? 19 : 13,
          chain: {
            kind: asset.kind,
            personId: asset.personId ?? null,
            name: asset.name,
            label: asset.name || KIND_LABEL[asset.kind] || asset.kind,
            fromTeamId: asset.fromTeamId,
            toTeamId: asset.toTeamId,
            arrivalTradeId: tradeId,
            arrivalDate: trade.date,
            pivot: null,
            children: [],
            terminal: null,
          },
          row: leafRow++,
        };
        nodes.push(model);
        links.push({
          id: `${hub.id}->${model.id}`,
          source: hub,
          target: model,
          color: legible(teamColor(asset.toTeamId ?? asset.fromTeamId)),
          width: asset.kind === 'player' ? 1.2 : 0.8,
          dashed: asset.kind !== 'player',
        });
        rows.push(model.row);
      });

      hub.row = rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : leafRow++;
      hubRows.push(hub.row);
    }

    rootModel.row = hubRows.length ? hubRows.reduce((a, b) => a + b, 0) / hubRows.length : 0;

    seatNodes();
    for (const model of nodes) {
      model.x = model.tx;
      model.y = model.ty;
    }
    render();
    startSim();
    renderCareerChrome(player);
  }

  function renderCareerChrome(player) {
    clear(breadcrumb);
    clear(note);
    breadcrumb.append(
      modeToggle(),
      el('span', { class: 'crumb' }, [
        el('span', { class: 'crumb-label' }, player.name),
        `${player.trades.length} trade${player.trades.length === 1 ? '' : 's'}`,
      ])
    );

    const clubs = new Set();
    for (const tradeId of player.trades) {
      const trade = index.tradesById.get(tradeId);
      const row = trade?.assets.find((a) => a.personId === player.personId);
      if (row) {
        clubs.add(row.fromTeamId);
        clubs.add(row.toTeamId);
      }
    }
    const back = nodes.filter((n) => n.type === 'asset' && n.col === 2).length;
    note.append(
      el('div', {}, [el('b', {}, player.name), ` · traded ${player.trades.length}\u00d7 across ${clubs.size} clubs`]),
      el('div', {}, `${back} asset${back === 1 ? '' : 's'} came back the other way`),
      el('div', {}, 'Every deal at once, not to scale in time · tap a disc for the trade')
    );
  }

  /* ------------------------------------------------------------ empty state */

  function renderEmpty() {
    clear(breadcrumb);
    clear(note);
    clear(canvas.linkLayer);
    clear(canvas.nodeLayer);
    nodes = [];
    links = [];
    if (sim) sim.stop();

    clear(emptyState);
    const grid = el('div', { class: 'tree-grid' });
    notableTrades(index, { limit: 12 }).forEach((trade, i) =>
      grid.append(
        tradeCard(index, trade, {
          index: i,
          onClick: () => {
            const first = trade.assets.find((a) => a.kind === 'player' && a.personId != null);
            if (first) rootOn(first.personId, trade.id);
          },
        })
      )
    );

    emptyState.append(
      el('div', { class: 'chain-empty-inner' }, [
        el('h2', {}, 'Follow a player forward'),
        el(
          'p',
          {},
          'Pick a trade and the graph follows the return package: who came back, who they later became, and where the thread finally goes cold.'
        ),
      ]),
      grid
    );
    emptyState.scrollTop = 0;
    emptyState.style.display = '';
  }

  /* ------------------------------------------------------------------- api */

  // Resizing (docking the detail panel, mostly) re-frames the graph rather than
  // rebuilding it -- a rebuild would tear down every headshot and re-fetch it.
  canvas.onResize = () => {
    if (!state.chain || !nodes.length) return;
    reflow();
  };

  /** Recompute layout targets for the existing nodes and let the sim settle. */
  function reflow() {
    if (!nodes.length || !sim) {
      build();
      return;
    }
    seatNodes();
    sim.alpha(0.6).restart();
  }

  function update() {
    const target = state.chain;
    if (!target || target.personId == null) {
      root = null;
      renderEmpty();
      return;
    }
    if (state.chainMode === 'career') {
      root = null;
      buildCareer(target.personId);
      return;
    }
    if (target.tradeId == null) {
      root = null;
      renderEmpty();
      return;
    }
    emptyState.style.display = 'none';
    const next = buildChain(index, {
      personId: target.personId,
      tradeId: target.tradeId,
      maxDepth: DEFAULT_DEPTH,
    });
    if (!next) {
      root = null;
      renderEmpty();
      return;
    }
    root = next;
    collapsed.clear();
    posCache.clear();
    nodes = [];
    build();
  }

  return { update };
}
