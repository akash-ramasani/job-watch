#!/usr/bin/env node
// auto-apply-stats.cjs — how auto-apply is doing, from the application records
// (users/{uid}/applications). Read only.
//
//   node scripts/auto-apply-stats.cjs [days=14] [uid=admin]
//
// Success rate = submitted / (submitted + needs you + error). Test runs
// (jwNoSubmit) and dismissed records are left out. "Email proof" counts the
// submitted ones the company has written back about (confirmation, rejection,
// interview…), read from Gmail by trackApplicationEmails.
const path = require("node:path");
const root = path.join(__dirname, "..");
process.env.GOOGLE_APPLICATION_CREDENTIALS ||= path.join(root, "worker", "service-account.json");
const admin = require(path.join(root, "functions", "node_modules", "firebase-admin"));
admin.initializeApp({ projectId: "greenhouse-jobs-scrapper" });

const days = Number(process.argv[2]) || 14;
const uid = process.argv[3] || "7Tojjo8l5PZIYctPmdwncf7PC133";

(async () => {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const snap = await admin.firestore().collection("users").doc(uid).collection("applications").get();
  const when = (d) => String(d.submittedAt || d.appliedAt || d.updatedAt || d.lastStartedAt || "");
  const isTest = (d) => (d.needsAttention || []).some((a) => /test run/i.test(a.note || "")) || /test run/i.test(d.lastError || "");
  const all = snap.docs.map((x) => x.data()).filter((d) => when(d) >= since);
  const docs = all.filter((d) => !isTest(d) && d.status !== "dismissed");
  const count = (list, f) => list.reduce((m, d) => { const k = f(d) || "?"; m[k] = (m[k] || 0) + 1; return m; }, {});
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `  ${String(v).padStart(4)}  ${k}`).join("\n");
  const board = (d) => d.source || (String(d.url || d.formUrl || d.applyUrl || d.formKey || "").match(/ashby|greenhouse|lever|workday/i) || ["other"])[0].toLowerCase();

  console.log(`Last ${days} days: ${docs.length} applications (left out ${all.filter(isTest).length} test runs, ${all.filter((d) => d.status === "dismissed").length} dismissed)`);
  console.log("status:", JSON.stringify(count(docs, (d) => d.status)));
  const sub = docs.filter((d) => d.status === "submitted");
  const finished = docs.filter((d) => ["submitted", "needs_attention", "error"].includes(d.status));
  console.log(`\nSUCCESS RATE: ${sub.length}/${finished.length} = ${finished.length ? ((100 * sub.length) / finished.length).toFixed(1) : "0"}%`);
  const byBoard = {};
  for (const d of finished) { const b = board(d); byBoard[b] ||= { submitted: 0, total: 0 }; byBoard[b].total++; if (d.status === "submitted") byBoard[b].submitted++; }
  for (const [b, v] of Object.entries(byBoard)) console.log(`  ${b.padEnd(11)} ${v.submitted}/${v.total} = ${((100 * v.submitted) / v.total).toFixed(1)}%`);
  // Per day: shows whether the latest fixes moved the rate (older failures stay in the total).
  const byDay = {};
  for (const d of finished) { const k = when(d).slice(0, 10); byDay[k] ||= { submitted: 0, total: 0 }; byDay[k].total++; if (d.status === "submitted") byDay[k].submitted++; }
  console.log("\nBY DAY");
  for (const [k, v] of Object.entries(byDay).sort()) console.log(`  ${k}  ${String(v.submitted).padStart(4)}/${String(v.total).padEnd(4)} = ${((100 * v.submitted) / v.total).toFixed(1)}%`);
  console.log(`\nEMAIL PROOF: ${sub.filter((d) => d.outcome).length}/${sub.length} submitted have an email back from the company`);
  console.log(top(count(sub, (d) => d.outcome || "no email yet"), 10));

  const notes = {};
  const labels = {};
  for (const d of docs.filter((x) => x.status !== "submitted")) for (const a of d.needsAttention || []) {
    const n = String(a.note || "").replace(/["“][^"”]*["”]/g, "…").replace(/\d+/g, "#").slice(0, 80);
    notes[n] = (notes[n] || 0) + 1;
    const l = String(a.label || "").toLowerCase().slice(0, 80);
    labels[l] = (labels[l] || 0) + 1;
  }
  console.log(`\nWHY NOT SUBMITTED (reasons)\n${top(notes, 20) || "  none"}`);
  console.log(`\nWHICH FIELDS\n${top(labels, 25) || "  none"}`);
  console.log(`\nERRORS\n${top(count(docs.filter((d) => d.status === "error"), (d) => String(d.lastError || "").replace(/\d+/g, "#").slice(0, 90)), 15) || "  none"}`);
  process.exit(0);
})().catch((e) => { console.error("failed:", e.message); process.exit(1); });
