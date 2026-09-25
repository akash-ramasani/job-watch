#!/usr/bin/env node
// import-latex-resume.mjs — import a resume written in the JobWatch LaTeX
// template into users/{ADMIN_UID}/resume/profile as the master profile the
// tailored-resume generator draws from. Same parser the Profile page uses
// for "Paste LaTeX" (src/lib/latexResume.js).
//
// Usage:
//   node scripts/import-latex-resume.mjs private/resume.tex --dry-run
//   node scripts/import-latex-resume.mjs private/resume.tex
//
// The .tex itself stays in the gitignored private/ folder — it has your
// contact details and the repo is public.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { db, ADMIN_UID } from "../worker/lib/firestore.mjs";
import { parseLatexResume, looksLikeLatexResume } from "../src/lib/latexResume.js";

const require = createRequire(new URL("../worker/package.json", import.meta.url));
const { FieldValue } = require("firebase-admin/firestore");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("Usage: node scripts/import-latex-resume.mjs <resume.tex> [--dry-run]");
  process.exit(1);
}
const tex = await readFile(path.resolve(file), "utf8");
if (!looksLikeLatexResume(tex)) {
  console.error("That file doesn't look like the JobWatch LaTeX resume template (no \\resumeSubheading / \\resumeItem).");
  process.exit(1);
}

const profile = { ...parseLatexResume(tex), fileName: path.basename(file), source: "latex-import" };

console.log(`name: ${profile.header.name}\ncontact: ${[profile.header.location, profile.header.phone, profile.header.email, profile.header.github, profile.header.linkedin].filter(Boolean).join(" | ")}`);
console.log(`summary: ${profile.summary.slice(0, 90)}…`);
console.log(`skill groups: ${profile.skillGroups.length} (${profile.skills.length} skills)`);
profile.skillGroups.forEach((g) => console.log(`  ${g.label}: ${g.skills.length}`));
console.log(`roles: ${profile.roles.length}`);
profile.roles.forEach((r) => console.log(`  ${r.title} @ ${r.company} | ${r.startDate} – ${r.endDate} | ${r.location} | ${r.description.split("\n").length} bullets`));
console.log(`projects: ${profile.projects.length}`);
profile.projects.forEach((p) => console.log(`  ${p.name} | ${p.link || "-"} | ${p.description.split("\n").length} bullets`));
console.log(`education: ${profile.education.length}`);
profile.education.forEach((e) => console.log(`  ${e.degree} @ ${e.institution} | ${e.location}`));

if (dryRun) {
  console.log("\n--dry-run: nothing written");
  process.exit(0);
}
const firestore = await db();
const ref = firestore.collection("users").doc(ADMIN_UID).collection("resume").doc("profile");
const existing = (await ref.get()).data() || {};
await ref.set(
  { ...profile, extraExperience: existing.extraExperience || "", resumeUrl: existing.resumeUrl || null, updatedAt: FieldValue.serverTimestamp(), savedAt: FieldValue.serverTimestamp() },
  { merge: false }
);
console.log("\nwritten to users/{ADMIN_UID}/resume/profile");
process.exit(0);
