#!/usr/bin/env node
// refetch-descriptions.mjs — re-read job descriptions that were stored cut off.
//
// Until 2026-09-25 descriptions were stored cut at 4,000 characters, which
// dropped the closing "Sponsorship:" / citizenship paragraphs of most long
// postings, so the visa check (functions/lib/eligibility.cjs) never saw them.
// This re-fetches the full description of every stored job that was cut
// (exactly 4,000 characters) and whose title is a type some user targets,
// re-runs the visa check, and reports what it would newly flag.
//
// Pass 1 (default): fetch and save results to --cache (no database writes).
// Pass 2 (--write): write fullDescription + el from the cache.
//
// Usage: node scripts/refetch-descriptions.mjs [--cache private/refetch-descriptions.json] [--write]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.GOOGLE_APPLICATION_CREDENTIALS ||= path.join(__dirname, "..", "worker", "service-account.json");
process.env.GCLOUD_PROJECT ||= "greenhouse-jobs-scrapper";
const require = createRequire(path.join(__dirname, "..", "functions", "package.json"));
const { ADMIN_UID, fetchJobsFromFeed, normalizeJobMinimal, fetchJobDescription } = require("./index.js").__internals;
const admin = require("firebase-admin");
const { classifyTitle } = require("./lib/jobFamilies.cjs");
const { eligibilityOf } = require("./lib/eligibility.cjs");
const pLimitPkg = require("p-limit");
const pLimit = pLimitPkg.default || pLimitPkg;

const arg = (n) => { const i = process.argv.indexOf(n); return i === -1 ? null : process.argv[i + 1]; };
const write = process.argv.includes("--write");
const cachePath = arg("--cache") || path.join(__dirname, "..", "private", "refetch-descriptions.json");
const OLD_CUT = 4000;
const db = admin.firestore();
const jobsCol = db.collection("users").doc(ADMIN_UID).collection("jobs");

if (write) {
  const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  const bw = db.bulkWriter();
  let n = 0;
  for (const r of cache.results) {
    if (!r.full || r.full.length <= OLD_CUT) continue;
    bw.set(jobsCol.doc(r.id), { fullDescription: r.full, el: r.el }, { merge: true });
    n++;
  }
  await bw.close();
  console.log(`wrote ${n} full descriptions (${cache.results.filter((r) => r.newFlags?.length).length} newly flagged)`);
  process.exit(0);
}

// Job types any user targets.
const users = (await db.collection("users").get()).docs;
const want = new Set();
for (const u of users) {
  const [prefs, scoring] = await Promise.all([db.doc(`users/${u.id}/settings/preferences`).get(), db.doc(`users/${u.id}/settings/scoring`).get()]);
  const t = prefs.data()?.jobTypes?.length ? prefs.data().jobTypes : scoring.data()?.autoJobTypes || [];
  for (const f of t) want.add(f);
}

const feeds = new Map((await db.collection("users").doc(ADMIN_UID).collection("feeds").get()).docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
const snap = await jobsCol.select("title", "fullDescription", "source", "externalId", "companyKey", "companyName", "el").get();
const todo = snap.docs
  .map((d) => ({ id: d.id, ...d.data() }))
  .filter((j) => (j.fullDescription || "").length === OLD_CUT && classifyTitle(j.title || "").some((f) => want.has(f)));
console.log(`${snap.size} jobs · ${todo.length} cut at ${OLD_CUT} with a targeted type · types: ${[...want].join(", ")}`);

const results = [];
const now = admin.firestore.Timestamp.now();
const record = (j, full) => {
  const el = eligibilityOf(full || "");
  const before = Array.isArray(j.el) ? j.el : [];
  results.push({ id: j.id, title: j.title, company: j.companyName, source: j.source, full, el: el.flags, newFlags: el.flags.filter((f) => !before.includes(f)), evidence: el.evidence });
};

// Greenhouse and Ashby: one request per board returns every description.
const BOARD_LEVEL = new Set(["greenhouse", "ashbyhq"]);
const byFeed = new Map();
for (const j of todo.filter((x) => BOARD_LEVEL.has(x.source))) {
  if (!byFeed.has(j.companyKey)) byFeed.set(j.companyKey, []);
  byFeed.get(j.companyKey).push(j);
}
const boardLimit = pLimit(8);
let boardsFailed = 0;
await Promise.all([...byFeed].map(([feedId, jobs]) => boardLimit(async () => {
  const feed = feeds.get(feedId);
  if (!feed?.url) return;
  const source = String(feed.source || "").toLowerCase();
  let url = feed.url;
  if (source.includes("greenhouse") && !url.includes("content=true")) url += url.includes("?") ? "&content=true" : "?content=true";
  try {
    const raw = await fetchJobsFromFeed(url, source, null);
    const full = new Map(raw.map((r) => normalizeJobMinimal(r, { source, companyName: "", companyKey: feedId, now, url })).filter(Boolean).map((n) => [n.jobDocId, n.fullDescription]));
    for (const j of jobs) if (full.get(j.id)) record(j, full.get(j.id));
  } catch {
    boardsFailed++;
  }
})));
console.log(`boards: ${byFeed.size} (${boardsFailed} failed) · ${results.length} descriptions`);

// Everyone else: one detail request per job.
const perJob = todo.filter((x) => !BOARD_LEVEL.has(x.source));
const jobLimit = pLimit(12);
let done = 0;
await Promise.all(perJob.map((j) => jobLimit(async () => {
  const feed = feeds.get(j.companyKey);
  if (!feed?.url || !j.externalId) return;
  const full = await fetchJobDescription(j.source, j.externalId, feed.url, null);
  if (full) record(j, full);
  if (++done % 250 === 0) console.log(`  per-job: ${done}/${perJob.length}`);
})));

const longer = results.filter((r) => r.full.length > OLD_CUT);
const newly = results.filter((r) => r.newFlags.length);
fs.writeFileSync(cachePath, JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
console.log(`fetched ${results.length}/${todo.length} · ${longer.length} longer than before · ${newly.length} newly flagged`);
const kinds = {};
for (const r of newly) for (const f of r.newFlags) kinds[f] = (kinds[f] || 0) + 1;
console.log("newly flagged by kind:", kinds, `\ncache: ${cachePath} — review, then rerun with --write`);
process.exit(0);
