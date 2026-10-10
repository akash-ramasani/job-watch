// backfill-application-keys.mjs — tag pre-ledger application records with the
// fields the ledger relies on (formKey, source, org, postingId, status,
// timestamps, attempts, filledCount) so the duplicate guard and the
// Applications page see them. Idempotent. Dry run by default; --apply writes.
//
//   node scripts/backfill-application-keys.mjs           # report only
//   node scripts/backfill-application-keys.mjs --apply   # write
import { createRequire } from "node:module";
import { db as getDb } from "../worker/lib/firestore.mjs";
const require = createRequire(import.meta.url);
const { formKeyFromUrl, roleKeyOf } = require("../functions/lib/apply/ledger.cjs");

const APPLY = process.argv.includes("--apply");
const db = await getDb();
const users = await db.collection("users").get();
let seen = 0, tagged = 0, already = 0, recovered = 0, legacyKeyed = 0;
const n = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// Recover the posting URL for records saved without one: the job docs carry
// company + title + apply URL.
async function recoverUrl(uid, a) {
  if (!a.companyName) return null;
  const q = await db.collection("users").doc(uid).collection("jobs").where("companyName", "==", a.companyName).limit(60).get();
  const hits = q.docs.map((d) => d.data()).filter((j) => n(j.title) === n(a.jobTitle));
  const urls = [...new Set(hits.map((j) => j.absolute_url || j.jobUrl || j.applyUrl || "").filter((u) => formKeyFromUrl(u)))];
  return urls.length === 1 ? urls[0] : null;
}
for (const u of users.docs) {
  const apps = await db.collection("users").doc(u.id).collection("applications").get();
  let batch = db.batch(), n = 0;
  for (const d of apps.docs) {
    seen++;
    const a = d.data();
    if (a.formKey && a.updatedAt && a.attempts) { already++; continue; } // roleKey may be empty when a record lacks company or title
    let jobUrl = a.jobUrl || "";
    let k = formKeyFromUrl(jobUrl);
    if (!k) {
      const m = d.id.match(/^ashbyhq\|([^|]+)\|([0-9a-f-]{36})/i);
      if (m) k = { source: "ashby", org: m[1], postingId: m[2].toLowerCase(), formKey: `ashby|${m[1].toLowerCase()}|${m[2].toLowerCase()}` };
    }
    if (!k) {
      const url = await recoverUrl(u.id, a);
      if (url) { jobUrl = url; k = formKeyFromUrl(url); recovered++; }
    }
    if (!k) { k = { source: a.source || "ashby", org: "", postingId: "", formKey: `legacy|${d.id}` }; legacyKeyed++; }
    const at = a.appliedAt || a.submittedAt || null;
    const patch = {
      formKey: k.formKey, source: k.source === "ashbyhq" ? "ashby" : k.source, org: k.org, postingId: k.postingId,
      roleKey: roleKeyOf(a.companyName, a.jobTitle),
      ...(jobUrl && !a.jobUrl ? { jobUrl } : {}),
      status: a.status || "submitted",
      submittedAt: a.submittedAt || ((a.status || "submitted") === "submitted" ? at : null),
      startedAt: a.startedAt || at, filledAt: a.filledAt || at, updatedAt: a.updatedAt || at,
      attempts: a.attempts || 1,
      filledCount: Number.isFinite(a.filledCount) ? a.filledCount : Object.keys(a.answersLog || {}).length,
      flow: a.flow || "legacy",
      needsAttention: Array.isArray(a.needsAttention) ? a.needsAttention : [],
    };
    tagged++;
    if (APPLY) { batch.set(d.ref, patch, { merge: true }); if (++n === 400) { await batch.commit(); batch = db.batch(); n = 0; } }
  }
  if (APPLY && n) await batch.commit();
}
console.log({ mode: APPLY ? "APPLIED" : "dry-run", seen, tagged, already, recovered, legacyKeyed });
process.exit(0);
