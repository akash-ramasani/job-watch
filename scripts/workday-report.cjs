#!/usr/bin/env node
// workday-report.cjs — what Workday auto-apply did, from the extension's traces
// (users/{uid}/workdayTraces, written by content/universal.js). Read only.
//
//   node scripts/workday-report.cjs [sinceISO] [outFile]
//
// Prints the account and field success rates; writes one JSON with every job:
// account steps, every step's fields (Workday ids, labels, types, options),
// answers, fill results, what Workday refused, the Review page, the result.
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
process.env.GOOGLE_APPLICATION_CREDENTIALS ||= path.join(root, "worker", "service-account.json");
const admin = require(path.join(root, "functions", "node_modules", "firebase-admin"));
admin.initializeApp({ projectId: "greenhouse-jobs-scrapper" });
const UID = process.env.JW_UID || "7Tojjo8l5PZIYctPmdwncf7PC133";
const since = process.argv[2] || "2000-01-01";
const outFile = process.argv[3] || path.join(root, "research", "workday-runs", `report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

(async () => {
  const snap = await admin.firestore().collection("users").doc(UID).collection("workdayTraces").where("at", ">=", since).get();
  const traces = snap.docs.map((d) => ({ ...d.data(), data: (() => { try { return JSON.parse(d.data().json || "{}"); } catch { return {}; } })() }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const jobs = new Map();
  for (const t of traces) {
    const key = t.jobId || `${t.tenant}|${t.url}`;
    const j = jobs.get(key) || { jobId: t.jobId, tenant: t.tenant, company: t.companyName, title: t.title, test: t.test, version: t.version, auth: [], steps: [], advances: [], review: null, result: null, first: t.at, last: t.at };
    j.last = t.at;
    if (t.test) j.test = true;
    if (t.kind === "auth") j.auth.push(t.data);
    else if (t.kind === "step") j.steps.push(t.data);
    else if (t.kind === "advance") j.advances.push(t.data);
    else if (t.kind === "review") j.review = t.data.text;
    else if (t.kind === "result") j.result = t.data;
    else if (["load", "init", "idle", "busy", "stuck", "precheck", "submit"].includes(t.kind)) (j.pages = j.pages || []).push({ kind: t.kind, at: t.at, ...t.data });
    jobs.set(key, j);
  }

  // ── Accounts ──
  const acct = { jobs: 0, signedIn: 0, signInDirect: 0, created: 0, createAttempts: 0, verifyNeeded: 0, verified: 0, resetAttempts: 0, resetEmailFound: 0, resetDone: 0, failed: [] };
  for (const j of jobs.values()) {
    if (!j.auth.length && !j.steps.length) continue;
    acct.jobs++;
    const phases = j.auth.map((a) => a.phase);
    const signed = j.auth.find((a) => a.phase === "signed in") || (j.steps.length ? { phase: "signed in" } : null);
    if (signed) acct.signedIn++;
    if (j.auth.some((a) => a.decided === "create")) acct.createAttempts++;
    if (signed && signed.viaCreate) acct.created++;
    if (signed && !signed.viaCreate && !signed.viaReset) acct.signInDirect++;
    if (j.auth.some((a) => /verif/i.test(`${(a.errors || []).join(" ")} ${a.message || ""}`)) || phases.includes("verification email found")) acct.verifyNeeded++;
    if (phases.includes("verification email found")) acct.verified++;
    if (phases.includes("reset requested")) acct.resetAttempts++;
    if (phases.includes("reset email found")) acct.resetEmailFound++;
    if (signed && signed.viaReset) acct.resetDone++;
    if (!signed) acct.failed.push({ company: j.company, tenant: j.tenant, why: j.result?.note || (j.auth[j.auth.length - 1]?.errors || []).join(" ") || "unknown" });
  }

  // ── Fields ──
  const fieldStats = { seen: 0, required: 0, prefilled: 0, computed: 0, filledOk: 0, fillFailed: 0, requiredLeftEmpty: 0, refusedByWorkday: 0, leftForPerson: 0, bySource: {}, byStep: {} };
  const catalog = {};
  for (const j of jobs.values()) {
    for (const s of j.steps) {
      const st = (fieldStats.byStep[s.step] = fieldStats.byStep[s.step] || { fields: 0, filledOk: 0, failed: 0, requiredEmpty: 0 });
      const results = s.results || {};
      for (const f of s.fields || []) {
        fieldStats.seen++; st.fields++;
        if (f.required) fieldStats.required++;
        if (f.filledBefore) fieldStats.prefilled++;
        const key = `${s.step} :: ${f.wd || "?"} :: ${f.label}`;
        const c = (catalog[key] = catalog[key] || { step: s.step, wd: f.wd, label: f.label, types: [], required: f.required, companies: [], options: {} });
        if (!c.types.includes(f.type)) c.types.push(f.type);
        if (!c.companies.includes(j.company)) c.companies.push(j.company);
        if (f.options?.length) c.options[j.company] = f.options;
      }
      for (const r of Object.values(results)) {
        fieldStats.computed++;
        fieldStats.bySource[r.source || "?"] = fieldStats.bySource[r.source || "?"] || { ok: 0, failed: 0 };
        if (r.ok) { fieldStats.filledOk++; st.filledOk++; fieldStats.bySource[r.source || "?"].ok++; }
        else { fieldStats.fillFailed++; st.failed++; fieldStats.bySource[r.source || "?"].failed++; }
      }
      const empty = (s.after || []).filter((a) => a.required && !a.filled).length;
      fieldStats.requiredLeftEmpty += empty; st.requiredEmpty += empty;
      fieldStats.leftForPerson += (s.review || []).length;
    }
    for (const a of j.advances) if (!a.moved) fieldStats.refusedByWorkday += (a.errors || []).length;
  }

  // ── Jobs ──
  const list = [...jobs.values()];
  const reachedReview = list.filter((j) => j.result?.status === "review" || j.review).length;
  const results = {};
  for (const j of list) { const k = j.result?.status || (j.steps.length ? "in progress" : "no result"); results[k] = (results[k] || 0) + 1; }
  const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
  const summary = {
    since, jobs: list.length, companies: new Set(list.map((j) => j.tenant)).size, results, reachedReview, reachedReviewRate: pct(reachedReview, list.length),
    accounts: { ...acct, signInRate: pct(acct.signedIn, acct.jobs), createRate: pct(acct.created, acct.createAttempts), verifyRate: pct(acct.verified, acct.verifyNeeded), resetRate: pct(acct.resetDone, acct.resetAttempts) },
    fields: { ...fieldStats, fillRate: pct(fieldStats.filledOk, fieldStats.computed) },
  };
  // Every field that went wrong, with its HTML (failed fills, required left empty, flagged by Workday).
  const problems = [];
  for (const j of list) {
    for (const s of j.steps) for (const p of s.problems || []) problems.push({ company: j.company, tenant: j.tenant, step: s.step, at: "after filling", ...p });
    for (const a of j.advances) for (const p of a.problems || []) problems.push({ company: j.company, tenant: j.tenant, step: a.step, at: `Save and Continue #${a.press}`, ...p });
  }
  summary.problemFields = problems.length;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ summary, problems, catalog: Object.values(catalog), jobs: list }, null, 1));
  console.log(JSON.stringify(summary, (k, v) => (k === "failed" && Array.isArray(v) ? v.slice(0, 15) : v), 1));
  console.log("\nwrote", outFile);
  process.exit(0);
})();
