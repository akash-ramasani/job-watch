#!/usr/bin/env node
// discover-ats-feeds.mjs — find Ashby and Greenhouse boards that aren't feeds
// yet, check each one, and (with --write) add the ones worth syncing.
//
// Candidates come from any text files: board links are pulled out with a
// regex, so endpoint lists, harvest CSVs, Common Crawl index dumps or GitHub
// search output all work as they are. A board is kept when its public API
// answers and it has at least --min open US postings of the profile's job
// types (the same location filter and type gate the sync uses). Boards that
// are already feeds, archived ones included, are skipped.
//
// Nothing is written without --write. Every checked board goes to the CSV,
// kept or not, with the reason.
//
// Usage: node scripts/discover-ats-feeds.mjs <file> [file…] [--guess companies.json] [--min 1] [--all-types]
//          [--sources ashby,greenhouse] [--limit N] [--add N] [--csv path] [--write]
//   --limit N checks only the first N new boards; --add N writes only the N
//   boards with the most matching postings (add in batches and watch the sync)
//        node scripts/discover-ats-feeds.mjs --apply private/discovered-feeds-<date>.csv
//          [--skip slug,slug] [--rename slug=Name] [--write]
//   default --csv: private/discovered-feeds-<today>.csv (private/ is git-ignored)
//
// New feeds are written like the extension's auto-added ones (addedBy
// "discover"); their first sync is a seed run, so scoring isn't flooded.

import path from "node:path";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.GOOGLE_APPLICATION_CREDENTIALS ||= path.join(__dirname, "..", "worker", "service-account.json");
process.env.GCLOUD_PROJECT ||= "greenhouse-jobs-scrapper";

const require = createRequire(path.join(__dirname, "..", "functions", "package.json"));
const { jobTypesFor, normalizeJobMinimal, jobMatchesLocationFilter, ADMIN_UID } = require("./index.js").__internals;
const admin = require("firebase-admin");
const { shouldAssess } = require("./lib/jobFamilies.cjs");
const pLimitPkg = require("p-limit");
const pLimit = pLimitPkg.default ?? pLimitPkg;

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
const valued = new Set(["--min", "--sources", "--limit", "--csv", "--guess", "--add", "--apply", "--skip", "--rename"]);
const files = argv.filter((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1]));
const write = argv.includes("--write");
const allTypes = argv.includes("--all-types");
const min = Number(arg("--min") || 1);
const sources = (arg("--sources") || "ashby,greenhouse").split(",").map((s) => s.trim().toLowerCase());
const limitN = Number(arg("--limit")) || Infinity;
const today = new Date().toISOString().slice(0, 10);
const csvPath = arg("--csv") || path.join(__dirname, "..", "private", `discovered-feeds-${today}.csv`);
if (!files.length && !arg("--guess") && !arg("--apply")) { console.error("Usage: node scripts/discover-ats-feeds.mjs <file> [file…] [--min 1] [--write]"); process.exit(1); }

const API = {
  ashby: (s) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s)}`,
  greenhouse: (s) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(s)}/jobs?content=true`,
};
// Path words on these hosts that aren't boards.
const NOT_SLUG = new Set(["embed", "api", "v1", "boards", "job-board", "posting-api", "favicon.ico", "robots.txt", "sitemap.xml", "jobs", "job_app", "static", "assets", "images", "_next"]);

