// apply-speed.mjs — read-only: how long after a job came out JobWatch
// submitted the application, per board (average, median, fastest, slowest).
//   node worker/apply-speed.mjs                # submitted since Nov 3 (Pacific)
//   node worker/apply-speed.mjs 2026-11-01     # since another day
//   node worker/apply-speed.mjs 12h            # the last 12 hours
// Two clocks per job: from when JobWatch first saw the job (its sync), and
// from the board's own date. Reads only; writes nothing.
import { db as getDb, ADMIN_UID } from "./lib/firestore.mjs";

const arg = process.argv[2] || "2026-11-03";
const hours = /^(\d+(?:\.\d+)?)h$/i.exec(arg)?.[1];
const since = hours ? Date.now() - hours * 3600e3 : Date.parse(`${arg}T00:00:00-08:00`);
const sinceDay = hours ? `the last ${hours} hours` : `${arg} (Pacific)`;
const ms = (ts) => (ts?.toMillis ? ts.toMillis() : ts?._seconds ? ts._seconds * 1000 : (Date.parse(ts) || 0));

const db = await getDb();
const user = db.collection("users").doc(ADMIN_UID);
const [allSnap, recentSnap, apps] = await Promise.all([
  user.collection("aggregations").doc("allJobs").get(),
  user.collection("aggregations").doc("recentJobs").get(),
  user.collection("applications").where("status", "==", "submitted").get(),
]);
const jobs = new Map();
for (const j of [...(allSnap.data()?.jobs || []), ...(recentSnap.data()?.jobs || [])]) if (j?.id && !jobs.has(j.id)) jobs.set(j.id, j);

const rows = { ashby: [], greenhouse: [], lever: [] };
let noJob = 0;
for (const d of apps.docs) {
  const a = d.data();
  const at = ms(a.submittedAt || a.appliedAt);
  if (!at || at < since) continue;
  const board = String(a.source || d.id).toLowerCase().match(/ashby|greenhouse|lever/)?.[0];
  if (!board) continue;
  const j = a.jobId && jobs.get(String(a.jobId));
  if (!j) { noJob++; continue; }
  const seen = ms(j.firstSeenAt);
  const posted = ms(j.sourceUpdatedTs);
  rows[board].push({ name: `${a.companyName || j.companyName} · ${a.jobTitle || j.title}`, seen: seen ? (at - seen) / 60000 : null, posted: posted ? (at - posted) / 60000 : null });
}

const fmt = (m) => m == null ? "–" : m < 90 ? `${Math.round(m)} min` : m < 48 * 60 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} d`;
function summary(list) {
  const v = list.filter((x) => x != null && x >= 0).sort((p, q) => p - q);
  if (!v.length) return "no data";
  const at = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  const within = (min) => v.filter((x) => x <= min).length;
  return `avg ${fmt(v.reduce((s, x) => s + x, 0) / v.length)} · median ${fmt(at(0.5))} · 90% within ${fmt(at(0.9))} · fastest ${fmt(v[0])} · slowest ${fmt(v[v.length - 1])} · ≤15 min ${within(15)}/${v.length} · ≤1 h ${within(60)}/${v.length}`;
}

console.log(`Submitted since ${sinceDay}: ${Object.values(rows).reduce((n, l) => n + l.length, 0) + noJob} in all\n`);
for (const [board, list] of Object.entries(rows)) {
  if (!list.length) { console.log(`${board}: none`); continue; }
  console.log(`${board} (${list.length} submitted)`);
  console.log(`  from JobWatch first seeing it: ${summary(list.map((r) => r.seen))}`);
  console.log(`  from the board's date:         ${summary(list.map((r) => r.posted))}`);
  const fresh = list.filter((r) => r.seen != null && r.seen <= 24 * 60);
  if (fresh.length) console.log(`  jobs that came out in the last day (${fresh.length}): ${summary(fresh.map((r) => r.seen))}`);
  for (const r of [...list].sort((p, q) => (p.seen ?? 1e12) - (q.seen ?? 1e12)).slice(0, 5)) console.log(`    ${fmt(r.seen).padStart(7)}  ${r.name}`);
}
if (noJob) console.log(`\n${noJob} submitted application(s) whose job is no longer in the job lists (not counted).`);
process.exit(0);
