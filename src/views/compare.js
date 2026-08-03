// View IV -- Trade Returns.
//
// Pick a trade, and for each club see what it actually got out of the players it
// acquired, counted only while those players were on that club and only from the
// trade forward. Deliberately a ledger, not a verdict: there is no value metric
// here yet, so the page reports production and lets the reader judge.
//
// What can honestly be added up, and what cannot, drives the whole design.
// Counting stats sum exactly. ERA and AVG are recomputed from their components
// (9*ER/IP, H/AB), so they are exact too. OPS and SLG are NOT shown in the
// totals: the dataset carries no doubles, triples, HBP or sac flies, so they
// cannot be rebuilt from an aggregate and a PA-weighted average of season OPS
// would be a fabrication dressed as a number.

import { formatDate, loadPlayers } from '../data.js';
import { tradeSentence } from '../chain.js';
import { legible, teamColor } from '../teams.js';
import { clear, el, jumpToChain, headshotURL, notableTrades, tradeCard } from '../ui.js';
import { setState, state } from '../state.js';

/** Sums exactly across seasons. Anything not here cannot be aggregated honestly. */
const HIT_SUM = ['g', 'pa', 'ab', 'h', 'hr', 'bb', 'so', 'sb'];
const PITCH_SUM = ['g', 'gs', 'er', 'so', 'bb', 'h', 'hr', 'w', 'l', 'sv'];

function ipToOuts(ip) {
  // "192.1" is 192 innings and 1 out, not 192.1 innings.
  const [whole, frac] = String(ip ?? 0).split('.');
  return Number(whole) * 3 + Number(frac || 0);
}

function outsToIp(outs) {
  return `${Math.floor(outs / 3)}.${outs % 3}`;
}

/**
 * What one club got from one player after this trade: every season row on that
 * club from the trade season forward. The trade-season row is already the
 * post-trade stint, because rows are split by team.
 *
 * ponytail: a player re-acquired by the same club years later would have those
 * later stints counted here too. Rare enough to accept; fix by bounding on the
 * next trade that moves him off the club if it ever matters.
 */
function contribution(entry, teamId, fromYear) {
  const take = (rows) => (rows || []).filter((r) => r.teamId === teamId && r.season >= fromYear);
  return { hitting: take(entry?.hitting), pitching: take(entry?.pitching) };
}

function total(rows, keys) {
  const out = {};
  for (const key of keys) out[key] = rows.reduce((n, r) => n + (Number(r[key]) || 0), 0);
  return out;
}

