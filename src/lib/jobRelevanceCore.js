// Pure relevance check (no Firebase), shared by the app and scripts. See jobRelevance.js.

/**
 * @param {{ fam?: string[] }} job  entry from recentJobs/allJobs
 * @param {object|undefined} score  the user's rollup entry for this job (myJobScores.scores[id])
 * @param {string[]|null} jobTypes  the user's job types; null/empty = unknown (show everything)
 * @param {{ needsSponsorship?: boolean }} [opts]  from the user's profile
 */
export function isRelatedJob(job, score, jobTypes, { needsSponsorship = false } = {}) {
  // Needs visa sponsorship: jobs that require US citizenship or a security
  // clearance, or say they won't sponsor (flags `el`, see functions/lib/eligibility.cjs).
  if (needsSponsorship && Array.isArray(job?.el) && job.el.length) return false;
  if (score?.o) return false;
  if (score && score.t !== undefined && score.m !== "r") return false; // skipped as another type
  if (score?.k) return true; // scored by the current AI or rule method: judged related
  if (!jobTypes || jobTypes.length === 0) return true;
  const fam = Array.isArray(job?.fam) ? job.fam : null;
  if (!fam || fam.length === 0) return true; // type can't be told from the title
  return fam.some((f) => jobTypes.includes(f));
}

