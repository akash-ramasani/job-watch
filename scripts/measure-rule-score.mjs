#!/usr/bin/env node
// measure-rule-score.mjs — how well the free rule score (functions/lib/ruleScore.cjs)
// agrees with the AI score, on every job a user has an AI assessment for.
//
// Jobs are split in two by id hash: tune on "train", report on "test".
// Prints rank agreement, a band-by-band table, and for each cutoff how many
// jobs would go to the AI and how many of the AI's good matches it keeps.
//
// Usage: node scripts/measure-rule-score.mjs [--user email] [--split test|train|all] [--examples]

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { db, ADMIN_UID } from "../worker/lib/firestore.mjs";

const require = createRequire(new URL("../worker/package.json", import.meta.url));
const { getAuth } = require("firebase-admin/auth");
const { ruleAssessJob, profileSkills } = require("../functions/lib/ruleScore.cjs");
const { familiesForProfile } = require("../functions/lib/jobFamilies.cjs");

const arg = (n) => { const i = process.argv.indexOf(n); return i === -1 ? null : process.argv[i + 1]; };
const split = arg("--split") || "test";
const f = await db();
const uid = arg("--user") ? (await getAuth().getUserByEmail(arg("--user"))).uid : ADMIN_UID;
const profile = (await f.doc(`users/${uid}/resume/profile`).get()).data();
const prefs = (await f.doc(`users/${uid}/settings/preferences`).get()).data() || {};
const targets = Array.isArray(prefs.jobTypes) && prefs.jobTypes.length ? prefs.jobTypes : familiesForProfile(profile);
const mine = profileSkills(profile);

const scored = (await f.collection(`users/${uid}/jobScores`).where("fit.version", "==", 2).get()).docs
  .filter((d) => !d.get("fit.screened"))
  .filter((d) => { const h = createHash("md5").update(d.id).digest()[0] % 2; return split === "all" || (split === "train" ? h === 0 : h === 1); });
const rows = [];
for (let i = 0; i < scored.length; i += 300) {
  const chunk = scored.slice(i, i + 300);
  const jobs = await f.getAll(...chunk.map((d) => f.doc(`users/${ADMIN_UID}/jobs/${d.id}`)), { fieldMask: ["title", "fullDescription"] });
  jobs.forEach((j, k) => {
    const desc = j.exists ? j.get("fullDescription") || "" : "";
    if (desc.length < 200) return;
    const rule = ruleAssessJob({ profile, jobTitle: j.get("title"), description: desc, targets, mine });
    rows.push({ id: j.id, title: j.get("title"), ai: chunk[k].get("score"), aiReason: chunk[k].get("reason"), rule });
  });
}

const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = []; let i = 0; while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2; i = j + 1; } return r; };
const corr = (x, y) => { const n = x.length, mx = x.reduce((a, b) => a + b) / n, my = y.reduce((a, b) => a + b) / n; let a = 0, b = 0, c = 0; for (let i = 0; i < n; i++) { a += (x[i] - mx) * (y[i] - my); b += (x[i] - mx) ** 2; c += (y[i] - my) ** 2; } return a / Math.sqrt(b * c); };
const ai = rows.map((r) => r.ai), rule = rows.map((r) => r.rule.score);
console.log(`${split}: ${rows.length} jobs with an AI score · rank agreement (Spearman) ${corr(rank(ai), rank(rule)).toFixed(2)} · average gap ${(rows.reduce((a, r) => a + Math.abs(r.ai - r.rule.score), 0) / rows.length).toFixed(0)} points`);

const band = (s) => (s >= 80 ? "80+" : s >= 60 ? "60-79" : s >= 40 ? "40-59" : s >= 15 ? "15-39" : "<15");
const B = ["80+", "60-79", "40-59", "15-39", "<15"];
console.log("\nAI score (rows) vs rule score (columns)\n         " + B.map((b) => b.padStart(7)).join(""));
for (const a of B) console.log(a.padEnd(9) + B.map((b) => String(rows.filter((r) => band(r.ai) === a && band(r.rule.score) === b).length).padStart(7)).join(""));

const g80 = rows.filter((r) => r.ai >= 80).length, g60 = rows.filter((r) => r.ai >= 60).length;
console.log("\nAI cutoff   sent to AI   AI 80+ kept   AI 60+ kept");
for (const T of [30, 35, 40, 45, 50]) {
  const sel = rows.filter((r) => r.rule.score >= T);
  console.log(`rule ≥ ${String(T).padEnd(4)} ${`${Math.round(100 * sel.length / rows.length)}%`.padStart(10)} ${`${sel.filter((r) => r.ai >= 80).length}/${g80}`.padStart(13)} ${`${sel.filter((r) => r.ai >= 60).length}/${g60}`.padStart(13)}`);
}
const K = Math.max(1, Math.round(rows.length * 0.1));
const top = [...rows].sort((a, b) => b.rule.score - a.rule.score).slice(0, K);
console.log(`\nrule's top 10% (${K} jobs): ${top.filter((r) => r.ai >= 60).length} are AI 60+, ${top.filter((r) => r.ai < 40).length} are AI < 40`);

if (process.argv.includes("--examples")) {
  console.log("\nBiggest misses (AI ≥ 70, rule < 40):");
  rows.filter((r) => r.ai >= 70 && r.rule.score < 40).slice(0, 10).forEach((r) => console.log(`  AI ${r.ai} / rule ${r.rule.score}  ${r.title} — rule: ${r.rule.reason}`));
  console.log("Biggest over-scores (AI < 25, rule ≥ 60):");
  rows.filter((r) => r.ai < 25 && r.rule.score >= 60).slice(0, 10).forEach((r) => console.log(`  AI ${r.ai} / rule ${r.rule.score}  ${r.title} — AI: ${r.aiReason}`));
}
process.exit(0);
