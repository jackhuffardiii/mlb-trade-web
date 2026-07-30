// Chain Explorer, "All trades" mode -- one player's whole career as a
// chronological flow chart, earliest deal on the left.
//
// The spine is the player: a glowing line running left to right, segmented and
// labelled by the club he was on during each span. Every trade is a stop on that
// line, with what moved alongside him stacked above and what came back stacked
// below. Ordinal spacing, not to scale: the gaps are equal, the dates are printed.

import { formatDate, KIND_GLYPH, KIND_LABEL } from '../data.js';
import { tradeSentence } from '../chain.js';
import { legible, rgba, teamColor } from '../teams.js';
import { assetNode, headerInset, playerNode, setFocus } from '../graph.js';
import { hideTip, moveTip, openPanel, showTip, svgEl, tradeBlock } from '../ui.js';

const COL = 270; // horizontal distance between trades (ordinal, not to scale)
const LEAD = 130; // the run-in / run-out stubs at either end
const STACK_STEP = 46;
// The date and from→to labels live just under each stop, so the lower stack has
// to start further out than the upper one.
const STACK_START = { '-1': 66, 1: 104 };
const CONNECT_START = { '-1': 26, 1: 72 };
const MAX_PER_SIDE = 4;

function truncate(text, max = 18) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Draw the career timeline into an existing canvas handle.
 *
 * @param {object} canvas from makeCanvas()
 * @param {object} index
 * @param {number} personId
 * @param {{onPlayer:(personId:number, tradeId:number)=>void}} handlers
 * @returns {{trades:number, first:string, last:string, clubs:number}} summary
 */
