// postings.mjs — a ledger record's posting on its board: still open, its
// description and form questions (for eligibility), and the link to apply.
// Shared by scripts/clear-needs-attention.mjs and scripts/apply-top-matches.mjs.
import { createRequire } from "node:module";
const require = createRequire(new URL("../../functions/index.js", import.meta.url));
const { workdayPostingApi } = require("./lib/apply/generic.cjs");
const { formEligibility } = require("./lib/eligibility.cjs");

export const applyUrlOf = (a, id) => {
  const [source, org, posting] = (a.formKey || id).split("|");
  if (source === "greenhouse" && org && posting) return `https://job-boards.greenhouse.io/embed/job_app?for=${org}&token=${posting}`;
  if (source === "ashby" && org && posting) return `https://jobs.ashbyhq.com/${org}/${posting}/application`;
  if (source === "lever" && org && posting) return `https://jobs.lever.co/${org}/${posting}/apply`;
  if (source === "workday") {
    const m = String(a.jobUrl || "").match(/^(https:\/\/[^?#]*?_[A-Za-z0-9-]+)(?:\/apply(?:\/[^?#]*)?)?\/?(?:[?#].*)?$/);
    return m ? `${m[1]}/apply/applyManually` : "";
  }
  return a.jobUrl || "";
};

// Is the posting still open, and its description (for the eligibility check)?
const ashbyBoards = new Map();
const unhtml = (h) => String(h || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/<\/(p|li|div|h\d)>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
export async function posting(a, id) {
  const [source, org, post] = (a.formKey || id).split("|");
  try {
    if (source === "greenhouse") {
      const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${org}/jobs/${post}?questions=true`);
      if (!r.ok) return { open: false };
      const j = await r.json();
      // The form's own required questions (lib/eligibility.cjs formEligibility).
      const formCitizen = formEligibility(j.questions).length > 0;
      return { open: true, desc: unhtml(j.content), formCitizen };
    }
    if (source === "lever") {
      const r = await fetch(`https://api.lever.co/v0/postings/${org}/${post}`);
      if (!r.ok) return { open: false };
      const j = await r.json();
      return { open: true, desc: [j.descriptionPlain, ...(j.lists || []).map((l) => `${l.text}\n${unhtml(l.content)}`), j.additionalPlain].filter(Boolean).join("\n") };
    }
    if (source === "ashby") {
      if (!ashbyBoards.has(org)) {
        const r = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${org}`);
        ashbyBoards.set(org, r.ok ? new Map(((await r.json()).jobs || []).map((j) => [String(j.id), j])) : null);
      }
      const jobs = ashbyBoards.get(org);
      if (!jobs) return { open: null };
      const j = jobs.get(String(post));
      return j ? { open: true, desc: j.descriptionPlain || unhtml(j.descriptionHtml) } : { open: false };
    }
    if (source === "workday") {
      const api = workdayPostingApi(a.jobUrl);
      if (!api) return { open: null };
      const r = await fetch(api.url, { headers: { accept: "application/json" } });
      if (r.status === 404 || r.status === 410) return { open: false };
      if (!r.ok) return { open: null };
      const j = await r.json().catch(() => null);
      return j?.jobPostingInfo ? { open: j.jobPostingInfo.canApply !== false, desc: unhtml(j.jobPostingInfo.jobDescription) } : { open: false };
    }
  } catch { return { open: null }; }
  return { open: null };
}

