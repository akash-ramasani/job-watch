#!/usr/bin/env node
// apply-top-matches.mjs — queue the best matches waiting on the Applications
// page ("Retrying": marked for another try; "Ready": filled, never submitted)
// at the front of auto-apply, so they are submitted first.
//
// A job qualifies when its posting is still open, the person is eligible for
// it (no US-citizenship, clearance or no-sponsorship bar in the posting or
// the form), and its match score is at least --min (60). The score is the
// job's own (users/{uid}/jobScores) while JobWatch still holds the job; for
// older jobs, whose records have expired, the rule score is worked out again
// from the posting as it reads now (lib/ruleScore.cjs, free, the score new
// jobs get first).
//
// Qualifying jobs are marked retryRequested + retryPriority; the queue
// (lib/apply/autoApply.cjs) puts them first, best score first. Workday ones
// submit when Workday Submit is on. Nothing else is changed.
//
// Usage:
//   node scripts/apply-top-matches.mjs              # dry run: every job with its score and outcome
//   node scripts/apply-top-matches.mjs --write      # mark the qualifying ones
//   node scripts/apply-top-matches.mjs --min 70     # another threshold
import { createRequire } from "node:module";
import { db as getDb, ADMIN_UID } from "../worker/lib/firestore.mjs";
import { posting, applyUrlOf } from "./lib/postings.mjs";

const require = createRequire(new URL("../functions/index.js", import.meta.url));
const { createAssistantContext } = require("./lib/assistantTools.cjs");
const { ruleAssessJob, profileSkills } = require("./lib/ruleScore.cjs");
const { eligibilityOf, blockedReason, needsSponsorship } = require("./lib/eligibility.cjs");

const args = process.argv.slice(2);
const write = args.includes("--write");
const minArg = args.indexOf("--min");
const MIN = minArg !== -1 ? Number(args[minArg + 1]) || 60 : 60;

const db = await getDb();
const U = db.collection("users").doc(ADMIN_UID);
const ctx = createAssistantContext(db, ADMIN_UID, { adminUid: ADMIN_UID });
const [userDoc, jobTypes, resumeSnap] = await Promise.all([ctx.userDoc(), ctx.jobTypes(), U.collection("resume").doc("profile").get()]);
const profile = resumeSnap.exists ? resumeSnap.data() : {};
const mine = profileSkills(profile);
const sponsorship = needsSponsorship(userDoc);
const ms = (v) => (v?.toDate ? v.toDate().getTime() : Date.parse(v || "") || 0);

const apps = (await U.collection("applications").get()).docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));
const retrying = apps.filter((a) => a.retryRequested && !["submitted", "dismissed"].includes(a.status) && Date.parse(a.retryRequested) > ms(a.lastStartedAt));
const ready = apps.filter((a) => a.status === "ready" && !retrying.includes(a));

/** The job's stored score while JobWatch still holds the job. */
async function storedScore(a) {
  let jd = null;
  if (a.jobId) { const d = await U.collection("jobs").doc(String(a.jobId)).get(); if (d.exists) jd = d; }
  if (!jd) {
    const ext = String(a.formKey || a.id).split("|")[2];
    if (ext) { const s = await U.collection("jobs").where("externalId", "==", ext).limit(2).get(); jd = s.docs[0] || null; }
  }
  if (!jd) return null;
  const sc = await U.collection("jobScores").doc(jd.id).get();
  return sc.exists && typeof sc.data().score === "number" ? sc.data().score : null;
}

const rows = [];
for (const [tab, list] of [["Retrying", retrying], ["Ready", ready]]) {
  for (const a of list) {
    const p = await posting(a, a.id);
    const r = { a, tab, board: String(a.formKey || a.id).split("|")[0] };
    if (p.open === false) { rows.push({ ...r, out: "closed" }); continue; }
    const blocked = blockedReason([...eligibilityOf(`${a.jobTitle || ""}. ${p.desc || ""}`).flags, ...(p.formCitizen ? ["citizen"] : [])], sponsorship);
    if (blocked) { rows.push({ ...r, out: `not eligible: ${blocked}` }); continue; }
    let score = await storedScore(a);
    let how = "stored";
    if (score == null && p.desc) {
      const rule = ruleAssessJob({ profile, jobTitle: a.jobTitle || "", description: p.desc, targets: jobTypes, mine });
      score = rule.screened ? 0 : rule.score;
      how = rule.screened ? "rule (screened)" : "rule";
    }
    if (score == null) { rows.push({ ...r, out: "no description to score" }); continue; }
    const url = a.retryApplyUrl || applyUrlOf(a, a.id);
    rows.push({ ...r, score, how, url, out: score >= MIN && url ? "apply" : `score below ${MIN}` });
  }
}

const count = (t, o) => rows.filter((x) => x.tab === t && (o ? x.out === o : true)).length;
for (const t of ["Retrying", "Ready"]) {
  const outs = {};
  for (const x of rows.filter((x) => x.tab === t)) { const k = x.out.startsWith("not eligible") ? "not eligible" : x.out; outs[k] = (outs[k] || 0) + 1; }
  console.log(`${t}: ${count(t)}  ${JSON.stringify(outs)}`);
}
const go = rows.filter((x) => x.out === "apply").sort((x, y) => y.score - x.score);
console.log(`\nTo apply (score >= ${MIN}): ${go.length}`);
for (const x of go) console.log(`  ${String(x.score).padStart(3)} ${x.how.padEnd(6)} ${x.tab.padEnd(8)} ${x.board.padEnd(10)} ${String(x.a.companyName || "?").slice(0, 26).padEnd(26)} | ${String(x.a.jobTitle || "").slice(0, 60)}`);

if (!write) { console.log("\nDry run. Add --write to queue these first."); process.exit(0); }
const iso = new Date().toISOString();
for (let i = 0; i < go.length; i += 400) {
  const batch = db.batch();
  for (const x of go.slice(i, i + 400)) batch.update(x.a.ref, { retryRequested: iso, retryApplyUrl: x.url, retryPriority: true, retryScore: x.score, updatedAt: iso });
  await batch.commit();
}
console.log(`\nQueued ${go.length} first (${iso}).`);
process.exit(0);
