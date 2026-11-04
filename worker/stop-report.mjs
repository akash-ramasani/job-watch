// stop-report.mjs — read-only: why applications stopped short of Submit,
// per board, with the fields and messages the forms showed.
//   node worker/stop-report.mjs        # the last 24 hours
//   node worker/stop-report.mjs 12h
// Reads only; writes nothing.
import { db as getDb, ADMIN_UID } from "./lib/firestore.mjs";

const hours = Number(/^(\d+(?:\.\d+)?)h$/i.exec(process.argv[2] || "")?.[1] || 24);
const since = new Date(Date.now() - hours * 3600e3).toISOString();
const db = await getDb();
const snap = await db.collection("users").doc(ADMIN_UID).collection("applications").where("updatedAt", ">=", since).get();

const stopped = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((a) => a.status !== "submitted");
const submitted = snap.size - stopped.length;
const boardOf = (a) => String(a.source || a.id).toLowerCase().match(/ashby|greenhouse|lever/)?.[0] || "other";
const tally = (list, key) => { const m = new Map(); for (const x of list) { const k = key(x); if (k) m.set(k, (m.get(k) || 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]); };

console.log(`Last ${hours} h: ${submitted} submitted, ${stopped.length} stopped`);
console.log("By status:", tally(stopped, (a) => a.status).map(([k, n]) => `${k} ${n}`).join(", "));
// Per hour (Pacific): an outage (the AI out of credits) shows as a block of stops.
const byHour = new Map(); // "2026-11-03T20" (UTC hour) -> counts
for (const d of snap.docs) { const a = d.data(); const k = String(a.updatedAt).slice(0, 13); const x = byHour.get(k) || { s: 0, x: 0 }; a.status === "submitted" ? x.s++ : x.x++; byHour.set(k, x); }
console.log("\nPer hour (Pacific): submitted / stopped");
for (const [k, x] of [...byHour].sort()) console.log(`  ${new Date(`${k}:00:00Z`).toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric" }).padEnd(10)} ${String(x.s).padStart(4)} / ${String(x.x).padStart(4)}`);
for (const board of ["ashby", "greenhouse", "lever", "other"]) {
  const list = stopped.filter((a) => boardOf(a) === board);
  if (!list.length) continue;
  console.log(`\n${board} (${list.length} stopped)`);
  const items = list.flatMap((a) => (a.needsAttention || []).map((n) => ({ ...n, co: a.companyName })));
  console.log("  fields / messages left (top 15):");
  for (const [k, n] of tally(items, (n) => `${n.label} — ${String(n.note || "").replace(/^after Submit: /, "").slice(0, 110)}`).slice(0, 15)) console.log(`   ${String(n).padStart(4)}  ${k}`);
  const noField = list.filter((a) => !(a.needsAttention || []).length);
  if (noField.length) console.log(`  with nothing listed: ${noField.length} (${tally(noField, (a) => a.lastError || a.status).slice(0, 4).map(([k, n]) => `${n}× ${String(k).slice(0, 80)}`).join("; ")})`);
  console.log("  companies:", tally(list, (a) => a.companyName).slice(0, 10).map(([k, n]) => `${k} ${n}`).join(", "));
}
process.exit(0);
