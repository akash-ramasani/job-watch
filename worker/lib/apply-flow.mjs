// apply-flow.mjs — the per-job pipeline for Greenhouse.
// Given a fetched form + profile + resume, it:
//   1. generates the tailored resume + cover letter PDFs,
//   2. answers any free-text questions with AI (two-pass, so mapForm stays sync),
//   3. maps every answer (compliance from profile only),
//   4. runs the 4-pass verifier,
// and returns a decision plus everything needed to submit later.
// It does NOT submit.

import { mapForm, SOURCE } from "./answer-engine.mjs";
import { verifyFourTimes } from "./verify.mjs";
import { answerFreeText } from "./ai.mjs";
import { generateApplicationDocs } from "./generate-docs.mjs";

/** Build the AI context used for free-text answers + docs. */
function aiContext(profile, resume, job) {
  const roles = resume.roles || resume.experience || [];
  return {
    name: profile.fullName || `${profile.firstName || ""} ${profile.lastName || ""}`.trim(),
    currentTitle: roles[0]?.title || roles[0]?.role || "",
    skills: (resume.skills || []).slice(0, 20).join(", "),
    summary: resume.summary || "",
    jobTitle: job.title,
    companyName: job.companyName || "",
  };
}

/** Run the full pipeline for one job. Returns:
 *  { ready, mapped, verdict, docs, coverText } */
export async function runApplyFlow(profile, resume, job, outDir, { generateDocs = true } = {}) {
  // 1. Tailored documents (resume + cover letter PDFs).
  let docs = null;
  if (generateDocs) {
    docs = await generateApplicationDocs(profile, resume, { ...job }, outDir);
  }
  // The resume field maps to the freshly tailored PDF.
  const profileForJob = { ...profile, resumePath: docs?.resumePath || profile.resumePath || "" };

  const questions = job.questions || [];

  // 2. First pass with no AI to discover which required questions are free-text.
  const firstPass = mapForm(questions, profileForJob, null);
  const needAi = firstPass.answers.filter(
    (a) => a.required && a.answers.length === 0 && /free-text needs AI/i.test(a.note)
  );

  // 3. Answer those with AI (in parallel), building a label -> answer cache.
  const ctx = aiContext(profile, resume, job);
  const cache = new Map();
  await Promise.all(
    needAi.map(async (a) => {
      try {
        const ans = await answerFreeText(a.label, ctx);
        if (ans) cache.set(a.label, ans);
      } catch { /* leave unanswered -> parks for review */ }
    })
  );

  // 4. Second pass with the AI cache.
  const mapped = mapForm(questions, profileForJob, { get: (label) => cache.get(label) });

  // 5. Verify four times.
  const verdict = verifyFourTimes(mapped, questions, profileForJob);

  return { ready: verdict.ok, mapped, verdict, docs, coverText: docs?.coverText || "" };
}

export { SOURCE };
