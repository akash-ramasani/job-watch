#!/usr/bin/env node
// retry-stuck.mjs — find "needs you" applications (Greenhouse, Ashby, Lever)
// whose posting is still open and that today's fixes can finish, and mark them
// for auto-apply to try again (users/{ADMIN_UID}/applications/*.retryRequested;
// getAutoApplyQueue then queues them after the day's new jobs).
//
// Usage:
//   node scripts/retry-stuck.mjs              # dry run: counts and a sample, writes nothing
//   node scripts/retry-stuck.mjs --write      # mark the open, fixable ones
//   node scripts/retry-stuck.mjs --limit 50   # only the first 50 (newest first)
//
// Skipped: postings that closed, and forms whose notes name something only the
// person can give (a transcript, a work sample, a video, references, an
// assessment). Workday has its own retries and is left out.

import { db as getDb, ADMIN_UID } from "../worker/lib/firestore.mjs";

const db = await getDb();

const args = process.argv.slice(2);
const write = args.includes("--write");
const limitArg = args.indexOf("--limit");
const limit = limitArg !== -1 ? Number(args[limitArg + 1]) || Infinity : Infinity;

// Things no fix can supply: the person's own files, accounts or tests.
const PERSON_ONLY = /transcript|work sample|writing sample|portfolio (link|upload)|video|voice recording|reference(s)? #|three references|assessment|coding challenge|take.?home|security code|verification code|captcha|ssn|social security/i;

const applyUrlOf = (a, id) => {
  const [source, org, posting] = (a.formKey || id).split("|");
  if (source === "greenhouse" && org && posting) return `https://job-boards.greenhouse.io/embed/job_app?for=${org}&token=${posting}`;
  if (source === "ashby" && org && posting) return `https://jobs.ashbyhq.com/${org}/${posting}/application`;
  if (source === "lever" && org && posting) return `https://jobs.lever.co/${org}/${posting}/apply`;
  return a.jobUrl || "";
};

// Is the posting still open? Public board APIs; Ashby lists a whole board, so it is cached per org.
const ashbyBoards = new Map();
async function isOpen(a, id) {
  const [source, org, posting] = (a.formKey || id).split("|");
  try {
    if (source === "greenhouse") return (await fetch(`https://boards-api.greenhouse.io/v1/boards/${org}/jobs/${posting}`)).ok;
    if (source === "lever") return (await fetch(`https://api.lever.co/v0/postings/${org}/${posting}`)).ok;
    if (source === "ashby") {
      if (!ashbyBoards.has(org)) {
        const r = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${org}`);
        ashbyBoards.set(org, r.ok ? new Set(((await r.json()).jobs || []).map((j) => String(j.id))) : null);
      }
      const ids = ashbyBoards.get(org);
      return ids ? ids.has(String(posting)) : null;
    }
  } catch { return null; }
  return null;
}

const notesOf = (a) => [...(a.needsAttention || []).map((n) => (typeof n === "object" ? `${n.label}: ${n.note}` : String(n))), ...(a.gateReasons || [])].join(" | ");

const snap = await db.collection("users").doc(ADMIN_UID).collection("applications").where("status", "==", "needs_attention").get();
const rows = snap.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }))
  .filter((a) => !String(a.formKey || a.id).startsWith("workday|") && !a.retryRequested)
  .sort((x, y) => String(y.updatedAt || "").localeCompare(String(x.updatedAt || "")))
  .slice(0, limit);

const out = { open: [], closed: 0, unknown: 0, personOnly: 0 };
for (const a of rows) {
  if (PERSON_ONLY.test(notesOf(a))) { out.personOnly++; continue; }
  const open = await isOpen(a, a.id);
  if (open === false) { out.closed++; continue; }
  if (open === null) { out.unknown++; continue; }
  out.open.push(a);
}

console.log(`needs-you forms checked: ${rows.length}`);
console.log(`  still open, retryable: ${out.open.length}`);
console.log(`  posting closed:        ${out.closed}`);
console.log(`  only you can finish:   ${out.personOnly}`);
console.log(`  could not check:       ${out.unknown}`);
for (const a of out.open.slice(0, 12)) console.log(`   - ${a.companyName || "?"} | ${a.jobTitle || "?"} | ${notesOf(a).slice(0, 90)}`);

if (!write) { console.log("\nDry run. Add --write to mark these for auto-apply."); process.exit(0); }
const now = new Date().toISOString();
for (let i = 0; i < out.open.length; i += 400) {
  const batch = db.batch();
  for (const a of out.open.slice(i, i + 400)) batch.update(a.ref, { retryRequested: now, retryApplyUrl: applyUrlOf(a, a.id) });
  await batch.commit();
}
console.log(`\nMarked ${out.open.length} for retry (${now}).`);
process.exit(0);
