// greenhouse.mjs
//
// Thin client for Greenhouse's PUBLIC job board API. Reading application forms
// is fully public and unauthenticated. Submission is intentionally NOT
// implemented here yet — see submit() — because it must be gated behind the
// 4-pass verifier and tested carefully against a real board before we trust it.

const BASE = "https://boards-api.greenhouse.io/v1/boards";

/** Parse a Greenhouse job URL into { token, id }.
 *  Handles both job-boards.greenhouse.io/{token}/jobs/{id} and
 *  boards.greenhouse.io/{token}/jobs/{id}. */
export function parseGreenhouseUrl(url) {
  const m = String(url).match(/greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
  if (!m) return null;
  return { token: m[1], id: m[2] };
}

/** List jobs for a board token (used for discovery/testing). */
export async function listJobs(token) {
  const res = await fetch(`${BASE}/${token}/jobs`);
  if (!res.ok) throw new Error(`Greenhouse list ${token} → ${res.status}`);
  const data = await res.json();
  return data.jobs || [];
}

/** Fetch a single job WITH its application questions (the form schema). */
export async function fetchForm(token, id) {
  const res = await fetch(`${BASE}/${token}/jobs/${id}?questions=true`);
  if (!res.ok) throw new Error(`Greenhouse job ${token}/${id} → ${res.status}`);
  const data = await res.json();
  return {
    token,
    id,
    title: data.title,
    url: data.absolute_url,
    location: data.location?.name || "",
    descriptionHtml: data.content || "",
    questions: data.questions || [],
  };
}

/** SUBMIT — deliberately not wired yet.
 *  Greenhouse accepts POST {BASE}/{token}/jobs/{id} with multipart form data,
 *  but (a) some boards disable direct submission, (b) it needs the resume/cover
 *  files uploaded, and (c) it must run ONLY after verifyFourTimes() passes.
 *  We implement this in the next phase, behind an explicit --submit flag and a
 *  single real-board test, so we never accidentally send a bad application. */
export async function submit() {
  throw new Error("submit() not implemented — dry-run only until the 4-pass gate is field-tested");
}
