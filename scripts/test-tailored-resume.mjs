#!/usr/bin/env node
// test-tailored-resume.mjs — call the generateTailoredResume callable as the
// admin against one job and print the match report + resume.
//
// Usage:
//   node scripts/test-tailored-resume.mjs                 # newest AI-scored job with a description
//   node scripts/test-tailored-resume.mjs <jobDocId>      # a specific job
//   node scripts/test-tailored-resume.mjs <jobDocId> --force
//   node scripts/test-tailored-resume.mjs <jobDocId> --tex out.tex   # also write the LaTeX (same template as the web app)

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { db, ADMIN_UID } from "../worker/lib/firestore.mjs";
import { buildResumeLatex } from "../src/lib/resumeLatex.js";

const require = createRequire(new URL("../worker/package.json", import.meta.url));
const { getAuth } = require("firebase-admin/auth");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ID = "greenhouse-jobs-scrapper";
const REGION = "us-central1";
const args = process.argv.slice(2);
const force = args.includes("--force");
const texIdx = args.indexOf("--tex");
const texOut = texIdx !== -1 ? args[texIdx + 1] : null;
let jobId = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--tex") || null;

const firestore = await db();
if (!jobId) {
  const snap = await firestore.collection("users").doc(ADMIN_UID).collection("jobs")
    .orderBy("fetchedAt", "desc").limit(40).get();
  const pick = snap.docs.find((d) => (d.data().fullDescription || "").length > 800 && (d.data().relevanceScore ?? 0) >= 50)
    || snap.docs.find((d) => (d.data().fullDescription || "").length > 800);
  if (!pick) throw new Error("No job with a description found");
  jobId = pick.id;
  console.log(`Using job ${jobId}: ${pick.data().title} @ ${pick.data().companyName} (score ${pick.data().relevanceScore})`);
}

const env = await readFile(path.join(__dirname, "..", ".env"), "utf8");
const apiKey = (env.match(/^VITE_FIREBASE_API_KEY=(.+)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, "");
const customToken = await getAuth().createCustomToken(ADMIN_UID);
const signIn = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: customToken, returnSecureToken: true }),
});
const { idToken } = await signIn.json();

const started = Date.now();
const resp = await fetch(`https://${REGION}-${PROJECT_ID}.cloudfunctions.net/generateTailoredResume`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
  body: JSON.stringify({ data: { jobId, force } }),
});
const text = await resp.text();
console.log(`HTTP ${resp.status} in ${Math.round((Date.now() - started) / 1000)}s`);
let body;
try {
  body = JSON.parse(text);
} catch {
  console.log(text.slice(0, 500));
  process.exit(1);
}
if (!resp.ok || body.error) { console.log(JSON.stringify(body, null, 2)); process.exit(1); }
const { resume, matchReport, cached } = body.result;
console.log(`cached=${cached} coverage=${matchReport.coveragePct}% gaps=${matchReport.gaps.length} trimmed=${(matchReport.trimmedBullets || []).length} removedBullets=${matchReport.removedBullets.length} droppedSkills=${matchReport.droppedSkills.length}`);
if (matchReport.trimmedBullets?.length) { console.log("\n--- TRIMMED BY AUDIT ---"); for (const b of matchReport.trimmedBullets) console.log(`- ${b.text}\n    → ${b.fixed}\n    ↳ ${b.reason}`); }
console.log("\n--- REQUIREMENTS ---");
for (const q of matchReport.requirements) console.log(`${q.covered === "yes" ? "✓" : q.covered === "partial" ? "◐" : "✗"} ${q.requirement}${q.evidence ? `  [${q.evidence}]` : ""}`);
if (matchReport.removedBullets.length) { console.log("\n--- REMOVED BY AUDIT ---"); for (const b of matchReport.removedBullets) console.log(`- ${b.text}\n    ↳ ${b.reason}`); }
if (matchReport.droppedSkills.length) console.log("\n--- SKILLS DROPPED (not in profile) ---", matchReport.droppedSkills.join(", "));
console.log("\n--- SUMMARY ---\n" + resume.summary);
console.log("\n--- SKILLS ---");
for (const g of resume.skillGroups || [{ label: "Skills", skills: resume.skills }]) console.log(`${g.label}: ${g.skills.join(", ")}`);
for (const r of resume.roles) { console.log(`\n--- ${r.title} @ ${r.company} (${r.startDate} – ${r.endDate}${r.location ? ", " + r.location : ""}) ---`); r.bullets.forEach((b) => console.log("• " + b)); }
if (texOut) {
  const tex = buildResumeLatex(resume, resume.header || {});
  await writeFile(texOut, tex, "utf8");
  console.log(`\nLaTeX written to ${texOut} (${tex.length} chars)`);
}
process.exit(0);
