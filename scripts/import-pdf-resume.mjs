#!/usr/bin/env node
// import-pdf-resume.mjs — replace the stored resume with a PDF: the file in
// Storage (same path and download token, so the saved URL keeps working), the
// parsed master profile in users/{uid}/resume/profile, and the mirror fields on
// the user doc. The parse is deterministic for the JobWatch resume layout
// (Profile / Skills / Professional Experience / Selected Projects / Education,
// "Label: a, b" skill lines, "Company<Mon YYYY – Mon YYYY>" role headers,
// "Title<Location>" lines, "– " bullets). Nothing goes to the AI.
//
// Usage: node scripts/import-pdf-resume.mjs ~/Desktop/Resumes/Akash_Ramasani.pdf [--dry-run] [--user email]

import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { db, bucket, ADMIN_UID } from "../worker/lib/firestore.mjs";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const pdfParse = require("pdf-parse");
const { FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const arg = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
const file = args.find((a) => !a.startsWith("--") && a !== arg("--user"));
if (!file) { console.error("Usage: node scripts/import-pdf-resume.mjs <resume.pdf> [--dry-run] [--user email]"); process.exit(1); }

const buf = await readFile(path.resolve(file));
const { text } = await pdfParse(buf);
const lines = text.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());

// ── Sections ────────────────────────────────────────────────────────────────
const HEADINGS = { profile: "summary", summary: "summary", skills: "skills", "technical skills": "skills", "professional experience": "experience", experience: "experience", "selected projects": "projects", projects: "projects", education: "education", certifications: "certifications" };
const sections = { header: [] };
let cur = "header";
for (const l of lines) {
  const h = HEADINGS[l.trim().toLowerCase()];
  if (h) { cur = h; sections[cur] = sections[cur] || []; continue; }
  (sections[cur] = sections[cur] || []).push(l);
}

// ── Header ──────────────────────────────────────────────────────────────────
const head = sections.header.join(" | ");
const pick = (re) => (head.match(re) || [])[0] || "";
const header = {
  name: sections.header[0]?.trim() || "",
  email: pick(/[\w.+-]+@[\w-]+\.[\w.]+/),
  phone: pick(/\+?\d[\d\s().-]{8,}\d/).trim(),
  github: pick(/github\.com\/[\w.-]+/),
  linkedin: pick(/linkedin\.com\/in\/[\w.-]+/),
  location: (sections.header[1] || "").split("|")[0].trim(),
};

// ── Summary ─────────────────────────────────────────────────────────────────
const summary = (sections.summary || []).join(" ").replace(/\s+/g, " ").trim();

// ── Skills: "Label: a, b, c" with wrapped continuation lines ───────────────
const skillGroups = [];
for (const l of sections.skills || []) {
  const m = l.match(/^([A-Za-z][A-Za-z /&-]{1,40}):\s*(.*)$/);
  if (m) skillGroups.push({ label: m[1].trim(), text: m[2] });
  else if (skillGroups.length) skillGroups[skillGroups.length - 1].text += " " + l.trim();
}
// Split on commas outside parentheses: "Stripe (subscriptions, metered billing)" stays whole.
const splitSkills = (s) => s.split(/,(?![^()]*\))/).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
for (const g of skillGroups) { g.skills = splitSkills(g.text); delete g.text; }
const skills = [...new Set(skillGroups.flatMap((g) => g.skills))];

// ── Experience / projects / education ───────────────────────────────────────
const DATE_TAIL = /^(.*?)((?:[A-Z][a-z]{2,8}\.? )?\d{4})\s*[–—-]\s*(Present|Current|(?:[A-Z][a-z]{2,8}\.? )?\d{4})$/;
// "Senior Software EngineerSan Jose, California": the title and the place are
// glued, so the place is the trailing run of Capitalized words + ", State".
// Each word must be Capital+lowercase so "EngineerSan" cannot start a city.
const LOCATION_TAIL = /(Remote(?: [-–] [A-Za-z ]+)?|Hybrid|[A-Z][a-z.]+(?: [A-Z][a-z.]+)*, (?:[A-Z]{2}|[A-Z][a-z]+(?: [A-Z][a-z]+)*))$/;
// "…Platformgithub.com/akash-ramasani/job-watch": a known host first, else a
// bare domain that is not glued to a letter.
const linkTail = (s) => s.match(/(?:https?:\/\/)?(?:github|gitlab|bitbucket)\.com\/\S+$/) || s.match(/(?<![A-Za-z0-9.-])(?:https?:\/\/)?[a-z0-9-]+\.(?:dev|io|app|ai|me|org|com)(?:\/\S*)?$/);
const isBullet = (l) => /^\s*[–—•-]\s+/.test(l);
const stripBullet = (l) => l.replace(/^\s*[–—•-]\s+/, "").trim();

/** Group a section into entries: a header line (not a bullet) starts an entry,
 *  extra non-bullet lines before the first bullet are header lines too,
 *  bullets attach to the entry, wrapped bullet text is joined. */
function entries(sectionLines, isHeader) {
  const out = [];
  let e = null;
  for (const l of sectionLines || []) {
    if (!e || (!isBullet(l) && isHeader(l, e))) { e = { heads: [l.trim()], bullets: [] }; out.push(e); continue; }
    if (isBullet(l)) e.bullets.push(stripBullet(l));
    else if (e.bullets.length) e.bullets[e.bullets.length - 1] += " " + l.trim();
    else e.heads.push(l.trim());
  }
  return out;
}

