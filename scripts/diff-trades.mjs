// Compares two trades.json snapshots and reports whether the meaningful
// payload (teams + trades) actually changed, ignoring the `generated` and
// `range.end` fields that churn on every run regardless of real content.
//
// Plain Node ESM, no npm dependencies. Run with:
//   node scripts/diff-trades.mjs <oldFile> <newFile>
//
// Writes changed=true|false and summary=<one-line> to $GITHUB_OUTPUT when
// that env var is set, for use as a workflow step output. Exits non-zero
// only on real errors (missing file, unparseable JSON); a "no changes"
// result is exit 0 — callers branch on the changed output, not exit code.

import { readFile, appendFile } from "node:fs/promises";

const SAMPLE_LIMIT = 10;
const DESC_TRUNCATE = 120;

async function loadTrades(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    throw new Error(`Cannot read ${filePath}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Cannot parse ${filePath} as JSON: ${err.message}`);
  }
}

// Serializes a value to JSON with object keys sorted, so two objects that
// differ only in key order compare equal. Array order is preserved as-is.
function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function truncate(str, max) {
  if (!str) return "";
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

function diffTrades(oldData, newData) {
  const oldTeamsKey = stableStringify(oldData.teams ?? []);
  const newTeamsKey = stableStringify(newData.teams ?? []);
  const teamsChanged = oldTeamsKey !== newTeamsKey;

  const oldById = new Map((oldData.trades ?? []).map((t) => [t.id, t]));
  const newById = new Map((newData.trades ?? []).map((t) => [t.id, t]));

  const added = [];
  const removed = [];
  const modified = [];

  for (const [id, newTrade] of newById) {
    if (!oldById.has(id)) {
      added.push(newTrade);
    }
  }
  for (const [id, oldTrade] of oldById) {
    if (!newById.has(id)) {
      removed.push(oldTrade);
    }
  }
  for (const [id, oldTrade] of oldById) {
    const newTrade = newById.get(id);
    if (newTrade && stableStringify(oldTrade) !== stableStringify(newTrade)) {
      modified.push({ id, oldTrade, newTrade });
    }
  }

  const changed = teamsChanged || added.length > 0 || removed.length > 0 || modified.length > 0;

  return { teamsChanged, added, removed, modified, changed };
}

function buildSummary({ teamsChanged, added, removed, modified, changed }) {
  if (!changed) return "no changes";
  const bits = [];
  if (added.length) bits.push(`+${added.length}`);
  if (removed.length) bits.push(`-${removed.length}`);
  if (modified.length) bits.push(`~${modified.length}`);
  let summary = bits.length ? `${bits.join(" ")} trades` : "";
  if (teamsChanged) summary = summary ? `${summary}, teams updated` : "teams updated";
  return summary;
}

function printReport(diff) {
  const { teamsChanged, added, removed, modified, changed } = diff;

  console.log("=== Trade data diff ===");
  console.log(`Teams changed: ${teamsChanged ? "yes" : "no"}`);
  console.log(`Trades added: ${added.length}`);
  console.log(`Trades removed: ${removed.length}`);
  console.log(`Trades modified: ${modified.length}`);
  console.log(`Overall: ${changed ? "CHANGED" : "no changes"}`);

  if (added.length) {
    console.log("");
    console.log(`Sample added trades (showing up to ${SAMPLE_LIMIT}):`);
    for (const t of added.slice(0, SAMPLE_LIMIT)) {
      console.log(`  [${t.id}] ${truncate(t.description, DESC_TRUNCATE)}`);
    }
  }
}

async function writeGithubOutput(changed, summary) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;

  const delimiter = `ghadelim_${Date.now()}`;
  const lines = [`changed=${changed}`, `summary<<${delimiter}`, summary, delimiter, ""].join("\n");
  await appendFile(outputPath, lines);
}

async function main() {
  const [oldFile, newFile] = process.argv.slice(2);
  if (!oldFile || !newFile) {
    throw new Error("Usage: node scripts/diff-trades.mjs <oldFile> <newFile>");
  }

  const [oldData, newData] = await Promise.all([loadTrades(oldFile), loadTrades(newFile)]);

  const diff = diffTrades(oldData, newData);
  const summary = buildSummary(diff);

  printReport(diff);
  await writeGithubOutput(diff.changed, summary);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exitCode = 1;
});
