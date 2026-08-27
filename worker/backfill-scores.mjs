// backfill-scores.mjs — one-off repair: mirror relevanceScore from the shared
// job docs into /users/{ADMIN_UID}/jobScores/* and rebuild the myJobScores
// aggregation. Fixes jobs scored by the pipeline but never mirrored (the old
// code only mirrored the first 50 scores per sync).
//
// Usage: node backfill-scores.mjs [--apply]   (default is dry-run)

import { db, ADMIN_UID } from "./lib/firestore.mjs";
import { Timestamp } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const MAX_SCORES_IN_AGG = 2000; // must match functions/lib/userJobScores.cjs

const fdb = await db();
const userRef = fdb.collection("users").doc(ADMIN_UID);

const [jobsSnap, scoresSnap] = await Promise.all([
  userRef.collection("jobs").get(),
  userRef.collection("jobScores").get(),
]);

const existing = new Map(scoresSnap.docs.map((d) => [d.id, d.data().score]));

let scored = 0, failed = 0, unscored = 0;
const missing = [];
for (const d of jobsSnap.docs) {
  const x = d.data();
  const s = x.relevanceScore;
  if (typeof s !== "number") { unscored++; continue; }
  if (s < 0) { failed++; continue; }
  scored++;
  // Add if absent, or overwrite a stale mirror (e.g. an old -1 failure that
  // was later re-scored successfully on the job doc).
  if (existing.get(d.id) !== s) {
    missing.push({
      jobId: d.id,
      score: s,
      reason: x.scoreReason || "",
      scoredAt: x.scoredAt instanceof Timestamp ? x.scoredAt : Timestamp.now(),
      title: x.title || "",
      company: x.companyName || "",
    });
  }
}

console.log(`jobs total:            ${jobsSnap.size}`);
console.log(`  scored (>=0):        ${scored}`);
console.log(`  failed (-1):         ${failed}  (retried automatically on next sync)`);
console.log(`  never scored:        ${unscored}`);
console.log(`jobScores entries:     ${scoresSnap.size}`);
console.log(`missing from mirror:   ${missing.length}`);

if (!APPLY) {
  for (const m of missing.slice(0, 15)) console.log(`  would add: ${m.score}  ${m.company} — ${m.title}`);
  if (missing.length > 15) console.log(`  … and ${missing.length - 15} more`);
  console.log("\nDry run only. Re-run with --apply to write.");
  process.exit(0);
}

// Write missing score docs in batches of 400
for (let i = 0; i < missing.length; i += 400) {
  const batch = fdb.batch();
  for (const m of missing.slice(i, i + 400)) {
    batch.set(
      userRef.collection("jobScores").doc(m.jobId),
      { score: m.score, reason: m.reason, scoredAt: m.scoredAt },
      { merge: true }
    );
  }
  await batch.commit();
  console.log(`wrote ${Math.min(i + 400, missing.length)}/${missing.length}`);
}

// Rebuild the myJobScores aggregation with the real production logic.
const { rebuildUserJobScores } = await import("../functions/lib/userJobScores.cjs");
const n = await rebuildUserJobScores(ADMIN_UID, fdb);
console.log(`aggregation rebuilt: ${n} scores in myJobScores`);
process.exit(0);
