// Hardcoded club colors. No logo images anywhere in this app (no CDN, no external
// requests) -- a color chip plus the abbreviation does the identification work.
// Each value is the club's recognizable primary. Several clubs are legitimately
// near-black (SD brown, CWS black, NYY/DET navy); `lighten()` derives a legible
// variant for text, rules and chips so those teams never disappear on the dark page.

export const TEAM_COLORS = {
  108: '#BA0021', // Los Angeles Angels
  109: '#A71930', // Arizona Diamondbacks
  110: '#DF4601', // Baltimore Orioles
  111: '#BD3039', // Boston Red Sox
  112: '#0E3386', // Chicago Cubs
  113: '#C6011F', // Cincinnati Reds
  114: '#00385D', // Cleveland Guardians
  115: '#33006F', // Colorado Rockies
  116: '#0C2340', // Detroit Tigers
  117: '#EB6E1F', // Houston Astros
  118: '#004687', // Kansas City Royals
  119: '#005A9C', // Los Angeles Dodgers
  120: '#AB0003', // Washington Nationals
  121: '#FF5910', // New York Mets
  133: '#003831', // Athletics
  134: '#FDB827', // Pittsburgh Pirates
  135: '#2F241D', // San Diego Padres (brown)
  136: '#0C2C56', // Seattle Mariners
  137: '#FD5A1E', // San Francisco Giants
  138: '#C41E3A', // St. Louis Cardinals
  139: '#092C5C', // Tampa Bay Rays
  140: '#003278', // Texas Rangers
  141: '#134A8E', // Toronto Blue Jays
  142: '#002B5C', // Minnesota Twins
  143: '#E81828', // Philadelphia Phillies
  144: '#CE1141', // Atlanta Braves
  145: '#27251F', // Chicago White Sox
  146: '#00A3E0', // Miami Marlins
  147: '#0C2340', // New York Yankees
  158: '#12284B', // Milwaukee Brewers
};

const FALLBACK = '#6A6F76';

export function teamColor(teamId) {
  return TEAM_COLORS[teamId] || FALLBACK;
}

function parse(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
const toHex = (rgb) => '#' + rgb.map((c) => clamp(c).toString(16).padStart(2, '0')).join('');

/** Relative luminance, 0 (black) .. 1 (white). */
export function luminance(hex) {
  const [r, g, b] = parse(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function mix(hex, target, amount) {
  const a = parse(hex);
  const b = parse(target);
  return toHex(a.map((c, i) => c + (b[i] - c) * amount));
}

/**
 * A version of the club color guaranteed to read as text/rule work on near-black.
 * Dark navies and browns get pulled up; already-bright colors are left alone.
 */
export function legible(hex) {
  let out = hex;
  let guard = 0;
  while (luminance(out) < 0.22 && guard++ < 12) out = mix(out, '#FFFFFF', 0.18);
  return out;
}

export function rgba(hex, alpha) {
  const [r, g, b] = parse(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}
