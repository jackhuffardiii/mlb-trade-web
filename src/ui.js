// Shared UI primitives: DOM helpers, headshots, club chips, the detail panel,
// the graph tooltip, trade rendering and the search index.

import { assetLabel, formatDate, KIND_GLYPH, loadPlayers, loadSavant } from './data.js';
import { tradeSentence } from './chain.js';
import { legible, rgba, teamColor } from './teams.js';

/* -------------------------------------------------------------- DOM helpers */

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const SVG_NS = 'http://www.w3.org/2000/svg';

export function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    node.setAttribute(key, value === true ? '' : String(value));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/* ------------------------------------------------------------------ people */

/**
 * The only external origin this app touches. Unknown/retired ids still answer
 * 200 with MLB's generic silhouette, so the URL scheme is its own fallback.
 */
export function headshotURL(personId) {
  return `https://midfield.mlbstatic.com/v1/people/${personId}/spots/120`;
}

export function initials(name) {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

/* -------------------------------------------------------------------- chips */

export function clubChip(index, teamId, { button = false, onClick } = {}) {
  const team = index.teamsById.get(teamId);
  const lit = legible(teamColor(teamId));
  const props = {
    class: 'chip',
    style: { '--club-lit': lit },
    title: team ? team.name : `Team ${teamId}`,
  };
  if (button) {
    props.type = 'button';
    if (onClick) props.onClick = onClick;
    return el('button', props, team ? team.abbreviation : String(teamId));
  }
  return el('span', props, team ? team.abbreviation : String(teamId));
}

/** One asset as a pill: headshot (players only), name, destination club. */
export function assetPill(index, asset, { onPlayer } = {}) {
  const destColor = legible(teamColor(asset.toTeamId));
  const isPlayer = asset.kind === 'player' && asset.personId != null;
  const dest = index.teamsById.get(asset.toTeamId);

  const face = isPlayer
    ? el('img', {
        class: 'face',
        src: headshotURL(asset.personId),
        alt: '',
        loading: 'lazy',
        decoding: 'async',
        referrerpolicy: 'no-referrer',
      })
    : el('span', { class: 'face blank' }, KIND_GLYPH[asset.kind] || '·');

  const kids = [
    face,
    el('span', { class: 'asset-name' }, assetLabel(asset)),
    el('span', { class: 'arrow' }, '→'),
    el('span', { class: 'arrow' }, dest ? dest.abbreviation : '?'),
  ];

  const style = { '--club-lit': destColor };

  if (isPlayer && onPlayer) {
    return el(
      'button',
      {
        class: 'asset',
        type: 'button',
        style,
        title: `Follow ${asset.name} in the Chain Explorer`,
        onClick: () => onPlayer(asset),
      },
      kids
    );
  }
  return el('span', { class: 'asset', style }, kids);
}

/* ------------------------------------------------------------- trade blocks */

export function tradeBlock(index, trade, { onPlayer, delay = 0 } = {}) {
  const sentence = tradeSentence(index, trade);
  const reconstructed = !(trade.description && trade.description.trim());

  return el('article', { class: 'trade', style: { animationDelay: `${delay}ms` } }, [
    el('div', { class: 'trade-meta' }, [
      el('span', { class: 'trade-date' }, formatDate(trade.date)),
      ...trade.teamIds.map((id) => clubChip(index, id)),
    ]),
    el('p', { class: `trade-desc${reconstructed ? ' reconstructed' : ''}` }, sentence),
    el(
      'div',
      { class: 'asset-row' },
      trade.assets.map((asset) => assetPill(index, asset, { onPlayer }))
    ),
  ]);
}

/** Newest-first list of trades, rendered into a container. */
export function renderTradeList(index, container, trades, { onPlayer, emptyNote } = {}) {
  clear(container);
  if (!trades.length) {
    container.append(el('p', { class: 'empty-note' }, emptyNote || 'No trades in this window.'));
    return;
  }
  const sorted = trades.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  sorted.forEach((trade, i) => {
    container.append(tradeBlock(index, trade, { onPlayer, delay: Math.min(i, 12) * 22 }));
  });
}

/* -------------------------------------------------------------------- panel */

const panelEl = () => document.getElementById('panel');

export function openPanel({ kicker, title, sub, render }) {
  const panel = panelEl();
  document.getElementById('panel-kicker').textContent = kicker || '';
  document.getElementById('panel-title').textContent = title || '';
  const subEl = document.getElementById('panel-sub');
  subEl.textContent = sub || '';
  subEl.style.display = sub ? '' : 'none';
  const body = clear(document.getElementById('panel-body'));
  if (render) render(body);
  panel.dataset.open = 'true';
  // Lets the workspace dock away from the panel on desktop instead of hiding
  // under it; the canvas ResizeObserver picks up the new width.
  document.querySelector('.app')?.setAttribute('data-panel', 'open');
}

export function closePanel() {
  const panel = panelEl();
  if (panel) delete panel.dataset.open;
  document.querySelector('.app')?.removeAttribute('data-panel');
}

/* ------------------------------------------------------------------ tooltip */

let tipTimer = null;

export function showTip(html, x, y, title) {
  const tip = document.getElementById('tip');
  if (!tip) return;
  clearTimeout(tipTimer);
  clear(tip);
  if (title) tip.append(el('div', { class: 'tip-title' }, title));
  tip.append(el('div', { class: 'tip-body' }, html));
  tip.dataset.open = 'true';
  positionTip(tip, x, y);
}

export function moveTip(x, y) {
  const tip = document.getElementById('tip');
  if (tip && tip.dataset.open === 'true') positionTip(tip, x, y);
}

function positionTip(tip, x, y) {
  const rect = tip.getBoundingClientRect();
  const pad = 14;
  let left = x + pad;
  let top = y + pad;
  if (left + rect.width > window.innerWidth - 10) left = x - rect.width - pad;
  if (top + rect.height > window.innerHeight - 10) top = y - rect.height - pad;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

export function hideTip() {
  const tip = document.getElementById('tip');
  if (!tip) return;
  delete tip.dataset.open;
}

/* ------------------------------------------------------------- trade cards */

/**
 * One trade as a card figure, in the same visual language as the Team Flows
 * grid: the deal is a club-coloured disc, each club's haul is a column of dots
 * either side. Players are filled, considerations are hollow and dashed.
 */
export function tradeMiniature(index, trade) {
  const W = 300;
  const H = 118;
  const svg = svgEl('svg', {
    class: 'mini',
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'xMidYMid meet',
    'aria-hidden': 'true',
  });

  // Two sides: assets going to the first club, and everything else.
  const [left, right] = [trade.teamIds[0], trade.teamIds[1] ?? trade.teamIds[0]];
  const sides = [
    { teamId: left, assets: trade.assets.filter((a) => a.toTeamId === left), x: 62 },
    { teamId: right, assets: trade.assets.filter((a) => a.toTeamId !== left), x: W - 62 },
  ];

  const midX = W / 2;
  const midY = H / 2;

  for (const side of sides) {
    const lit = legible(teamColor(side.teamId));
    const n = side.assets.length;
    const step = Math.min(24, (H - 30) / Math.max(n - 1, 1));
    side.assets.forEach((asset, i) => {
      const y = midY + (i - (n - 1) / 2) * step;
      const bend = (side.x + midX) / 2;
      svg.append(
        svgEl('path', {
          d: `M${midX},${midY}C${bend},${midY} ${bend},${y} ${side.x},${y}`,
          fill: 'none',
          stroke: rgba(lit, 0.4),
          'stroke-width': 1,
        })
      );
      const player = asset.kind === 'player';
      svg.append(
        svgEl('circle', {
          cx: side.x,
          cy: y,
          r: player ? 3.4 : 2.4,
          fill: player ? rgba(lit, 0.85) : 'none',
          stroke: rgba(lit, player ? 0.9 : 0.55),
          'stroke-width': 1,
          'stroke-dasharray': player ? null : '2 2',
        })
      );
    });
  }

  const discColor = legible(teamColor(left));
  svg.append(
    svgEl('circle', {
      cx: midX,
      cy: midY,
      r: 7,
      fill: rgba(discColor, 0.24),
      stroke: discColor,
      'stroke-width': 1.4,
    })
  );
  return svg;
}

/** The 1-3 names worth putting faces on: the players, biggest package first. */
function marqueeOf(trade) {
  return trade.assets
    .filter((a) => a.kind === 'player' && a.personId != null)
    .slice(0, 3);
}

/**
 * A trade as a grid card. Shares the Team Flows card markup and CSS wholesale,
 * so the three landing surfaces read as one system.
 */
export function tradeCard(index, trade, { onClick, index: i = 0 } = {}) {
  const lit = legible(teamColor(trade.teamIds[0]));
  const marquee = marqueeOf(trade);
  const players = trade.assets.filter((a) => a.kind === 'player').length;
  const others = trade.assets.length - players;

  const faces = el(
    'div',
    { class: 'tree-faces' },
    marquee.map((m) =>
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

  const names = marquee.map((m) => m.name).filter(Boolean);
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
      title: tradeSentence(index, trade),
      onClick,
    },
    [
      el('div', { class: 'tree-card-figure' }, [tradeMiniature(index, trade)]),
      el('div', { class: 'tree-card-body' }, [
        faces.children.length ? faces : null,
        el('h3', { class: 'tree-card-title' }, caption),
        el('div', { class: 'tree-card-meta' }, [
          el('span', {}, trade.teamIds.map((id) => index.teamsById.get(id)?.abbreviation || id).join(' ⇄ ')),
          el('span', {}, `${players} player${players === 1 ? '' : 's'}`),
          others ? el('span', {}, `+${others}`) : null,
          el('span', {}, formatDate(trade.date)),
        ]),
      ]),
    ]
  );
}

/** Big, multi-player deals, newest first. The shared picker for both landings. */
export function notableTrades(index, { limit = 12, minPlayers = 4, before = null } = {}) {
  return index.trades
    .filter((t) => {
      if (t.assets.filter((a) => a.kind === 'player').length < minPlayers) return false;
      return before == null || Number(t.date.slice(0, 4)) <= before;
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, limit);
}

/* ---------------------------------------------------------------- dossier */

const SAVANT = (personId) => `https://baseballsavant.mlb.com/savant-player/${personId}`;

/** "RHP · B/T R/L · Debut 2020" -- whatever of it we actually know. */
function bioLine(entry) {
  const parts = [];
  if (entry.position) parts.push(entry.position);
  if (entry.bats && entry.throws) parts.push(`B/T ${entry.bats}/${entry.throws}`);
  if (entry.debut) parts.push(`Debut ${entry.debut.slice(0, 4)}`);
  return parts.join(' · ');
}

/**
 * Season ledger for one player, newest last, with the trade cut in as a rule.
 * Rows are per season AND team, so a mid-season deal shows both stints -- that
 * split IS the before/after, without needing a value metric to summarise it.
 */
function ledger(index, entry, pivot) {
  const pitcher = entry.position === 'P' && entry.pitching?.length;
  const rows = (pitcher ? entry.pitching : entry.hitting) || [];
  if (!rows.length) {
    return el(
      'p',
      { class: 'dossier-empty' },
      'No major-league record in this window. Traded as a prospect or before 2015.'
    );
  }

  const cols = pitcher
    ? [['IP', (r) => r.ip], ['ERA', (r) => r.era], ['SO', (r) => r.so]]
    : [['PA', (r) => r.pa], ['OPS', (r) => (r.ops || '').replace(/^0/, '')], ['HR', (r) => r.hr]];

  const table = el('div', { class: 'ledger-grid' });
  table.append(
    el('span', { class: 'lg-head' }, 'Yr'),
    el('span', { class: 'lg-head' }, 'Club'),
    ...cols.map(([label]) => el('span', { class: 'lg-head num' }, label))
  );

  // Where the trade falls: the first row at or after the deal on the new club.
  const cutAt = pivot
    ? rows.findIndex(
        (r) => r.season > pivot.year || (r.season === pivot.year && r.teamId === pivot.toTeamId)
      )
    : -1;

  rows.forEach((row, i) => {
    if (i === cutAt) table.append(tradeRule(index, pivot));
    const lit = legible(teamColor(row.teamId));
    const team = index.teamsById.get(row.teamId);
    table.append(
      el('span', { class: 'lg-yr' }, String(row.season)),
      el('span', { class: 'lg-club', style: { '--club-lit': lit } }, team ? team.abbreviation : '—'),
      ...cols.map(([, get]) => el('span', { class: 'lg-num' }, String(get(row) ?? '—')))
    );
  });
  if (cutAt === -1 && pivot) table.append(tradeRule(index, pivot));
  return table;
}

function tradeRule(index, pivot) {
  const to = index.teamsById.get(pivot.toTeamId);
  return el('div', { class: 'lg-rule' }, [
    el('span', {}, `Traded to ${to ? to.abbreviation : '?'} · ${formatDate(pivot.date)}`),
  ]);
}

/* ------------------------------------------------------- percentile bars */

/**
 * Savant's diverging scale, warmed to sit on this page's near-black rather than
 * their white card: steel blue at cold, neutral at the median, ember at hot.
 * The convention is worth keeping -- anyone who reads Savant reads this instantly.
 */
function percentileColor(p) {
  const stops = [
    [0, [72, 118, 168]],
    [50, [104, 110, 122]],
    [100, [214, 78, 62]],
  ];
  const i = p <= 50 ? 0 : 1;
  const [lo, a] = stops[i];
  const [hi, b] = stops[i + 1];
  const t = (p - lo) / (hi - lo);
  return `rgb(${a.map((c, n) => Math.round(c + (b[n] - c) * t)).join(',')})`;
}

/**
 * One season of percentiles as a bar card. Prefers the season of the trade;
 * falls back to the most recent earlier season, because a July deal often has
 * only a partial current year and the prior full season is the better read.
 */
function percentileCard(savant, personId, pivotYear) {
  const seasons = savant.players?.[String(personId)];
  if (!seasons) return null;

  const years = Object.keys(seasons).map(Number).sort((a, b) => a - b);
  if (!years.length) return null;
  const year =
    pivotYear && seasons[pivotYear]
      ? pivotYear
      : pivotYear
        ? years.filter((y) => y < pivotYear).pop() ?? years[years.length - 1]
        : years[years.length - 1];

  const row = seasons[year];
  const metrics = Object.entries(row).filter(([k]) => k !== 'type');
  if (!metrics.length) return null;

  const card = el('div', { class: 'pct-card' });
  card.append(
    el('div', { class: 'pct-head' }, [
      el('span', {}, 'Statcast percentiles'),
      el('span', { class: 'pct-year' }, String(year)),
    ])
  );

  for (const [key, value] of metrics) {
    card.append(
      el('div', { class: 'pct-row' }, [
        el('span', { class: 'pct-label' }, savant.labels?.[key] || key),
        el('span', { class: 'pct-track' }, [
          el('span', {
            class: 'pct-dot',
            style: { left: `${value}%`, background: percentileColor(value) },
            text: String(value),
          }),
        ]),
      ])
    );
  }

  if (year !== pivotYear && pivotYear) {
    card.append(el('p', { class: 'pct-note' }, `No Statcast season in ${pivotYear}; showing ${year}.`));
  }
  return card;
}

/**
 * The player block that sits above the trade list in every player panel.
 * Returns synchronously with a placeholder; the season data is a separate
 * ~590 KB file, so it is fetched on first use and shared from then on.
 */
export function playerDossier(index, personId, tradeId = null) {
  const host = el('div', { class: 'dossier' });
  host.append(el('div', { class: 'dossier-wait' }, 'Loading season data…'));

  loadPlayers()
    .then((players) => {
      const entry = players[String(personId)];
      clear(host);
      if (!entry) {
        host.append(el('p', { class: 'dossier-empty' }, 'No season data on record.'));
        return;
      }

      const trade = tradeId != null ? index.tradesById.get(tradeId) : null;
      const moved = trade?.assets.find((a) => a.personId === personId);
      const pivot = moved
        ? { year: Number(trade.date.slice(0, 4)), date: trade.date, toTeamId: moved.toTeamId }
        : null;

      const bio = bioLine(entry);
      host.append(
        el('div', { class: 'dossier-head' }, [
          bio ? el('span', { class: 'dossier-bio' }, bio) : null,
          el(
            'a',
            {
              class: 'savant-link',
              href: SAVANT(personId),
              target: '_blank',
              rel: 'noopener noreferrer',
            },
            ['Savant ↗']
          ),
        ]),
        ledger(index, entry, pivot)
      );

      // Savant covers 99.9% of players who reached MLB but only ~56% of
      // player-trade rows, so this is additive: absent card, not empty card.
      loadSavant()
        .then((savant) => {
          const card = percentileCard(savant, personId, pivot?.year ?? null);
          if (card) host.append(card);
        })
        .catch(() => {});
    })
    .catch(() => {
      clear(host);
      host.append(el('p', { class: 'dossier-empty' }, 'Season data unavailable.'));
    });

  return host;
}

/* -------------------------------------------------------------- navigation */

export function jumpToChain(personId, tradeId) {
  document.dispatchEvent(new CustomEvent('jump:chain', { detail: { personId, tradeId } }));
}

export function jumpToCompare(tradeId) {
  document.dispatchEvent(new CustomEvent('jump:compare', { detail: { tradeId } }));
}

export function jumpToFlows(teamId) {
  document.dispatchEvent(new CustomEvent('jump:flows', { detail: { teamId } }));
}

/* ------------------------------------------------------------------ search */

const strip = (s) =>
  (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

export function buildSearchIndex(index) {
  const entries = [];
  for (const team of index.teams) {
    entries.push({
      type: 'team',
      id: team.id,
      label: team.name,
      meta: team.abbreviation,
      hay: strip(`${team.name} ${team.abbreviation}`),
      weight: (index.teamTrades.get(team.id) || []).length,
    });
  }

  // personId -> clubs involved, used to bias results when a club filter is on.
  const clubsOf = new Map();
  for (const trade of index.trades) {
    for (const asset of trade.assets) {
      if (asset.kind !== 'player' || asset.personId == null) continue;
      let set = clubsOf.get(asset.personId);
      if (!set) clubsOf.set(asset.personId, (set = new Set()));
      set.add(asset.fromTeamId);
      set.add(asset.toTeamId);
    }
  }

  for (const player of index.playerIndex.values()) {
    entries.push({
      type: 'player',
      id: player.personId,
      label: player.name,
      meta: `${player.trades.length} trade${player.trades.length === 1 ? '' : 's'}`,
      hay: strip(player.name),
      weight: player.trades.length,
      clubs: clubsOf.get(player.personId) || new Set(),
    });
  }
  return entries;
}

/** Fuzzy prefix match. Whole-string prefix beats word prefix beats subsequence. */
export function searchEntries(entries, rawQuery, { teamId = null, limit = 9 } = {}) {
  const query = strip(rawQuery).trim();
  if (!query) return [];
  const scored = [];

  for (const entry of entries) {
    let score = 0;
    if (entry.hay.startsWith(query)) score = 100;
    else {
      const wordHit = entry.hay.split(/[\s.'-]+/).some((w) => w.startsWith(query));
      if (wordHit) score = 78;
      else if (entry.hay.includes(query)) score = 52;
      else if (isSubsequence(query, entry.hay)) score = 26;
    }
    if (!score) continue;
    if (entry.type === 'team') score += 8;
    if (teamId != null && entry.type === 'player' && entry.clubs && entry.clubs.has(teamId)) {
      score += 30; // club filter on: surface that club's players first
    }
    score += Math.min(entry.weight, 12) * 0.4;
    scored.push({ entry, score });
  }

  scored.sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label));
  return scored.slice(0, limit).map((s) => s.entry);
}

function isSubsequence(needle, hay) {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

export { rgba, legible, teamColor, formatDate };
