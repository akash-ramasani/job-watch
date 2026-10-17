#!/usr/bin/env node
// rescreen-scores.mjs — re-run only the screens (job type, clearance/citizenship,
// too senior) over a user's existing scores, through the admin rescoreJobs
// function in screenOnly mode: jobs that are now ruled out get score 0 and
// drop off the Jobs page; every other score is left exactly as it was (no
// model calls, no rule scores replacing AI scores).
//
// Usage:
//   node scripts/rescreen-scores.mjs            # dry run: counts what would be screened
//   node scripts/rescreen-scores.mjs --write
//   node scripts/rescreen-scores.mjs --write --user someone@x.com

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { db, ADMIN_UID } from "../worker/lib/firestore.mjs";

const require = createRequire(new URL("../worker/package.json", import.meta.url));
const { getAuth } = require("firebase-admin/auth");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const write = args.includes("--write");
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
const BATCH = 250;

const firestore = await db();
const userId = flag("--user") ? (String(flag("--user")).includes("@") ? (await getAuth().getUserByEmail(flag("--user"))).uid : flag("--user")) : ADMIN_UID;

// Every job this user currently sees on the Jobs page (any score, including 0)
// plus listed jobs with no rollup entry yet: those are the ones a screen can remove.
const aggs = firestore.collection("users").doc(ADMIN_UID).collection("aggregations");
const [recent, all, mine] = await Promise.all([aggs.doc("recentJobs").get(), aggs.doc("allJobs").get(), firestore.collection("users").doc(userId).collection("aggregations").doc("myJobScores").get()]);
const listed = new Map();
for (const j of [...(recent.data()?.jobs || []), ...(all.data()?.jobs || [])]) if (j?.id && !listed.has(j.id)) listed.set(j.id, j);
const scores = mine.data()?.scores || {};
const ids = [...listed.keys()].filter((id) => !scores[id]?.o);
console.log(`${ids.length} scored jobs for ${userId}; ${write ? "WRITE" : "dry run"}`);

const env = await readFile(path.join(__dirname, "..", ".env"), "utf8");
const apiKey = (env.match(/^VITE_FIREBASE_API_KEY=(.+)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, "");
const customToken = await getAuth().createCustomToken(ADMIN_UID);
const signIn = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: customToken, returnSecureToken: true }) });
const { idToken } = await signIn.json();

const totals = { calls: 0, screened: 0, byReason: {} };
for (let i = 0; i < ids.length; i += BATCH) {
  const batch = ids.slice(i, i + BATCH);
  const t0 = Date.now();
  const r = await fetch("https://us-central1-greenhouse-jobs-scrapper.cloudfunctions.net/rescoreJobs", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ dryRun: !write, screenOnly: true, jobIds: batch, userId }),
  });
  const o = await r.json().catch(() => ({}));
  totals.calls++;
  const rows = o.results || o.jobs || [];
  const screened = rows.filter((x) => x.new === 0 || x.screened);
  totals.screened += screened.length;
  for (const x of screened) { const k = String(x.reason || "").replace(/\d+/g, "N").slice(0, 60); totals.byReason[k] = (totals.byReason[k] || 0) + 1; }
  console.log(`batch ${totals.calls}/${Math.ceil(ids.length / BATCH)}: HTTP ${r.status} · ${rows.length} checked · ${screened.length} screened · ${Math.round((Date.now() - t0) / 1000)}s${o.error ? " · " + o.error : ""}`);
  if (!r.ok) break;
}
console.log(`\n${totals.screened} of ${ids.length} would be ${write ? "" : "(dry run) "}screened out`);
for (const [k, n] of Object.entries(totals.byReason).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`${String(n).padStart(6)}  ${k}`);
process.exit(0);
