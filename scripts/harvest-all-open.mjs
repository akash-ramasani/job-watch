#!/usr/bin/env node
// harvest-all-open.mjs — every open posting on the Ashby and Greenhouse boards,
// whatever its age, kept until a date.
//
// The sync only takes postings from the last 3 days and they expire 3 days
// after posting, so a role that has been open for weeks is never in the
// database. This walks every active Ashby/Greenhouse feed once (the boards'
// public APIs return the whole list of open jobs), keeps the US postings whose
// type matches the profile's job types (or every type with --all-types), and
//   - writes the ones missing from the database with expireAt = --until
//   - pushes expireAt out to --until for the ones already stored
//   - writes a CSV of all of them, best rule score first, for applying.
// Nothing is sent to the AI: the rule score in the CSV is computed locally
// (functions/lib/ruleScore.cjs) and no score is stored.
//
// Usage: node scripts/harvest-all-open.mjs [--until 2026-10-16T23:59:00-07:00] [--sources ashby,greenhouse]
//          [--since 2000-01-01] [--all-types] [--user email] [--max-feeds N] [--csv path] [--write]
//   default --until: the coming Friday, end of day Pacific
//   default --csv:   private/harvest-open-<today>.csv (private/ is git-ignored)

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { pacific } from "./lib/week.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.GOOGLE_APPLICATION_CREDENTIALS ||= path.join(__dirname, "..", "worker", "service-account.json");
process.env.GCLOUD_PROJECT ||= "greenhouse-jobs-scrapper";

const require = createRequire(path.join(__dirname, "..", "functions", "package.json"));
const functionsModule = require("./index.js");
const { harvestFeedJobs, loadActiveFeeds, jobTypesFor, ADMIN_UID } = functionsModule.__internals;
const admin = require("firebase-admin");
const { shouldAssess } = require("./lib/jobFamilies.cjs");
const { ruleAssessJob, profileSkills } = require("./lib/ruleScore.cjs");
const { eligibilityOf, blockedReason, needsSponsorship } = require("./lib/eligibility.cjs");
const pLimitPkg = require("p-limit");
const pLimit = pLimitPkg.default ?? pLimitPkg;

const arg = (n) => { const i = process.argv.indexOf(n); return i === -1 ? null : process.argv[i + 1]; };
const write = process.argv.includes("--write");
const allTypes = process.argv.includes("--all-types");
const sources = (arg("--sources") || "ashby,ashbyhq,greenhouse").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const maxFeeds = Number(arg("--max-feeds")) || Infinity;

