// save-tailored-resume.mjs — read-only: save the tailored resume JobWatch
// uploaded for a job as a PDF on the Desktop.
//   node worker/save-tailored-resume.mjs "Akash_Ramasani_Resume_Senior_Software_Engineer_AI_Compute_Together_Cloud.pdf"
//   node worker/save-tailored-resume.mjs "together"            # any words of the file name, title or company
// Finds the job among the person's applications (users/{uid}/applications),
// reads its tailored resume (users/{uid}/tailoredResumes/{jobId}, the one the
// extension typeset and uploaded), builds the same LaTeX and compiles it with
// the local tectonic. Writes nothing to Firestore.
import { createRequire } from "node:module";
import { mkdtemp, writeFile, readFile, copyFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { db as getDb, ADMIN_UID } from "./lib/firestore.mjs";
import { buildResumeLatex } from "../functions/lib/resumeLatex.mjs";

const require = createRequire(import.meta.url);
const { resumeFileName } = require("../functions/lib/apply/autoApply.cjs");

const query = (process.argv[2] || "").replace(/\.pdf$/i, "");
if (!query) { console.log('Usage: node worker/save-tailored-resume.mjs "<file name or words of the job title>"'); process.exit(1); }
const words = query.replace(/^.*?_Resume_/i, "").split(/[_\s,]+/).filter((w) => w.length > 1).map((w) => w.toLowerCase());

const db = await getDb();
const user = db.collection("users").doc(ADMIN_UID);
const u = (await user.get()).data() || {};
const name = u.fullName || `${u.firstName || ""} ${u.lastName || ""}`.trim();

// The applications whose company + title hold every word, newest first.
const apps = (await user.collection("applications").get()).docs.map((d) => ({ id: d.id, ...d.data() }))
  .filter((a) => a.jobId)
  .map((a) => ({ a, text: `${a.companyName || ""} ${a.jobTitle || a.title || ""} ${resumeFileName(name, a.jobTitle || a.title || "")}`.toLowerCase() }))
  .filter(({ text }) => words.every((w) => text.includes(w)))
  .sort((x, y) => (y.a.updatedAt?.toMillis?.() || 0) - (x.a.updatedAt?.toMillis?.() || 0));
if (!apps.length) { console.log(`No application matches "${query}".`); process.exit(1); }
if (apps.length > 1) console.log(`${apps.length} match; saving the newest. Others:`, apps.slice(1, 6).map(({ a }) => `${a.companyName} · ${a.jobTitle || a.title}`).join(" | "));
const app = apps[0].a;

const cached = await user.collection("tailoredResumes").doc(String(app.jobId)).get();
const resume = cached.exists ? cached.data()?.resume : null;
if (!resume) { console.log(`No tailored resume is stored for ${app.companyName} · ${app.jobTitle || app.title} (job ${app.jobId}).`); process.exit(1); }

const contact = { name, location: u.city || "", phone: u.phone || "", email: u.email || "", github: u.github || "", linkedin: u.linkedin || "" };
const tex = buildResumeLatex(resume, contact);
const dir = await mkdtemp(path.join(os.tmpdir(), "jw-resume-"));
await writeFile(path.join(dir, "resume.tex"), tex, "utf8");
const r = spawnSync("tectonic", ["--untrusted", "--chatter", "minimal", "-o", dir, path.join(dir, "resume.tex")], { encoding: "utf8" });
const fileName = resumeFileName(resume.header?.name || name, app.jobTitle || app.title || "");
const out = path.join(os.homedir(), "Desktop", fileName);
if (r.status !== 0) {
  await copyFile(path.join(dir, "resume.tex"), out.replace(/\.pdf$/, ".tex"));
  console.log("tectonic could not compile it; saved the LaTeX instead:", out.replace(/\.pdf$/, ".tex"), "\n", (r.stderr || "").slice(-600));
  process.exit(1);
}
await writeFile(out, await readFile(path.join(dir, "resume.pdf")));
console.log(`Saved: ${out}\n(${app.companyName} · ${app.jobTitle || app.title}, job ${app.jobId})`);
process.exit(0);
