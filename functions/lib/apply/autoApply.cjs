// autoApply.cjs — the queue behind the extension's unattended auto-apply.
//
// Every Ashby and Greenhouse job on the person's Jobs page (the same
// "related" rule the page uses: job types, AI/rule verdicts, visa
// eligibility), newest first, minus every job already applied to (by job id,
// form key and company+title). No score floor and no daily cap: the person
// asked for all of them. Each entry carries the URL the runner opens: the
// Ashby application page, or Greenhouse's own embedded form (a company's
// careers site may wrap it in an iframe the runner cannot drive).

const { createAssistantContext, isRelatedJob } = require("../assistantTools.cjs");
const { classifyTitle } = require("../jobFamilies.cjs");
const ledger = require("./ledger.cjs");

const GH_SOURCES = new Set(["greenhouse"]);
const ASHBY_SOURCES = new Set(["ashby", "ashbyhq"]);

/** Board slug of a feed URL: boards-api.greenhouse.io/v1/boards/<token>/..., posting-api/job-board/<org>. */
function feedSlug(url) {
  const u = String(url || "");
  const gh = u.match(/greenhouse\.io\/v1\/boards\/([^/?#]+)/i) || u.match(/greenhouse\.io\/([^/?#]+)/i);
  if (gh && !/^(v1|embed)$/i.test(gh[1])) return { source: "greenhouse", slug: gh[1] };
  const ash = u.match(/ashbyhq\.com\/posting-api\/job-board\/([^/?#]+)/i) || u.match(/jobs\.ashbyhq\.com\/([^/?#]+)/i);
  if (ash) return { source: "ashby", slug: ash[1] };
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
 * The queue: [{ jobId, source: "ashby"|"greenhouse", applyUrl, title,
 * companyName, externalId, locationName, postedAt }].
 */
async function buildQueue(db, uid, { adminUid, limit = 2000 } = {}) {
  const ctx = createAssistantContext(db, uid, { adminUid });
  const aggs = db.collection("users").doc(adminUid).collection("aggregations");
  const [allSnap, recentSnap, feedsSnap, appsSnap, scores, jobTypes, sponsorship] = await Promise.all([
    aggs.doc("allJobs").get(),
    aggs.doc("recentJobs").get(),
    db.collection("users").doc(adminUid).collection("feeds").get(),
    db.collection("users").doc(uid).collection("applications").get(),
    ctx.scores(), ctx.jobTypes(), ctx.sponsorship(),
  ]);
  const feedSlugs = new Map();
  for (const d of feedsSnap.docs) { const s = feedSlug(d.data()?.url); if (s) feedSlugs.set(d.id, s); }

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
  const lists = [...(allSnap.exists ? allSnap.data()?.jobs || [] : []), ...(recentSnap.exists ? recentSnap.data()?.jobs || [] : [])];
  for (const j of lists) {
    if (!j?.id || seen.has(j.id)) continue;
    seen.add(j.id);
    const src = String(j.source || "").toLowerCase();
    if (!GH_SOURCES.has(src) && !ASHBY_SOURCES.has(src)) continue;
    const fam = Array.isArray(j.fam) ? j.fam : classifyTitle(j.title);
    if (!isRelatedJob({ ...j, fam }, scores[j.id], jobTypes, { needsSponsorship: sponsorship })) continue;
    if (applied.ids.has(j.id)) continue;
    const applyUrl = applyUrlFor(j, feedSlugs);
    if (!applyUrl) continue;
    const key = ledger.formKeyFromUrl(applyUrl);
    if (key && applied.forms.has(key.formKey)) continue;
    const rk = ledger.roleKeyOf(j.companyName, j.title);
    if (rk && applied.roles.has(rk)) continue;
    const ts = j.sourceUpdatedTs;
    const postedAt = ts?.toMillis ? ts.toMillis() : ts?._seconds ? ts._seconds * 1000 : (Date.parse(ts) || 0);
    out.push({
      jobId: j.id, source: ASHBY_SOURCES.has(src) ? "ashby" : "greenhouse", applyUrl,
      title: j.title || "", companyName: j.companyName || "", externalId: String(j.externalId || ""),
      locationName: j.locationName || "", postedAt,
    });
  }
  out.sort((a, b) => b.postedAt - a.postedAt);
  return out.slice(0, limit);
}

module.exports = { buildQueue, applyUrlFor, feedSlug, resumeFileName };