// Default keep-until: the coming Friday, end of day Pacific.
const ymdPacific = (d) => new Date(d.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
const comingFriday = () => {
  const pt = ymdPacific(new Date());
  const ahead = ((5 - pt.getDay()) + 7) % 7 || 7; // 1..7 days ahead, never today
  pt.setDate(pt.getDate() + ahead);
  return `${pt.getFullYear()}-${String(pt.getMonth() + 1).padStart(2, "0")}-${String(pt.getDate()).padStart(2, "0")}`;
};
const untilDay = arg("--until") ? null : comingFriday();
const until = arg("--until") ? new Date(arg("--until")) : pacific(untilDay, "23:59");
const since = new Date(arg("--since") || "2000-01-01T00:00:00Z");
const today = new Date().toISOString().slice(0, 10);
const tag = `open-${today}`;
const csvPath = arg("--csv") || path.join(__dirname, "..", "private", `harvest-open-${today}.csv`);
if (Number.isNaN(until.getTime()) || Number.isNaN(since.getTime())) { console.error("Bad --until or --since date."); process.exit(1); }

const db = admin.firestore();
let uid = ADMIN_UID;
if (arg("--user")) uid = (await admin.auth().getUserByEmail(arg("--user"))).uid;
const [userSnap, profileSnap, prefsSnap] = await Promise.all([
  db.doc(`users/${uid}`).get(),
  db.doc(`users/${uid}/resume/profile`).get(),
  db.doc(`users/${uid}/settings/preferences`).get(),
]);
const profile = profileSnap.data() || {};
const targets = jobTypesFor(profile, prefsSnap.data() || {});
if (!targets.length && !allTypes) { console.error("No job types for this user (no resume and no saved job types). Use --all-types to take every job."); process.exit(1); }
const wantJob = allTypes ? () => true : (title, description) => shouldAssess(title, targets, description).assess;
const needsVisa = needsSponsorship(userSnap.data() || {});
const mine = profileSkills(profile);

const feeds = (await loadActiveFeeds(ADMIN_UID)).filter((f) => sources.includes(String(f.source || "").toLowerCase())).slice(0, maxFeeds);
console.log(`${write ? "WRITE" : "dry run"} · every open posting since ${since.toISOString().slice(0, 10)} · keep until ${until.toISOString()} (${until.toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} PT)`);
console.log(`sources: ${sources.join(", ")} · ${feeds.length} feeds · job types: ${allTypes ? "ALL" : targets.join(", ")}`);

const limit = pLimit(8);
const totals = { feeds: 0, failed: 0, fetched: 0, matched: 0, added: 0, extended: 0 };
const bySource = {};
const top = [];
const rows = [];
const started = Date.now();
await Promise.all(feeds.map((feed) => limit(async () => {
  try {
    const r = await harvestFeedJobs({ userId: ADMIN_UID, feed, since, until, wantJob, retainUntil: until, weekTag: tag, dryRun: !write, extendExisting: true });
    const added = write ? r.written : r.missing || 0;
    totals.feeds++; totals.fetched += r.fetched; totals.matched += r.matched; totals.added += added; totals.extended += r.extended || 0;
    const s = (bySource[feed.source] ||= { feeds: 0, matched: 0, added: 0, extended: 0 });
    s.feeds++; s.matched += r.matched; s.added += added; s.extended += r.extended || 0;
    if (added) top.push([added, feed.companyName || feed.company || feed.id]);
    rows.push(...(r.rows || []));
  } catch (e) {
    totals.failed++;
    console.log(`  ! ${feed.companyName || feed.company || feed.id}: ${String(e.message).split(". Body:")[0].slice(0, 120)}`);
  }
  if ((totals.feeds + totals.failed) % 100 === 0) console.log(`  … ${totals.feeds + totals.failed}/${feeds.length} feeds, ${totals.matched} matching so far (${totals.added} ${write ? "added" : "missing"})`);
})));

// CSV: every matching open posting, best rule score first. The score is the
// free rule score computed here; nothing is stored and the AI is not called.
const esc = (v) => { const s = String(v ?? "").replace(/\r?\n/g, " "); return /[",]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s; };
const scored = rows.map((r) => {
  let score = "", reason = "";
  try {
    const rule = ruleAssessJob({ profile, jobTitle: r.title, description: r.description || "", targets, mine });
    score = rule.score; reason = rule.reason || "";
  } catch (_) { /* no score */ }
  const flags = r.description ? eligibilityOf(r.description).flags : [];
  const blocked = needsVisa ? blockedReason(flags, true) : null;
  return { ...r, score, reason, eligibility: blocked || "ok" };
}).sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || String(b.postedAt).localeCompare(String(a.postedAt)));
const header = ["score", "eligibility", "title", "company", "location", "source", "posted", "status", "jobUrl", "applyUrl", "reason", "id"];
const csv = [header.join(","), ...scored.map((r) => [r.score, r.eligibility, r.title, r.companyName, r.locationName, r.source, r.postedAt.slice(0, 10), r.status, r.jobUrl, r.applyUrl, r.reason, r.id].map(esc).join(","))].join("\n");
await mkdir(path.dirname(csvPath), { recursive: true });
await writeFile(csvPath, csv);

console.log(`\ndone in ${Math.round((Date.now() - started) / 1000)}s: ${totals.feeds} feeds (${totals.failed} failed) · ${totals.fetched} open postings seen · ${totals.matched} match (US + job type) · ${totals.added} ${write ? "added" : "missing, would be added"} · ${totals.extended} ${write ? "extended" : "stored, would be extended"} to ${until.toISOString().slice(0, 10)}`);
console.log("by source:", JSON.stringify(bySource));
console.log("most added:", top.sort((a, b) => b[0] - a[0]).slice(0, 15).map(([n, c]) => `${c} ${n}`).join(", "));
console.log(`eligibility: ${scored.filter((r) => r.eligibility === "ok").length} ok · ${scored.filter((r) => r.eligibility !== "ok").length} blocked for a sponsorship candidate`);
console.log(`csv: ${csvPath} (${scored.length} rows)`);
process.exit(0);
