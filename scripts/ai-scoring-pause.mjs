#!/usr/bin/env node
// ai-scoring-pause.mjs — pause or resume the automatic AI job assessment.
//
// Writes users/{admin}/settings/aiControl { pauseJobScoring }. While paused,
// the sync and the backlog store the free rule score for new jobs (flagged
// aiPending) and never call OpenAI for them; the manual rescoreJobs endpoint
// answers 409. Cover letters, tailored resumes, the assistant and auto-apply
// keep working. Deployed functions pick the change up within a minute.
//
// Usage: node scripts/ai-scoring-pause.mjs on|off|status [--note "why"]

import { db, ADMIN_UID } from "../worker/lib/firestore.mjs";

const cmd = process.argv[2];
const arg = (n) => { const i = process.argv.indexOf(n); return i === -1 ? null : process.argv[i + 1]; };
if (!["on", "off", "status"].includes(cmd)) { console.error("Usage: node scripts/ai-scoring-pause.mjs on|off|status [--note text]"); process.exit(1); }

const ref = (await db()).doc(`users/${ADMIN_UID}/settings/aiControl`);
const before = (await ref.get()).data() || {};
if (cmd === "status") {
  console.log(before.pauseJobScoring === true ? `AI job scoring is PAUSED since ${before.pausedAt || "?"}${before.note ? ` (${before.note})` : ""}` : `AI job scoring is running${before.resumedAt ? ` (resumed ${before.resumedAt})` : ""}`);
  process.exit(0);
}
const now = new Date().toISOString();
await ref.set(cmd === "on"
  ? { pauseJobScoring: true, pausedAt: now, note: arg("--note") || "paused by the user", resumedAt: null }
  : { pauseJobScoring: false, resumedAt: now }, { merge: true });
console.log(cmd === "on" ? `AI job scoring PAUSED at ${now}. New jobs get rule scores only until you run: node scripts/ai-scoring-pause.mjs off` : `AI job scoring RESUMED at ${now}. Jobs flagged aiPending are assessed by the next syncs.`);
process.exit(0);
