// View I -- The Trade Web.
// League mode: 30 club nodes, edge weight = trades between the pair inside the
// current filters. Club mode: that club's player web, headshot nodes for who it
// acquired and who it sent away.

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  scaleSqrt,
  drag as d3drag,
  select,
} from 'd3';
import { formatDate } from '../data.js';
import { legible, mix, teamColor } from '../teams.js';
import {
  arc,
  clubNode,
  linkGroup,
  makeCanvas,
  playerNode,
  setFocus,
  setLinkPath,
  straight,
} from '../graph.js';
import {
  clear,
  el,
  hideTip,
  jumpToChain,
  jumpToFlows,
  moveTip,
  openPanel,
  renderTradeList,
  showTip,
} from '../ui.js';
import { passes, setState, state } from '../state.js';

const PLAYER_CAP = 150;

export function createNetworkView(host, index) {
  clear(host);

  const canvas = makeCanvas(host);
  const actions = el('div', { class: 'canvas-actions' });
  const note = el('div', { class: 'canvas-note' });
  host.append(actions, note);

  const positions = new Map(); // node id -> {x,y}, so filter changes don't teleport
  let sim = null;
  let nodes = [];
  let links = [];
  let selected = null;

  // The chrome floats over the canvas, so the graph has to settle below it.
  const headerInset = () =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--head-h')) || 130;
  const midY = () => headerInset() + (canvas.size.height - headerInset()) / 2;

  canvas.onResize = () => {
    if (!sim) return;
    sim.force('center', forceCenter(canvas.size.width / 2, midY()));
    sim.alpha(0.35).restart();
  };

  canvas.svg.addEventListener('click', (event) => {
    if (event.target === canvas.svg) {
      selected = null;
      setFocus(canvas, {});
      refreshSelection();
    }
  });

  /* ------------------------------------------------------------ simulation */

  function stopSim() {
    if (sim) sim.stop();
    sim = null;
  }

  function rememberPositions() {
    for (const node of nodes) {
      if (Number.isFinite(node.x)) positions.set(node.id, { x: node.x, y: node.y });
    }
  }

  function seed(node, i, total) {
    const saved = positions.get(node.id);
    if (saved) {
      node.x = saved.x;
      node.y = saved.y;
      return;
    }
    const angle = (i / Math.max(total, 1)) * Math.PI * 2;
    const radius = Math.min(canvas.size.width, canvas.size.height - headerInset()) * 0.34;
    node.x = canvas.size.width / 2 + Math.cos(angle) * radius;
    node.y = midY() + Math.sin(angle) * radius;
  }

  function attachDrag() {
    select(canvas.nodeLayer)
      .selectAll('.node')
      .data(nodes)
      .call(
        d3drag()
          .on('start', (event, d) => {
            if (!event.active && sim) sim.alphaTarget(0.22).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on('drag', (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on('end', (event, d) => {
            if (!event.active && sim) sim.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          })
      );
  }

  function tick() {
    for (const link of links) {
      setLinkPath(
        link.el,
        link.curve ? arc(link.source, link.target) : straight(link.source, link.target)
      );
    }
    for (const node of nodes) {
      node.el.setAttribute('transform', `translate(${node.x},${node.y})`);
    }
  }

  /* ------------------------------------------------------------ league mode */

  function buildLeague() {
    const teams = index.teams;
    nodes = teams.map((team) => ({
      id: `club-${team.id}`,
      type: 'club',
      teamId: team.id,
      name: team.name,
      abbrev: team.abbreviation,
      r: 24,
    }));
    const byTeam = new Map(nodes.map((n) => [n.teamId, n]));

    const counts = new Map();
    for (const [key, tradeIds] of index.pairMatrix) {
      const kept = tradeIds.filter((id) => passes(index.tradesById.get(id)));
      if (kept.length) counts.set(key, kept);
    }

    const maxCount = Math.max(1, ...[...counts.values()].map((v) => v.length));
    const weight = scaleSqrt().domain([1, maxCount]).range([0.7, 5.2]);

    links = [];
    for (const [key, tradeIds] of counts) {
      const [a, b] = key.split('-').map(Number);
      const source = byTeam.get(a);
      const target = byTeam.get(b);
      if (!source || !target) continue;
      links.push({
        id: `pair-${key}`,
        key,
        source,
        target,
        tradeIds,
        count: tradeIds.length,
        width: weight(tradeIds.length),
        intensity: (weight(tradeIds.length) - 0.7) / 4.5,
        color: mix(legible(teamColor(a)), legible(teamColor(b)), 0.5),
        curve: false,
      });
    }

    // A club with no edges under the current filter is muted, not removed --
    // the league shape should stay recognisable while you scrub the years.
    const live = new Set();
    for (const link of links) {
      live.add(link.source.id);
      live.add(link.target.id);
    }
    for (const node of nodes) {
      node.muted =
        !live.has(node.id) || (state.team != null && node.teamId !== state.team && !isNeighbor(node));
    }

    function isNeighbor(node) {
      return links.some(
        (l) =>
          (l.source.id === node.id && l.target.teamId === state.team) ||
          (l.target.id === node.id && l.source.teamId === state.team)
      );
    }

    render();

    sim = forceSimulation(nodes)
      .force(
        'link',
        forceLink(links)
          .id((d) => d.id)
          .distance((d) => 210 - Math.min(d.count, 22) * 4.5)
          .strength((d) => Math.min(0.06 + d.count * 0.012, 0.4))
      )
      .force('charge', forceManyBody().strength(-780).distanceMax(760))
      .force('collide', forceCollide().radius(46).strength(0.9))
      .force('center', forceCenter(canvas.size.width / 2, midY()))
      .force('x', forceX(canvas.size.width / 2).strength(0.035))
      .force('y', forceY(midY()).strength(0.05))
      .alpha(positions.size ? 0.5 : 1)
      .alphaDecay(0.028)
      .on('tick', tick);

    // Count distinct trades: a 3-club deal is credited to several pairings.
    const distinct = new Set();
    for (const link of links) for (const id of link.tradeIds) distinct.add(id);
    note.innerHTML = '';
    note.append(
      el('div', {}, [
        el('b', {}, String(links.length)),
        ` club pairings · ${distinct.size} trade${distinct.size === 1 ? '' : 's'} in view`,
      ]),
      el('div', {}, 'Tap a club for its ledger · tap a line for that pairing')
    );

    clear(actions);
    if (state.team != null) {
      const team = index.teamsById.get(state.team);
      actions.append(
        el('button', { class: 'ghost-btn accent', type: 'button', onClick: () => openClub(state.team) }, [
          `${team.abbreviation} ledger`,
        ]),
        el(
          'button',
          { class: 'ghost-btn', type: 'button', onClick: () => openPlayerWeb(state.team) },
          ['Player web']
        )
      );
    }
    actions.append(
      el('button', { class: 'ghost-btn', type: 'button', onClick: () => canvas.resetZoom() }, [
        'Recenter',
      ])
    );
  }

  /* -------------------------------------------------------- player web mode */

  function buildPlayerWeb(teamId) {
    const team = index.teamsById.get(teamId);
    const tradeIds = index.teamTrades.get(teamId) || [];
    const trades = tradeIds
      .map((id) => index.tradesById.get(id))
      .filter((t) => t && passes(t))
      .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first, so the cap keeps recency

    const seen = new Set();
    const players = [];
    let truncated = false;

    for (const trade of trades) {
      for (const asset of trade.assets) {
        if (asset.kind !== 'player' || asset.personId == null) continue;
        const incoming = asset.toTeamId === teamId;
        const outgoing = asset.fromTeamId === teamId;
        if (!incoming && !outgoing) continue;
        const key = `${asset.personId}-${incoming ? 'in' : 'out'}-${trade.id}`;
        if (seen.has(key)) continue;
        if (players.length >= PLAYER_CAP) {
          truncated = true;
          continue;
        }
        seen.add(key);
        players.push({
          id: `p-${key}`,
          type: 'player',
          personId: asset.personId,
          name: asset.name,
          incoming,
          tradeId: trade.id,
          date: trade.date,
          counterpart: incoming ? asset.fromTeamId : asset.toTeamId,
          teamId: asset.toTeamId,
          r: 19,
        });
      }
    }

    const hub = {
      id: `club-${teamId}`,
      type: 'club',
      teamId,
      name: team.name,
      abbrev: team.abbreviation,
      r: 34,
      fx: canvas.size.width / 2,
      fy: midY(),
    };

    nodes = [hub, ...players];
    links = players.map((player) => ({
      id: `l-${player.id}`,
      source: hub,
      target: player,
      count: 1,
      width: 0.9,
      color: legible(teamColor(player.counterpart)),
      curve: true,
      player,
    }));

    render();

    sim = forceSimulation(nodes)
      .force('link', forceLink(links).id((d) => d.id).distance(230).strength(0.5))
      .force('charge', forceManyBody().strength((d) => (d.type === 'club' ? -1500 : -170)))
      .force('collide', forceCollide().radius((d) => d.r + 16).strength(0.95))
      // Acquired to the left of the hub, sent away to the right.
      .force(
        'x',
        forceX((d) =>
          d.type === 'club'
            ? canvas.size.width / 2
            : canvas.size.width / 2 + (d.incoming ? -1 : 1) * canvas.size.width * 0.26
        ).strength(0.14)
      )
      .force('y', forceY(midY()).strength(0.045))
      .alpha(1)
      .alphaDecay(0.03)
      .on('tick', tick);

    const inCount = players.filter((p) => p.incoming).length;
    note.innerHTML = '';
    note.append(
      el('div', {}, [el('b', {}, team.abbreviation), ` player web · ${players.length} moves shown`]),
      el('div', {}, `${inCount} acquired (left) · ${players.length - inCount} sent (right)`),
      truncated
        ? el('div', {}, `Showing the latest ${PLAYER_CAP} moves in this window`)
        : el('div', {}, 'Tap a face for that player’s trades')
    );

    clear(actions);
    actions.append(
      el(
        'button',
        {
          class: 'ghost-btn accent',
          type: 'button',
          onClick: () => {
            setState({ webMode: 'league', webTeam: null });
          },
        },
        ['← League web']
      ),
      el('button', { class: 'ghost-btn', type: 'button', onClick: () => jumpToFlows(teamId) }, [
        'Team flows',
      ]),
      el('button', { class: 'ghost-btn', type: 'button', onClick: () => canvas.resetZoom() }, [
        'Recenter',
      ])
    );
  }

  /* ---------------------------------------------------------------- render */

  function render() {
    clear(canvas.linkLayer);
    clear(canvas.nodeLayer);

    for (const link of links) {
      link.el = linkGroup({
        color: link.color,
        width: link.width,
        intensity: link.intensity ?? 1,
      });
      link.el.addEventListener('pointerenter', (event) => onLinkEnter(link, event));
      link.el.addEventListener('pointermove', (event) => moveTip(event.clientX, event.clientY));
      link.el.addEventListener('pointerleave', onLeave);
      link.el.addEventListener('click', (event) => {
        event.stopPropagation();
        onLinkClick(link);
      });
      canvas.linkLayer.append(link.el);
    }

    nodes.forEach((node, i) => {
      node.el =
        node.type === 'club'
          ? clubNode(canvas.defs, { teamId: node.teamId, abbreviation: node.abbrev, r: node.r })
          : playerNode(canvas.defs, {
              personId: node.personId,
              name: node.name,
              teamId: node.teamId,
              r: node.r,
              caption: node.name,
            });
      if (node.muted) node.el.classList.add('muted');
      node.el.addEventListener('pointerenter', (event) => onNodeEnter(node, event));
      node.el.addEventListener('pointermove', (event) => moveTip(event.clientX, event.clientY));
      node.el.addEventListener('pointerleave', onLeave);
      node.el.addEventListener('click', (event) => {
        event.stopPropagation();
        onNodeClick(node);
      });
      seed(node, i, nodes.length);
      node.el.setAttribute('transform', `translate(${node.x},${node.y})`);
      canvas.nodeLayer.append(node.el);
    });

    canvas.svg.classList.toggle('dense', nodes.length > 40);
    attachDrag();
    refreshSelection();
  }

  function refreshSelection() {
    for (const node of nodes) node.el?.classList.toggle('selected', node.id === selected);
  }

  /* ------------------------------------------------------------ interaction */

  function neighborsOf(node) {
    const nearNodes = new Set([node.el]);
    const nearLinks = [];
    for (const link of links) {
      if (link.source.id === node.id || link.target.id === node.id) {
        nearLinks.push(link.el);
        nearNodes.add(link.source.el);
        nearNodes.add(link.target.el);
      }
    }
    return { nearNodes: [...nearNodes], nearLinks };
  }

  function onNodeEnter(node, event) {
    const { nearNodes, nearLinks } = neighborsOf(node);
    setFocus(canvas, { hotNodes: [node.el], nearNodes, nearLinks });
    if (node.type === 'club') {
      const degree = nearLinks.length;
      const total = links
        .filter((l) => l.source.id === node.id || l.target.id === node.id)
        .reduce((n, l) => n + l.count, 0);
      showTip(
        `${total} trade${total === 1 ? '' : 's'} with ${degree} club${degree === 1 ? '' : 's'} in this window.`,
        event.clientX,
        event.clientY,
        node.name
      );
    } else {
      const counterpart = index.teamsById.get(node.counterpart);
      showTip(
        `${node.incoming ? 'Acquired from' : 'Sent to'} ${counterpart ? counterpart.name : 'another club'} · ${formatDate(node.date)}`,
        event.clientX,
        event.clientY,
        node.name
      );
    }
  }

  function onLinkEnter(link, event) {
    setFocus(canvas, {
      hotNodes: [],
      nearNodes: [link.source.el, link.target.el],
      nearLinks: [link.el],
    });
    if (link.player) {
      showTip(
        `${link.player.incoming ? 'Acquired' : 'Sent away'} · ${formatDate(link.player.date)}`,
        event.clientX,
        event.clientY,
        link.player.name
      );
      return;
    }
    const dates = link.tradeIds.map((id) => index.tradesById.get(id).date).sort();
    showTip(
      `${link.count} trade${link.count === 1 ? '' : 's'} · ${dates[0].slice(0, 4)}–${dates[dates.length - 1].slice(0, 4)}`,
      event.clientX,
      event.clientY,
      `${link.source.abbrev} ⇄ ${link.target.abbrev}`
    );
  }

  function onLeave() {
    hideTip();
    setFocus(canvas, {});
  }

  function onNodeClick(node) {
    selected = node.id;
    refreshSelection();
    if (node.type === 'club') {
      if (state.webMode === 'team') canvas.zoomTo(node.x, node.y, 1.1);
      openClub(node.teamId);
    } else {
      openPlayer(node);
    }
  }

  function onLinkClick(link) {
    if (link.player) {
      openPlayer(link.player);
      return;
    }
    const trades = link.tradeIds.map((id) => index.tradesById.get(id));
    openPanel({
      kicker: 'Pairing',
      title: `${link.source.abbrev} ⇄ ${link.target.abbrev}`,
      sub: `${link.count} trade${link.count === 1 ? '' : 's'} · ${state.yearMin}–${state.yearMax}`,
      render: (body) => {
        renderTradeList(index, body, trades, {
          onPlayer: (asset) => jumpToChain(asset.personId, findTradeFor(asset, trades)),
        });
      },
    });
  }

  function openClub(teamId) {
    const team = index.teamsById.get(teamId);
    const trades = (index.teamTrades.get(teamId) || [])
      .map((id) => index.tradesById.get(id))
      .filter((t) => t && passes(t));

    openPanel({
      kicker: 'Club ledger',
      title: team.name,
      sub: `${trades.length} trade${trades.length === 1 ? '' : 's'} · ${state.yearMin}–${state.yearMax}`,
      render: (body) => {
        const bar = el('div', { class: 'asset-row', style: { margin: '4px 0 14px' } }, [
          el(
            'button',
            {
              class: 'ghost-btn accent',
              type: 'button',
              onClick: () => openPlayerWeb(teamId),
            },
            ['Open player web']
          ),
          el('button', { class: 'ghost-btn', type: 'button', onClick: () => jumpToFlows(teamId) }, [
            'Team flows',
          ]),
          el(
            'button',
            {
              class: 'ghost-btn',
              type: 'button',
              onClick: () => setState({ team: state.team === teamId ? null : teamId }),
            },
            [state.team === teamId ? 'Clear club filter' : 'Filter to this club']
          ),
        ]);
        body.append(bar);
        const list = el('div');
        body.append(list);
        renderTradeList(index, list, trades, {
          onPlayer: (asset) => jumpToChain(asset.personId, findTradeFor(asset, trades)),
        });
      },
    });
  }

  function openPlayer(node) {
    const player = index.playerIndex.get(node.personId);
    const trades = (player?.trades || []).map((id) => index.tradesById.get(id));
    openPanel({
      kicker: 'Player',
      title: node.name,
      sub: `${trades.length} trade${trades.length === 1 ? '' : 's'} on record`,
      render: (body) => {
        body.append(
          el('div', { class: 'asset-row', style: { margin: '4px 0 14px' } }, [
            el(
              'button',
              {
                class: 'ghost-btn accent',
                type: 'button',
                onClick: () => jumpToChain(node.personId, node.tradeId),
              },
              ['View chain →']
            ),
          ])
        );
        const list = el('div');
        body.append(list);
        renderTradeList(index, list, trades, {
          onPlayer: (asset) => jumpToChain(asset.personId, findTradeFor(asset, trades)),
        });
      },
    });
  }

  function openPlayerWeb(teamId) {
    setState({ webMode: 'team', webTeam: teamId });
  }

  function findTradeFor(asset, trades) {
    const hit = trades.find((t) => t.assets.some((a) => a === asset));
    if (hit) return hit.id;
    const player = index.playerIndex.get(asset.personId);
    return player ? player.trades[0] : null;
  }

  /* ------------------------------------------------------------------- api */

  function update() {
    rememberPositions();
    stopSim();
    selected = null;
    if (state.webMode === 'team' && state.webTeam != null) buildPlayerWeb(state.webTeam);
    else buildLeague();
  }

  return {
    update,
    destroy() {
      stopSim();
      canvas.destroy();
    },
  };
}
