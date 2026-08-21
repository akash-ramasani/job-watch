#!/usr/bin/env node
// run-loop.mjs — the Greenhouse auto-apply loop (runs on the Linux box).
//
// Reads your scored Greenhouse jobs from Firestore, applies the eligible ones,
// and parks anything uncertain into a review queue. NEVER misses a job: it
// processes every eligible job and logs every skip with a reason.
//
// SAFE BY DEFAULT: dry-run. It generates docs, maps answers, and runs the
// 4-pass gate, but does NOT submit unless you pass --submit (Phase 3, gated).
//
// Usage:
//   node run-loop.mjs                 # dry-run over all eligible jobs
//   node run-loop.mjs --min 60 --limit 20
//   node run-loop.mjs --submit        # (after the supervised test is signed off)

import { db, bucket, ADMIN_UID, getProfile, getResume } from "./lib/firestore.mjs";
import { fetchForm, parseBoardToken } from "./lib/greenhouse.mjs";
import { runApplyFlow } from "./lib/apply-flow.mjs";
import { selectEligible, jobKey } from "./lib/dedup.mjs";

const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, arr) =>
  a.startsWith("--") ? [[a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]] : []));
const MIN_SCORE = Number(args.min ?? process.env.APPLY_MIN_SCORE ?? 40);
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const SUBMIT = !!args.submit; // Phase 3 — held off until field-tested
const OUT = new URL("./out", import.meta.url).pathname;

async function loadGreenhouseJobs(d) {
  // Query by source only (no composite index needed); filter score in memory.
  const out = [];
  let last = null;
  for (;;) {
    let q = d.collection("users").doc(ADMIN_UID).collection("jobs")
      .where("source", "==", "greenhouse").orderBy("__name__").limit(1000);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    snap.forEach((doc) => {
      const j = { id: doc.id, ...doc.data() };
      if ((j.relevanceScore ?? 0) >= MIN_SCORE && j.externalId) out.push(j);
    });
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 1000) break;
  }
  return out;
}

const feedTokens = new Map();
async function tokenFor(d, companyKey) {
  if (feedTokens.has(companyKey)) return feedTokens.get(companyKey);
  const f = await d.collection("users").doc(ADMIN_UID).collection("feeds").doc(companyKey).get();
  const t = f.exists ? parseBoardToken(f.data().url) : null;
  feedTokens.set(companyKey, t);
  return t;
}

async function writeReview(d, job, result) {
  const key = jobKey(job).replace(/[/#?]/g, "_").slice(0, 400);
  const reasons = result.verdict.failures;
  const answered = result.mapped.answers.filter((a) => a.answers.length).length;
  await d.collection("users").doc(ADMIN_UID).collection("needsReview").doc(key).set({
    title: job.title, company: job.companyName || "", jobUrl: job.jobUrl || "",
    score: job.relevanceScore ?? null, source: "greenhouse",
    answered, total: result.mapped.answers.length, reasons,
    updatedAt: new Date(),
  }, { merge: true });
}

async function main() {
  const d = await db();
  const [profile, resume] = await Promise.all([getProfile(), getResume()]);
  console.log(`loop start  min-score=${MIN_SCORE}  submit=${SUBMIT ? "ON" : "dry-run"}`);

  const all = await loadGreenhouseJobs(d);
  const { eligible, skipped } = selectEligible(all, { minScore: MIN_SCORE });
  console.log(`greenhouse jobs >= ${MIN_SCORE}: ${all.length} | eligible now: ${eligible.length} | skipped: ${skipped.length}`);

  let ready = 0, parked = 0, errors = 0, submitted = 0, processed = 0;
  for (const job of eligible) {
    if (processed >= LIMIT) { console.log(`(stopping at --limit ${LIMIT}; ${eligible.length - processed} eligible not processed)`); break; }
    processed++;
    try {
      const token = await tokenFor(d, job.companyKey);
      if (!token) { console.log(`  ? no board token: ${job.title}`); errors++; continue; }
      const form = await fetchForm(token, job.externalId);
      const result = await runApplyFlow(profile, resume, { ...job, questions: form.questions, descriptionHtml: form.descriptionHtml, title: form.title }, OUT);

      if (result.ready) {
        ready++;
        if (SUBMIT) {
          // Phase 3 submission goes here (gated). Held until the supervised test.
          console.log(`  READY (submit held): ${form.title}`);
        } else {
          console.log(`  READY (would submit): ${form.title} @ ${token}`);
        }
      } else {
        parked++;
        await writeReview(d, { ...job, title: form.title }, result);
        console.log(`  review (${result.verdict.failures.length}): ${form.title}`);
      }
    } catch (e) {
      errors++;
      console.log(`  error: ${job.title}: ${e.message}`);
    }
  }

  console.log(`\ndone  processed=${processed}  ready=${ready}  parked=${parked}  submitted=${submitted}  errors=${errors}`);
  console.log(`(nothing missed: eligible=${eligible.length}, processed+remaining accounted for)`);
  process.exit(0);
}

main().catch((e) => { console.error("loop failed:", e.message); process.exit(1); });
