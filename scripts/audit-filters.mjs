#!/usr/bin/env node
// audit-filters.mjs — are the filters in front of the AI dropping jobs that matter?
//
//   0. Location (at fetch): live sample of Greenhouse/Ashby boards — what gets
//      dropped for not looking US, and do any dropped ones look remote/US?
//   1. Job types: skipped jobs that other evidence says are good — an AI score
//      (current or old method) or a strong skills match with the resume.
//   2. Duplicates: are grouped postings really the same job?
//   3. Rule score cutoff: AI-scored good jobs the rule score would have kept from the AI.
// Also a data-analyst check: jobs a data-analytics profile skips whose
// descriptions read like analytics work.
//
// Usage: node scripts/audit-filters.mjs [--boards 120] [--user email]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.GOOGLE_APPLICATION_CREDENTIALS ||= path.join(__dirname, "..", "worker", "service-account.json");
process.env.GCLOUD_PROJECT ||= "greenhouse-jobs-scrapper";
const require = createRequire(path.join(__dirname, "..", "functions", "package.json"));
const { loadActiveFeeds, jobTypesFor, ADMIN_UID, fetchJobsFromFeed, normalizeJobMinimal, jobMatchesLocationFilter } = require("./index.js").__internals;
const admin = require("firebase-admin");
const { FIT_VERSION } = require("./lib/jobFit.cjs");
const { shouldAssess, classifyTitle, ADJACENT } = require("./lib/jobFamilies.cjs");
const { ruleAssessJob, profileSkills, parseRequirements } = require("./lib/ruleScore.cjs");

const arg = (n) => { const i = process.argv.indexOf(n); return i === -1 ? null : process.argv[i + 1]; };
const db = admin.firestore();
const uid = arg("--user") ? (await admin.auth().getUserByEmail(arg("--user"))).uid : ADMIN_UID;
const profile = (await db.doc(`users/${uid}/resume/profile`).get()).data();
const prefs = (await db.doc(`users/${uid}/settings/preferences`).get()).data() || {};
const targets = jobTypesFor(profile, prefs);
const mine = profileSkills(profile);
const show = (list, n = 25) => list.slice(0, n).forEach((x) => console.log("   ", x));

