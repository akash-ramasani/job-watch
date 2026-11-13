#!/usr/bin/env node
// clear-needs-attention.mjs — empty the Applications page's "Needs attention"
// tab (needs_attention, error, and in_progress older than two hours): every
// record is sorted into exactly one outcome.
//
//   submitted elsewhere  the same job (or company + title) was submitted in another record  -> dismissed
//   not a match          outside today's match (score, else job types): Workday test runs,
//                        and jobs older versions queued wider                               -> dismissed
//   posting closed       the board says the posting is gone                                 -> dismissed
//   only you can answer  references, a transcript, an ID number, an assessment, a video    -> dismissed (listed, reopen on the page)
//   retry                still open (or the board could not say): marked retryRequested;
//                        auto-apply queues it after the day's new jobs (lib/apply/autoApply.cjs)
//                        and it shows under "Retrying" until it starts again.
//
// Dismissed records are never queued again (autoApply.cjs) and can be reopened
// on the Applications page; dismissReason says why.
//
// Usage:
//   node scripts/clear-needs-attention.mjs           # dry run: counts and every record's outcome, writes nothing
//   node scripts/clear-needs-attention.mjs --write   # apply
//   add --recheck to re-check the records already waiting on a retry
import { createRequire } from "node:module";
import { db as getDb, ADMIN_UID } from "../worker/lib/firestore.mjs";
import { posting, applyUrlOf } from "./lib/postings.mjs";

const require = createRequire(new URL("../functions/index.js", import.meta.url));
const { createAssistantContext } = require("./lib/assistantTools.cjs");
const { classifyTitle } = require("./lib/jobFamilies.cjs");
const ledger = require("./lib/apply/ledger.cjs");
const { eligibilityOf, formEligibility, blockedReason, needsSponsorship } = require("./lib/eligibility.cjs");
// Boards the auto-apply queue takes (lib/apply/autoApply.cjs); others are applied to by hand.
const QUEUE_BOARDS = new Set(["greenhouse", "ashby", "lever", "workday"]);

const write = process.argv.includes("--write");
// --recheck: also re-check the records already waiting on a retry (eligibility,
// match, closed); one still fine keeps its place in the queue.
const recheck = process.argv.includes("--recheck");
const db = await getDb();
const userRef = db.collection("users").doc(ADMIN_UID);
const now = Date.now();
const STALE_MS = 2 * 60 * 60 * 1000;

// Only the person can give these (no fix supplies them).
const PERSON_ONLY = [
  [/references?\b.{0,40}(name|email|phone|contact)|three (professional )?references|reference #\d/i, "references"],
  [/transcript/i, "a transcript"],
  [/type, number, issue date|driver'?s license number|id number|passport number|social security|\bssn\b/i, "an ID number"],
  [/work sample|writing sample|portfolio (link|upload)/i, "a work sample"],
  [/video|voice recording/i, "a video"],
  [/assessment|coding challenge|take.?home|captcha/i, "an assessment"],
];

const ms = (v) => (v?.toDate ? v.toDate().getTime() : Date.parse(v || "") || 0);
const notesOf = (a) => [...(a.needsAttention || []).map((n) => (typeof n === "object" ? `${n.label}: ${n.note}` : String(n))), a.lastError || "", ...(a.gateReasons || [])].join(" | ");
const keyOf = (a) => `${String(a.companyName || "").toLowerCase().trim()}|${String(a.jobTitle || "").toLowerCase().replace(/\s+/g, " ").trim()}`;

// Is this a job auto-apply would pick today (its score, else the job types)?
// Older versions queued wider (Flight Test Engineer, AI Biologist).
const ctx = createAssistantContext(db, ADMIN_UID, { adminUid: ADMIN_UID });
const [scores, jobTypes, prefs, userDoc] = await Promise.all([ctx.scores(), ctx.jobTypes(), ctx.prefs(), ctx.userDoc()]);
// Needs sponsorship: a job requiring US citizenship, a clearance, or saying it
// won't sponsor is out (General Matter "Currently a US Citizen with capability
// to obtain and maintain a US Q clearance" had been queued again, 2026-11-13).
const sponsorship = needsSponsorship(userDoc);
const minScore = Number.isFinite(Number(prefs?.autoApplyMinScore)) ? Number(prefs.autoApplyMinScore) : 40;
async function matchesToday(a) {
  const req = String(a.formKey || "").split("|")[2] || "";
  let job = a.jobId ? await userRef.collection("jobs").doc(String(a.jobId)).get() : null;
  if (job && !job.exists) job = null;
  if (!job && req) {
    const s = await userRef.collection("jobs").where("externalId", "==", req).limit(3).get();
    job = s.docs[0] || null;
  }
  const sc = job ? scores[job.id] : null;
  if (typeof sc?.score === "number") return sc.score >= minScore && !sc.o;
  const fam = classifyTitle(a.jobTitle || job?.data()?.title || "");
  return !!fam.length && Array.isArray(jobTypes) && fam.every((f) => jobTypes.includes(f));
}

const all = (await userRef.collection("applications").get()).docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));
const submitted = all.filter((a) => a.status === "submitted");
const subForms = new Set(submitted.map((a) => a.formKey).filter(Boolean));
const subJobs = new Set(submitted.map((a) => a.jobId).filter(Boolean));
const subKeys = new Set(submitted.map(keyOf));
// The queue's own same-role test ("AI deployment engineer (East)" and "(West)").
const subRoles = new Set(submitted.map((a) => a.roleKey || ledger.roleKeyOf(a.companyName, a.jobTitle)).filter(Boolean));
// Already marked and not started since: waiting in the queue ("Retrying"), not on the person.
const awaitingRetry = (a) => a.retryRequested && Date.parse(a.retryRequested) > ms(a.lastStartedAt);
const rows = all.filter((a) => recheck || !awaitingRetry(a)).filter((a) => ["needs_attention", "error"].includes(a.status)
  || (a.status === "in_progress" && now - ms(a.lastStartedAt || a.startedAt || a.updatedAt) > STALE_MS));