export function renderTimeline(canvas, index, personId, { onPlayer } = {}) {
  const player = index.playerIndex.get(personId);
  const stops = (player?.trades || [])
    .map((tradeId) => {
      const trade = index.tradesById.get(tradeId);
      const row = trade?.assets.find((a) => a.personId === personId);
      return trade && row ? { trade, row } : null;
    })
    .filter(Boolean);

  if (!stops.length) return { trades: 0 };

  const spineLayer = svgEl('g', { class: 'spine-layer' });
  const connectorLayer = svgEl('g', { class: 'connector-layer' });
  canvas.linkLayer.append(spineLayer, connectorLayer);

  const columns = stops.map((stop, i) => ({ ...stop, x: i * COL, els: [] }));

  /* ------------------------------------------------------------ the spine */

  const segment = (x1, x2, teamId, { dashed = false } = {}) => {
    const lit = legible(teamColor(teamId));
    const team = index.teamsById.get(teamId);
    const g = svgEl('g', { class: 'spine-seg' });
    g.append(
      svgEl('line', {
        x1,
        y1: 0,
        x2,
        y2: 0,
        stroke: rgba(lit, 0.16),
        'stroke-width': 13,
        'stroke-linecap': 'round',
      })
    );
    g.append(
      svgEl('line', {
        x1,
        y1: 0,
        x2,
        y2: 0,
        stroke: lit,
        'stroke-width': 3,
        'stroke-linecap': 'round',
        'stroke-dasharray': dashed ? '5 6' : null,
      })
    );
    const label = svgEl('text', {
      class: 'seg-label',
      x: (x1 + x2) / 2,
      y: -19,
      fill: lit,
    });
    label.textContent = team ? team.abbreviation : '—';
    g.append(label);
    const title = svgEl('title');
    title.textContent = team ? team.name : `Team ${teamId}`;
    g.append(title);
    spineLayer.append(g);
    return g;
  };

  // Run-in: the club he was with before the first trade on record.
  segment(columns[0].x - LEAD, columns[0].x, columns[0].row.fromTeamId);

  for (let i = 0; i < columns.length - 1; i++) {
    const held = columns[i].row.toTeamId;
    const nextFrom = columns[i + 1].row.fromTeamId;
    const x1 = columns[i].x;
    const x2 = columns[i + 1].x;
    if (held === nextFrom) {
      segment(x1, x2, held);
    } else {
      // He changed clubs between trades by some route the data doesn't carry
      // (waivers, free agency, a minor-league move). Show the break honestly.
      const mid = (x1 + x2) / 2;
      segment(x1, mid - 9, held);
      segment(mid + 9, x2, nextFrom, { dashed: true });
    }
  }

  const last = columns[columns.length - 1];
  segment(last.x, last.x + LEAD, last.row.toTeamId);

  /* ------------------------------------------------------------- the stops */

  const openTrade = (trade) => {
    const clubs = trade.teamIds
      .map((id) => index.teamsById.get(id)?.abbreviation || id)
      .join(' ⇄ ');
    openPanel({
      kicker: 'Trade',
      title: clubs,
      sub: formatDate(trade.date),
      render: (body) => {
        body.append(
          tradeBlock(index, trade, {
            onPlayer: (asset) => onPlayer?.(asset.personId, trade.id),
          })
        );
      },
    });
  };

  const attach = (node, column, { tip, onClick }) => {
    node.addEventListener('pointerenter', (event) => {
      setFocus(canvas, { hotNodes: [node], nearNodes: column.els });
      showTip(tip.body, event.clientX, event.clientY, tip.title);
    });
    node.addEventListener('pointermove', (event) => moveTip(event.clientX, event.clientY));
    node.addEventListener('pointerleave', () => {
      hideTip();
      setFocus(canvas, {});
    });
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    column.els.push(node);
    canvas.nodeLayer.append(node);
  };

  for (const column of columns) {
    const { trade, row, x } = column;
    const from = index.teamsById.get(row.fromTeamId);
    const to = index.teamsById.get(row.toTeamId);

    // Everything else in the deal, split by which way it went.
    const others = trade.assets.filter((a) => a !== row);
    const alongside = others.filter((a) => a.toTeamId === row.toTeamId);
    const theOtherWay = others.filter((a) => a.toTeamId !== row.toTeamId);

    const stack = (assets, direction) => {
      const shown = assets.slice(0, MAX_PER_SIDE);
      const hidden = assets.length - shown.length;
      const start = STACK_START[String(direction)];

      shown.forEach((asset, i) => {
        const y = direction * (start + i * STACK_STEP);
        const isPlayer = asset.kind === 'player' && asset.personId != null;
        const node = isPlayer
          ? playerNode(canvas.defs, {
              personId: asset.personId,
              name: asset.name,
              teamId: asset.toTeamId,
              r: 15,
              caption: truncate(asset.name),
            })
          : assetNode({
              glyph: KIND_GLYPH[asset.kind] || '·',
              teamId: asset.toTeamId,
              r: 12,
              caption: KIND_LABEL[asset.kind] || asset.kind,
            });
        node.setAttribute('transform', `translate(${x},${y})`);
        node.classList.add('timeline-side');

        connector(
          x,
          direction * (i === 0 ? CONNECT_START[String(direction)] : start + (i - 1) * STACK_STEP + 16),
          x,
          y - direction * 16,
          asset.toTeamId
        );

        const dest = index.teamsById.get(asset.toTeamId);
        attach(node, column, {
          tip: {
            title: asset.kind === 'player' ? asset.name : KIND_LABEL[asset.kind],
            body: `${direction < 0 ? 'Moved with' : 'Came back for'} ${player.name} · to ${dest ? dest.name : '?'}`,
          },
          onClick: () => {
            if (isPlayer) onPlayer?.(asset.personId, trade.id);
            else openTrade(trade);
          },
        });
      });

      if (hidden > 0) {
        const y = direction * (start + shown.length * STACK_STEP);
        const more = svgEl('g', { class: 'node more-node' });
        more.append(
          svgEl('circle', {
            r: 13,
            fill: '#12151d',
            stroke: 'rgba(232,180,76,.55)',
            'stroke-width': 1,
          })
        );
        const text = svgEl('text', { class: 'abbrev', fill: '#e8b44c', 'font-size': 10 });
        text.textContent = `+${hidden}`;
        more.append(text);
        more.append(svgEl('circle', { class: 'hit', r: 24, fill: 'transparent' }));
        more.setAttribute('transform', `translate(${x},${y})`);
        attach(more, column, {
          tip: { title: `${hidden} more`, body: 'Open the trade for the full package.' },
          onClick: () => openTrade(trade),
        });
      }
    };

    stack(alongside, -1); // above the spine: went with him
    stack(theOtherWay, 1); // below the spine: came the other way

    // The focal player sits on the spine, ringed by the club receiving him.
    const focal = playerNode(canvas.defs, {
      personId,
      name: player.name,
      teamId: row.toTeamId,
      r: 24,
    });
    focal.setAttribute('transform', `translate(${x},0)`);
    focal.classList.add('timeline-stop');

    const date = svgEl('text', { class: 'stop-date', x, y: 46 });
    date.textContent = formatDate(trade.date);
    canvas.nodeLayer.append(date);

    const move = svgEl('text', { class: 'stop-move', x, y: 62 });
    move.textContent = `${from ? from.abbreviation : '?'} → ${to ? to.abbreviation : '?'}`;
    canvas.nodeLayer.append(move);

    attach(focal, column, {
      tip: {
        title: `${formatDate(trade.date)} · ${from ? from.abbreviation : '?'} → ${to ? to.abbreviation : '?'}`,
        body: tradeSentence(index, trade),
      },
      onClick: () => openTrade(trade),
    });
    column.els.push(date, move);
  }

  function connector(x1, y1, x2, y2, teamId) {
    const lit = legible(teamColor(teamId));
    connectorLayer.append(
      svgEl('line', {
        class: 'timeline-connector',
        x1,
        y1,
        x2,
        y2,
        stroke: rgba(lit, 0.4),
        'stroke-width': 1,
        'stroke-dasharray': '2 4',
      })
    );
  }

  /* --------------------------------------------------------------- framing */

  const contentLeft = columns[0].x - LEAD - 40;
  const contentRight = last.x + LEAD + 40;
  const totalWidth = contentRight - contentLeft;

  /**
   * Re-frame without redrawing. Called on resize (docking the panel changes the
   * width) so the headshots aren't torn down and re-fetched.
   */
  function refit(duration = 620) {
    const inset = headerInset();
    const centerY = inset + (canvas.size.height - inset) / 2;
    // Fit to width where it fits, but never shrink below a readable node size --
    // a long career pans instead.
    const fitScale = (canvas.size.width - 60) / totalWidth;
    const scale = Math.min(1.05, Math.max(0.75, fitScale));

    if (totalWidth * scale <= canvas.size.width - 60) {
      canvas.zoomToPoint(
        (contentLeft + contentRight) / 2,
        0,
        scale,
        canvas.size.width / 2,
        centerY,
        duration
      );
    } else {
      // Too wide to fit: start at the earliest trade and let the reader pan right.
      canvas.zoomToPoint(contentLeft, 0, scale, 30, centerY, duration);
    }
    return totalWidth * scale > canvas.size.width - 60;
  }

  const scrolls = refit();

  const clubs = new Set();
  clubs.add(columns[0].row.fromTeamId);
  for (const column of columns) clubs.add(column.row.toTeamId);

  return {
    trades: columns.length,
    first: columns[0].trade.date,
    last: last.trade.date,
    clubs: clubs.size,
    scrolls,
    refit,
  };
}
