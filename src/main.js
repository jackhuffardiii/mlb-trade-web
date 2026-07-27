import './style.css';

import { formatDateLong, loadData } from './data.js';
import { legible, teamColor } from './teams.js';
import { setState, state, subscribe } from './state.js';
import {
  buildSearchIndex,
  clear,
  closePanel,
  el,
  searchEntries,
} from './ui.js';
import { createNetworkView } from './views/network.js';
import { createChainView } from './views/chains.js';
import { createFlowsView } from './views/flows.js';

const VIEWS = ['web', 'chain', 'flows'];

boot();

async function boot() {
  const bootEl = document.getElementById('boot');
  const bootMsg = document.getElementById('boot-msg');

  let index;
  try {
    index = await loadData();
  } catch (error) {
    bootMsg.textContent = 'Could not load the trade data';
    console.error(error);
    return;
  }

  bootMsg.textContent = `${index.trades.length.toLocaleString()} trades indexed`;

  state.yearMin = index.minYear;
  state.yearMax = index.maxYear;

  document.getElementById('dateline-edition').textContent =
    `Edition of ${formatDateLong(index.generated)}`;
  document.getElementById('dateline-counts').textContent =
    `${index.trades.length.toLocaleString()} trades · ${index.assetCount.toLocaleString()} assets`;

  const views = {
    web: { host: document.getElementById('view-web'), api: null, dirty: true },
    chain: { host: document.getElementById('view-chain'), api: null, dirty: true },
    flows: { host: document.getElementById('view-flows'), api: null, dirty: true },
  };

  mountChrome(index);
  mountSearch(index);
  trackHeaderHeight();

  subscribe((changed) => {
    if (changed.has('view')) applyView(views);
    if (
      changed.has('yearMin') ||
      changed.has('yearMax') ||
      changed.has('team') ||
      changed.has('webMode') ||
      changed.has('webTeam')
    ) {
      views.web.dirty = true;
      views.flows.dirty = true;
    }
    if (changed.has('flowsTeam')) views.flows.dirty = true;
    if (changed.has('chain')) views.chain.dirty = true;
    if (changed.has('team') || changed.has('yearMin') || changed.has('yearMax')) syncChrome(index);
    applyView(views);
  });

  document.addEventListener('jump:chain', (event) => {
    const { personId, tradeId } = event.detail;
    if (personId == null) return;
    const resolved = tradeId ?? index.playerIndex.get(personId)?.trades[0];
    if (resolved == null) return;
    closePanel();
    setState({ chain: { personId, tradeId: resolved }, view: 'chain' });
  });

  document.addEventListener('jump:flows', (event) => {
    closePanel();
    setState({ flowsTeam: event.detail.teamId, view: 'flows' });
  });

  document.getElementById('panel-close').addEventListener('click', closePanel);

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePanel();
    if (event.key === '/' && document.activeElement?.id !== 'search') {
      event.preventDefault();
      document.getElementById('search').focus();
    }
  });

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => setState({ view: tab.dataset.tab }));
  }

  applyView(views);
  syncChrome(index);

  // Let the first paint land before dropping the curtain.
  requestAnimationFrame(() => {
    setTimeout(() => {
      bootEl.dataset.done = 'true';
    }, 90);
  });

  /* ------------------------------------------------------------ view mgmt */

  function applyView(registry) {
    for (const name of VIEWS) {
      const entry = registry[name];
      const active = state.view === name;
      entry.host.dataset.active = String(active);
      for (const tab of document.querySelectorAll('.tab')) {
        tab.setAttribute('aria-selected', String(tab.dataset.tab === state.view));
      }
      if (!active) continue;
      if (!entry.api) {
        entry.api =
          name === 'web'
            ? createNetworkView(entry.host, index)
            : name === 'chain'
              ? createChainView(entry.host, index)
              : createFlowsView(entry.host, index);
        entry.dirty = true;
      }
      if (entry.dirty) {
        entry.api.update();
        entry.dirty = false;
      }
    }
  }
}

/* ------------------------------------------------------------------ chrome */

