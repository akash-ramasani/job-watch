#!/usr/bin/env node
// fill-user-scores.mjs — give every listed job that has no current score for a user a rule score
// through the admin rescoreJobs function in ruleOnly mode (the AI stays paused; no model calls).
// Usage: node scripts/fill-user-scores.mjs someone@x.com [--write]
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path"; import { fileURLToPath } from "node:url";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { db, ADMIN_UID } = await import(ROOT + "/worker/lib/firestore.mjs");
const f = await db();
const require = createRequire(ROOT + "/worker/package.json");
const { getAuth } = require("firebase-admin/auth");
const write = process.argv.includes("--write");
const uid = (await getAuth().getUserByEmail(process.argv[2])).uid;
const aggs = f.collection("users").doc(ADMIN_UID).collection("aggregations");
const [recent, all, mine] = await Promise.all([aggs.doc("recentJobs").get(), aggs.doc("allJobs").get(), f.collection("users").doc(uid).collection("aggregations").doc("myJobScores").get()]);
const listed = new Map(); for (const j of [...(recent.data()?.jobs || []), ...(all.data()?.jobs || [])]) if (j?.id && !listed.has(j.id)) listed.set(j.id, j);
const scores = mine.data()?.scores || {};
const ids = [...listed.keys()].filter((id) => !scores[id] || (scores[id].k && !/^(2|rule-7):/.test(scores[id].k)));
console.log(`${uid}: ${listed.size} listed, ${ids.length} without a current score; ${write ? "WRITE" : "dry run"}`);
const env = await readFile(ROOT + "/.env", "utf8");
const apiKey = (env.match(/^VITE_FIREBASE_API_KEY=(.+)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, "");
const customToken = await getAuth().createCustomToken(ADMIN_UID);
const { idToken } = await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: customToken, returnSecureToken: true }) })).json();
let scored = 0;
for (let i = 0; i < ids.length; i += 250) {
  const batch = ids.slice(i, i + 250); const t0 = Date.now();
  const r = await fetch("https://us-central1-greenhouse-jobs-scrapper.cloudfunctions.net/rescoreJobs", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` }, body: JSON.stringify({ dryRun: !write, ruleOnly: true, jobIds: batch, userId: uid }) });
  const o = await r.json().catch(() => ({}));
  scored += o.scored || 0;
  console.log(`batch ${Math.floor(i / 250) + 1}/${Math.ceil(ids.length / 250)}: HTTP ${r.status} · scored ${o.scored ?? "?"} · ${Math.round((Date.now() - t0) / 1000)}s${o.error ? " · " + o.error : ""}`);
  if (!r.ok) break;
}
const after = (await f.collection("users").doc(uid).collection("aggregations").doc("myJobScores").get()).data()?.scores || {};
const vis = [...listed.keys()].filter((id) => after[id] && !after[id].o);
console.log(`done: ${scored} scored; now ${vis.length} visible listed jobs for this user`);
process.exit(0);
