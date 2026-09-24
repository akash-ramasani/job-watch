#!/usr/bin/env node
// import-latex-resume.mjs — import a resume written in the JobWatch LaTeX
// template (\resumeSubheading / \resumeItem / \resumeProjectHeading …) into
// users/{ADMIN_UID}/resume/profile as the master profile the tailored-resume
// generator draws from. Keeps bullets, grouped skills, locations, project
// links and the header block, so the generator has the full detail.
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

// ── LaTeX → plain text ───────────────────────────────────────────────────────
function unbrace(s) {
  // Strip one level of wrapping macros/braces: \textbf{x} → x, \underline{x} → x
  let prev;
  do {
    prev = s;
    s = s.replace(/\\(?:textbf|textit|underline|small|scshape|LARGE)\s*\{([^{}]*)\}/g, "$1");
  } while (s !== prev);
  return s;
}
function plain(s) {
  return unbrace(String(s || ""))
    .replace(/\\href\{[^}]*\}\{([^{}]*)\}/g, "$1")
    .replace(/\\&/g, "&").replace(/\\%/g, "%").replace(/\\\$/g, "$").replace(/\\#/g, "#").replace(/\\_/g, "_")
    .replace(/---/g, "—").replace(/--/g, "–")
    .replace(/\\\\/g, " ").replace(/\\vspace\{[^}]*\}/g, "").replace(/\$\|\$/g, "|")
    .replace(/\\[a-zA-Z]+\s*/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Read balanced {…} groups following a position in the text.
function readGroups(src, from, count) {
  const out = [];
  let i = from;
  for (let g = 0; g < count; g++) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== "{") break;
    let depth = 0;
    let start = i;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
    }
    out.push(src.slice(start + 1, i - 1));
  }
  return { groups: out, end: i };
}

// ── Sections ────────────────────────────────────────────────────────────────
// Drop LaTeX comments (unescaped % to end of line) before parsing.
const body = tex
  .slice(tex.indexOf("\\begin{document}"))
  .replace(/(^|[^\\])%[^\n]*/g, "$1");
const sectionRe = /\\section\{([^}]*)\}/g;
const sections = [];
let m;
while ((m = sectionRe.exec(body))) sections.push({ name: m[1], start: m.index + m[0].length });
const sectionText = (name) => {
  const i = sections.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
  if (i === -1) return "";
  return body.slice(sections[i].start, i + 1 < sections.length ? sections[i + 1].start - 9 : body.indexOf("\\end{document}"));
};

// Header block: name + contact line
const headerBlock = body.slice(body.indexOf("\\begin{center}") + "\\begin{center}".length, body.indexOf("\\end{center}"));
const name = plain((headerBlock.match(/\\scshape\s+([^}]*)\}/) || [])[1] || "");
const contactLine = plain(headerBlock.replace(/\\textbf\{\\LARGE[^}]*\}\s*\}/, ""));
const contactParts = contactLine.replace(name, "").split("|").map((s) => s.trim()).filter(Boolean);
const header = { name, contact: contactParts };
for (const c of contactParts) {
  if (/@/.test(c)) header.email = c;
  else if (/^\+?[\d\s()-]{7,}$/.test(c)) header.phone = c;
  else if (/github\.com/.test(c)) header.github = c;
  else if (/linkedin\.com/.test(c)) header.linkedin = c;
  else if (!header.location) header.location = c;
}

const summary = plain(sectionText("Profile"));

// Skills: \resumeItem{\textbf{Label:} a, b, c}
const skillGroups = [];
const skillsSrc = sectionText("Skills");
let pos = 0;
while ((pos = skillsSrc.indexOf("\\resumeItem", pos)) !== -1) {
  const { groups, end } = readGroups(skillsSrc, pos + "\\resumeItem".length, 1);
  pos = end;
  const raw = groups[0] || "";
  const lm = raw.match(/\\textbf\{([^}]*):\}\s*(.*)$/s);
  if (!lm) continue;
  skillGroups.push({ label: plain(lm[1]), skills: plain(lm[2]).split(/,\s*(?![^()]*\))/).map((s) => s.trim()).filter(Boolean) });
}
const skills = [...new Set(skillGroups.flatMap((g) => g.skills))];

