// postingFromUrl.cjs — a job's title, company and description read straight
// from its board, for a job JobWatch no longer holds (job records expire after
// a few days; the "Retrying" jobs from Nov 2-4 had none, so no tailored resume
// could be made and 145 jobs stopped, 2026-11-13).
//
// postingFromUrl(applyUrl) -> { title, companyName, locationName, description } | null
// Greenhouse, Ashby, Lever and Workday apply links, as auto-apply opens them.

const DEFAULT_FETCH = (...a) => fetch(...a);
const decode = (h) => String(h || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const text = (h) => decode(h).replace(/<\/(p|li|div|h\d)>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

async function postingFromUrl(applyUrl, fetchFn = DEFAULT_FETCH) {
  let u;
  try { u = new URL(String(applyUrl || "")); } catch { return null; }
  const host = u.hostname.toLowerCase();
  try {
    if (/greenhouse\.io$/.test(host)) {
      const org = u.searchParams.get("for") || u.pathname.split("/").filter(Boolean)[0];
      const id = u.searchParams.get("token") || (u.pathname.match(/jobs\/(\d+)/) || [])[1];
      if (!org || !id) return null;
      const r = await fetchFn(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(org)}/jobs/${encodeURIComponent(id)}`);
      if (!r.ok) return null;
      const j = await r.json();
      return { title: j.title || "", companyName: j.company_name || "", locationName: j.location?.name || "", description: text(j.content) };
    }
    if (/ashbyhq\.com$/.test(host)) {
      const [org, id] = u.pathname.split("/").filter(Boolean);
      if (!org || !id) return null;
      const r = await fetchFn(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}`);
      if (!r.ok) return null;
      const j = (await r.json()).jobs?.find((x) => String(x.id) === id);
      return j ? { title: j.title || "", companyName: "", locationName: j.location || "", description: j.descriptionPlain || text(j.descriptionHtml) } : null;
    }
    if (/lever\.co$/.test(host)) {
      const [org, id] = u.pathname.split("/").filter(Boolean);
      if (!org || !id) return null;
      const r = await fetchFn(`https://api.lever.co/v0/postings/${encodeURIComponent(org)}/${encodeURIComponent(id)}`);
      if (!r.ok) return null;
      const j = await r.json();
      const lists = (j.lists || []).map((l) => `${l.text}\n${text(l.content)}`).join("\n");
      return { title: j.text || "", companyName: "", locationName: j.categories?.location || "", description: [j.descriptionPlain, lists, j.additionalPlain].filter(Boolean).join("\n") };
    }
    if (/myworkdayjobs\.com$|myworkdaysite\.com$/.test(host)) {
      const { fetchWorkdayPosting } = require("./generic.cjs");
      const p = await fetchWorkdayPosting(applyUrl, fetchFn);
      return p ? { title: p.title || "", companyName: p.companyName || "", locationName: p.locationName || "", description: text(p.descriptionHtml) } : null;
    }
  } catch { return null; }
  return null;
}

module.exports = { postingFromUrl };
