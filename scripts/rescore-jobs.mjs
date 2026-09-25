#!/usr/bin/env node
// rescore-jobs.mjs — call the admin rescoreJobs function and print old vs new
// scores. Dry run by default (nothing written).
//
// Usage:
//   node scripts/rescore-jobs.mjs --sample            # dry run on a mixed sample of recent jobs
//   node scripts/rescore-jobs.mjs --ids a,b,c         # dry run on specific job doc ids
//   node scripts/rescore-jobs.mjs --backlog 200 --write   # rescore the 200 newest stale jobs for real
//   node scripts/rescore-jobs.mjs --stale --write     # rescore every stale job (old method or old profile), in batches
//   add --verbose to print each job's requirements

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { db, ADMIN_UID } from "../worker/lib/firestore.mjs";

const require = createRequire(new URL("../worker/package.json", import.meta.url));
const { getAuth } = require("firebase-admin/auth");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true); };
const write = args.includes("--write");
const verbose = args.includes("--verbose");

const firestore = await db();
let body = { dryRun: !write };
let staleQueue = null;
if (flag("--stale")) {
  // Same rule as the sync backlog: jobs whose score predates this method or the
  // current profile, skipping ones the old scorer already put below 30.
  const profile = (await firestore.collection("users").doc(ADMIN_UID).collection("resume").doc("profile").get()).data();
  const { FIT_VERSION, profileStampOf } = require("../functions/lib/jobFit.cjs");
  const stamp = profileStampOf(profile);
  const snap = await firestore.collection("users").doc(ADMIN_UID).collection("jobs").orderBy("fetchedAt", "desc")
    .select("relevanceScore", "scoreVersion", "scoreProfileStamp").get();
  staleQueue = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((j) => j.scoreVersion !== FIT_VERSION || j.scoreProfileStamp !== stamp)
    .filter((j) => typeof j.relevanceScore !== "number" || j.relevanceScore < 0 || j.relevanceScore >= 30 || j.scoreVersion === FIT_VERSION)
    .map((j) => j.id);
  console.log(`${staleQueue.length} stale jobs`);
  if (!staleQueue.length) process.exit(0);
  body.jobIds = staleQueue.slice(0, 250);
} else if (flag("--ids")) body.jobIds = String(flag("--ids")).split(",");
else if (flag("--backlog")) body.limit = Number(flag("--backlog")) || 50;
else if (flag("--sample")) {
  // A spread: old top scores, the middle, titles that should be capped, and a few low ones.
  const snap = await firestore.collection("users").doc(ADMIN_UID).collection("jobs").orderBy("fetchedAt", "desc").limit(1500)
    .select("relevanceScore", "title", "companyName").get();
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const pick = (pred, n) => rows.filter(pred).slice(0, n).map((r) => r.id);
  const t = (re) => (r) => re.test(r.title || "");
  body.jobIds = [...new Set([
    ...pick((r) => r.relevanceScore >= 85 && /engineer|developer/i.test(r.title), 10),
    ...pick((r) => r.relevanceScore >= 30 && r.relevanceScore < 85, 5),
    ...pick(t(/intern|new grad|early career/i), 2),
    ...pick(t(/principal|director|head of|staff/i), 2),
    ...pick(t(/sales|account executive|marketing|recruit/i), 2),
    ...pick(t(/data engineer|devops|site reliability|solutions architect/i), 3),
    ...pick((r) => r.relevanceScore < 30 && /engineer/i.test(r.title), 2),
  ])];
} else {
  console.error("Pass --sample, --ids a,b or --backlog N (add --write to save).");
  process.exit(1);
}

const env = await readFile(path.join(__dirname, "..", ".env"), "utf8");
const apiKey = (env.match(/^VITE_FIREBASE_API_KEY=(.+)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, "");
const signInAsAdmin = async () => {
  const customToken = await getAuth().createCustomToken(ADMIN_UID);
  const signIn = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  return (await signIn.json()).idToken; // valid for an hour
};
const idToken = await signInAsAdmin();

if (staleQueue && write) {
  // Loop in batches until nothing is left or a batch makes no progress.
  let totals = { scored: 0, calls: 0 };
  const retried = new Set();
  while (staleQueue.length) {
    const batch = staleQueue.splice(0, 250);
    const t0 = Date.now();
    const token = await signInAsAdmin();
    const r = await fetch("https://us-central1-greenhouse-jobs-scrapper.cloudfunctions.net/rescoreJobs", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ dryRun: false, jobIds: batch }),
    });
    const o = await r.json().catch(() => ({ ok: false }));
    totals.calls++;
    totals.scored += o.scored || 0;
    // Jobs the time budget cut off are still stale; retry each of those once.
    const after = await firestore.getAll(...batch.map((id) => firestore.collection("users").doc(ADMIN_UID).collection("jobs").doc(id)), { fieldMask: ["scoreVersion"] });
    const unfinished = after.filter((d) => d.exists && d.get("scoreVersion") !== 2).map((d) => d.id).filter((id) => !retried.has(id));
    unfinished.forEach((id) => retried.add(id));
    staleQueue.unshift(...unfinished);
    console.log(`batch ${totals.calls}: HTTP ${r.status} · ${o.scored ?? "?"} scored · ${unfinished.length} requeued · ${Math.round((Date.now() - t0) / 1000)}s · ${staleQueue.length} left`);
    if (!o.ok || !o.scored) { console.log("stopping: batch made no progress", o.error || ""); break; }
  }
  console.log(`done: ${totals.scored} scored in ${totals.calls} calls`);
  process.exit(0);
}
console.log(`${write ? "WRITE" : "dry run"} · ${body.jobIds ? `${body.jobIds.length} jobs` : `backlog up to ${body.limit}`}`);
const started = Date.now();
const resp = await fetch("https://us-central1-greenhouse-jobs-scrapper.cloudfunctions.net/rescoreJobs", {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` }, body: JSON.stringify(body),
});
const text = await resp.text();
let out;
try { out = JSON.parse(text); } catch { console.log(`HTTP ${resp.status}`, text.slice(0, 400)); process.exit(1); }
console.log(`HTTP ${resp.status} in ${Math.round((Date.now() - started) / 1000)}s\n`);
if (!out.ok) { console.log(out); process.exit(1); }

const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
console.log(`${pad("old", 4)} ${pad("new", 4)} ${pad("cov", 4)} ${pad("fit", 18)} ${pad("job", 58)} reason`);
for (const r of out.results.sort((a, b) => (b.new ?? -1) - (a.new ?? -1))) {
  console.log(`${pad(r.old, 4)} ${pad(r.new, 4)} ${pad(r.coverage ?? "", 4)} ${pad([r.roleFit, r.seniorityFit].filter(Boolean).join("/"), 18)} ${pad(`${r.title} @ ${r.company}`, 58)} ${r.reason}`);
  if (verbose && r.requirements) r.requirements.forEach((q) => console.log(`        ${q}`));
}
process.exit(0);
