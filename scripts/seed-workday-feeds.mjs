#!/usr/bin/env node
// seed-workday-feeds.mjs — create users/{ADMIN_UID}/feeds docs for every
// Workday career site in scripts/workday_companies.csv (source: "workday").
//
// Idempotent: a company whose canonical career URL already exists as a feed is
// skipped (archived or not), so re-running after adding rows is safe.
//
// Usage:
//   node scripts/seed-workday-feeds.mjs                 # add all rows
//   node scripts/seed-workday-feeds.mjs --only NVIDIA   # add one company (staged rollout)
//   node scripts/seed-workday-feeds.mjs --dry-run       # print, write nothing
//
// The first sync of a Workday feed is a seed run: every current posting is
// remembered in users/{uid}/feedState/{feedId} and only today's US postings are
// written (max 15 per feed per run), so scoring isn't flooded.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { db, ADMIN_UID } from "../worker/lib/firestore.mjs";

// firebase-admin is installed under worker/, not at the repo root.
const require = createRequire(new URL("../worker/package.json", import.meta.url));
const { FieldValue } = require("firebase-admin/firestore");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV_PATH = path.join(__dirname, "workday_companies.csv");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx !== -1 ? (args[onlyIdx + 1] || "").toLowerCase() : null;

// Minimal RFC-4180 reader: categories like "Internet, Media & Telecom" are quoted.
function splitCsvLine(line) {
  const cells = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { cells.push(cur); cur = ""; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

function parseCsv(text) {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const cols = splitCsvLine(header);
  return lines.filter(Boolean).map((line) => {
    const cells = splitCsvLine(line);
    return Object.fromEntries(cols.map((c, i) => [c, (cells[i] || "").trim()]));
  });
}

// Same reduction as parseWorkdayFeedUrl in functions/index.js.
function canonicalWorkdayUrl(raw) {
  const u = new URL(raw);
  const host = u.hostname.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/i);
  if (!host) throw new Error(`Not a Workday host: ${raw}`);
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length && /^[a-z]{2}-[A-Z]{2}$/.test(parts[0])) parts.shift();
  if (!parts[0]) throw new Error(`No site in URL: ${raw}`);
  return `https://${u.hostname}/${parts[0]}`;
}

const rows = parseCsv(await readFile(CSV_PATH, "utf8"))
  .filter((r) => r.company && r.career_url)
  .filter((r) => !only || r.company.toLowerCase() === only);

if (rows.length === 0) {
  console.error(only ? `No row for --only ${only}` : "CSV is empty");
  process.exit(1);
}

const firestore = await db();
const feedsCol = firestore.collection("users").doc(ADMIN_UID).collection("feeds");
const existing = new Set(
  (await feedsCol.get()).docs.map((d) => String(d.data().url || "").toLowerCase())
);

let added = 0;
let skipped = 0;
for (const r of rows) {
  const url = canonicalWorkdayUrl(r.career_url);
  if (existing.has(url.toLowerCase())) {
    skipped++;
    console.log(`skip  ${r.company} (already a feed)`);
    continue;
  }
  console.log(`${dryRun ? "would add" : "add  "} ${r.company} → ${url}`);
  if (!dryRun) {
    await feedsCol.add({
      company: r.company,
      url,
      source: "workday",
      category: r.category || null,
      createdAt: FieldValue.serverTimestamp(),
      archivedAt: null,
      lastCheckedAt: null,
      lastError: null,
    });
    existing.add(url.toLowerCase());
  }
  added++;
}

console.log(`\n${dryRun ? "would add" : "added"} ${added}, skipped ${skipped} of ${rows.length}`);
process.exit(0);
