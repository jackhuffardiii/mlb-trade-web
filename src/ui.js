// Shared UI primitives: DOM helpers, headshots, club chips, the detail panel,
// the graph tooltip, trade rendering and the search index.

import { assetLabel, formatDate, KIND_GLYPH, loadPlayers } from './data.js';
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
