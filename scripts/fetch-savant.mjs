// Fetches Baseball Savant percentile rankings for every player who appears as a
// traded asset, and writes public/data/savant.json for the dossier's bar card.
//
// Savant publishes one bulk CSV per (season, player type) -- ~45 KB for the
// whole league -- so this is 24 requests total, not one per player.
//
// Plain Node ESM, no npm dependencies. Run with:
//   node scripts/fetch-savant.mjs [--from 2015] [--to 2026]

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADES_PATH = path.join(__dirname, "..", "public", "data", "trades.json");
const OUTPUT_PATH = path.join(__dirname, "..", "public", "data", "savant.json");

const FIRST_SEASON = 2015;
const REQUEST_DELAY_MS = 150;
const MAX_RETRIES = 3;

// ponytail: sleep/todayStr duplicated from fetch-trades.mjs, same as
// fetch-players.mjs. Three consumers now -- worth extracting to scripts/lib.mjs
// next time any of them is touched.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function fetchText(url) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) await sleep(300 * attempt);
    }
  }
  throw new Error(`Failed after ${MAX_RETRIES} attempts: ${url} — ${lastErr.message}`);
}

/** Split one CSV line, respecting "quoted, fields" -- player_name is "Last, First". */
function splitCsv(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Metrics kept, in the order the card renders them. Savant's own card is
 * ordered by family (value, then contact quality, then plate discipline, then
 * physical tools); this mirrors that rather than the CSV's column order.
 * `hi` false means a LOW percentile is the good outcome for a pitcher.
 */
const METRICS = [
  ["xwoba", "xwOBA"],
  ["xba", "xBA"],
  ["xslg", "xSLG"],
  ["xobp", "xOBP"],
  ["xiso", "xISO"],
  ["xera", "xERA"],
  ["brl_percent", "Barrel%"],
  ["exit_velocity", "Avg EV"],
  ["max_ev", "Max EV"],
  ["hard_hit_percent", "Hard Hit%"],
  ["squared_up_rate", "Squared Up%"],
  ["bat_speed", "Bat Speed"],
  ["swing_length", "Swing Length"],
  ["k_percent", "K%"],
  ["bb_percent", "BB%"],
  ["whiff_percent", "Whiff%"],
  ["chase_percent", "Chase%"],
  ["fb_velocity", "Fastball Velo"],
  ["fb_spin", "Fastball Spin"],
  ["curve_spin", "Curve Spin"],
  ["arm_strength", "Arm Strength"],
  ["sprint_speed", "Sprint Speed"],
  ["oaa", "Outs Above Avg"],
];
const KEYS = METRICS.map(([k]) => k);

async function seasonRows(year, type) {
  const url = `https://baseballsavant.mlb.com/leaderboard/percentile-rankings?type=${type}&year=${year}&csv=true`;
  const text = await fetchText(url);
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];

  const header = splitCsv(lines[0]).map((h) => h.replace(/^﻿/, "").trim().toLowerCase());
  const idCol = header.indexOf("player_id");
  if (idCol === -1) throw new Error(`no player_id column for ${year}/${type}`);

  const out = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsv(line);
    const id = Number(cells[idCol]);
    if (!Number.isFinite(id)) continue;
    const row = {};
    for (const key of KEYS) {
      const col = header.indexOf(key);
      if (col === -1) continue;
      const raw = (cells[col] ?? "").trim();
      // Empty means the metric did not exist that season (bat speed pre-2024,
      // whiff% pre-2017). Absent, not zero -- a zero bar would be a lie.
      if (raw === "") continue;
      const n = Number(raw);
      if (Number.isFinite(n)) row[key] = n;
    }
    if (Object.keys(row).length) out.push({ id, type, row });
  }
  return out;
}

async function main() {
  const arg = (flag, fallback) => {
    const i = process.argv.indexOf(flag);
    return i !== -1 ? Number(process.argv[i + 1]) : fallback;
  };
  const from = arg("--from", FIRST_SEASON);
  const to = arg("--to", new Date().getFullYear());

  const trades = JSON.parse(await readFile(TRADES_PATH, "utf8"));
  const traded = new Set();
  for (const trade of trades.trades || []) {
    for (const asset of trade.assets || []) {
      if (asset.kind === "player" && asset.personId != null) traded.add(asset.personId);
    }
  }
  console.log(`${traded.size} traded players to match against.`);

  // playerId -> season -> {metric: percentile}
  const players = new Map();
  let kept = 0;
  let dropped = 0;

  for (let year = from; year <= to; year++) {
    for (const type of ["pitcher", "batter"]) {
      const rows = await seasonRows(year, type);
      for (const { id, type: t, row } of rows) {
        if (!traded.has(id)) {
          dropped++;
          continue;
        }
        const seasons = players.get(id) || new Map();
        // A two-way player appears in both leaderboards; keep both under one
        // season key, tagging which side each metric set came from.
        const existing = seasons.get(year) || {};
        seasons.set(year, { ...existing, ...row, type: existing.type ? "two-way" : t });
        players.set(id, seasons);
        kept++;
      }
      await sleep(REQUEST_DELAY_MS);
    }
    console.log(`  ${year} done`);
  }

  // Canonical ordering: player ids ascending, seasons ascending, metric keys in
  // METRICS order. Same discipline as d049da7 -- the file must not churn.
  const out = {};
  for (const id of [...players.keys()].sort((a, b) => a - b)) {
    const seasons = players.get(id);
    const bySeason = {};
    for (const year of [...seasons.keys()].sort((a, b) => a - b)) {
      const row = seasons.get(year);
      const ordered = { type: row.type };
      for (const key of KEYS) if (row[key] !== undefined) ordered[key] = row[key];
      bySeason[year] = ordered;
    }
    out[String(id)] = bySeason;
  }

  await writeFile(
    OUTPUT_PATH,
    JSON.stringify(
      {
        generated: todayStr(),
        source: "Baseball Savant percentile-rankings leaderboard",
        range: { start: from, end: to },
        labels: Object.fromEntries(METRICS),
        players: out,
      },
      null,
      2
    )
  );

  console.log(`\nMatched ${kept} player-seasons for ${Object.keys(out).length} traded players.`);
  console.log(`Discarded ${dropped} rows for players never traded.`);
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
