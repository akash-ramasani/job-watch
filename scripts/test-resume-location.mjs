#!/usr/bin/env node
// test-resume-location.mjs — run chooseResumeLocation over recent jobs in the
// DB and report what the resume header would say, so the metro table and the
// parser can be tuned against real postings.
//
// Usage: node scripts/test-resume-location.mjs [limit=1500] [--defaults] [--tier4]
//   --defaults  list jobs that fell back to San Francisco (unparsed / remote)
//   --tier4     list unlisted "City, ST" results (candidates for the metro table)

import { createRequire } from "node:module";
import { db, ADMIN_UID } from "../worker/lib/firestore.mjs";

const require = createRequire(import.meta.url);
const { chooseResumeLocation } = require("../functions/lib/resumeLocation.cjs");

const args = process.argv.slice(2);
const limit = Number(args.find((a) => /^\d+$/.test(a)) || 1500);
const showDefaults = args.includes("--defaults");
const showTier4 = args.includes("--tier4");

const f = await db();
const snap = await f.collection("users").doc(ADMIN_UID).collection("jobs").orderBy("fetchedAt", "desc").limit(limit).get();

const byDisplay = new Map();
const byReason = new Map();
const defaults = [];
const tier4 = new Map();
for (const d of snap.docs) {
  const j = d.data();
  const r = chooseResumeLocation(j);
  byDisplay.set(r.displayWithZip || r.display, (byDisplay.get(r.displayWithZip || r.display) || 0) + 1);
  byReason.set(r.reason, (byReason.get(r.reason) || 0) + 1);
  if (r.reason.endsWith("→ default") && !r.reason.startsWith("remote")) defaults.push(j.locationName);
  if (r.tier === 4) tier4.set(r.display, (tier4.get(r.display) || 0) + 1);
}

console.log(`jobs: ${snap.size}\n\n--- by reason ---`);
for (const [k, v] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`${String(v).padStart(5)}  ${k}`);
console.log(`\n--- top resume locations ---`);
for (const [k, v] of [...byDisplay].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${String(v).padStart(5)}  ${k}`);
if (showDefaults) {
  console.log(`\n--- fell back to default without being remote (${defaults.length}) ---`);
  const uniq = [...new Set(defaults)];
  uniq.slice(0, 60).forEach((l) => console.log("  " + String(l).slice(0, 110)));
}
if (showTier4) {
  console.log(`\n--- unlisted City, ST (${tier4.size} distinct) ---`);
  for (const [k, v] of [...tier4].sort((a, b) => b[1] - a[1]).slice(0, 60)) console.log(`${String(v).padStart(5)}  ${k}`);
}
process.exit(0);
