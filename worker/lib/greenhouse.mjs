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

/** Parse the board token from a stored feed URL, e.g.
 *  https://boards-api.greenhouse.io/v1/boards/sidlee/jobs?content=true -> "sidlee". */
export function parseBoardToken(feedUrl) {
  const m = String(feedUrl || "").match(/\/boards\/([^/?]+)\/jobs/);
  return m ? m[1] : null;
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

/** Submit an application to Greenhouse.
 *  POSTs multipart/form-data to {BASE}/{token}/jobs/{id}.
 *  - answers: the mapped answers array (each { answers: [{name,value,isFile}] }).
 *  - resumePath / coverPath: local PDF paths to attach.
 *  MUST only be called after verifyFourTimes() passes.
 *
 *  Note: some boards require the company's Job Board API key (HTTP 401/403). If
 *  that happens, this returns ok:false with the status so the caller can fall
 *  back to the browser form. We attempt the public submission (no key) first. */
export async function submit({ token, id, answers, resumePath, coverPath }) {
  const { readFile } = await import("node:fs/promises");
  const fd = new FormData();

  for (const a of answers) {
    for (const ans of a.answers) {
      if (ans.isFile) continue; // files attached below
      if (ans.value == null || ans.value === "") continue;
      fd.append(ans.name, String(ans.value));
    }
  }
  if (resumePath) {
    const buf = await readFile(resumePath);
    fd.append("resume", new Blob([buf], { type: "application/pdf" }), "resume.pdf");
  }
  if (coverPath) {
    const buf = await readFile(coverPath);
    fd.append("cover_letter", new Blob([buf], { type: "application/pdf" }), "cover_letter.pdf");
  }

  const res = await fetch(`${BASE}/${token}/jobs/${id}`, { method: "POST", body: fd });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body: body.slice(0, 500) };
}
