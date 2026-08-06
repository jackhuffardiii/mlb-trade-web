// Fetches season-by-season stat lines + bio for every player who appears as
// a traded asset in public/data/trades.json, and writes/incrementally
// maintains a static JSON dataset for the D3 frontend to consume.
//
// Plain Node ESM, no npm dependencies. Run with:
//   node scripts/fetch-players.mjs [--limit N]

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADES_PATH = path.join(__dirname, "..", "public", "data", "trades.json");
const OUTPUT_PATH = path.join(__dirname, "..", "public", "data", "players.json");

const FIRST_SEASON = 2015;

const REQUEST_DELAY_MS = 150;
const MAX_RETRIES = 3;

// ponytail: duplicated from fetch-trades.mjs (sleep/fetchJson/todayStr) —
// move to a shared scripts/lib.mjs if a third consumer needs these.
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

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
// ponytail: end of copied block.

const HYDRATE = "stats(group=[hitting,pitching],type=[yearByYear])";

// The /people endpoint takes many ids at once with the same hydrate, so the
// whole roster is a couple of dozen requests rather than one per player. 200
// works; 100 keeps each response ~2.5 MB and the URL comfortably short.
const BATCH = 100;

// Sort by (season, seq) ascending. `seq` is the position the API returned the
// split in, which is chronological -- Paredes 2024 comes back as TB then CHC,
// the order he actually played them in. Sorting by teamId instead would put CHC
// (112) before TB (139) and silently invert the before/after story a split
// season is there to tell. Storing seq rather than trusting array order keeps
// the file deterministic even if the API's ordering ever drifts.
function compareSeasonSeq(a, b) {
  return a.season - b.season || a.seq - b.seq;
}

function mapHittingSplit(split) {
  const s = split.stat;
  return {
    season: Number(split.season),
    teamId: Number(split.team.id),
    g: s.gamesPlayed,
    pa: s.plateAppearances,
    ab: s.atBats,
    h: s.hits,
    hr: s.homeRuns,
    bb: s.baseOnBalls,
    so: s.strikeOuts,
    avg: s.avg,
    obp: s.obp,
    slg: s.slg,
    ops: s.ops,
    sb: s.stolenBases,
  };
}

function mapPitchingSplit(split) {
  const s = split.stat;
  return {
    season: Number(split.season),
    teamId: Number(split.team.id),
    g: s.gamesPlayed,
    gs: s.gamesStarted,
    ip: s.inningsPitched,
    er: s.earnedRuns,
    era: s.era,
    so: s.strikeOuts,
    bb: s.baseOnBalls,
    h: s.hits,
    hr: s.homeRuns,
    whip: s.whip,
    w: s.wins,
    l: s.losses,
    sv: s.saves,
  };
}

// Extracts, filters (gameType R, season >= FIRST_SEASON, drops the teamless
// season-total row — see trap in the spec), sorts, and maps one stat group.
function extractGroup(statsArray, groupName, mapFn) {
  const group = (statsArray || []).find((g) => g.group?.displayName === groupName);
  const splits = group?.splits || [];
  return splits
    .filter((split) => split.gameType === "R")
    .filter((split) => split.team != null)
    .filter((split) => Number(split.season) >= FIRST_SEASON)
    .map((split, i) => ({ ...mapFn(split), seq: i }))
    .sort(compareSeasonSeq);
}

function entryFor(person) {
  const hitting = extractGroup(person.stats, "hitting", mapHittingSplit);
  const pitching = extractGroup(person.stats, "pitching", mapPitchingSplit);

  const entry = {
    name: person.fullName,
    position: person.primaryPosition?.abbreviation ?? null,
    bats: person.batSide?.code ?? null,
    throws: person.pitchHand?.code ?? null,
    debut: person.mlbDebutDate ?? null,
  };
  if (hitting.length) entry.hitting = hitting;
  if (pitching.length) entry.pitching = pitching;
  return entry;
}

/** One request for up to BATCH players. Returns id -> entry. */
async function fetchBatch(ids) {
  const url =
    `https://statsapi.mlb.com/api/v1/people?personIds=${ids.join(",")}` +
    `&hydrate=${encodeURIComponent(HYDRATE)}`;
  const data = await fetchJson(url);
  const out = new Map();
  for (const person of data.people || []) {
    if (person?.id != null) out.set(person.id, entryFor(person));
  }
  return out;
}

// Latest season on file across both stat groups, or -Infinity if the player has
// no season rows at all.
function latestSeasonOnFile(entry) {
  const seasons = [...(entry.hitting || []), ...(entry.pitching || [])].map((r) => r.season);
  return seasons.length ? Math.max(...seasons) : -Infinity;
}