export function createCompareView(host, index) {
  clear(host);
  const shell = el('div', { class: 'compare-shell' });
  host.append(shell);

  let players = null;

  function update() {
    const trade = state.compareTrade != null ? index.tradesById.get(state.compareTrade) : null;
    if (!trade) {
      renderEmpty();
      return;
    }
    if (!players) {
      clear(shell);
      shell.append(el('p', { class: 'dossier-wait' }, 'Loading season data…'));
      loadPlayers()
        .then((p) => {
          players = p;
          update();
        })
        .catch(() => {
          clear(shell);
          shell.append(el('p', { class: 'dossier-empty' }, 'Season data unavailable.'));
        });
      return;
    }
    renderTrade(trade);
  }

  function renderEmpty() {
    clear(shell);
    const grid = el('div', { class: 'tree-grid' });
    // Deals with enough years behind them to have produced something. A trade
    // from last week is a correct but blank ledger, a poor way in.
    notableTrades(index, { limit: 12, before: index.maxYear - 3 }).forEach((trade, i) =>
      grid.append(
        tradeCard(index, trade, { index: i, onClick: () => setState({ compareTrade: trade.id }) })
      )
    );

    shell.append(
      el('div', { class: 'compare-empty' }, [
        el('h2', {}, 'What did each club actually get?'),
        el(
          'p',
          {},
          'Pick a trade. Every player each club acquired is followed forward, and only what they did for that club after the deal is counted. Production, not a verdict: there is no value metric here, so the totals are the evidence and the judgement is yours.'
        ),
      ]),
      grid
    );
  }

  function renderTrade(trade) {
    clear(shell);
    const year = Number(trade.date.slice(0, 4));

    shell.append(
      el('header', { class: 'compare-head' }, [
        el('div', { class: 'compare-kicker' }, 'Trade returns'),
        el('h2', { class: 'compare-title' }, formatDate(trade.date)),
        el('p', { class: 'compare-sentence' }, tradeSentence(index, trade)),
        el(
          'button',
          { class: 'ghost-btn', type: 'button', onClick: () => setState({ compareTrade: null }) },
          ['‹ Another trade']
        ),
      ])
    );

    const columns = el('div', { class: 'compare-cols' });
    for (const teamId of trade.teamIds) {
      columns.append(clubColumn(trade, teamId, year));
    }
    shell.append(columns);

    shell.append(
      el('p', { class: 'compare-note' }, [
        el('b', {}, 'Counted: '),
        'games on the acquiring club from this trade forward. ERA and AVG are recomputed from their components, so they are exact. ',
        el('b', {}, 'Not shown: '),
        'OPS and SLG, which cannot be rebuilt from a season aggregate without doubles, triples and sac flies. Players who never reached the majors contribute nothing and are listed as such.',
      ])
    );
  }

  function clubColumn(trade, teamId, year) {
    const team = index.teamsById.get(teamId);
    const lit = legible(teamColor(teamId));
    const got = trade.assets.filter((a) => a.toTeamId === teamId);
    const people = got.filter((a) => a.kind === 'player' && a.personId != null);

    const hitRows = [];
    const pitchRows = [];
    const lines = [];

    for (const asset of people) {
      const entry = players[String(asset.personId)];
      const c = contribution(entry, teamId, year);
      hitRows.push(...c.hitting);
      pitchRows.push(...c.pitching);
      const pa = c.hitting.reduce((n, r) => n + (Number(r.pa) || 0), 0);
      const outs = c.pitching.reduce((n, r) => n + ipToOuts(r.ip), 0);
      lines.push({ asset, entry, pa, outs, seasons: c.hitting.length + c.pitching.length });
    }

    const hit = total(hitRows, HIT_SUM);
    const pit = total(pitchRows, PITCH_SUM);
    const outs = pitchRows.reduce((n, r) => n + ipToOuts(r.ip), 0);

    const stats = [];
    if (hit.pa) {
      stats.push(
        ['PA', hit.pa],
        ['AVG', hit.ab ? (hit.h / hit.ab).toFixed(3).replace(/^0/, '') : '—'],
        ['HR', hit.hr],
        ['BB', hit.bb]
      );
    }
    if (outs) {
      stats.push(
        ['IP', outsToIp(outs)],
        ['ERA', outs ? ((pit.er * 27) / outs).toFixed(2) : '—'],
        ['SO', pit.so],
        ['SV', pit.sv]
      );
    }

    const body = el('div', { class: 'compare-players' });
    if (!people.length) {
      body.append(el('p', { class: 'dossier-empty' }, 'No players acquired in this deal.'));
    }
    for (const line of lines) {
      const contributed = line.pa || line.outs;
      body.append(
        el('div', { class: 'compare-player', dataset: { empty: String(!contributed) } }, [
          el('img', {
            class: 'face',
            src: headshotURL(line.asset.personId),
            alt: '',
            loading: 'lazy',
            decoding: 'async',
            referrerpolicy: 'no-referrer',
          }),
          el('button', {
            class: 'compare-name',
            type: 'button',
            onClick: () => jumpToChain(line.asset.personId, trade.id),
            text: line.asset.name || 'Unnamed',
          }),
          el(
            'span',
            { class: 'compare-line' },
            contributed
              ? line.outs
                ? `${outsToIp(line.outs)} IP`
                : `${line.pa} PA`
              : line.entry?.hitting || line.entry?.pitching
                ? 'none for this club'
                : 'never reached MLB'
          ),
        ])
      );
    }

    const nonPlayers = got.filter((a) => a.kind !== 'player');

    return el('section', { class: 'compare-col', style: { '--club-lit': lit } }, [
      el('h3', { class: 'compare-club' }, [
        el('span', { class: 'mark' }, team ? team.abbreviation : String(teamId)),
        team ? team.name : `Team ${teamId}`,
      ]),
      el('div', { class: 'compare-received' }, `Received ${people.length} player${people.length === 1 ? '' : 's'}${nonPlayers.length ? ` + ${nonPlayers.length} consideration${nonPlayers.length === 1 ? '' : 's'}` : ''}`),
      stats.length
        ? el(
            'dl',
            { class: 'compare-stats' },
            stats.map(([label, value]) => el('div', {}, [el('dt', {}, label), el('dd', {}, String(value))]))
          )
        : el('p', { class: 'dossier-empty' }, 'Nothing this club acquired has played for it.'),
      body,
    ]);
  }

  return { update };
}
