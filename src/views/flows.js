// View III -- Team Flows.
// One club's ledger inside the current filters: everything acquired on the left,
// everything sent away on the right, grouped by trade, with a summary strip.

import { formatDate } from '../data.js';
import { tradeSentence } from '../chain.js';
import { legible, teamColor } from '../teams.js';
import { assetPill, clear, clubChip, el, jumpToChain } from '../ui.js';
import { inYears, setState, state } from '../state.js';

export function createFlowsView(host, index) {
  clear(host);
  const shell = el('div', { class: 'flows-shell' });
  host.append(shell);

  function teamsSorted() {
    return index.teams;
  }

  function pickDefaultTeam() {
    if (state.flowsTeam != null) return state.flowsTeam;
    if (state.team != null) return state.team;
    let best = null;
    let bestCount = -1;
    for (const [teamId, trades] of index.teamTrades) {
      if (trades.length > bestCount) {
        bestCount = trades.length;
        best = teamId;
      }
    }
    return best;
  }

  function update() {
    const teamId = pickDefaultTeam();
    if (teamId == null) return;
    if (state.flowsTeam !== teamId) state.flowsTeam = teamId;

    const team = index.teamsById.get(teamId);
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

    /* -------------------------------------------------------------- header */

    const head = el('header', { class: 'flows-head', style: { '--club-lit': lit } }, [
      el('h2', { class: 'flows-team', style: { '--club-lit': lit } }, [
        el('span', { class: 'mark' }, team.abbreviation),
        team.name,
      ]),
      el('div', { class: 'asset-row', style: { marginBottom: '18px' } }, [
        selector(teamId),
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

    /* -------------------------------------------------------------- ledger */

    const ledger = el('div', { class: 'ledger' }, [
      column('Acquired', acquired, teamId, 'in'),
      column('Sent away', sent, teamId, 'out'),
    ]);

    shell.append(head, summary, ledger);
  }

  function stat(label, value, sub) {
    return el('div', { class: 'stat' }, [
      el('dt', {}, label),
      el('dd', {}, [String(value), sub ? el('small', {}, sub) : null]),
    ]);
  }

  function selector(teamId) {
    const select = el('select', {
      class: 'ghost-btn',
      'aria-label': 'Choose a club',
      onChange: (event) => {
        const next = Number(event.target.value);
        setState({ flowsTeam: next, team: state.team == null ? null : next });
        if (state.team == null) update();
      },
    });
    for (const team of teamsSorted()) {
      const option = el('option', { value: team.id }, `${team.abbreviation} · ${team.name}`);
      if (team.id === teamId) option.selected = true;
      select.append(option);
    }
    return select;
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
                  onClick: () => {
                    setState({ flowsTeam: id, team: null });
                    update();
                  },
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

  return { update, destroy() {} };
}