/**
 * Who to refetch. Anyone who could still add a line this season:
 *
 *   - never fetched;
 *   - no major-league record at all -- a prospect can debut any day, and under
 *     the old "latest === currentYear" rule those 1,069 players were frozen
 *     blank forever;
 *   - last played this season or last season -- catches a return from injury or
 *     the minors, which the old rule also missed for 236 players.
 *
 * Anyone whose last game is two or more seasons back is done; leave them alone.
 */
function needsRefresh(entry, currentYear) {
  if (!entry) return true;
  const latest = latestSeasonOnFile(entry);
  if (latest === -Infinity) return true;
  return latest >= currentYear - 1;
}

async function loadExistingPlayers() {
  try {
    const raw = await readFile(OUTPUT_PATH, "utf8");
    return JSON.parse(raw).players || {};
  } catch {
    return {};
  }
}

function collectCandidateIds(tradesData) {
  const ids = new Set();
  for (const trade of tradesData.trades || []) {
    for (const asset of trade.assets || []) {
      if (asset.kind === "player" && asset.personId != null) ids.add(asset.personId);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

async function main() {
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg !== -1 ? Number(process.argv[limitArg + 1]) : Infinity;

  const tradesData = JSON.parse(await readFile(TRADES_PATH, "utf8"));
  const allCandidateIds = collectCandidateIds(tradesData);
  console.log(`Found ${allCandidateIds.length} unique candidate player ids in trades.json.`);

  // --limit caps which candidates are actually considered for fetch/skip
  // logic this run (first N in sorted order) — not a fetch budget walked
  // across the full list — so repeated `--limit N` runs are idempotent
  // against the same player set. Candidates beyond the limit are simply
  // carried over from the existing file untouched (if present at all).
  const processedIds = Number.isFinite(limit) ? new Set(allCandidateIds.slice(0, limit)) : null;

  const existingPlayers = await loadExistingPlayers();
  const currentYear = new Date().getFullYear();

  const fetched = [];
  const skipped = [];
  const failed = [];

  // players is built by inserting keys in ascending numeric order (matching
  // allCandidateIds' sort) so key order is explicit, not incidental engine
  // behavior; skipped/carried-over players' existing entries are copied
  // through completely unchanged.
  const players = {};

  // Decide first, then fetch in batches, then reassemble in id order so the
  // output stays canonical regardless of how the batches came back.
  const toFetch = [];
  for (const id of allCandidateIds) {
    const key = String(id);
    const existing = existingPlayers[key];

    if (processedIds && !processedIds.has(id)) {
      // Beyond this run's --limit slice: leave completely untouched.
      if (existing) players[key] = existing;
      continue;
    }
    if (!needsRefresh(existing, currentYear)) {
      players[key] = existing;
      skipped.push(id);
      continue;
    }
    toFetch.push(id);
  }

  console.log(`Refreshing ${toFetch.length}, skipping ${skipped.length}.`);

  const fresh = new Map();
  for (let i = 0; i < toFetch.length; i += BATCH) {
    const slice = toFetch.slice(i, i + BATCH);
    try {
      for (const [id, entry] of await fetchBatch(slice)) fresh.set(id, entry);
    } catch (err) {
      // A whole batch failing is survivable: keep whatever was already on file
      // for those ids and carry on.
      for (const id of slice) failed.push({ id, error: err.message });
      console.warn(`  WARN: batch ${i / BATCH + 1} failed: ${err.message}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  for (const id of toFetch) {
    const key = String(id);
    if (fresh.has(id)) {
      players[key] = fresh.get(id);
      fetched.push(id);
    } else if (existingPlayers[key]) {
      // Asked for but not returned (or the batch failed): keep what we had.
      players[key] = existingPlayers[key];
    }
  }

  // Re-sort: batch reassembly appended in toFetch order, but skipped players
  // were inserted earlier. Rebuild strictly ascending by id.
  const ordered = {};
  for (const id of allCandidateIds) {
    const key = String(id);
    if (players[key]) ordered[key] = players[key];
  }
  Object.keys(players).forEach((k) => delete players[k]);
  Object.assign(players, ordered);

  const output = {
    generated: todayStr(),
    source: "MLB Stats API yearByYear (hydrated)",
    players,
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));

  console.log("");
  console.log("=== Summary ===");
  console.log(`Fetched: ${fetched.length}`);
  console.log(`Skipped: ${skipped.length}`);
  console.log(`Failed: ${failed.length}`);
  if (failed.length) {
    console.log("Failed ids:");
    for (const f of failed) console.log(`  ${f.id}: ${f.error}`);
  }
  console.log(`Wrote ${OUTPUT_PATH}`);

  if (fetched.length === 0 && failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