// ── Step 0: location ─────────────────────────────────────────────────────────
{
  const feeds = (await loadActiveFeeds(ADMIN_UID)).filter((f) => /greenhouse|ashby/.test(f.source));
  const sample = feeds.filter((f) => createHash("md5").update(f.id).digest()[0] % Math.max(1, Math.round(feeds.length / Number(arg("--boards") || 120))) === 0);
  const now = admin.firestore.Timestamp.now();
  let total = 0, kept = 0;
  const dropped = [];
  for (const feed of sample) {
    try {
      const raw = await fetchJobsFromFeed(feed.url, feed.source, 0);
      for (const r of raw) {
        const j = normalizeJobMinimal(r, { source: feed.source, companyName: feed.companyName || feed.company, companyKey: feed.id, now, url: feed.url });
        if (!j) continue;
        total++;
        if (jobMatchesLocationFilter(j)) kept++; else dropped.push(j);
      }
    } catch { /* dead board: skip */ }
  }
  const looksUS = (l) => /\b(remote|anywhere|united states|usa|u\.s\.|north america|americas|flexible|distributed|hybrid)\b/i.test(l) || !l.trim();
  const suspicious = dropped.filter((j) => looksUS(j.locationName || ""));
  const relevant = suspicious.filter((j) => shouldAssess(j.title, targets, j.fullDescription || "").assess);
  const byLoc = {};
  for (const j of suspicious) byLoc[j.locationName || "(blank)"] = (byLoc[j.locationName || "(blank)"] || 0) + 1;
  console.log(`\n0. LOCATION — ${sample.length} boards, ${total} live jobs: ${kept} kept, ${dropped.length} dropped as non-US`);
  console.log(`   dropped but location looks US/remote/blank: ${suspicious.length} (${relevant.length} of your job types)`);
  show(Object.entries(byLoc).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${n} × "${l}"`), 15);
  console.log("   examples of your types:");
  show(relevant.map((j) => `${j.title} @ ${j.companyName} — "${j.locationName}"`), 15);
}

// Corpus + scores
const jobs = (await db.collection(`users/${ADMIN_UID}/jobs`).select("title", "fullDescription", "relevanceScore", "scoreVersion", "companyKey", "companyName").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const scores = new Map();
for (let i = 0; i < jobs.length; i += 300) (await db.getAll(...jobs.slice(i, i + 300).map((j) => db.doc(`users/${uid}/jobScores/${j.id}`)))).forEach((s) => { if (s.exists) scores.set(s.id, s.data()); });
const gate = (j) => shouldAssess(j.title, targets, j.fullDescription || "");

// ── Step 1: job types ────────────────────────────────────────────────────────
{
  const skipped = jobs.filter((j) => !gate(j).assess);
  const aiGood = skipped.filter((j) => { const s = scores.get(j.id); return s?.fit?.version === FIT_VERSION && !s.fit.screened && s.score >= 40; });
  const oldGood = skipped.filter((j) => uid === ADMIN_UID && typeof j.relevanceScore === "number" && j.relevanceScore >= 60 && j.scoreVersion !== FIT_VERSION);
  // Skills evidence regardless of job type: how much of the job's must-haves the resume covers.
  const strong = [];
  for (const j of skipped) {
    const desc = j.fullDescription || "";
    if (desc.length < 400) continue;
    const p = parseRequirements(desc);
    const must = p.requirements.filter((q) => q.n === "must");
    if (must.length < 5) continue;
    const hit = must.filter((q) => q.skills.some((id) => mine.have.has(id))).length;
    if (hit / must.length >= 0.7) strong.push({ j, cov: Math.round((100 * hit) / must.length), n: must.length });
  }
  console.log(`\n1. JOB TYPES — targets: ${targets.join(", ")}`);
  console.log(`   ${jobs.length} jobs, ${skipped.length} skipped as other types`);
  console.log(`   skipped but AI (current method) scored 40+: ${aiGood.length}`);
  show(aiGood.map((j) => `${scores.get(j.id).score} ${j.title} [${classifyTitle(j.title).join(",")}]`));
  console.log(`   skipped but old-method AI scored 60+: ${oldGood.length}`);
  show(oldGood.sort((a, b) => b.relevanceScore - a.relevanceScore).map((j) => `${j.relevanceScore} ${j.title} @ ${j.companyName} [${classifyTitle(j.title).join(",")}]`), 40);
  console.log(`   skipped but the resume covers 70%+ of 5+ must-have skills: ${strong.length}`);
  show(strong.sort((a, b) => b.cov - a.cov || b.n - a.n).map((x) => `${x.cov}% of ${x.n}  ${x.j.title} @ ${x.j.companyName} [${classifyTitle(x.j.title).join(",")}]`), 40);
}

// ── Data-analyst check (a profile with no resume yet) ────────────────────────
{
  const DA = ADJACENT.data_analytics;
  const TERMS = [/\bsql\b/i, /\btableau\b/i, /\bpower ?bi\b/i, /\blooker\b/i, /\bdashboards?\b/i, /\bexcel\b/i, /\bdata analysis\b/i, /\ba\/b test/i, /\bstatistic/i, /\bdata visuali[sz]ation\b/i, /\breporting\b/i, /\bkpis?\b/i];
  const skipped = jobs.filter((j) => !shouldAssess(j.title, DA, j.fullDescription || "").assess);
  const analytic = skipped.map((j) => ({ j, n: TERMS.filter((re) => re.test(j.fullDescription || "")).length })).filter((x) => x.n >= 5);
  console.log(`\nDA. DATA-ANALYST PROFILE — ${skipped.length} skipped; ${analytic.length} of those use 5+ analytics terms:`);
  show(analytic.sort((a, b) => b.n - a.n).map((x) => `${x.n} terms  ${x.j.title} @ ${x.j.companyName} [${classifyTitle(x.j.title).join(",") || "no type"}]`), 40);
}

// ── Step 2: duplicates ───────────────────────────────────────────────────────
{
  const sig = (j) => { const d = String(j.fullDescription || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); if (d.length < 200) return null; return createHash("sha1").update(`${j.companyKey}|${String(j.title).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}|${d.slice(0, 4000)}`).digest("hex"); };
  const groups = new Map();
  for (const j of jobs) { const s = sig(j); if (s) (groups.get(s) || groups.set(s, []).get(s)).push(j); }
  const dups = [...groups.values()].filter((g) => g.length > 1);
  const mixed = dups.filter((g) => new Set(g.map((j) => `${j.companyKey}|${j.title}`)).size > 1);
  show(mixed.slice(0, 4).map((g) => [...new Set(g.map((j) => `${j.companyName}: "${j.title}"`))].join("  vs  ")));
  console.log(`\n2. DUPLICATES — ${dups.length} groups covering ${dups.reduce((a, g) => a + g.length, 0)} jobs; groups mixing different companies/titles: ${mixed.length}`);
  show(dups.sort((a, b) => b.length - a.length).slice(0, 5).map((g) => `${g.length} × ${g[0].title} @ ${g[0].companyName}`));
}

// ── Step 3: rule-score cutoff ────────────────────────────────────────────────
{
  const ai = jobs.filter((j) => { const s = scores.get(j.id); return s?.fit?.version === FIT_VERSION && !s.fit.screened && (j.fullDescription || "").length >= 200; });
  const rows = ai.map((j) => ({ j, ai: scores.get(j.id).score, aiReason: scores.get(j.id).reason, rule: ruleAssessJob({ profile, jobTitle: j.title, description: j.fullDescription, targets, mine }) }));
  const missed = rows.filter((r) => r.ai >= 60 && !r.rule.aiWorthy);
  console.log(`\n3. RULE SCORE ROUTING — ${rows.length} AI-scored jobs; AI 60+ that the rule score keeps from the AI: ${missed.length} of ${rows.filter((r) => r.ai >= 60).length} · AI 80+: ${rows.filter((r) => r.ai >= 80 && !r.rule.aiWorthy).length} of ${rows.filter((r) => r.ai >= 80).length}`);
  show(missed.sort((a, b) => b.ai - a.ai).map((r) => `AI ${r.ai} / rule ${r.rule.score}  ${r.j.title} — rule: ${r.rule.reason}`), 30);
}
process.exit(0);
