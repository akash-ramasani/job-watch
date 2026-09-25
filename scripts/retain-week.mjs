#!/usr/bin/env node
// retain-week.mjs — keep this week's jobs that match a profile until a set time.
//
// Jobs normally expire 3 days after posting (TTL on expireAt). This pushes
// expireAt out to --until for every job posted Monday–Friday of the given week
// whose type matches the profile's job types (functions/lib/jobFamilies.cjs),
// and tags it { retainedForWeek, retainUntil }. Nothing else changes: newly
// ingested jobs keep the normal 3-day TTL, and once --until passes these
// records expire like any other.
//
// Idempotent; never shortens an expiry. Re-run after Friday so Friday's jobs
// (and any job the sync re-wrote with a shorter expiry) are covered too.
//
// Usage: node scripts/retain-week.mjs [--week 2026-09-21] [--until 2026-09-28T15:00:00-07:00] [--user email] [--write] [--csv out.csv]
//   --csv writes the week's matching jobs (with the user's AI score where there is one) for applying.

import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { db, ADMIN_UID } from "../worker/lib/firestore.mjs";
import { weekWindow } from "./lib/week.mjs";

const require = createRequire(new URL("../worker/package.json", import.meta.url));
const { Timestamp } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { familiesForProfile, shouldAssess } = require("../functions/lib/jobFamilies.cjs");
const { eligibilityOf, blockedReason, needsSponsorship } = require("../functions/lib/eligibility.cjs");

const arg = (n) => { const i = process.argv.indexOf(n); return i === -1 ? null : process.argv[i + 1]; };
const write = process.argv.includes("--write");

const { week, start, end, until } = weekWindow(arg("--week") || undefined, arg("--until"));

const f = await db();
let uid = ADMIN_UID;
if (arg("--user")) uid = (await getAuth().getUserByEmail(arg("--user"))).uid;
const [profileSnap, prefsSnap] = await Promise.all([
  f.doc(`users/${uid}/resume/profile`).get(),
  f.doc(`users/${uid}/settings/preferences`).get(),
]);
const saved = prefsSnap.data()?.jobTypes;
const targets = Array.isArray(saved) && saved.length ? saved : familiesForProfile(profileSnap.data() || {});
if (!targets.length) { console.error("No job types for this user (no resume and no saved job types)."); process.exit(1); }
const needsVisa = needsSponsorship((await f.doc(`users/${uid}`).get()).data() || {});

const snap = await f.collection(`users/${ADMIN_UID}/jobs`)
  .where("sourceUpdatedTs", ">=", start).where("sourceUpdatedTs", "<", end)
  .select("title", "companyName", "locationName", "jobUrl", "applyUrl", "sourceUpdatedTs", "expireAt", "fullDescription", "retainUntil", "el").get();

const untilTs = Timestamp.fromDate(until);
let matched = 0, extended = 0, notEligible = 0;
const rows = [];
const bw = f.bulkWriter();
for (const d of snap.docs) {
  const x = d.data();
  if (!shouldAssess(x.title, targets, x.fullDescription || "").assess) continue;
  // Not eligible for someone who needs sponsorship: not kept, not listed.
  if (needsVisa && blockedReason(Array.isArray(x.el) ? x.el : eligibilityOf(x.fullDescription || "").flags, true)) { notEligible++; continue; }
  matched++;
  rows.push({ id: d.id, ...x });
  if ((x.expireAt?.toMillis?.() || 0) >= until.getTime() && x.retainUntil) continue;
  extended++;
  if (write) {
    const expireAt = (x.expireAt?.toMillis?.() || 0) > until.getTime() ? x.expireAt : untilTs;
    bw.set(d.ref, { expireAt, retainUntil: untilTs, retainedForWeek: week }, { merge: true });
  }
}
await bw.close();
console.log(`week of ${week} (${start.toISOString()} → ${end.toISOString()}), keep until ${until.toISOString()}`);
console.log(`targets: ${targets.join(", ")}`);
console.log(`${snap.size} jobs posted that week · ${matched} match${needsVisa ? ` (${notEligible} more need citizenship/clearance or won't sponsor — left out)` : ""} · ${extended} ${write ? "extended" : "would be extended"}`);
if (arg("--csv")) {
  // The user's own score where scoring has run (jobScores), else blank.
  const scores = new Map();
  for (let i = 0; i < rows.length; i += 300) {
    const snaps = await f.getAll(...rows.slice(i, i + 300).map((r) => f.doc(`users/${uid}/jobScores/${r.id}`)));
    snaps.forEach((s) => { if (s.exists && !s.get("fit.screened")) scores.set(s.id, s.data()); });
  }
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const sorted = rows.sort((a, b) => (scores.get(b.id)?.score ?? -1) - (scores.get(a.id)?.score ?? -1) || b.sourceUpdatedTs.toMillis() - a.sourceUpdatedTs.toMillis());
  const by = (x) => (!x ? "" : x.fit?.method === "rule" ? "rules" : x.fit?.version === 2 ? "AI" : "AI (old method)");
  const lines = ["score,scored_by,title,company,location,posted_pt,apply_url,why", ...sorted.map((r) => [
    scores.get(r.id)?.score ?? "", by(scores.get(r.id)), r.title, r.companyName, r.locationName,
    r.sourceUpdatedTs.toDate().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }),
    r.applyUrl || r.jobUrl, scores.get(r.id)?.reason || "",
  ].map(q).join(","))];
  await writeFile(arg("--csv"), lines.join("\n") + "\n");
  console.log(`csv: ${arg("--csv")} (${rows.length} jobs, ${[...scores.values()].length} with a score)`);
}
if (!write) console.log("dry run — add --write to apply");
process.exit(0);
