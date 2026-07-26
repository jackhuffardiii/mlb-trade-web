// Fetches all MLB trades from 2015-01-01 through today from the official MLB Stats API
// and writes a static JSON dataset for the D3 frontend to consume.
//
// Plain Node ESM, no npm dependencies. Run with: node scripts/fetch-trades.mjs

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "public", "data", "trades.json");

const START_DATE = "2015-01-01";
const FIRST_SEASON = 2015;

const REQUEST_DELAY_MS = 150;
const MAX_RETRIES = 3;

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const END_DATE = todayStr();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, retries = MAX_RETRIES) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const backoff = 300 * attempt;
        console.warn(`  retry ${attempt}/${retries - 1} after error: ${err.message} (waiting ${backoff}ms)`);
        await sleep(backoff);
      }
    }
  }
  throw new Error(`Failed after ${retries} attempts: ${url} — ${lastErr.message}`);
}

// Build monthly [start, end] date chunks between startDateStr and endDateStr (inclusive).
function monthChunks(startDateStr, endDateStr) {
  const [sy, sm] = startDateStr.split("-").map(Number);
  const [ey, em] = endDateStr.split("-").map(Number);
  const chunks = [];
  let y = sy;
  let m = sm;
  while (y < ey || (y === ey && m <= em)) {
    const monthStart = `${y}-${String(m).padStart(2, "0")}-01`;
    let monthEnd;
    if (y === ey && m === em) {
      monthEnd = endDateStr;
    } else {
      const lastDay = new Date(y, m, 0).getDate(); // day 0 of next month = last day of this month
      monthEnd = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    }
    chunks.push({ start: monthStart, end: monthEnd });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return chunks;
}

async function fetchMlbTeamIds() {
  console.log("Fetching MLB team rosters per season (2015-2026) to build team-id set...");
  const teamMap = new Map(); // id -> { id, name, abbreviation, season }
  const currentYear = new Date().getFullYear();
  const lastSeason = Math.max(currentYear, FIRST_SEASON);
  for (let season = FIRST_SEASON; season <= lastSeason; season++) {
    const url = `https://statsapi.mlb.com/api/v1/teams?sportId=1&season=${season}`;
    const data = await fetchJson(url);
    const teams = data.teams || [];
    for (const team of teams) {
      const existing = teamMap.get(team.id);
      if (!existing || season > existing.season) {
        teamMap.set(team.id, {
          id: team.id,
          name: team.name,
          abbreviation: team.abbreviation,
          season,
        });
      }
    }
    await sleep(REQUEST_DELAY_MS);
  }
  console.log(`  found ${teamMap.size} distinct MLB team ids across seasons.`);
  return teamMap;
}

async function fetchAllTransactionRows() {
  const chunks = monthChunks(START_DATE, END_DATE);
  console.log(`Fetching transactions in ${chunks.length} monthly chunks (${START_DATE} .. ${END_DATE})...`);
  const rawRows = [];
  for (const [i, { start, end }] of chunks.entries()) {
    const url = `https://statsapi.mlb.com/api/v1/transactions?startDate=${start}&endDate=${end}`;
    const data = await fetchJson(url);
    const transactions = data.transactions || [];
    for (const t of transactions) rawRows.push(t);
    if ((i + 1) % 12 === 0 || i === chunks.length - 1) {
      console.log(`  [${i + 1}/${chunks.length}] ${start}..${end}: ${transactions.length} rows (running total ${rawRows.length})`);
    }
    await sleep(REQUEST_DELAY_MS);
  }
  return rawRows;
}

function classifyKind(row) {
  if (row.person) return "player";
  const desc = row.description || "";
  if (/cash/i.test(desc)) return "cash";
  if (/player to be named/i.test(desc)) return "ptbnl";
  return "other";
}

async function main() {
  const teamMap = await fetchMlbTeamIds();
  const mlbTeamIds = new Set(teamMap.keys());

  const rawRows = await fetchAllTransactionRows();

  // Filter to MLB-only trade rows and dedupe on (id, personId, fromTeamId, toTeamId).
  const seen = new Set();
  const dedupedRows = [];
  for (const row of rawRows) {
    if (row.typeCode !== "TR") continue;
    const fromTeamId = row.fromTeam?.id;
    const toTeamId = row.toTeam?.id;
    if (fromTeamId == null || toTeamId == null) continue;
    if (!mlbTeamIds.has(fromTeamId) || !mlbTeamIds.has(toTeamId)) continue;
    const personId = row.person?.id ?? null;
    const key = `${row.id}|${personId}|${fromTeamId}|${toTeamId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedRows.push(row);
  }

  // Group deduped rows into trade events by shared id.
  const eventsMap = new Map(); // id -> rows[]
  for (const row of dedupedRows) {
    if (!eventsMap.has(row.id)) eventsMap.set(row.id, []);
    eventsMap.get(row.id).push(row);
  }

  const trades = [];
  let totalAssets = 0;
  let singleAssetCount = 0;

  for (const [id, rows] of eventsMap) {
    const assets = rows.map((row) => ({
      personId: row.person?.id ?? null,
      name: row.person?.fullName ?? null,
      fromTeamId: row.fromTeam.id,
      toTeamId: row.toTeam.id,
      kind: classifyKind(row),
    }));

    const teamIds = [...new Set(assets.flatMap((a) => [a.fromTeamId, a.toTeamId]))].sort((a, b) => a - b);
    const date = [...rows].map((r) => r.date).sort()[0];
    const description = rows[0].description;

    totalAssets += assets.length;
    if (assets.length === 1) singleAssetCount++;

    trades.push({ id, date, description, teamIds, assets });
  }

  trades.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));

  const teams = [...teamMap.values()]
    .map((t) => ({ id: t.id, name: t.name, abbreviation: t.abbreviation }))
    .sort((a, b) => a.id - b.id);

  const output = {
    generated: todayStr(),
    range: { start: START_DATE, end: END_DATE },
    teams,
    trades,
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));

  // Summary
  const eventsPerYear = {};
  for (const t of trades) {
    const year = t.date.slice(0, 4);
    eventsPerYear[year] = (eventsPerYear[year] || 0) + 1;
  }

  console.log("");
  console.log("=== Summary ===");
  console.log(`Total trade events: ${trades.length}`);
  console.log("Events per year:");
  for (const year of Object.keys(eventsPerYear).sort()) {
    console.log(`  ${year}: ${eventsPerYear[year]}`);
  }
  console.log(`Total asset count: ${totalAssets}`);
  console.log(`Single-asset events: ${singleAssetCount}`);
  console.log(`Team count: ${teams.length}`);
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