function mountChrome(index) {
  const rail = document.getElementById('teams-rail');
  clear(rail);

  rail.append(
    el(
      'button',
      {
        class: 'team-pill all',
        type: 'button',
        'aria-pressed': 'true',
        dataset: { team: 'all' },
        onClick: () => setState({ team: null }),
      },
      ['All clubs']
    )
  );

  for (const team of index.teams) {
    const base = teamColor(team.id);
    rail.append(
      el(
        'button',
        {
          class: 'team-pill',
          type: 'button',
          'aria-pressed': 'false',
          title: team.name,
          dataset: { team: String(team.id) },
          style: { '--club': base, '--club-lit': legible(base) },
          onClick: () => setState({ team: state.team === team.id ? null : team.id }),
        },
        [el('span', { class: 'dot' }), team.abbreviation]
      )
    );
  }

  document.getElementById('clear-filter').addEventListener('click', () => setState({ team: null }));

  const minInput = document.getElementById('year-min');
  const maxInput = document.getElementById('year-max');
  for (const input of [minInput, maxInput]) {
    input.min = String(index.minYear);
    input.max = String(index.maxYear);
    input.step = '1';
  }
  minInput.value = String(index.minYear);
  maxInput.value = String(index.maxYear);

  const onYears = () => {
    let lo = Number(minInput.value);
    let hi = Number(maxInput.value);
    if (lo > hi) {
      // Push the other handle rather than letting the range invert.
      if (document.activeElement === minInput) hi = lo;
      else lo = hi;
      minInput.value = String(lo);
      maxInput.value = String(hi);
    }
    setState({ yearMin: lo, yearMax: hi });
  };
  minInput.addEventListener('input', onYears);
  maxInput.addEventListener('input', onYears);
}

function syncChrome(index) {
  for (const pill of document.querySelectorAll('.team-pill')) {
    const key = pill.dataset.team;
    const on = key === 'all' ? state.team == null : Number(key) === state.team;
    pill.setAttribute('aria-pressed', String(on));
  }
  document.getElementById('clear-filter').dataset.show = String(state.team != null);

  document.getElementById('year-readout').textContent =
    state.yearMin === state.yearMax ? String(state.yearMin) : `${state.yearMin}–${state.yearMax}`;

  const span = index.maxYear - index.minYear || 1;
  const fill = document.getElementById('year-fill');
  fill.style.left = `${((state.yearMin - index.minYear) / span) * 100}%`;
  fill.style.right = `${((index.maxYear - state.yearMax) / span) * 100}%`;
}

function trackHeaderHeight() {
  const chrome = document.querySelector('.chrome');
  const apply = () => {
    document.documentElement.style.setProperty('--head-h', `${chrome.offsetHeight}px`);
  };
  new ResizeObserver(apply).observe(chrome);
  apply();
}

/* ------------------------------------------------------------------ search */

function mountSearch(index) {
  const input = document.getElementById('search');
  const results = document.getElementById('results');
  const entries = buildSearchIndex(index);
  let active = -1;
  let current = [];

  const close = () => {
    delete results.dataset.open;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };

  const choose = (entry) => {
    input.value = '';
    close();
    input.blur();
    if (entry.type === 'team') {
      setState({ team: entry.id, flowsTeam: entry.id, view: 'flows' });
    } else {
      const player = index.playerIndex.get(entry.id);
      if (!player) return;
      setState({ chain: { personId: entry.id, tradeId: player.trades[0] }, view: 'chain' });
    }
  };

  const draw = () => {
    clear(results);
    if (!current.length) {
      results.append(el('div', { class: 'result-empty' }, 'No player or club by that name.'));
      results.dataset.open = 'true';
      input.setAttribute('aria-expanded', 'true');
      return;
    }
    current.forEach((entry, i) => {
      const color = entry.type === 'team' ? legible(teamColor(entry.id)) : null;
      results.append(
        el(
          'button',
          {
            class: 'result',
            type: 'button',
            role: 'option',
            dataset: { active: String(i === active) },
            onClick: () => choose(entry),
            onMouseenter: () => {
              active = i;
              markActive();
            },
          },
          [
            color
              ? el('span', {
                  class: 'dot',
                  style: {
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: color,
                    flex: '0 0 auto',
                  },
                })
              : null,
            el('span', { class: 'result-name' }, entry.label),
            el('span', { class: 'result-meta' }, entry.meta),
          ]
        )
      );
    });
    results.dataset.open = 'true';
    input.setAttribute('aria-expanded', 'true');
  };

  const markActive = () => {
    [...results.children].forEach((child, i) => {
      child.dataset.active = String(i === active);
    });
  };

  input.addEventListener('input', () => {
    const query = input.value.trim();
    if (!query) {
      close();
      return;
    }
    current = searchEntries(entries, query, { teamId: state.team });
    active = current.length ? 0 : -1;
    draw();
  });

  input.addEventListener('keydown', (event) => {
    if (!current.length && event.key !== 'Escape') return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      active = (active + 1) % current.length;
      markActive();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      active = (active - 1 + current.length) % current.length;
      markActive();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (current[active]) choose(current[active]);
    } else if (event.key === 'Escape') {
      close();
      input.blur();
    }
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.search')) close();
  });
}
