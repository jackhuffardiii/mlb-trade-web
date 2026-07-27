// Shared graph primitives for the two canvases (league web + chain).
// An Obsidian-ish look: hairline links doubled up as a wide dim "glow" stroke
// under a thin bright core, luminous club-colored node rings, and a focus mode
// that dims everything except the touched node and its neighbours.

import { select, zoom, zoomIdentity } from 'd3';
import { headshotURL, initials, svgEl } from './ui.js';
import { legible, mix, rgba, teamColor } from './teams.js';

export function makeCanvas(host) {
  const svg = svgEl('svg', { class: 'canvas graph' });
  const defs = svgEl('defs');
  const root = svgEl('g');
  const linkLayer = svgEl('g', { class: 'links' });
  const nodeLayer = svgEl('g', { class: 'nodes' });

  root.append(linkLayer, nodeLayer);
  svg.append(defs, root);
  host.append(svg);

  const zoomBehavior = zoom()
    .scaleExtent([0.2, 5])
    .on('zoom', (event) => {
      root.setAttribute('transform', event.transform.toString());
    });

  const sel = select(svg);
  sel.call(zoomBehavior).on('dblclick.zoom', null);

  const size = { width: host.clientWidth || 1200, height: host.clientHeight || 800 };
  const observer = new ResizeObserver(() => {
    const width = host.clientWidth || size.width;
    const height = host.clientHeight || size.height;
    if (width === size.width && height === size.height) return;
    size.width = width;
    size.height = height;
    svg.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`);
    handle.onResize?.(size);
  });
  svg.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`);

  const handle = {
    svg,
    defs,
    root,
    linkLayer,
    nodeLayer,
    size,
    onResize: null,
    resetZoom(duration = 500) {
      sel.transition().duration(duration).call(zoomBehavior.transform, zoomIdentity);
    },
    /** Put the content point (x,y) at the given screen point. */
    zoomToPoint(x, y, scale, screenX, screenY, duration = 600) {
      const t = zoomIdentity.translate(screenX, screenY).scale(scale).translate(-x, -y);
      sel.transition().duration(duration).call(zoomBehavior.transform, t);
    },
    zoomTo(x, y, scale = 1.4, duration = 600) {
      handle.zoomToPoint(x, y, scale, size.width / 2, size.height / 2, duration);
    },
    destroy() {
      observer.disconnect();
      svg.remove();
    },
  };
  observer.observe(host);
  return handle;
}

/* ---------------------------------------------------------------- clip defs */

const clipIds = new WeakMap();

function ensureCircleClip(defs, r) {
  let seen = clipIds.get(defs);
  if (!seen) clipIds.set(defs, (seen = new Set()));
  const id = `clip-r${String(r).replace('.', '_')}`;
  if (!seen.has(id)) {
    const clip = svgEl('clipPath', { id, clipPathUnits: 'userSpaceOnUse' });
    clip.append(svgEl('circle', { cx: 0, cy: 0, r }));
    defs.append(clip);
    seen.add(id);
  }
  return id;
}

/* ------------------------------------------------------------------- nodes */

/**
 * A club node: filled disc in the club color with a luminous ring and the
 * abbreviation set in mono. Dark navies/browns stay visible because the ring
 * and glow use the lightened variant.
 */
export function clubNode(defs, { teamId, abbreviation, r = 24 }) {
  const base = teamColor(teamId);
  const lit = legible(base);
  const g = svgEl('g', { class: 'node club' });

  g.append(
    svgEl('circle', {
      class: 'halo',
      r: r + 9,
      fill: 'none',
      stroke: rgba(lit, 0.5),
      'stroke-width': 1,
    })
  );
  g.append(
    svgEl('circle', {
      class: 'glow',
      r: r + 3,
      fill: rgba(lit, 0.12),
      stroke: 'none',
    })
  );
  g.append(
    svgEl('circle', {
      class: 'disc',
      r,
      fill: mix(base, '#0b0d12', 0.15),
      stroke: lit,
      'stroke-width': 1.6,
    })
  );
  g.append(
    Object.assign(svgEl('text', { class: 'abbrev', fill: lit, 'font-size': r * 0.56 }), {
      textContent: abbreviation,
    })
  );
  // Generous transparent hit area so this is a comfortable phone tap target.
  g.append(svgEl('circle', { class: 'hit', r: Math.max(r + 12, 26) }));
  return g;
}

/**
 * A player node: circular MLB headshot clipped to a disc, ringed in the color of
 * the club that received him. The image is created here and only here, so a
 * headshot is fetched only for nodes that actually get rendered.
 */
export function playerNode(defs, { personId, name, teamId, r = 20, caption }) {
  const lit = legible(teamColor(teamId));
  const g = svgEl('g', { class: 'node player' });

  g.append(
    svgEl('circle', {
      class: 'halo',
      r: r + 8,
      fill: 'none',
      stroke: rgba(lit, 0.55),
      'stroke-width': 1,
    })
  );
  g.append(svgEl('circle', { class: 'disc', r, fill: '#171b24' }));
  g.append(
    Object.assign(svgEl('text', { class: 'initials', 'font-size': r * 0.52 }), {
      textContent: initials(name),
    })
  );

  if (personId != null) {
    const clip = ensureCircleClip(defs, r);
    const img = svgEl('image', {
      class: 'headshot',
      x: -r,
      y: -r,
      width: r * 2,
      height: r * 2,
      preserveAspectRatio: 'xMidYMid slice',
      'clip-path': `url(#${clip})`,
      decoding: 'async',
    });
    img.addEventListener('load', () => img.classList.add('loaded'));
    img.addEventListener('error', () => img.remove());
    img.setAttribute('href', headshotURL(personId));
    g.append(img);
  }

  g.append(
    svgEl('circle', {
      class: 'ring',
      r,
      fill: 'none',
      stroke: lit,
      'stroke-width': 2,
    })
  );

  if (caption) {
    g.append(
      Object.assign(svgEl('text', { class: 'caption', y: r + 15 }), { textContent: caption })
    );
  }
  g.append(svgEl('circle', { class: 'hit', r: Math.max(r + 12, 26) }));
  return g;
}

/** A labelled disc for cash / PTBNL / other considerations -- never an image. */
export function assetNode(defs, { glyph, teamId, r = 15, caption }) {
  const lit = legible(teamColor(teamId));
  const g = svgEl('g', { class: 'node asset-node' });
  g.append(
    svgEl('circle', {
      class: 'halo',
      r: r + 7,
      fill: 'none',
      stroke: rgba(lit, 0.4),
      'stroke-width': 1,
    })
  );
  g.append(
    svgEl('circle', {
      class: 'disc',
      r,
      fill: '#12151d',
      stroke: rgba(lit, 0.7),
      'stroke-width': 1.4,
      'stroke-dasharray': '3 3',
    })
  );
  g.append(
    Object.assign(svgEl('text', { class: 'initials', 'font-size': r * 0.7, fill: lit }), {
      textContent: glyph,
    })
  );
  if (caption) {
    g.append(
      Object.assign(svgEl('text', { class: 'caption', y: r + 14 }), { textContent: caption })
    );
  }
  g.append(svgEl('circle', { class: 'hit', r: Math.max(r + 12, 24) }));
  return g;
}

/* -------------------------------------------------------------------- links */

/**
 * Two stacked strokes (wide + dim, thin + bright) read as a glow without an SVG
 * filter, which matters when several hundred edges are on screen.
 */
export function linkGroup({ color, width = 1, hit = true, intensity = 1 }) {
  const g = svgEl('g', { class: 'link' });
  // Every club has traded with nearly every other club since 2015, so weight
  // alone can't carry the picture -- one-off pairings also have to recede.
  const t = Math.max(0, Math.min(1, intensity));
  g.append(
    svgEl('path', {
      class: 'link-glow',
      stroke: rgba(color, 0.04 + 0.17 * t),
      'stroke-width': Math.max(width * 3, 4),
    })
  );
  g.append(
    svgEl('path', {
      class: 'link-core',
      stroke: rgba(color, 0.16 + 0.6 * t),
      'stroke-width': width,
    })
  );
  if (hit) {
    g.append(svgEl('path', { class: 'link-hit', 'stroke-width': Math.max(width + 16, 18) }));
  }
  return g;
}

export function setLinkPath(group, d) {
  for (const path of group.children) path.setAttribute('d', d);
}

export function straight(a, b) {
  return `M${a.x},${a.y}L${b.x},${b.y}`;
}

/** A gentle arc, so parallel edges between hubs stay individually readable. */
export function arc(a, b, bend = 0.16) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dr = Math.hypot(dx, dy) / bend / 6;
  return `M${a.x},${a.y}A${dr},${dr} 0 0,1 ${b.x},${b.y}`;
}

/* -------------------------------------------------------------------- focus */

/**
 * Obsidian-style neighbour highlight. `hot` is the touched node; `near` is
 * everything one hop away. Everything else fades back into the canvas.
 */
export function setFocus(canvas, { hotNodes = [], nearNodes = [], nearLinks = [] } = {}) {
  const { svg } = canvas;
  for (const node of svg.querySelectorAll('.node.hot')) node.classList.remove('hot');
  for (const node of svg.querySelectorAll('.node.near')) node.classList.remove('near');
  for (const link of svg.querySelectorAll('.link.near')) link.classList.remove('near');

  if (!hotNodes.length && !nearNodes.length) {
    delete svg.dataset.focused;
    return;
  }
  for (const node of hotNodes) node?.classList.add('hot');
  for (const node of nearNodes) node?.classList.add('near');
  for (const link of nearLinks) link?.classList.add('near');
  svg.dataset.focused = 'true';
}

export function clearFocus(canvas) {
  setFocus(canvas, {});
}
