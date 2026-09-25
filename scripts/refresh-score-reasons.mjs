#!/usr/bin/env node
// refresh-score-reasons.mjs — rebuild the one-line score reason from each
// stored assessment (users/{uid}/jobScores/{jobId}.fit) after reasonFor()
// changes. No model calls: the requirements are already stored.
//
// Usage: node scripts/refresh-score-reasons.mjs [--write]   (dry run by default)

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const { FIT_VERSION, reasonFor } = require("../functions/lib/jobFit.cjs");
const { rebuildUserJobScores } = require("../functions/lib/userJobScores.cjs");
const { rebuildRecentJobs, rebuildAllJobs } = require("../functions/lib/recentJobs.cjs");

const ADMIN_UID = "7Tojjo8l5PZIYctPmdwncf7PC133";
const write = process.argv.includes("--write");

const sa = JSON.parse(await readFile(new URL("../worker/service-account.json", import.meta.url), "utf8"));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const users = await db.collection("users").listDocuments();
for (const userRef of users) {
  const snap = await userRef.collection("jobScores").where("fit.version", "==", FIT_VERSION).get();
  const changes = snap.docs
    .map((d) => ({ id: d.id, old: d.get("reason") || "", next: reasonFor(d.get("fit")) }))
    .filter((c) => c.next && c.next !== c.old);
  if (!snap.size) continue;
  console.log(`${userRef.id}: ${snap.size} assessments, ${changes.length} reasons change`);
  changes.slice(0, 3).forEach((c) => console.log(`  ${c.old}\n  → ${c.next}`));
  if (!write || !changes.length) continue;

  const writer = db.bulkWriter();
  for (const c of changes) {
    writer.set(userRef.collection("jobScores").doc(c.id), { reason: c.next, fit: { reason: c.next } }, { merge: true });
    if (userRef.id === ADMIN_UID) writer.set(userRef.collection("jobs").doc(c.id), { scoreReason: c.next }, { merge: true });
  }
  await writer.close();
  if (userRef.id === ADMIN_UID) {
    await rebuildRecentJobs(ADMIN_UID);
    await rebuildAllJobs(ADMIN_UID);
  }
  await rebuildUserJobScores(userRef.id);
  console.log(`  written, rollups rebuilt`);
}
if (!write) console.log("\ndry run — add --write to save");
process.exit(0);
