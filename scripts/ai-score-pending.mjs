#!/usr/bin/env node
// ai-score-pending.mjs — run the AI assessment on every job waiting for it.
//
// Jobs the rule score marked worth a closer look (fit.aiPending) keep their
// rule score until the AI runs — e.g. after the OpenAI account ran out of
// credits. This sends them to the deployed rescoreJobs endpoint in batches,
// best rule score first, until none are left or a batch makes no progress.
//
// --redo re-runs AI assessments made with an older prompt (fit.prompt below
// PROMPT_VERSION in functions/lib/jobFit.cjs) instead of pending ones.
//
// With --redo, --role-fit different and --title <regex> narrow it to those jobs.
//
// Usage: node scripts/ai-score-pending.mjs [--user email] [--redo [--role-fit X] [--title RE]] [--limit N] [--batch 150]

import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { db, ADMIN_UID } from "../worker/lib/firestore.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(new URL("../worker/package.json", import.meta.url));
const { getAuth } = require("firebase-admin/auth");
const arg = (n) => { const i = process.argv.indexOf(n); return i === -1 ? null : process.argv[i + 1]; };

const firestore = await db();
const uid = arg("--user") ? (await getAuth().getUserByEmail(arg("--user"))).uid : ADMIN_UID;
const batchSize = Math.min(400, Number(arg("--batch")) || 150);
const scoresCol = firestore.collection("users").doc(uid).collection("jobScores");

const redo = process.argv.includes("--redo");
const { PROMPT_VERSION } = require("../functions/lib/jobFit.cjs");
// Still to do: waiting for the AI, or (with --redo) assessed with an older prompt.
const todo = (fit) => (redo
  ? fit && fit.version === 2 && fit.method !== "rule" && !fit.screened && (fit.prompt || 1) < PROMPT_VERSION
  : fit?.aiPending === true);

async function pendingIds() {
  const snap = redo
    ? await scoresCol.where("fit.version", "==", 2).select("fit").get()
    : await scoresCol.where("fit.aiPending", "==", true).select("fit.score").get();
  let docs = snap.docs.filter((d) => todo(d.get("fit")));
  if (redo && arg("--role-fit")) docs = docs.filter((d) => d.get("fit.roleFit") === arg("--role-fit"));
  if (redo && arg("--title")) {
    const re = new RegExp(arg("--title"), "i");
    const jobsCol = firestore.collection("users").doc(ADMIN_UID).collection("jobs");
    const titles = new Map();
    for (let i = 0; i < docs.length; i += 300) {
      for (const j of await firestore.getAll(...docs.slice(i, i + 300).map((d) => jobsCol.doc(d.id)), { fieldMask: ["title"] })) titles.set(j.id, j.get("title") || "");
    }
    docs = docs.filter((d) => re.test(titles.get(d.id) || ""));
  }
  return docs.map((d) => ({ id: d.id, score: d.get("fit.score") ?? 0 })).sort((a, b) => b.score - a.score).map((r) => r.id);
}

const env = await readFile(path.join(__dirname, "..", ".env"), "utf8");
const apiKey = (env.match(/^VITE_FIREBASE_API_KEY=(.+)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, "");
async function adminToken() {
  const customToken = await getAuth().createCustomToken(ADMIN_UID);
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  return (await r.json()).idToken;
}

let queue = await pendingIds();
const limit = Number(arg("--limit")) || queue.length;
queue = queue.slice(0, limit);
console.log(`${queue.length} jobs ${redo ? "to re-assess with the current prompt" : "waiting for the AI"} (batches of ${batchSize})`);

let scored = 0;
let calls = 0;
while (queue.length) {
  const batch = queue.splice(0, batchSize);
  const t0 = Date.now();
  // A dropped connection doesn't lose work: whatever the endpoint finished is
  // saved, and the check below requeues the rest.
  let r = null;
  for (let attempt = 1; attempt <= 3 && !r; attempt++) {
    try {
      r = await fetch("https://us-central1-greenhouse-jobs-scrapper.cloudfunctions.net/rescoreJobs", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${await adminToken()}` },
        body: JSON.stringify({ dryRun: false, userId: uid, jobIds: batch }),
      });
    } catch (e) {
      console.log(`  batch request failed (${e.cause?.code || e.message}), attempt ${attempt}/3`);
      await new Promise((res) => setTimeout(res, 20000));
    }
  }
  const o = r ? await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` })) : { ok: true };
  calls++;
  // Jobs the endpoint's time budget cut off are still pending: put them back once.
  const after = await firestore.getAll(...batch.map((id) => scoresCol.doc(id)), { fieldMask: ["fit"] });
  const left = after.filter((d) => d.exists && todo(d.get("fit"))).map((d) => d.id);
  const done = batch.length - left.length;
  scored += done;
  console.log(`batch ${calls}: HTTP ${r?.status ?? "none"} · ${done}/${batch.length} done · ${Math.round((Date.now() - t0) / 1000)}s · ${queue.length + (done ? left.length : 0)} left`);
  if (!o.ok || done === 0) {
    console.log("stopping: batch made no progress", o.error || "");
    break;
  }
  queue.unshift(...left);
}
console.log(`finished: ${scored} jobs assessed by the AI in ${calls} calls`);
process.exit(0);
