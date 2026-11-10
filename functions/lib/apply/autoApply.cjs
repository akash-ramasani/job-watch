// autoApply.cjs — the queue behind the extension's unattended auto-apply.
//
// Every Ashby, Greenhouse, Lever and Workday job on the person's Jobs page (the same
// "related" rule the page uses: job types, AI/rule verdicts, visa
// eligibility), newest day first and the best match first within a day, minus every job already applied to (by job id,
// form key and company+title). Only matching jobs: a fit score of at least
// MIN_SCORE (Partial Match on the Jobs page; settings/preferences.autoApplyMinScore
// changes it, 0 takes every job), each sent with its tailored resume
// (2026-11-03). No daily cap. Each entry carries the URL the runner opens: the
// Ashby or Lever application page, or Greenhouse's own embedded form (a company's
// careers site may wrap it in an iframe the runner cannot drive), or Workday's
// "Apply Manually" page (2026-11-10: Workday signs in or makes the account with
// the password saved in the extension, fills each step and stops at Review).

const { createAssistantContext, isRelatedJob } = require("../assistantTools.cjs");
const { classifyTitle } = require("../jobFamilies.cjs");
const MIN_SCORE = 40; // "Partial Match" and up on the Jobs page
const ledger = require("./ledger.cjs");

const GH_SOURCES = new Set(["greenhouse"]);
const ASHBY_SOURCES = new Set(["ashby", "ashbyhq"]);
const LEVER_SOURCES = new Set(["lever"]);
const WORKDAY_SOURCES = new Set(["workday"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Board slug of a feed URL: boards-api.greenhouse.io/v1/boards/<token>/..., posting-api/job-board/<org>. */
function feedSlug(url) {
  const u = String(url || "");
  const gh = u.match(/greenhouse\.io\/v1\/boards\/([^/?#]+)/i) || u.match(/greenhouse\.io\/([^/?#]+)/i);
  if (gh && !/^(v1|embed)$/i.test(gh[1])) return { source: "greenhouse", slug: gh[1] };
  const ash = u.match(/ashbyhq\.com\/posting-api\/job-board\/([^/?#]+)/i) || u.match(/jobs\.ashbyhq\.com\/([^/?#]+)/i);
  if (ash) return { source: "ashby", slug: ash[1] };
  const lev = u.match(/api\.(eu\.)?lever\.co\/v0\/postings\/([^/?#]+)/i) || u.match(/jobs\.(eu\.)?lever\.co\/([^/?#]+)/i);
  if (lev) return { source: "lever", slug: decodeURIComponent(lev[2]), eu: !!lev[1] };
  return null;
}

/** The page the runner opens for a job, or "" when it cannot be built. */
function applyUrlFor(job, feedSlugs) {
  const src = String(job.source || "").toLowerCase();
  const url = String(job.jobUrl || "");
  const ext = String(job.externalId || "");
  if (ASHBY_SOURCES.has(src)) {
    const m = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/i);
    if (m) return `https://jobs.ashbyhq.com/${m[1]}/${m[2]}/application`;
    const org = feedSlugs.get(job.companyKey)?.slug;
    return org && /^[0-9a-f-]{36}$/i.test(ext) ? `https://jobs.ashbyhq.com/${org}/${ext}/application` : "";
  }
  if (LEVER_SOURCES.has(src)) {
    const m = url.match(/jobs\.(eu\.)?lever\.co\/([^/?#]+)\/([0-9a-f-]{36})/i);
    if (m) return `https://jobs.${m[1] ? "eu." : ""}lever.co/${m[2]}/${m[3].toLowerCase()}/apply`;
    const f = feedSlugs.get(job.companyKey);
    return f?.source === "lever" && UUID.test(ext) ? `https://jobs.${f.eu ? "eu." : ""}lever.co/${encodeURIComponent(f.slug)}/${ext.toLowerCase()}/apply` : "";
  }
  if (WORKDAY_SOURCES.has(src)) {
    // <tenant>.wdN.myworkdayjobs.com/[locale/]<site>/job/<loc>/<Title>_<Req>
    // (or wdN.myworkdaysite.com/recruiting/<tenant>/<site>/job/...): the posting
    // plus /apply/applyManually, which skips the "how to apply" choice.
    const m = url.match(/^(https:\/\/(?:[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com|wd\d+\.myworkdaysite\.com\/recruiting\/[^/?#]+)\/(?:[a-z]{2}-[A-Z]{2}\/)?[^/?#]+\/(?:job|details)\/[^?#]*?[^/?#]*_[A-Za-z0-9-]+)(?:\/apply(?:\/[^?#]*)?)?\/?(?:[?#].*)?$/i);
    return m ? `${m[1]}/apply/applyManually` : "";
  }
  if (GH_SOURCES.has(src)) {
    let token = feedSlugs.get(job.companyKey)?.slug || "";
    let id = ext;
    const m = url.match(/greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i);
    if (m && m[1] !== "embed") { token = token || m[1]; id = id || m[2]; }
    const q = url.match(/[?&]gh_jid=(\d+)/i);
    if (q) id = id || q[1];
    return token && /^\d+$/.test(id) ? `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(token)}&token=${id}` : "";
  }
  return "";
}

/** "Akash_Ramasani_Resume_Senior_Software_Engineer_Payments.pdf" */
function resumeFileName(fullName, jobTitle) {
  const part = (s, max) => String(s || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/\((?:[^)]*?\b(?:req|r-?\d|jr\d|id)\b[^)]*)\)/gi, " ") // "(Req 1234)"
    .replace(/\b(?:req(?:uisition)?\s*#?\s*\d+|jr\d+|r-?\d{4,})\b/gi, " ")
    .replace(/&/g, " and ").replace(/\+/g, " Plus ").replace(/#/g, " Sharp ")
    .replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean)
    .map((w) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w))
    .join("_").slice(0, max).replace(/_+$/, "");
  const name = part(fullName, 40) || "Resume";
  const title = part(jobTitle, 60);
  return `${name}_Resume${title ? `_${title}` : ""}.pdf`;
}

/**
 * The queue: [{ jobId, source, applyUrl, title,
 * companyName, externalId, locationName, postedAt }]; source is "ashby",
 * "greenhouse", "lever" or "workday".
 */
async function buildQueue(db, uid, { adminUid, limit = 2000, locationOk = null } = {}) {
  const ctx = createAssistantContext(db, uid, { adminUid });
  const aggs = db.collection("users").doc(adminUid).collection("aggregations");
  const [allSnap, recentSnap, feedsSnap, appsSnap, scores, jobTypes, sponsorship, prefs] = await Promise.all([
    aggs.doc("allJobs").get(),
    aggs.doc("recentJobs").get(),
    db.collection("users").doc(adminUid).collection("feeds").get(),
    db.collection("users").doc(uid).collection("applications").get(),
    ctx.scores(), ctx.jobTypes(), ctx.sponsorship(), ctx.prefs(),
  ]);
  // Companies the person hid on the Jobs page (settings/preferences.excludedCompanies).
  const minScore = Number.isFinite(Number(prefs?.autoApplyMinScore)) ? Number(prefs.autoApplyMinScore) : MIN_SCORE;
  // Boards auto-apply takes (settings/preferences.autoApplyBoards, e.g. ["workday"]
  // while Workday is being tested, 2026-11-10); unset or empty: every board.
  const boardsOn = new Set((Array.isArray(prefs?.autoApplyBoards) ? prefs.autoApplyBoards : []).map((x) => String(x).toLowerCase()));
  const hidden = new Set((Array.isArray(prefs?.excludedCompanies) ? prefs.excludedCompanies : []).map((c) => String(c).trim().toLowerCase()));
  const feedSlugs = new Map();
  const archivedFeeds = new Set(); // archived on the Feeds page: no applications to its jobs
  for (const d of feedsSnap.docs) { const s = feedSlug(d.data()?.url); if (s) feedSlugs.set(d.id, s); if (d.data()?.archivedAt) archivedFeeds.add(d.id); }

  // Already applied: by job id, by form, and by company + title.
  const applied = { ids: new Set(), forms: new Set(), roles: new Set() };
  for (const d of appsSnap.docs) {
    const a = d.data() || {};
    if (a.status !== "submitted") continue;
    if (a.jobId) applied.ids.add(String(a.jobId));
    if (a.formKey) applied.forms.add(String(a.formKey));
    const rk = a.roleKey || ledger.roleKeyOf(a.companyName, a.jobTitle);
    if (rk) applied.roles.add(rk);
  }

  const seen = new Set();
  const out = [];
  // For the log: Ashby/Greenhouse jobs on the Jobs page, how many are applied to, how many are left.
  const stats = { ashby: { total: 0, applied: 0 }, greenhouse: { total: 0, applied: 0 }, lever: { total: 0, applied: 0 }, workday: { total: 0, applied: 0 } };
  const lists = [...(allSnap.exists ? allSnap.data()?.jobs || [] : []), ...(recentSnap.exists ? recentSnap.data()?.jobs || [] : [])];
  for (const j of lists) {
    if (!j?.id || seen.has(j.id)) continue;
    seen.add(j.id);
    const src = String(j.source || "").toLowerCase();
    // Ashby, Greenhouse, Lever (back on after its 50-form test, 2026-11-02) and Workday.
    const board = ASHBY_SOURCES.has(src) ? "ashby" : LEVER_SOURCES.has(src) ? "lever" : WORKDAY_SOURCES.has(src) ? "workday" : GH_SOURCES.has(src) ? "greenhouse" : "";
    if (!board || (boardsOn.size && !boardsOn.has(board))) continue;
    if (hidden.has(String(j.companyName || "").trim().toLowerCase())) continue;
    if (j.companyKey && archivedFeeds.has(j.companyKey)) continue;
    // The US filter again, as it reads today: jobs saved under an older one
    // ("-REMOTE, BULGARIA-" passed on its bare "REMOTE") are left out.
    if (typeof locationOk === "function" && j.locationName && !locationOk(j.locationName)) continue;
    const fam = Array.isArray(j.fam) ? j.fam : classifyTitle(j.title);
    if (!isRelatedJob({ ...j, fam }, scores[j.id], jobTypes, { needsSponsorship: sponsorship })) continue;
    // Not scored yet (the AI is behind or down): only titles wholly in the
    // person's job types. "GTM Systems Engineer" is software and sales;
    // "Test & Launch Operations Engineer" is operations (2026-11-03).
    if (!scores[j.id] && Array.isArray(jobTypes) && jobTypes.length && fam.length && !fam.every((f) => jobTypes.includes(f))) continue;
    // A matching job only; an unscored one waits for its score.
    if (minScore > 0 && !(typeof scores[j.id]?.score === "number" && scores[j.id].score >= minScore)) continue;
    const st = stats[board];
    st.total++;
    if (applied.ids.has(j.id)) { st.applied++; continue; }
    const applyUrl = applyUrlFor(j, feedSlugs);
    if (!applyUrl) continue;
    const key = ledger.formKeyFromUrl(applyUrl);
    if (key && applied.forms.has(key.formKey)) { st.applied++; continue; }
    const rk = ledger.roleKeyOf(j.companyName, j.title);
    if (rk && applied.roles.has(rk)) { st.applied++; continue; }
    // When the job came out: the board's date, or when JobWatch first saw it
    // if that is earlier (Greenhouse's date moves on every edit).
    const ms = (ts) => (ts?.toMillis ? ts.toMillis() : ts?._seconds ? ts._seconds * 1000 : (Date.parse(ts) || 0));
    const postedAt = Math.min(...[ms(j.sourceUpdatedTs), ms(j.firstSeenAt)].filter((t) => t > 0)) || 0;
    const score = typeof scores[j.id]?.score === "number" ? scores[j.id].score : -1;
    out.push({
      jobId: j.id, source: board, applyUrl,
      title: j.title || "", companyName: j.companyName || "", externalId: String(j.externalId || ""),
      locationName: j.locationName || "", postedAt, score,
    });
  }
  // Newest day first; within a day, the best match first; then the newest.
  const day = (t) => new Date(t).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  out.sort((a, b) => day(b.postedAt).localeCompare(day(a.postedAt)) || b.score - a.score || b.postedAt - a.postedAt);
  const list = out.slice(0, limit);
  stats.ashby.left = out.filter((j) => j.source === "ashby").length;
  stats.greenhouse.left = out.filter((j) => j.source === "greenhouse").length;
  stats.lever.left = out.filter((j) => j.source === "lever").length;
  stats.workday.left = out.filter((j) => j.source === "workday").length;
  Object.defineProperty(list, "stats", { value: stats, enumerable: false });
  return list;
}

module.exports = { buildQueue, applyUrlFor, feedSlug, resumeFileName };
