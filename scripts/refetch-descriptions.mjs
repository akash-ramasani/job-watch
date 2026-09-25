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
// Pass 2 (--from-cache [--show-added]): re-run the current visa check on the
//   cached full text and on every other stored job; report what changes.
// Pass 3 (--write): the same, and save fullDescription + el.
//
// Usage: node scripts/refetch-descriptions.mjs [--cache private/refetch-descriptions.json] [--only-source workday]
//                                              [--from-cache|--write] [--show-added]

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

if (write || process.argv.includes("--from-cache")) {
  // Re-run the current visa check on the fetched full text and on every other
  // stored job; report (and with --write, save) what changes.
  const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  const fetched = new Map(cache.results.filter((r) => r.full && r.full.length > OLD_CUT).map((r) => [r.id, r.full]));
  const snap = await jobsCol.select("title", "companyName", "fullDescription", "el").get();
  // Use fetched text only when it continues the stored text: a posting edited
  // or replaced since (or a lookup that hit another posting) keeps what we had.
  const flat = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const full = new Map();
  for (const d of snap.docs) {
    const text = fetched.get(d.id);
    if (!text) continue;
    const old = flat(d.get("fullDescription"));
    if (flat(text).slice(0, 1500) === old.slice(0, 1500) || flat(text).includes(old.slice(100, 700))) full.set(d.id, text);
  }
  console.log(`${fetched.size} fetched · ${fetched.size - full.size} set aside (text no longer matches the stored posting)`);
  const changes = [];
  for (const d of snap.docs) {
    const j = d.data();
    const text = full.get(d.id) || j.fullDescription || "";
    const { flags, evidence } = eligibilityOf(text);
    const before = Array.isArray(j.el) ? j.el : [];
    const same = flags.length === before.length && flags.every((f) => before.includes(f));
    if (full.has(d.id) || !same) changes.push({ id: d.id, company: j.companyName, title: j.title, full: full.get(d.id), el: flags, added: flags.filter((f) => !before.includes(f)), removed: before.filter((f) => !flags.includes(f)), evidence });
  }
  const added = changes.filter((c) => c.added.length);
  const removed = changes.filter((c) => c.removed.length);
  console.log(`${full.size} longer descriptions · ${added.length} jobs gain a flag · ${removed.length} lose one`);
  for (const c of removed) console.log(`  unflag ${c.removed.join(",")}: ${c.company} — ${c.title}`);
  if (process.argv.includes("--show-added")) for (const c of added) for (const f of c.added) console.log(`  [${f}] ${c.company} :: ${String(c.evidence[f]).slice(0, 200)}`);
  if (write) {
    const bw = db.bulkWriter();
    for (const c of changes) bw.set(jobsCol.doc(c.id), { ...(c.full ? { fullDescription: c.full } : {}), el: c.el }, { merge: true });
    await bw.close();
    console.log(`wrote ${changes.length} jobs`);
  }
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
const onlySource = arg("--only-source"); // re-fetch one source and replace its entries in the cache
const snap = await jobsCol.select("title", "fullDescription", "source", "externalId", "companyKey", "companyName", "el", "jobUrl").get();
const todo = snap.docs
  .map((d) => ({ id: d.id, ...d.data() }))
  .filter((j) => (j.fullDescription || "").length === OLD_CUT && classifyTitle(j.title || "").some((f) => want.has(f)))
  .filter((j) => !onlySource || j.source === onlySource);
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
  const full = await fetchJobDescription(j.source, j.externalId, feed.url, null, j.jobUrl);
  if (full) record(j, full);
  if (++done % 250 === 0) console.log(`  per-job: ${done}/${perJob.length}`);
})));

const longer = results.filter((r) => r.full.length > OLD_CUT);
const newly = results.filter((r) => r.newFlags.length);
const kept = onlySource && fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")).results.filter((r) => r.source !== onlySource) : [];
fs.writeFileSync(cachePath, JSON.stringify({ at: new Date().toISOString(), results: [...kept, ...results] }, null, 1));
console.log(`fetched ${results.length}/${todo.length} · ${longer.length} longer than before · ${newly.length} newly flagged`);
const kinds = {};
for (const r of newly) for (const f of r.newFlags) kinds[f] = (kinds[f] || 0) + 1;
console.log("newly flagged by kind:", kinds, `\ncache: ${cachePath} — review, then rerun with --write`);
process.exit(0);