const roles = entries(sections.experience, (l) => DATE_TAIL.test(l.trim())).map((e) => {
  const d = e.heads[0].match(DATE_TAIL) || [];
  const tl = (e.heads[1] || "").match(LOCATION_TAIL);
  return {
    company: (d[1] || e.heads[0]).trim(), startDate: d[2] || "", endDate: d[3] || "",
    title: tl ? e.heads[1].slice(0, tl.index).trim() : (e.heads[1] || ""), location: tl ? tl[1] : "",
    description: e.bullets.map((b) => b.replace(/\s+/g, " ")).join("\n"),
  };
});
// A project header is a non-bullet line after a finished bullet (ends in
// . ! or ?) that starts with a capital; anything else after a bullet is the
// bullet's wrapped text.
const startsNewEntry = (l, e) => e.bullets.length > 0 && /[.!?]$/.test(e.bullets[e.bullets.length - 1]) && /^[A-Z0-9]/.test(l.trim());
const projects = entries(sections.projects, startsNewEntry).map((e) => {
  const lm = linkTail(e.heads[0]);
  const url = lm ? lm[0] : "";
  return { name: lm ? e.heads[0].slice(0, lm.index).trim() : e.heads[0], link: url ? (/^https?:/.test(url) ? url : `https://${url}`) : "", techStack: "", description: e.bullets.map((b) => b.replace(/\s+/g, " ")).join("\n") };
});
const education = [];
const edu = sections.education || [];
for (let i = 0; i < edu.length; i += 2) {
  const tl = (edu[i + 1] || "").match(LOCATION_TAIL);
  education.push({ institution: edu[i].trim(), degree: tl ? edu[i + 1].slice(0, tl.index).trim() : (edu[i + 1] || "").trim(), location: tl ? tl[1] : "", startDate: "", endDate: "", description: "" });
}
const certifications = (sections.certifications || []).map(stripBullet).filter(Boolean);

const profile = { header, summary, skills, skillGroups, roles, projects, education, certifications, rawText: text.slice(0, 5000), fileName: path.basename(file), source: "pdf-import" };

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`name: ${header.name}\ncontact: ${[header.location, header.phone, header.email, header.github, header.linkedin].filter(Boolean).join(" | ")}`);
console.log(`summary: ${summary.slice(0, 110)}…`);
console.log(`skill groups: ${skillGroups.length} (${skills.length} skills)`);
skillGroups.forEach((g) => console.log(`  ${g.label}: ${g.skills.length} — ${g.skills.slice(0, 4).join(", ")}…`));
console.log(`roles: ${roles.length}`);
roles.forEach((r) => console.log(`  ${r.title} @ ${r.company} | ${r.startDate} – ${r.endDate} | ${r.location} | ${r.description.split("\n").filter(Boolean).length} bullets`));
console.log(`projects: ${projects.length}`);
projects.forEach((p) => console.log(`  ${p.name} | ${p.link || "-"} | ${p.description.split("\n").filter(Boolean).length} bullets`));
console.log(`education: ${education.length}`);
education.forEach((e) => console.log(`  ${e.degree} @ ${e.institution} | ${e.location}`));
console.log(`certifications: ${certifications.length}`);
const problems = [];
if (!header.name || !header.email) problems.push("header missing name or email");
if (roles.some((r) => !r.title || !r.company || !r.startDate)) problems.push("a role is missing title, company or dates");
if (!roles.length || !skillGroups.length || !summary) problems.push("a main section is empty");
if (problems.length) { console.error("\nPARSE PROBLEMS: " + problems.join("; ") + "\nNothing written."); process.exit(1); }

if (dryRun) { console.log("\n--dry-run: nothing written"); process.exit(0); }

// ── Write ───────────────────────────────────────────────────────────────────
const firestore = await db();
let uid = ADMIN_UID;
if (arg("--user")) uid = (await getAuth().getUserByEmail(arg("--user"))).uid;
const userRef = firestore.collection("users").doc(uid);
const profileRef = userRef.collection("resume").doc("profile");
const [userSnap, existingSnap] = await Promise.all([userRef.get(), profileRef.get()]);
const user = userSnap.data() || {};
const existing = existingSnap.data() || {};

// Storage: same object path; keep the existing download token so the saved URL stays valid.
const storagePath = `resumes/${uid}/resume.pdf`;
const fileRef = (await bucket()).file(storagePath);
let token = (String(user.resumeUrl || existing.resumeUrl || "").match(/[?&]token=([0-9a-f-]{36})/) || [])[1];
if (!token) { try { token = (await fileRef.getMetadata())[0]?.metadata?.firebaseStorageDownloadTokens?.split(",")[0]; } catch (_) { /* new file */ } }
if (!token) token = require("crypto").randomUUID();
await fileRef.save(buf, { metadata: { contentType: "application/pdf", metadata: { firebaseStorageDownloadTokens: token } }, resumable: false });
const resumeUrl = `https://firebasestorage.googleapis.com/v0/b/${(await bucket()).name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;

await profileRef.set(
  { ...profile, extraExperience: existing.extraExperience || "", resumeUrl, updatedAt: FieldValue.serverTimestamp(), savedAt: FieldValue.serverTimestamp() },
  { merge: false }
);
await userRef.set({ resumeUrl, resumeFileName: profile.fileName, resumeUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
console.log(`\nuploaded ${storagePath} (${buf.length} bytes) and wrote users/${uid}/resume/profile + user doc mirror\n${resumeUrl}`);
process.exit(0);