// Experience / Education: \resumeSubheading{a}{b}{c}{d} followed by \resumeItem bullets
function parseSubheadings(src, kind) {
  const out = [];
  let p = 0;
  while ((p = src.indexOf("\\resumeSubheading", p)) !== -1) {
    const { groups, end } = readGroups(src, p + "\\resumeSubheading".length, 4);
    const next = src.indexOf("\\resumeSubheading", end);
    const block = src.slice(end, next === -1 ? src.length : next);
    const bullets = [];
    let q = 0;
    while ((q = block.indexOf("\\resumeItem", q)) !== -1) {
      const r = readGroups(block, q + "\\resumeItem".length, 1);
      q = r.end;
      const b = plain(r.groups[0]);
      if (b) bullets.push(b);
    }
    const [g1, g2, g3, g4] = groups.map(plain);
    const [startDate, endDate] = (g2 || "").split(/\s*[–—-]+\s*/).map((s) => s.trim());
    if (kind === "role") {
      out.push({ company: g1, startDate: startDate || "", endDate: endDate || "", title: g3, location: g4, description: bullets.join("\n") });
    } else {
      out.push({ institution: g1, startDate: startDate || "", endDate: endDate || "", degree: g3, location: g4, description: bullets.join("\n") });
    }
    p = end;
  }
  return out;
}
const roles = parseSubheadings(sectionText("Professional Experience"), "role");
const education = parseSubheadings(sectionText("Education"), "edu");

// Projects: \resumeProjectHeading{name}{link}
const projects = [];
{
  const src = sectionText("Selected Projects");
  let p = 0;
  while ((p = src.indexOf("\\resumeProjectHeading", p)) !== -1) {
    const { groups, end } = readGroups(src, p + "\\resumeProjectHeading".length, 2);
    const next = src.indexOf("\\resumeProjectHeading", end);
    const block = src.slice(end, next === -1 ? src.length : next);
    const bullets = [];
    let q = 0;
    while ((q = block.indexOf("\\resumeItem", q)) !== -1) {
      const r = readGroups(block, q + "\\resumeItem".length, 1);
      q = r.end;
      const b = plain(r.groups[0]);
      if (b) bullets.push(b);
    }
    const linkMatch = (groups[1] || "").match(/\\href\{([^}]*)\}/);
    projects.push({ name: plain(groups[0]), link: linkMatch ? linkMatch[1] : "", techStack: "", description: bullets.join("\n") });
    p = end;
  }
}

const rawText = [
  name, contactParts.join(" | "), "", "PROFILE", summary, "", "SKILLS",
  ...skillGroups.map((g) => `${g.label}: ${g.skills.join(", ")}`), "", "EXPERIENCE",
  ...roles.flatMap((r) => [`${r.title} — ${r.company} (${r.startDate} – ${r.endDate}, ${r.location})`, ...r.description.split("\n").map((b) => `• ${b}`), ""]),
  "PROJECTS",
  ...projects.flatMap((p) => [`${p.name}${p.link ? ` (${p.link})` : ""}`, ...p.description.split("\n").map((b) => `• ${b}`), ""]),
  "EDUCATION",
  ...education.map((e) => `${e.degree} — ${e.institution} (${e.location})`),
].join("\n");

const profile = { header, summary, skills, skillGroups, roles, projects, education, certifications: [], rawText, fileName: path.basename(file), source: "latex-import" };

console.log(`name: ${name}\ncontact: ${contactParts.join(" | ")}\nsummary: ${summary.slice(0, 90)}…`);
console.log(`skill groups: ${skillGroups.length} (${skills.length} skills)`);
skillGroups.forEach((g) => console.log(`  ${g.label}: ${g.skills.length}`));
console.log(`roles: ${roles.length}`);
roles.forEach((r) => console.log(`  ${r.title} @ ${r.company} | ${r.startDate} – ${r.endDate} | ${r.location} | ${r.description.split("\n").length} bullets`));
console.log(`projects: ${projects.length}`);
projects.forEach((p) => console.log(`  ${p.name} | ${p.link || "-"} | ${p.description.split("\n").length} bullets`));
console.log(`education: ${education.length}`);
education.forEach((e) => console.log(`  ${e.degree} @ ${e.institution} | ${e.location}`));

if (dryRun) {
  console.log("\n--dry-run: nothing written");
  process.exit(0);
}
const firestore = await db();
const ref = firestore.collection("users").doc(ADMIN_UID).collection("resume").doc("profile");
const existing = (await ref.get()).data() || {};
await ref.set({ ...profile, extraExperience: existing.extraExperience || "", resumeUrl: existing.resumeUrl || null, updatedAt: FieldValue.serverTimestamp(), savedAt: FieldValue.serverTimestamp() }, { merge: false });
console.log("\nwritten to users/{ADMIN_UID}/resume/profile");
process.exit(0);
