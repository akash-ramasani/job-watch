// dedup.mjs
//
// Two guarantees:
//   1. Re-apply window: a job is eligible again if it was last applied to more
//      than RE_APPLY_HOURS ago (default 24h). A permanent "applied" flag is NOT
//      used, because you asked to re-apply when a posting returns after a day.
//   2. Never miss: selectEligible() returns EVERY job that qualifies, with no
//      cap, sampling, or truncation. The caller must process all of them.

export const RE_APPLY_HOURS = 24;

/** Read a timestamp off a job's apply record. Accepts a JS Date, epoch ms,
 *  ISO string, or a Firestore Timestamp ({seconds}). Returns epoch ms or null. */
export function toMillis(v) {
  if (!v) return null;
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v.seconds === "number") return v.seconds * 1000;
  return null;
}

/** Is this job eligible to apply right now?
 *  Eligible if: never applied, OR last applied more than RE_APPLY_HOURS ago. */
export function isEligible(job, now = Date.now(), reApplyHours = RE_APPLY_HOURS) {
  const last = toMillis(job.lastAppliedAt || job.appliedAt);
  if (last == null) return true; // never applied
  return now - last >= reApplyHours * 3600_000;
}

/** Select every eligible job. No cap. Preserves input order so nothing is
 *  silently dropped. Also de-duplicates jobs that appear twice in one batch by
 *  a stable key, keeping the first occurrence. */
export function selectEligible(jobs, { now = Date.now(), reApplyHours = RE_APPLY_HOURS, minScore = null } = {}) {
  const seen = new Set();
  const eligible = [];
  const skipped = [];
  for (const job of jobs) {
    const key = jobKey(job);
    if (seen.has(key)) continue;
    seen.add(key);
    if (minScore != null && typeof job.relevanceScore === "number" && job.relevanceScore < minScore) {
      skipped.push({ key, reason: `score ${job.relevanceScore} < ${minScore}` });
      continue;
    }
    if (isEligible(job, now, reApplyHours)) eligible.push(job);
    else skipped.push({ key, reason: "applied within re-apply window" });
  }
  // Return everything; the caller logs skipped so nothing is hidden.
  return { eligible, skipped, total: jobs.length };
}

/** Stable identity for a posting across re-appearances. Prefer the ATS external
 *  id + company; fall back to the apply URL. */
export function jobKey(job) {
  const ext = job.externalId || job.id || "";
  const co = job.companyKey || job.companyName || job.source || "";
  if (ext) return `${co}:${ext}`.toLowerCase();
  return String(job.jobUrl || job.applyUrl || job.absolute_url || JSON.stringify(job)).toLowerCase();
}
