// analyze-form-coverage.mjs — measure the answer engine against the observed
// form corpus (scripts/observations/high-scores_*), using the REAL profile.
//
// For every captured form schema (Greenhouse questions / Ashby fieldEntries),
// runs the worker answer engine and reports:
//   - how many forms are fully answerable (deterministic / with AI free-text)
//   - every distinct question that PARKS a form, ranked by how many jobs it blocks
//
// Usage: node scripts/analyze-form-coverage.mjs [path/to/observations/run]
//        env: SHOW=40 (how many blockers to print)

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mapForm } from "../worker/lib/answer-engine.mjs";
import { getProfile } from "../worker/lib/firestore.mjs";

const SHOW = Number(process.env.SHOW || 40);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let runDir = process.argv[2];
if (!runDir) {
  const obsDir = path.join(__dirname, "observations");
  const runs = readdirSync(obsDir).filter((d) => d.startsWith("high-scores_")).sort();
  runDir = path.join(obsDir, runs[runs.length - 1]);
}
runDir = path.resolve(runDir);

const { jobs } = JSON.parse(readFileSync(path.join(runDir, "jobs.json"), "utf8"));
const profile = await getProfile();
if (!profile) throw new Error("no profile doc");
// The real flow always has a tailored resume + AI for free text, and injects
// application history (apply-one.mjs); model that.
const profileForRun = { ...profile, resumePath: profile.resumePath || "resume.pdf", appliedToCompanyBefore: false };
const aiStub = { get: () => "«AI-answer»" };

// ── Normalize Ashby fieldEntries to Greenhouse-style questions ────────────────
function ashbyToQuestions(form) {
  const qs = [];
  for (const s of form.sections || []) {
    for (const e of s.fieldEntries || []) {
      const f = e.field || {};
      if (f.isDeactivated) continue;
      let values = (f.selectableValues || []).map((v) => ({
        label: v.label ?? v.value ?? String(v),
        value: v.value ?? v.label ?? String(v),
      }));
      if (f.type === "Boolean") values = [{ label: "Yes", value: "Yes" }, { label: "No", value: "No" }];
      qs.push({
        label: f.title || f.humanReadablePath || f.path,
        required: !!e.isRequired,
        fields: [{ name: f.path, type: f.type, values }],
      });
    }
  }
  return qs;
}

// ── Run the engine over every form ────────────────────────────────────────────
const normLabel = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").replace(/[*:]+$/, "").trim();
const blockers = new Map(); // normLabel -> {label, count, jobs:Set, notes:Set, options:Set, sources:Set}
const stats = { forms: 0, fullyDeterministic: 0, fullyWithAi: 0, parked: 0, bySource: {} };
const parkedJobs = [];

for (const j of jobs) {
  if (!j.applicationForm) continue;
  let questions;
  if (j.source === "greenhouse") questions = j.applicationForm.form.questions || [];
  else if (j.source === "ashbyhq") questions = ashbyToQuestions(j.applicationForm.form);
  else continue;

  stats.forms++;
  stats.bySource[j.source] = (stats.bySource[j.source] || 0) + 1;

  const profileForJob = { ...profileForRun, jobLocationName: j.locationName || "" };
  const det = mapForm(questions, profileForJob, null);
  const ai = mapForm(questions, profileForJob, aiStub);

  const detOk = det.review.length === 0;
  const aiOk = ai.review.length === 0;
  if (detOk) stats.fullyDeterministic++;
  if (aiOk) stats.fullyWithAi++;
  else {
    stats.parked++;
    parkedJobs.push({ job: `${j.companyName} — ${j.title}`, source: j.source, blockedBy: ai.review.map((r) => r.label) });
    for (const r of ai.review) {
      const key = normLabel(r.label);
      const b = blockers.get(key) || { label: r.label, count: 0, jobs: new Set(), notes: new Set(), options: new Set(), sources: new Set() };
      b.count++;
      b.jobs.add(j.companyName);
      b.notes.add(r.note);
      b.sources.add(j.source);
      const q = questions.find((q) => q.label === r.label);
      const opts = q?.fields?.[0]?.values || [];
      opts.slice(0, 12).forEach((o) => b.options.add(String(o.label)));
      blockers.set(key, b);
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
const ranked = [...blockers.values()].sort((a, b) => b.count - a.count);

console.log(`Forms analyzed        : ${stats.forms}  ${JSON.stringify(stats.bySource)}`);
console.log(`Fully deterministic   : ${stats.fullyDeterministic}  (${((stats.fullyDeterministic / stats.forms) * 100).toFixed(1)}%)`);
console.log(`Fully answerable w/AI : ${stats.fullyWithAi}  (${((stats.fullyWithAi / stats.forms) * 100).toFixed(1)}%)`);
console.log(`Parked (need review)  : ${stats.parked}`);
console.log(`Distinct blocking questions: ${ranked.length}\n`);

for (const b of ranked.slice(0, SHOW)) {
  console.log(`■ blocks ${b.count} form(s) [${[...b.sources]}] — "${b.label}"`);
  console.log(`    note   : ${[...b.notes].join(" | ")}`);
  if (b.options.size) console.log(`    options: ${[...b.options].slice(0, 12).join(" / ")}`);
  console.log(`    at     : ${[...b.jobs].slice(0, 6).join(", ")}${b.jobs.size > 6 ? " …" : ""}`);
}

const outFile = path.join(runDir, "coverage-analysis.json");
writeFileSync(outFile, JSON.stringify({
  generatedAt: new Date().toISOString(),
  stats,
  blockers: ranked.map((b) => ({ ...b, jobs: [...b.jobs], notes: [...b.notes], options: [...b.options], sources: [...b.sources] })),
  parkedJobs,
}, null, 2));
console.log(`\nSaved: ${outFile}`);
process.exit(0);
