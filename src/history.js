// In-app navigation history: an internal stack with standard back/forward
// semantics. Only navigational state is recorded -- which view you're on and
// what you're looking at. The season range and the club filter chips are
// filters, not destinations, so scrubbing the slider doesn't fill the stack.
//
// (The club filter *is* recorded, because pinning a club is how you get into a
// club's league web and it changes what the view shows.)

// flowsTree/flowsMode are destinations (which tree is open, trees vs ledger), so
// they belong here. flowsSort is a ranking preference like the season slider --
// a filter, not a place -- so it stays out.
const NAV_KEYS = [
  'view',
  'team',
  'flowsTeam',
  'flowsTree',
  'flowsMode',
  'chain',
  'chainMode',
  'webMode',
  'webTeam',
];
const LIMIT = 80;

let stack = [];
let cursor = -1;
let restoring = false;
const listeners = new Set();

function snapshot(state) {
  const snap = {};
  for (const key of NAV_KEYS) snap[key] = state[key];
  // Freeze the chain reference so restoring later doesn't hand back a mutated
  // object; setState compares by identity, which is what we want here.
  if (state.chain) snap.chain = { personId: state.chain.personId, tradeId: state.chain.tradeId };
  return snap;
}

function same(a, b) {
  if (!a || !b) return false;
  for (const key of NAV_KEYS) {
    if (key === 'chain') {
      const x = a.chain;
      const y = b.chain;
      if (!x !== !y) return false;
      if (x && y && (x.personId !== y.personId || x.tradeId !== y.tradeId)) return false;
    } else if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

function notify() {
  for (const fn of listeners) fn({ back: canBack(), forward: canForward() });
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function init(state) {
  stack = [snapshot(state)];
  cursor = 0;
  notify();
}

/** Record the current state as a new entry, truncating any forward history. */
export function record(state) {
  if (restoring) return;
  const next = snapshot(state);
  if (cursor >= 0 && same(stack[cursor], next)) return;
  stack = stack.slice(0, cursor + 1);
  stack.push(next);
  if (stack.length > LIMIT) stack.shift();
  cursor = stack.length - 1;
  notify();
}

export function canBack() {
  return cursor > 0;
}

export function canForward() {
  return cursor >= 0 && cursor < stack.length - 1;
}

/**
 * Step the cursor and hand back the state patch to apply. The caller wraps the
 * apply in restoring=true so it isn't recorded as a new navigation.
 */
function step(delta) {
  const next = cursor + delta;
  if (next < 0 || next >= stack.length) return null;
  cursor = next;
  notify();
  return stack[cursor];
}

export function back() {
  return step(-1);
}

export function forward() {
  return step(1);
}

/** Apply a restored snapshot without recording it. */
export function withRestore(fn) {
  restoring = true;
  try {
    fn();
  } finally {
    restoring = false;
  }
}