const out = { dup: [], notMatch: [], notEligible: [], closed: [], person: [], retry: [] };
for (const a of rows) {
  const board = String(a.formKey || a.id).split("|")[0];
  if ((a.formKey && subForms.has(a.formKey)) || (a.jobId && subJobs.has(a.jobId)) || subKeys.has(keyOf(a)) || subRoles.has(a.roleKey || ledger.roleKeyOf(a.companyName, a.jobTitle))) { out.dup.push(a); continue; }
  if (!QUEUE_BOARDS.has(board)) { out.closed.push({ ...a, why: `auto-apply does not take ${board} forms: apply by hand` }); continue; }
  if (!(await matchesToday(a))) { out.notMatch.push(a); continue; }
  const who = PERSON_ONLY.find(([re]) => re.test(notesOf(a)));
  const { open, desc, formCitizen } = await posting(a, a.id);
  if (open === false) { out.closed.push(a); continue; }
  const blocked = blockedReason([...eligibilityOf(desc || "").flags, ...(formCitizen ? ["citizen"] : [])], sponsorship);
  if (blocked) { out.notEligible.push({ ...a, blocked }); continue; }
  if (who) { out.person.push({ ...a, needs: who[1] }); continue; }
  const url = applyUrlOf(a, a.id);
  if (!url) { out.closed.push({ ...a, why: "no apply link" }); continue; }
  out.retry.push({ ...a, url, open });
}

const line = (a) => `${a.status.padEnd(15)} ${String(a.companyName || "?").slice(0, 28).padEnd(28)} | ${String(a.jobTitle || "?").slice(0, 60)}`;
console.log(`Needs attention records: ${rows.length}`);
console.log(`  submitted elsewhere -> dismiss: ${out.dup.length}`);
console.log(`  not a match today -> dismiss: ${out.notMatch.length}`);
console.log(`  not eligible (citizenship, clearance, no sponsorship) -> dismiss: ${out.notEligible.length}`);
console.log(`  posting closed -> dismiss: ${out.closed.length}`);
console.log(`  only you can answer -> dismiss: ${out.person.length}`);
console.log(`  open -> retry: ${out.retry.length} (board could not say: ${out.retry.filter((a) => a.open === null).length})`);
const byBoard = {}; for (const a of out.retry) { const b = String(a.formKey || a.id).split("|")[0]; byBoard[b] = (byBoard[b] || 0) + 1; }
console.log(`    by board: ${JSON.stringify(byBoard)}`);
console.log("\nOnly you can answer:"); for (const a of out.person) console.log(`  ${line(a)}  [${a.needs}]`);
console.log("\nNot eligible:"); for (const a of out.notEligible) console.log(`  ${line(a)}  [${a.blocked}]`);
console.log("\nNot a match:"); for (const a of out.notMatch) console.log(`  ${line(a)}`);
console.log("\nRetry (first 40):"); for (const a of out.retry) console.log(`  ${line(a)}`);

if (!write) { console.log("\nDry run. Add --write to apply."); process.exit(0); }
const iso = new Date().toISOString();
const ops = [
  ...out.dup.map((a) => [a.ref, { status: "dismissed", dismissedAt: iso, dismissReason: "submitted in another record" }]),
  ...out.notMatch.map((a) => [a.ref, { status: "dismissed", dismissedAt: iso, dismissReason: "not a match for your job types or score" }]),
  ...out.notEligible.map((a) => [a.ref, { status: "dismissed", dismissedAt: iso, dismissReason: `not eligible: ${a.blocked}` }]),
  ...out.closed.map((a) => [a.ref, { status: "dismissed", dismissedAt: iso, dismissReason: a.why || "posting closed" }]),
  ...out.person.map((a) => [a.ref, { status: "dismissed", dismissedAt: iso, dismissReason: `only you can answer: ${a.needs}` }]),
  ...out.retry.filter((a) => !awaitingRetry(a)).map((a) => [a.ref, { status: "needs_attention", retryRequested: iso, retryApplyUrl: a.url, updatedAt: iso }]),
];
for (let i = 0; i < ops.length; i += 400) {
  const batch = db.batch();
  for (const [ref, patch] of ops.slice(i, i + 400)) batch.update(ref, patch);
  await batch.commit();
}
console.log(`\nWrote ${ops.length} records (${iso}).`);
process.exit(0);
