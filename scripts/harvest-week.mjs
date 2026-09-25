#!/usr/bin/env node
// harvest-week.mjs — fetch this week's matching jobs that aren't in the database.
//
// The sync only takes jobs as they appear, and they expire 3 days after
// posting; Workday/Oracle feeds added mid-week also skipped what was already
// posted. This walks every active feed once and writes the jobs posted
// Monday–Friday (Pacific) whose type matches the profile's job types and that
// are missing, keeping them until next Monday 3 PM PT. Jobs already in the
// database are handled by scripts/retain-week.mjs. Runs the functions' own
// fetch + normalize code locally; nothing is deployed.
//
// Usage: node scripts/harvest-week.mjs [--week 2026-09-21] [--until ISO] [--user email] [--only workday,oracle] [--write]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { weekWindow } from "./lib/week.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.GOOGLE_APPLICATION_CREDENTIALS ||= path.join(__dirname, "..", "worker", "service-account.json");
process.env.GCLOUD_PROJECT ||= "greenhouse-jobs-scrapper";

const require = createRequire(path.join(__dirname, "..", "functions", "package.json"));
const functionsModule = require("./index.js");
const { harvestFeedJobs, loadActiveFeeds, jobTypesFor, ADMIN_UID } = functionsModule.__internals;
const admin = require("firebase-admin");
const { shouldAssess } = require("./lib/jobFamilies.cjs");
const pLimitPkg = require("p-limit");
const pLimit = pLimitPkg.default ?? pLimitPkg;

const arg = (n) => { const i = process.argv.indexOf(n); return i === -1 ? null : process.argv[i + 1]; };
const write = process.argv.includes("--write");
const only = arg("--only") ? arg("--only").split(",") : null;
const { week, start, end, until } = weekWindow(arg("--week") || undefined, arg("--until"));

const db = admin.firestore();
let uid = ADMIN_UID;
if (arg("--user")) uid = (await admin.auth().getUserByEmail(arg("--user"))).uid;
const [profileSnap, prefsSnap] = await Promise.all([
  db.doc(`users/${uid}/resume/profile`).get(),
  db.doc(`users/${uid}/settings/preferences`).get(),
]);
const targets = jobTypesFor(profileSnap.data() || {}, prefsSnap.data() || {});
if (!targets.length) { console.error("No job types for this user (no resume and no saved job types)."); process.exit(1); }
const wantJob = (title, description) => shouldAssess(title, targets, description).assess;

const feeds = (await loadActiveFeeds(ADMIN_UID)).filter((f) => !only || only.some((s) => String(f.source).includes(s)));
console.log(`${write ? "WRITE" : "dry run"} · week of ${week} (${start.toISOString()} → ${end.toISOString()}) · keep until ${until.toISOString()}`);
console.log(`targets: ${targets.join(", ")} · ${feeds.length} feeds`);

const limit = pLimit(8);
const totals = { feeds: 0, failed: 0, fetched: 0, matched: 0, added: 0 };
const bySource = {};
const top = [];
const started = Date.now();
await Promise.all(feeds.map((feed) => limit(async () => {
  try {
    const r = await harvestFeedJobs({ userId: ADMIN_UID, feed, since: start, until: end, wantJob, retainUntil: until, weekTag: week, dryRun: !write });
    const added = write ? r.written : r.missing || 0;
    totals.feeds++; totals.fetched += r.fetched; totals.matched += r.matched; totals.added += added;
    const s = (bySource[feed.source] ||= { feeds: 0, matched: 0, added: 0 });
    s.feeds++; s.matched += r.matched; s.added += added;
    if (added) top.push([added, feed.company || feed.companyName]);
  } catch (e) {
    totals.failed++;
    console.log(`  ! ${feed.company || feed.id}: ${String(e.message).split(". Body:")[0].slice(0, 120)}`);
  }
  if ((totals.feeds + totals.failed) % 100 === 0) console.log(`  … ${totals.feeds + totals.failed}/${feeds.length} feeds, ${totals.added} ${write ? "added" : "missing"} so far`);
})));

console.log(`\ndone in ${Math.round((Date.now() - started) / 1000)}s: ${totals.feeds} feeds (${totals.failed} failed) · ${totals.matched} matching jobs posted that week · ${totals.added} ${write ? "added" : "missing, would be added"}`);
console.log("by source:", JSON.stringify(bySource));
console.log("most added:", top.sort((a, b) => b[0] - a[0]).slice(0, 15).map(([n, c]) => `${c} ${n}`).join(", "));
process.exit(0);