/** "source:slug" keys for every Ashby/Greenhouse board link in a text. */
function slugsIn(text) {
  const out = new Map();
  const add = (source, raw) => {
    let s;
    try { s = decodeURIComponent(raw); } catch { s = raw; }
    s = s.trim();
    if (!s || s.length > 80 || NOT_SLUG.has(s.toLowerCase()) || !/^[A-Za-z0-9][A-Za-z0-9 ._'&-]*$/.test(s)) return;
    const key = `${source}:${s.toLowerCase()}`;
    if (!out.has(key)) out.set(key, { source, slug: s });
  };
  const patterns = [
    ["ashby", /jobs\.ashbyhq\.com\/([^/?#"'\s<>)\]\\,]+)/gi],
    ["ashby", /api\.ashbyhq\.com\/posting-api\/job-board\/([^/?#"'\s<>)\]\\,]+)/gi],
    ["greenhouse", /(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=)?([^/?#&"'\s<>)\]\\,]+)/gi],
    ["greenhouse", /boards-api(?:\.eu)?\.greenhouse\.io\/v1\/boards\/([^/?#"'\s<>)\]\\,]+)/gi],
    ["greenhouse", /greenhouse\.io\/[^"'\s<>]*?[?&]for=([A-Za-z0-9_-]+)/gi],
  ];
  for (const [source, re] of patterns) for (const m of text.matchAll(re)) add(source, m[1]);
  return out;
}

/** "source:slug" for a feed URL, or null. */
function feedKey(source, url) {
  const m = String(url || "").match(/ashbyhq\.com\/posting-api\/job-board\/([^/?#]+)/i) || String(url || "").match(/greenhouse\.io\/v1\/boards\/([^/?#]+)/i);
  if (!m) return null;
  let slug = m[1];
  try { slug = decodeURIComponent(slug); } catch { /* keep */ }
  return `${/ashby/i.test(source) ? "ashby" : "greenhouse"}:${slug.toLowerCase()}`;
}

async function getJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: { "User-Agent": "JobWatch feed discovery" } }).catch(() => null);
    if (r?.ok) return { ok: true, json: await r.json().catch(() => null) };
    if (r && r.status !== 429 && r.status < 500) return { ok: false, status: r.status };
    await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
  }
  return { ok: false, status: "network" };
}

/** "AccuWeather Careers", "Five Rings LLC - Careers", "Billtrust US Careers Page" → the company. */
const cleanName = (s) => String(s).trim().replace(/\s*[-–|:]?\s*(?:US\s+|Corporate\s+|University\s+)?(?:Careers?|Jobs)(?:\s+Page)?\s*$/i, "").trim() || String(s).trim();

async function companyName(source, slug) {
  try {
    if (source === "greenhouse") {
      const r = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}`);
      if (r.ok && r.json?.name) return cleanName(r.json.name);
    } else {
      const r = await fetch(`https://jobs.ashbyhq.com/${encodeURIComponent(slug)}`);
      const t = r.ok ? (await r.text()).match(/<title>([^<]+?)\s+Jobs\s*<\/title>/i) : null;
      if (t?.[1]) return cleanName(t[1]);
    }
  } catch { /* fall through */ }
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Lowercase letters and digits only, minus legal suffixes: "Acme, Inc." → "acme". */
const squash = (s) => String(s || "").toLowerCase().replace(/\b(inc|llc|ltd|corp|corporation|co|company|technologies|labs?|hq)\b\.?/g, "").replace(/[^a-z0-9]/g, "");

/** Likely board names for a company: its name squashed and hyphenated, its domain, its own slug. */
function guessSlugs({ name, slug, website }) {
  const out = new Set();
  const words = String(name || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length) { out.add(words.join("")); out.add(words.join("-")); }
  if (slug) out.add(String(slug).toLowerCase());
  try { out.add(new URL(website).hostname.replace(/^www\./, "").split(".")[0]); } catch { /* no site */ }
  return [...out].filter((s) => s.length >= 2);
}

// ─── Candidates ──────────────────────────────────────────────────────────────
// --guess <file.json>: a list of companies ({ name, slug?, website? }, e.g. the
// YC directory). Each gets a few guessed slugs on both boards; a guess is kept
// only when the board's own company name matches (checked below).
const candidates = new Map();
for (const file of files) {
  const found = slugsIn(await readFile(file, "utf8"));
  for (const [k, v] of found) if (!candidates.has(k)) candidates.set(k, v);
  console.log(`${file}: ${found.size} boards`);
}
if (arg("--guess")) {
  const list = JSON.parse(await readFile(arg("--guess"), "utf8"));
  let n = 0;
  for (const c of list) {
    if (!c?.name) continue;
    for (const s of guessSlugs(c)) for (const source of ["ashby", "greenhouse"]) {
      const k = `${source}:${s}`;
      if (!candidates.has(k)) { candidates.set(k, { source, slug: s, expect: c.name }); n++; }
    }
  }
  console.log(`${arg("--guess")}: ${list.length} companies → ${n} guessed boards`);
}

const db = admin.firestore();
const feedsSnap = await db.collection("users").doc(ADMIN_UID).collection("feeds").get();
const have = new Set(feedsSnap.docs.map((d) => feedKey(d.get("source"), d.get("url"))).filter(Boolean));
// Company names already followed on any board (Workday, Lever…), so the same jobs don't come in twice.
const haveNames = new Set(feedsSnap.docs.filter((d) => !d.get("archivedAt")).map((d) => squash(d.get("company") || d.get("companyName"))).filter(Boolean));
// --apply <csv>: write the "keep" rows of a reviewed CSV from an earlier dry
// run as they are, instead of discovering again. --skip slug,slug drops rows;
// --rename slug=Name fixes a name. Boards and companies that became feeds since
// are still skipped.
if (arg("--apply")) {
  const [head, ...lines] = (await readFile(arg("--apply"), "utf8")).split("\n").filter(Boolean);
  const cells = (line) => [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(?:,|$)/g)].map((m) => m[1].replace(/^"|"$/g, "").replace(/""/g, "\"")).slice(0, head.split(",").length);
  const cols = head.split(",");
  const skip = new Set((arg("--skip") || "").toLowerCase().split(",").filter(Boolean));
  const rename = Object.fromEntries((arg("--rename") || "").split(",").filter(Boolean).map((x) => x.split("=")).map(([k, v]) => [k.toLowerCase(), v]));
  const rows = lines.map((l) => Object.fromEntries(cells(l).map((v, i) => [cols[i], v]))).filter((r) => r.status === "keep");
  const out = [];
  for (const r of rows) {
    r.company = Object.hasOwn(rename, r.slug.toLowerCase()) ? rename[r.slug.toLowerCase()] : r.company;
    if (skip.has(r.slug.toLowerCase()) || have.has(`${r.source}:${r.slug.toLowerCase()}`) || haveNames.has(squash(r.company))) continue;
    out.push(r);
  }
  console.log(`${arg("--apply")}: ${rows.length} kept rows · ${rows.length - out.length} skipped (asked, or already feeds) · ${out.length} to write`);
  if (write) await writeFeeds(out); else console.log("dry run: nothing written (add --write)");
  process.exit(0);
}

const fresh = [...candidates.entries()].filter(([k, v]) => !have.has(k) && sources.includes(v.source)).map(([, v]) => v);
const todo = fresh.slice(0, limitN);
console.log(`${candidates.size} unique boards · ${candidates.size - fresh.length} already feeds (or other sources) · ${fresh.length} new · checking ${todo.length}`);

const [profileSnap, prefsSnap] = await Promise.all([
  db.doc(`users/${ADMIN_UID}/resume/profile`).get(),
  db.doc(`users/${ADMIN_UID}/settings/preferences`).get(),
]);
const targets = jobTypesFor(profileSnap.data() || {}, prefsSnap.data() || {});
if (!targets.length && !allTypes) { console.error("No job types on the admin profile. Use --all-types to count every job."); process.exit(1); }
const wantJob = allTypes ? () => true : (title, description) => shouldAssess(title, targets, description).assess;
console.log(`job types: ${allTypes ? "ALL" : targets.join(", ")} · keep boards with ≥${min} matching US posting(s)`);

// ─── Check each board ────────────────────────────────────────────────────────
const now = admin.firestore.Timestamp.now();
const limit = pLimit(8);
const results = [];
let done = 0;
await Promise.all(todo.map(({ source, slug, expect }) => limit(async () => {
  const url = API[source](slug);
  const row = { source, slug, url, company: "", total: 0, us: 0, matching: 0, newest: "", titles: "", status: "" };
  const r = await getJson(url);
  if (!r.ok) row.status = `HTTP ${r.status}`;
  else {
    const raw = Array.isArray(r.json?.jobs) ? r.json.jobs : [];
    row.total = raw.length;
    const jobs = raw.map((j) => normalizeJobMinimal(j, { source, companyName: slug, companyKey: "discover", now, url })).filter(Boolean);
    const us = jobs.filter(jobMatchesLocationFilter);
    const matching = us.filter((j) => wantJob(j.title, j.fullDescription || ""));
    row.us = us.length;
    row.matching = matching.length;
    row.newest = matching.map((j) => j.sourceUpdatedTs?.toDate?.()?.toISOString?.() || "").sort().pop()?.slice(0, 10) || "";
    row.titles = matching.slice(0, 3).map((j) => j.title).join(" | ");
    row.status = !raw.length ? "no jobs" : !us.length ? "no US jobs" : matching.length < min ? "no matching jobs" : "keep";
    if (row.status === "keep") row.company = await companyName(source, slug);
    // A guessed slug can belong to a different company with the same word.
    if (row.status === "keep" && expect) {
      const [a, b] = [squash(row.company), squash(expect)];
      if (!a || !b || (a !== b && !(a.length >= 4 && b.startsWith(a)) && !(b.length >= 4 && a.startsWith(b)))) row.status = `name mismatch (expected ${expect})`;
      else row.company = expect;
    }
  }
  results.push(row);
  if (++done % 100 === 0) console.log(`  … ${done}/${todo.length} checked, ${results.filter((x) => x.status === "keep").length} to keep`);
})));

for (const r of results) if (r.status === "keep" && haveNames.has(squash(r.company))) r.status = "company already a feed";
const keep = results.filter((r) => r.status === "keep").sort((a, b) => b.matching - a.matching);
// One feed per company: a company found on both boards keeps the one with more matches.
const byName = new Map();
for (const r of keep) { const k = r.company.toLowerCase(); if (!byName.has(k)) byName.set(k, r); else r.status = `duplicate of ${byName.get(k).source}:${byName.get(k).slug}`; }
// --add N: write only the N boards with the most matching postings (batches).
const add = keep.filter((r) => r.status === "keep").slice(0, Number(arg("--add")) || Infinity);

const esc = (v) => { const s = String(v ?? "").replace(/\r?\n/g, " "); return /[",]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s; };
const header = ["status", "company", "source", "slug", "matching", "us", "total", "newest", "titles", "url"];
const rows = results.sort((a, b) => (a.status === "keep" ? 0 : 1) - (b.status === "keep" ? 0 : 1) || b.matching - a.matching || b.us - a.us);
await mkdir(path.dirname(csvPath), { recursive: true });
await writeFile(csvPath, [header.join(","), ...rows.map((r) => header.map((h) => esc(r[h])).join(","))].join("\n"));

const tally = results.reduce((t, r) => { const k = r.status.startsWith("HTTP") ? "dead (HTTP error)" : r.status.startsWith("duplicate") ? "duplicate company" : r.status.startsWith("name mismatch") ? "name mismatch" : r.status; t[k] = (t[k] || 0) + 1; return t; }, {});
console.log(`\nchecked ${results.length}: ${JSON.stringify(tally)}`);
console.log(`to add: ${add.length} (ashby ${add.filter((r) => r.source === "ashby").length}, greenhouse ${add.filter((r) => r.source === "greenhouse").length}) · ${add.reduce((n, r) => n + r.matching, 0)} matching US postings between them`);
console.log("most matching:", add.slice(0, 20).map((r) => `${r.company} ${r.matching}`).join(", "));
console.log(`csv: ${csvPath}`);

if (write && add.length) await writeFeeds(add);
else if (!write) console.log("dry run: nothing written (add --write to create the feeds)");
process.exit(0);

/** Create a feed doc per row, shaped like the extension's auto-added ones. */
async function writeFeeds(list) {
  const col = db.collection("users").doc(ADMIN_UID).collection("feeds");
  const bw = db.bulkWriter();
  for (const r of list) {
    bw.create(col.doc(), {
      company: r.company, url: r.url, source: r.source, createdAt: admin.firestore.FieldValue.serverTimestamp(),
      archivedAt: null, lastCheckedAt: null, lastError: null, addedBy: "discover",
    });
  }
  await bw.close();
  console.log(`wrote ${list.length} feeds`);
}
