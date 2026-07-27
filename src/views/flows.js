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
  let renderedTeam = null;

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

    // A new club starts at the top of its own ledger.
    if (renderedTeam !== teamId) host.scrollTop = 0;
    renderedTeam = teamId;

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
      titlePicker(teamId, lit),
      el('div', { class: 'asset-row', style: { marginBottom: '18px' } }, [
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

  function choose(nextId) {
    // A pinned club filter follows the ledger; an unpinned one stays unpinned.
    setState({ flowsTeam: nextId, team: state.team == null ? null : nextId });
  }

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

    const options = teamsSorted().map((option) => {
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
                  onClick: () => setState({ flowsTeam: id, team: null }),
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
