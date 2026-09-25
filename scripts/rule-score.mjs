#!/usr/bin/env node
// rule-score.mjs — give every matching job the free rule score now
// (functions/lib/ruleScore.cjs), without waiting for the AI.
//
// For each job in the database whose type the user targets and that has no
// current AI assessment, stores the rule result as the user's score
// (jobScores + the Jobs page rollup). Jobs the rule score marks aiWorthy are
// flagged aiPending, so the AI refines them when it runs. AI assessments are
// never overwritten; type skips are left as they are.
//
// Usage: node scripts/rule-score.mjs [--user email] [--week 2026-09-21] [--write]
//   --week limits it to jobs posted that week (Mon–Fri Pacific); default: all jobs.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { weekWindow } from "./lib/week.mjs";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const { FIT_VERSION, profileStampOf } = require("../functions/lib/jobFit.cjs");
const { ruleAssessJob, profileSkills, RULE_VERSION } = require("../functions/lib/ruleScore.cjs");
const { familiesForProfile, shouldAssess, targetsKey } = require("../functions/lib/jobFamilies.cjs");
const { writeUserScores } = require("../functions/lib/userJobScores.cjs");

const ADMIN_UID = "7Tojjo8l5PZIYctPmdwncf7PC133";
const arg = (n) => { const i = process.argv.indexOf(n); return i === -1 ? null : process.argv[i + 1]; };
const write = process.argv.includes("--write");

const sa = JSON.parse(await readFile(new URL("../worker/service-account.json", import.meta.url), "utf8"));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const uid = arg("--user") ? (await admin.auth().getUserByEmail(arg("--user"))).uid : ADMIN_UID;
const [profileSnap, prefsSnap] = await Promise.all([db.doc(`users/${uid}/resume/profile`).get(), db.doc(`users/${uid}/settings/preferences`).get()]);
if (!profileSnap.exists) { console.error("This user has no resume yet."); process.exit(1); }
const profile = profileSnap.data();
const prefs = prefsSnap.data() || {};
const targets = Array.isArray(prefs.jobTypes) && prefs.jobTypes.length ? prefs.jobTypes : familiesForProfile(profile);
const tk = targetsKey(targets);
const profileStamp = profileStampOf(profile);
const mine = profileSkills(profile);

let q = db.collection("users").doc(ADMIN_UID).collection("jobs");
if (arg("--week")) { const w = weekWindow(arg("--week")); q = q.where("sourceUpdatedTs", ">=", w.start).where("sourceUpdatedTs", "<", w.end); }
const jobs = await q.select("title", "fullDescription").get();

const scoreRefs = jobs.docs.map((d) => db.doc(`users/${uid}/jobScores/${d.id}`));
const existing = new Map();
for (let i = 0; i < scoreRefs.length; i += 300) (await db.getAll(...scoreRefs.slice(i, i + 300))).forEach((s) => existing.set(s.id, s.exists ? s.data() : null));

const now = admin.firestore.Timestamp.now();
const entries = [];
const stats = { jobs: jobs.size, otherTypes: 0, hasAi: 0, noDescription: 0, scored: 0, aiPending: 0 };
const bands = { "80+": 0, "60-79": 0, "40-59": 0, "15-39": 0, "<15": 0 };
for (const d of jobs.docs) {
  const title = d.get("title") || "";
  const desc = d.get("fullDescription") || "";
  if (!shouldAssess(title, targets, desc).assess) { stats.otherTypes++; continue; }
  const fit = existing.get(d.id)?.fit;
  if (fit && fit.version === FIT_VERSION && !fit.screened && fit.profileStamp === profileStamp) { stats.hasAi++; continue; }
  if (desc.length < 200) { stats.noDescription++; continue; }
  const rule = ruleAssessJob({ profile, jobTitle: title, description: desc, targets, mine });
  const aiPending = rule.aiWorthy;
  stats.scored++;
  if (aiPending) stats.aiPending++;
  bands[rule.score >= 80 ? "80+" : rule.score >= 60 ? "60-79" : rule.score >= 40 ? "40-59" : rule.score >= 15 ? "15-39" : "<15"]++;
  entries.push({ jobId: d.id, score: rule.score, reason: rule.reason, fit: { ...rule, version: `rule-${RULE_VERSION}`, profileStamp, targetsKey: tk, scoredAt: now, ...(aiPending ? { aiPending: true } : {}) } });
}

console.log(`${stats.jobs} jobs · ${stats.otherTypes} other job types (left as is) · ${stats.hasAi} already have an AI score · ${stats.noDescription} without a description`);
console.log(`${stats.scored} ${write ? "rule-scored" : "would be rule-scored"}: ${JSON.stringify(bands)}`);
console.log(`${stats.aiPending} (${Math.round((100 * stats.aiPending) / Math.max(1, stats.scored))}%) would go to the AI (rule.aiWorthy); the rest are final on the rule score`);
if (write && entries.length) {
  for (let i = 0; i < entries.length; i += 400) await writeUserScores(uid, entries.slice(i, i + 400), db);
  console.log("written");
} else if (!write) console.log("dry run — add --write to save");
process.exit(0);
