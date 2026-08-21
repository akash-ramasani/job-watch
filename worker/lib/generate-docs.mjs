// generate-docs.mjs — produce a tailored resume PDF and a cover letter PDF for
// one job, from the user's Firestore profile + parsed resume. Returns file paths.
// Falls back to the untailored resume content if the AI tailoring fails, so a
// job never blocks on doc generation.

import { coverLetter, tailorResume } from "./ai.mjs";
import { renderResume, renderCoverLetter } from "./pdf.mjs";
import { contactFromProfile, sentencesFrom } from "./profile-util.mjs";
import { downloadResume } from "./firestore.mjs";

/** Build the AI context object from profile + resume + job. */
function buildContext(profile, resume, job) {
  const roles = resume.roles || resume.experience || [];
  return {
    name: profile.fullName || `${profile.firstName || ""} ${profile.lastName || ""}`.trim(),
    currentTitle: roles[0]?.title || roles[0]?.role || "",
    experience: roles.slice(0, 3).map((r) => `${r.title || r.role} at ${r.company || r.employer}`).join("; "),
    skills: (resume.skills || []).slice(0, 20).join(", "),
    allSkills: (resume.skills || []).join(", "),
    summary: resume.summary || "",
    bullets: roles.flatMap((r) => r.bullets || r.highlights || [String(r.description || "").slice(0, 160)]).filter(Boolean).slice(0, 12),
    jobTitle: job.title,
    companyName: job.companyName || job.company || "",
    jobDescription: (job.descriptionPlain || job.descriptionHtml || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  };
}

/** Generate both documents. outDir must exist. Returns { resumePath, coverPath }.
 *  Default (useRealResume=true): attach the user's REAL uploaded resume, no
 *  fabrication risk. Only the cover letter is generated. Set useRealResume=false
 *  to also produce an AI-tailored resume (may embellish; needs review). */
export async function generateApplicationDocs(profile, resume, job, outDir, { useRealResume = true } = {}) {
  const ctx = buildContext(profile, resume, job);
  const contact = contactFromProfile(profile);
  const roles = resume.roles || resume.experience || [];
  const safe = (job.title || "job").replace(/[^a-z0-9]+/gi, "-").slice(0, 40);

  // Cover letter (always AI, always sanitized, never invents facts).
  const clText = await coverLetter(ctx);
  const coverPath = `${outDir}/cover-${safe}.pdf`;
  await renderCoverLetter(clText, { name: ctx.name, contact, companyName: ctx.companyName, jobTitle: ctx.jobTitle }, coverPath);

  // Resume: use the real uploaded PDF as-is (recommended, zero fabrication).
  if (useRealResume) {
    const realPath = `${outDir}/resume-real.pdf`;
    const got = await downloadResume(realPath).catch(() => null);
    return { resumePath: got, coverPath, tailored: false, coverText: clText };
  }

  // Otherwise, AI-tailored resume with a safe fallback to untailored real content.
  let tr = null;
  try { tr = await tailorResume(ctx); } catch { tr = null; }
  const resumeData = {
    name: ctx.name,
    contact,
    summary: tr?.summary || resume.summary || "",
    skills: (tr?.skills?.length ? tr.skills : (resume.skills || []).slice(0, 14)),
    roles: roles.slice(0, 4).map((r, i) => ({
      title: r.title || r.role || "",
      company: r.company || r.employer || "",
      dates: [r.startDate, r.endDate || "present"].filter(Boolean).join(" to "),
      bullets: i === 0 && tr?.bullets?.length
        ? tr.bullets
        : (r.bullets || r.highlights || sentencesFrom(r.description, 3)).filter(Boolean).slice(0, 4),
    })),
  };
  const resumePath = `${outDir}/resume-${safe}.pdf`;
  await renderResume(resumeData, resumePath);

  return { resumePath, coverPath, tailored: !!tr, coverText: clText };
}
