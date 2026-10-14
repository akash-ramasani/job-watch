"use strict";
/**
 * Career-site adapters beyond the four built-in board sources (Lever, Workable,
 * SmartRecruiters, BambooHR). Each adapter reads a public listing the way the
 * career page itself does, so no credentials are involved.
 *
 *   peopleadmin      https://<school>.peopleadmin.com/postings/search  (or jobs.<school>.edu/postings)
 *   neogov           https://www.governmentjobs.com/careers/<agency>   (schooljobs.com too)
 *   paycom           https://www.paycomonline.net/v4/ats/web.php/jobs?clientkey=<KEY>
 *   adp              https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=<cid>&ccId=<ccId>
 *   pageup           https://<x>.pageuppeople.com/<n>/ci/en-us/listing   (or a custom host /en-us/listing)
 *   icims            https://<x>.icims.com/jobs/search
 *   cornerstone      https://<corp>.csod.com/ux/ats/careersite/<n>/home?c=<corp>
 *   paylocity        https://recruiting.paylocity.com/recruiting/jobs/All/<guid>/<Company>
 *   taleo            https://<org>.taleo.net/careersection/<n>/jobsearch.ftl
 *   ukg              https://recruiting2.ultipro.com/<tenant>/JobBoard/<guid>/
 *   interfolio       https://apply.interfolio.com/<institution>/positions
 *   silkroad         https://jobs.silkroad.com/<Co>/<Site>
 *   applicantpro     https://<slug>.applicantpro.com/jobs/
 *   avature          https://<x>.avature.net/jobs   (or a custom host /jobs)
 *   brassring        https://sjobs.brassring.com/TGnewUI/Search/Home/Home?partnerid=<p>&siteid=<s>
 *   phenom           https://careers.<company>.com/us/en
 *   jazzhr           https://<slug>.applytojob.com/apply
 *   breezy           https://<slug>.breezy.hr
 *   successfactors   https://careers.<company>.com/search/   (SuccessFactors "Unify" career sites)
 *
 * Contract used by functions/index.js (fetchBoardNewJobs / normalizeBoardJob /
 * fetchBoardDescription):
 *   parse(source, url)                      → parsed | null
 *   adapter(source, parsed, h)              → { fetchPage(offset), fetchDetail(row), keep(row, detail), pageSize }
 *   normalize(source, parsed, raw, h)       → { title, jobUrl, locParts, us, remote, workplaceType, postedIso, postedDay, meta, html }
 *   description(source, parsed, id, h)      → html | null
 * `h` carries { now, ageDaysFromIsoDate, isUSCountry, looksUS, maxAge } from index.js.
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const TIMEOUT_MS = 25000;

// ---------------------------------------------------------------- HTTP helpers

async function request(url, { method = "GET", headers = {}, body = null, accept = "*/*", retries = 2 } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method,
        headers: { "user-agent": UA, accept, ...headers },
        body,
        redirect: "follow",
        signal: ac.signal,
      });
      if (resp.ok) return resp;
      const retryable = resp.status === 429 || resp.status >= 500;
      if (retryable && attempt < retries) {
        attempt++;
        await new Promise((r) => setTimeout(r, (resp.status === 429 ? 4000 : 1200) * attempt));
        continue;
      }
      const text = (await resp.text().catch(() => "")).slice(0, 200);
      throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}. Body: ${text}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
const getText = async (url, opts = {}) => (await request(url, { accept: "text/html,application/xhtml+xml,application/xml,*/*", ...opts })).text();
const getJson = async (url, opts = {}) => (await request(url, { accept: "application/json,*/*", ...opts })).json();
const postJson = async (url, data, headers = {}, opts = {}) =>
  (await request(url, { method: "POST", body: JSON.stringify(data), headers: { "content-type": "application/json", ...headers }, accept: "application/json,*/*", ...opts })).json();

// ---------------------------------------------------------------- text helpers

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#160": " " };
function decodeEntities(s) {
  return String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (ENTITIES[k] != null) return ENTITIES[k];
    if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith("#")) return String.fromCodePoint(parseInt(k.slice(1), 10));
    return m;
  });
}
const textOf = (html) => decodeEntities(String(html || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const attr = (tag, name) => { const m = String(tag).match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i")); return m ? decodeEntities(m[1]) : null; };

/** First schema.org JobPosting object embedded in a page as JSON-LD, or null. */
function ldJobPosting(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const items = Array.isArray(data) ? data : data && Array.isArray(data["@graph"]) ? data["@graph"] : [data];
    const job = items.find((x) => x && /JobPosting/i.test(String(x["@type"])));
    if (job) return job;
  }
  return null;
}
const ldText = (v) => (v == null ? "" : decodeEntities(String(v)));
function ldLocation(ld) {
  const places = Array.isArray(ld?.jobLocation) ? ld.jobLocation : ld?.jobLocation ? [ld.jobLocation] : [];
  const parts = [];
  let country = null;
  for (const p of places) {
    const a = p?.address || {};
    const locality = ldText(a.addressLocality || "").trim();
    const region = ldText(a.addressRegion || "").trim();
    const name = locality && region && new RegExp(`[,\\s]${region.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i").test(locality) ? locality : [locality, region].filter(Boolean).join(", ") || p?.name || "";
    if (name) parts.push(ldText(name));
    if (!country && a.addressCountry) country = typeof a.addressCountry === "object" ? a.addressCountry.name : a.addressCountry;
  }
  return { parts, country: country ? String(country) : null };
}
const isoDay = (v) => { const s = String(v || "").trim(); const m = s.match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; };
/** "10/12/2026", "10/12/26", "Oct 12, 2026", "12-Oct-2026" → "2026-10-12" (null when unparsable). */
function toIsoDay(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  const iso = isoDay(s);
  if (iso) return iso;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`; }
  const t = Date.parse(s.replace(/(\d+)(st|nd|rd|th)/, "$1"));
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}
const usCountry = (c, h) => (c == null || c === "" ? null : h.isUSCountry(c) || /^(US|USA)$/i.test(String(c).trim()));

function originOf(raw) { try { return new URL(raw).origin; } catch { return null; } }
function urlOf(raw) { try { return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; } }

// ---------------------------------------------------------------- adapters

const ADAPTERS = {
  // ---- PeopleAdmin: an Atom feed of the last week's postings (newest first, descriptions included); the posting page has the facts table.
  peopleadmin: {
    parse(raw) {
      const u = urlOf(raw);
      if (!u) return null;
      const isPa = /\.peopleadmin\.com$/i.test(u.hostname) || /^\/postings(\/|$)/i.test(u.pathname) || /\/postings\.atom/i.test(u.pathname);
      if (!isPa) return null;
      const base = u.origin;
      return { slug: u.hostname, base, careerUrl: `${base}/postings/search`, listUrl: `${base}/postings/search.atom?query=&query_v0_posted_at_date=week&sort=posted_at_date+desc` };
    },
    adapter(parsed, h) {
      return {
        pageSize: Number.MAX_SAFE_INTEGER,
        fetchPage: async (offset) => {
          if (offset > 0) return { rows: [], total: 0 };
          const xml = await getText(parsed.listUrl, { accept: "application/atom+xml,application/xml,text/xml,*/*" });
          const rows = [];
          const re = /<entry>([\s\S]*?)<\/entry>/g;
          let m;
          while ((m = re.exec(xml))) {
            const e = m[1];
            const link = (e.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/) || e.match(/<id>([^<]+)<\/id>/) || [])[1] || "";
            const id = (link.match(/\/postings\/(\d+)/) || [])[1] || null;
            const published = (e.match(/<published>([^<]+)<\/published>/) || [])[1] || null;
            const title = textOf((e.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || "");
            const content = decodeEntities((e.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || "");
            rows.push({ id, ageDays: h.ageDaysFromIsoDate(isoDay(published), h.now), looksUS: true, raw: { id, link: decodeEntities(link), published, title, content } });
          }
          return { rows, total: rows.length };
        },
        fetchDetail: async (row) => peopleAdminDetail(row.raw.link || `${parsed.base}/postings/${row.id}`),
        keep: (row, detail) => !(detail?.fields?.Country && !usCountry(detail.fields.Country, h)),
      };
    },
    normalize(parsed, { id, list = {}, detail }, h) {
      const f = detail?.fields || {};
      const locParts = [f.City, f.Location || f.Campus || f["Work Location"] || f["Primary Location"]].filter(Boolean).map(String);
      const meta = {};
      for (const k of ["Department", "Position Type", "Type", "Job Category", "Salary Range", "Pay Rate Range", "Requisition Number", "Posting Number", "Close Date"]) if (f[k]) meta[k] = String(f[k]).slice(0, 200);
      const html = [list.content, detail?.html].filter(Boolean).join("\n");
      return { title: list.title || f["Working Title"] || f["Job Title"] || null, jobUrl: list.link || `${parsed.base}/postings/${id}`, locParts, us: !f.Country || usCountry(f.Country, h), remote: /remote/i.test(locParts.join(" ")), postedIso: list.published || null, meta, html };
    },
    async description(parsed, id) { const d = await peopleAdminDetail(`${parsed.base}/postings/${id}`); return d?.html || null; },
  },

  // ---- NEOGOV (governmentjobs.com / schooljobs.com): the list is an HTML partial the page loads; each job page carries JSON-LD.
  neogov: {
    parse(raw) {
      const u = urlOf(raw);
      if (!u || !/(^|\.)(governmentjobs|schooljobs)\.com$/i.test(u.hostname)) return null;
      const m = u.pathname.match(/^\/careers\/([^/]+)/i);
      if (!m || /^(home|agencycustomstylescheme)$/i.test(m[1])) return null;
      const agency = m[1].toLowerCase();
      const host = u.hostname.replace(/^agency\./, "www.");
      return { slug: agency, host, careerUrl: `https://${host}/careers/${agency}` };
    },
    adapter(parsed, h) {
      const PAGE = 10;
      return {
        pageSize: PAGE,
        fetchPage: async (offset) => {
          const page = Math.floor(offset / PAGE) + 1;
          const html = await getText(`https://${parsed.host}/careers/home/index?agency=${encodeURIComponent(parsed.slug)}&sort=PostingDate&isDescendingSort=true&page=${page}&_=${Date.now()}`, { headers: { "x-requested-with": "XMLHttpRequest" } });
          const rows = [];
          const re = /<li class="list-item"[^>]*data-job-id="(\d+)"[^>]*>([\s\S]*?)<\/li>\s*(?=<li class="list-item|<\/ul>)/g;
          let m;
          while ((m = re.exec(html))) {
            const id = m[1];
            const body = m[2];
            const a = body.match(/<a[^>]*class="item-details-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
            const metaItems = [...body.matchAll(/<ul class="list-meta">([\s\S]*?)<\/ul>/g)].flatMap((x) => [...x[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((y) => textOf(y[1])));
            const posted = textOf((body.match(/Posted[^<]{0,60}/) || [""])[0]);
            rows.push({ id, ageDays: neogovAge(posted, h), looksUS: metaItems[0] ? h.looksUS(metaItems[0]) : true, raw: { id, title: a ? textOf(a[2]) : null, href: a ? decodeEntities(a[1]) : null, meta: metaItems, posted } });
          }
          const total = Number((textOf(html).match(/([\d,]+)\s+jobs? found/i) || [])[1]?.replace(/,/g, "")) || undefined;
          return { rows, total };
        },
        fetchDetail: async (row) => ldJobPosting(await getText(row.raw.href?.startsWith("http") ? row.raw.href : `https://${parsed.host}${row.raw.href || `/careers/${parsed.slug}/jobs/${row.id}`}`)),
        keep: (row, detail) => { const c = ldLocation(detail).country; return (c == null || usCountry(c, h)) && h.recentEnough(isoDay(detail?.datePosted)); },
      };
    },
    normalize(parsed, { id, list = {}, detail }, h) {
      const loc = ldLocation(detail);
      const locParts = loc.parts.length ? loc.parts : list.meta?.[0] ? [list.meta[0]] : [];
      const meta = {};
      if (list.meta?.[1]) meta["Employment Type"] = list.meta[1];
      const dept = (list.meta || []).find((x) => /^Department:/i.test(x));
      if (dept) meta["Department"] = dept.replace(/^Department:\s*/i, "");
      return { title: ldText(detail?.title) || list.title || null, jobUrl: list.href?.startsWith("http") ? list.href : `https://${parsed.host}${list.href || `/careers/${parsed.slug}/jobs/${id}`}`, locParts, us: loc.country ? usCountry(loc.country, h) : h.looksUS(locParts.join("; ")), remote: /remote/i.test(locParts.join(" ")), postedDay: isoDay(detail?.datePosted), meta, html: ldText(detail?.description) };
    },
    async description(parsed, id) { return ldText(ldJobPosting(await getText(`https://${parsed.host}/careers/${parsed.slug}/jobs/${id}`))?.description) || null; },
  },

  // ---- Paycom: the career page embeds a bearer token and the search service URL; job pages carry JSON-LD.
  paycom: {
    parse(raw) {
      const u = urlOf(raw);
      if (!u || !/paycomonline\.net$/i.test(u.hostname)) return null;
      const key = u.searchParams.get("clientkey") || (u.pathname.match(/\/portal\/([A-F0-9]{16,})/i) || [])[1];
      if (!key) return null;
      return { slug: key.toUpperCase(), key: key.toUpperCase(), careerUrl: `https://www.paycomonline.net/v4/ats/web.php/jobs?clientkey=${key.toUpperCase()}`, portalUrl: `https://www.paycomonline.net/v4/ats/web.php/portal/${key.toUpperCase()}/career-page` };
    },
    adapter(parsed, h) {
      const PAGE = 50;
      let session = null;
      const connect = async () => {
        if (session) return session;
        const html = await getText(parsed.portalUrl);
        const token = (html.match(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/) || [])[0];
        const svc = (html.match(/atsPortalMantleServiceUrl\\?":\\?"(https:[^"\\]+)/) || [])[1]?.replace(/\\\//g, "/") || "https://portal-applicant-tracking.us-cent.paycomonline.net/";
        if (!token) throw new Error(`Paycom career page has no session token: ${parsed.portalUrl}`);
        session = { token, svc: svc.replace(/\/?$/, "/") };
        return session;
      };
      return {
        pageSize: PAGE,
        fetchPage: async (offset) => {
          const s = await connect();
          const data = await postJson(`${s.svc}api/ats/job-posting-previews/search`, { skip: offset, take: PAGE, filtersForQuery: { distanceFrom: "", workEnvironments: [], positionTypes: [], educationLevels: [], categories: [], travelTypes: [], shiftTypes: [], otherFilters: [], keywordSearchText: "", location: "", sortOption: "" } }, { authorization: `Bearer ${s.token}`, locale: "en-US", "portal-host-referrer": parsed.portalUrl });
          const rows = (data?.jobPostingPreviews || []).map((raw) => ({ id: raw.jobId != null ? String(raw.jobId) : null, ageDays: h.ageDaysFromIsoDate(toIsoDay(raw.postedOn), h.now), looksUS: raw.locations ? h.looksUS(raw.locations) : true, raw }));
          return { rows, total: data?.jobPostingPreviewsCount };
        },
        fetchDetail: async (row) => ldJobPosting(await getText(`https://www.paycomonline.net/v4/ats/web.php/portal/${parsed.key}/jobs/${row.id}`)),
        keep: (row, detail) => { const c = ldLocation(detail).country; return (c == null || usCountry(c, h)) && h.recentEnough(isoDay(detail?.datePosted)); },
      };
    },
    normalize(parsed, { id, list = {}, detail }, h) {
      const loc = ldLocation(detail);
      const locParts = loc.parts.length ? loc.parts : list.locations ? [list.locations] : [];
      const meta = {};
      if (list.positionType) meta["Employment Type"] = list.positionType;
      const remote = /remote/i.test(`${list.remoteType || ""} ${locParts.join(" ")}`);
      return { title: ldText(detail?.title) || list.jobTitle || null, jobUrl: `https://www.paycomonline.net/v4/ats/web.php/portal/${parsed.key}/jobs/${id}`, locParts, us: loc.country ? usCountry(loc.country, h) : h.looksUS(locParts.join("; ")), remote, workplaceType: remote ? "remote" : /hybrid/i.test(list.remoteType || "") ? "hybrid" : null, postedDay: isoDay(detail?.datePosted) || toIsoDay(list.postedOn), meta, html: ldText(detail?.description) || list.description || "" };
    },
    async description(parsed, id) { return ldText(ldJobPosting(await getText(`https://www.paycomonline.net/v4/ats/web.php/portal/${parsed.key}/jobs/${id}`))?.description) || null; },
  },

  // ---- ADP Workforce Now: a public JSON API behind the recruitment page.
  adp: {
    parse(raw) {
      const u = urlOf(raw);
      if (!u || !/workforcenow\.adp\.com$/i.test(u.hostname)) return null;
      const cid = u.searchParams.get("cid");
      if (!cid) return null;
      const ccId = u.searchParams.get("ccId") || "19000101_000001";
      return { slug: cid, cid, ccId, careerUrl: `https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=${cid}&ccId=${ccId}&lang=en_US`, api: `https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions` };
    },
    adapter(parsed, h) {
      const PAGE = 50;
      const q = () => `cid=${encodeURIComponent(parsed.cid)}&timeStamp=${Date.now()}&lang=en_US&ccId=${encodeURIComponent(parsed.ccId)}&locale=en_US`;
      return {
        pageSize: PAGE,
        fetchPage: async (offset) => {
          const data = await getJson(`${parsed.api}?${q()}&$top=${PAGE}&$skip=${offset}`);
          const rows = (data?.jobRequisitions || []).map((raw) => ({ id: raw.itemID || null, ageDays: h.ageDaysFromIsoDate(isoDay(raw.postDate), h.now), looksUS: adpLooksUS(raw, h), raw }));
          return { rows, total: data?.meta?.totalNumber };
        },
        fetchDetail: async (row) => (await getJson(`${parsed.api}/${encodeURIComponent(row.id)}?${q()}`)) || null,
        keep: (row, detail) => adpLooksUS(detail || row.raw, h),
      };
    },
    normalize(parsed, { id, list = {}, detail }, h) {
      const d = detail || list;
      const locs = (d.requisitionLocations || list.requisitionLocations || []).map((l) => (l.nameCode?.shortName || [l.address?.cityName, l.address?.countrySubdivisionLevel1?.codeValue].filter(Boolean).join(", ")).trim()).filter(Boolean);
      const meta = {};
      const pay = d.payGradeRange;
      if (pay?.minimumRate?.amountValue && pay?.maximumRate?.amountValue) meta["Pay"] = `${pay.minimumRate.amountValue}–${pay.maximumRate.amountValue} ${pay.minimumRate.currencyCode || ""}`.trim();
      const cat = (d.customFieldGroup?.codeFields || []).find((f) => f.nameCode?.codeValue === "WorkerCategory" || f.nameCode?.codeValue === "JobClass");
      if (cat?.shortName) meta["Category"] = cat.shortName;
      if (d.clientRequisitionID) meta["Req ID"] = d.clientRequisitionID;
      return { title: d.requisitionTitle || list.requisitionTitle || null, jobUrl: `https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=${parsed.cid}&ccId=${parsed.ccId}&jobId=${encodeURIComponent(id)}&lang=en_US&source=CC2`, locParts: locs, us: adpLooksUS(d, h), remote: /remote/i.test(locs.join(" ")), postedIso: d.postDate || list.postDate || null, meta, html: d.requisitionDescription || "" };
    },
    async description(parsed, id) { const d = await getJson(`${parsed.api}/${encodeURIComponent(id)}?cid=${encodeURIComponent(parsed.cid)}&timeStamp=${Date.now()}&lang=en_US&ccId=${encodeURIComponent(parsed.ccId)}&locale=en_US`); return d?.requisitionDescription || null; },
  },

  // ---- PageUp: an RSS feed with full descriptions (job:description).
  pageup: {
    parse(raw) {
      const u = urlOf(raw);
      if (!u) return null;
      let base = null;
      let m = u.pathname.match(/^\/(\d+)\/ci\/([a-z]{2}-[a-z]{2})/i);
      if (/pageuppeople\.com$/i.test(u.hostname) && m) base = `${u.origin}/${m[1]}/ci/${m[2].toLowerCase()}`;
      else if ((m = u.pathname.match(/^\/([a-z]{2}-[a-z]{2})\/(listing|rss|job|search)/i))) base = `${u.origin}/${m[1].toLowerCase()}`;
      else if (/pageuppeople\.com$/i.test(u.hostname) && (m = u.pathname.match(/^\/(\d+)\/?$/))) base = `${u.origin}/${m[1]}/ci/en-us`;
      if (!base) return null;
      return { slug: u.hostname, base, careerUrl: `${base}/listing/`, listUrl: `${base}/rss` };
    },
    adapter(parsed, h) {
      return {
        pageSize: Number.MAX_SAFE_INTEGER,
        fetchPage: async (offset) => {
          if (offset > 0) return { rows: [], total: 0 };
          const xml = await getText(parsed.listUrl, { accept: "application/rss+xml,application/xml,text/xml,*/*" });
          const rows = [];
          const re = /<item>([\s\S]*?)<\/item>/g;
          let m;
          while ((m = re.exec(xml))) {
            const e = m[1];
            const link = decodeEntities((e.match(/<link>([^<]+)<\/link>/) || [])[1] || "");
            const id = (e.match(/<job:refNo>([^<]+)<\/job:refNo>/) || link.match(/\/job\/(\d+)/) || [])[1] || null;
            const pub = (e.match(/<a10:updated>([^<]+)<\/a10:updated>/) || e.match(/<pubDate>([^<]+)<\/pubDate>/) || [])[1] || null;
            const fields = {};
            for (const f of e.matchAll(/<job:([A-Za-z]+)>([\s\S]*?)<\/job:\1>/g)) fields[f[1]] = decodeEntities(f[2].replace(/^<!\[CDATA\[|\]\]>$/g, ""));
            const title = textOf((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
            const loc = fields.location || fields.Location || fields.city || "";
            rows.push({ id, ageDays: h.ageDaysFromIsoDate(toIsoDay(pub), h.now), looksUS: loc ? h.looksUS(loc) : true, raw: { id, link, title, pub, fields, summary: decodeEntities((e.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || "") } });
          }
          return { rows, total: rows.length };
        },
        fetchDetail: async (row) => row.raw,
        keep: () => true,
      };
    },
    normalize(parsed, { id, list = {} }, h) {
      const f = list.fields || {};
      const loc = f.location || f.Location || f.city || "";
      const meta = {};
      if (f.category) meta["Category"] = f.category.replace(/^[^|]*\|/, "");
      if (f.workType || f.worktype) meta["Work Type"] = f.workType || f.worktype;
      return { title: list.title || null, jobUrl: list.link || `${parsed.base}/job/${id}`, locParts: loc ? [loc] : [], us: loc ? h.looksUS(loc) : true, remote: /remote/i.test(loc), postedIso: list.pub ? new Date(list.pub).toISOString() : null, meta, html: f.description || list.summary || "" };
    },
    async description(parsed, id) { const html = await getText(`${parsed.base}/job/${id}`); return ldText(ldJobPosting(html)?.description) || (html.match(/<div[^>]*class="[^"]*job-card[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/) || [])[1] || null; },
  },

  // ---- iCIMS: paged HTML search; each job page has JSON-LD with the posting date and description.
  icims: {
    parse(raw) {
      const u = urlOf(raw);
      if (!u || !/\.icims\.com$/i.test(u.hostname) || /^(www|login|media|jobs)\./i.test(u.hostname)) return null;
      return { slug: u.hostname.replace(/\.icims\.com$/i, ""), base: u.origin, careerUrl: `${u.origin}/jobs/search?ss=1`, listUrl: `${u.origin}/jobs/search?ss=1&in_iframe=1` };
    },
    adapter(parsed, h) {
      const PAGE = 20;
      return {
        pageSize: PAGE,
        fetchPage: async (offset) => {
          const html = await getText(`${parsed.listUrl}&pr=${Math.floor(offset / PAGE)}`);
          const seen = new Set();
          const rows = [];
          for (const m of html.matchAll(/<a[^>]*href="(https?:\/\/[^"]*\/jobs\/(\d+)\/[^"]*?\/job[^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) {
            if (seen.has(m[2])) continue;
            seen.add(m[2]);
            rows.push({ id: m[2], ageDays: null, looksUS: true, raw: { id: m[2], href: decodeEntities(m[1]).replace(/[?&]in_iframe=1/, ""), title: textOf(m[3]).replace(/^(Requisition\s+)?(Job\s+)?Title:?\s*/i, "") || null } });
          }
          const pages = Number((textOf(html).match(/Page \d+ of (\d+)/i) || [])[1]) || null;
          return { rows, total: pages ? pages * PAGE : undefined };
        },
        fetchDetail: async (row) => ldJobPosting(await getText(`${row.raw.href}${row.raw.href.includes("?") ? "&" : "?"}in_iframe=1`)),
        keep: (row, detail) => { const c = ldLocation(detail).country; return c == null || usCountry(c, h); },
      };
    },
    normalize(parsed, { id, list = {}, detail }, h) {
      const loc = ldLocation(detail);
      const meta = {};
      if (detail?.occupationalCategory) meta["Category"] = ldText(detail.occupationalCategory);
      if (detail?.employmentType && detail.employmentType !== "OTHER") meta["Employment Type"] = ldText(detail.employmentType);
      return { title: ldText(detail?.title) || list.title || null, jobUrl: list.href || ldText(detail?.url) || `${parsed.base}/jobs/${id}/job`, locParts: loc.parts, us: loc.country ? usCountry(loc.country, h) : h.looksUS(loc.parts.join("; ")), remote: /remote/i.test(loc.parts.join(" ")), postedDay: h.ageDaysFromIsoDate(isoDay(detail?.datePosted), h.now) <= 14 ? isoDay(detail?.datePosted) : null, meta, html: ldText(detail?.description) };
    },
    async description(parsed, id) { return ldText(ldJobPosting(await getText(`${parsed.base}/jobs/${id}/job?in_iframe=1`))?.description) || null; },
  },

  // ---- Cornerstone OnDemand career sites: the home page embeds a bearer token for the search and job-details services.
  cornerstone: {
    parse(raw) {
      const u = urlOf(raw);
      if (!u || !/\.csod\.com$/i.test(u.hostname)) return null;
      const m = u.pathname.match(/\/ux\/ats\/careersite\/(\d+)/i);
      if (!m) return null;
      const corp = u.searchParams.get("c") || u.hostname.split(".")[0];
      return { slug: `${corp}-${m[1]}`, base: u.origin, corp, siteId: Number(m[1]), careerUrl: `${u.origin}/ux/ats/careersite/${m[1]}/home?c=${corp}` };
    },
    adapter(parsed, h) {
      const PAGE = 25;
      let token = null;
      const auth = async () => {
        if (token) return token;
        const html = await getText(parsed.careerUrl);
        token = (html.match(/"token":"([^"]+)"/) || [])[1];
        if (!token) throw new Error(`Cornerstone career site has no token: ${parsed.careerUrl}`);
        return token;
      };
      return {
        pageSize: PAGE,
        fetchPage: async (offset) => {
          const t = await auth();
          const data = await postJson(`${parsed.base}/services/x/career-site/v1/search`, { careerSiteId: parsed.siteId, careerSitePageId: parsed.siteId, pageNumber: Math.floor(offset / PAGE) + 1, pageSize: PAGE, cultureId: 1, cultureName: "en-US", searchText: "", cities: [], countryCodes: [], cultures: [], customFieldCheckboxKeys: [], customFieldDropdowns: [], customFieldRadios: [], placeID: "", postingsWithinDays: null, radius: null, states: [] }, { authorization: `Bearer ${t}` });
          const rows = (data?.data?.requisitions || []).map((raw) => ({ id: raw.requisitionId != null ? String(raw.requisitionId) : null, ageDays: h.ageDaysFromIsoDate(toIsoDay(raw.postingEffectiveDate), h.now), looksUS: !raw.locations?.length || raw.locations.some((l) => usCountry(l.country, h) !== false), raw }));
          return { rows, total: data?.data?.totalCount };
        },
        fetchDetail: async (row) => (await getJson(`${parsed.base}/services/x/job-requisition/v2/requisitions/${row.id}/jobDetails?cultureId=1`, { headers: { authorization: `Bearer ${await auth()}` } }))?.data || null,
        keep: () => true,
      };
    },
    normalize(parsed, { id, list = {}, detail }, h) {
      const locs = (list.locations || []).map((l) => [l.city, l.state].filter(Boolean).join(", ")).filter(Boolean);
      const us = !list.locations?.length || list.locations.some((l) => usCountry(l.country, h));
      return { title: detail?.displayTitle || list.displayJobTitle || null, jobUrl: `${parsed.base}/ux/ats/careersite/${parsed.siteId}/home/requisition/${id}?c=${parsed.corp}`, locParts: locs, us, remote: /remote/i.test(locs.join(" ")), postedDay: toIsoDay(list.postingEffectiveDate), meta: {}, html: detail?.externalDescription || "" };
    },
    async description(parsed, id) {
      const html = await getText(parsed.careerUrl);
      const token = (html.match(/"token":"([^"]+)"/) || [])[1];
      if (!token) return null;
      return (await getJson(`${parsed.base}/services/x/job-requisition/v2/requisitions/${id}/jobDetails?cultureId=1`, { headers: { authorization: `Bearer ${token}` } }))?.data?.externalDescription || null;
    },
  },

  // ---- Paylocity: the public job list page embeds window.pageData; job pages carry JSON-LD.
  paylocity: {
    parse(raw) {
      const u = urlOf(raw);
      if (!u || !/recruiting\.paylocity\.com$/i.test(u.hostname)) return null;
      const m = u.pathname.match(/^\/recruiting\/jobs\/(All|List)\/([0-9a-f-]{36})(\/[^/?#]+)?/i);
      if (!m) return null;
      return { slug: m[2], careerUrl: `https://recruiting.paylocity.com/recruiting/jobs/All/${m[2]}${m[3] || ""}` };
    },
    adapter(parsed, h) {
      return {
        pageSize: Number.MAX_SAFE_INTEGER,
        fetchPage: async (offset) => {
          if (offset > 0) return { rows: [], total: 0 };
          const html = await getText(parsed.careerUrl);
          const data = inlineJson(html, /window\.pageData\s*=\s*/);
          const rows = (data?.Jobs || []).map((raw) => ({ id: raw.JobId != null ? String(raw.JobId) : null, ageDays: h.ageDaysFromIsoDate(isoDay(raw.PublishedDate), h.now), looksUS: raw.JobLocation?.Country ? usCountry(raw.JobLocation.Country, h) : raw.LocationName ? h.looksUS(raw.LocationName) : true, raw }));
          return { rows, total: rows.length };
        },
        fetchDetail: async (row) => ldJobPosting(await getText(`https://recruiting.paylocity.com/Recruiting/Jobs/Details/${row.id}`)),
        keep: () => true,
      };
    },
    normalize(parsed, { id, list = {}, detail }, h) {
      const l = list.JobLocation || {};
      const locParts = [list.LocationName || [l.City, l.State].filter(Boolean).join(", ")].filter(Boolean);
      const us = l.Country ? usCountry(l.Country, h) : locParts.length ? h.looksUS(locParts[0]) : true;
      const meta = {};
      if (list.HiringDepartment) meta["Department"] = list.HiringDepartment;
      return { title: list.JobTitle || ldText(detail?.title) || null, jobUrl: `https://recruiting.paylocity.com/Recruiting/Jobs/Details/${id}`, locParts, us, remote: Boolean(list.IsRemote), workplaceType: list.IsRemote ? "remote" : null, postedIso: list.PublishedDate || null, meta, html: ldText(detail?.description) || list.Description || "" };
    },
    async description(parsed, id) { return ldText(ldJobPosting(await getText(`https://recruiting.paylocity.com/Recruiting/Jobs/Details/${id}`))?.description) || null; },
  },

  // ---- Taleo career sections: a JSON search service. Descriptions sit behind a stateful page, so the
  //      listing is written without one and scoring fetches the job page later.
  taleo: {
    parse(raw) {
      const u = urlOf(raw);
      if (!u || !/\.taleo\.net$/i.test(u.hostname)) return null;
      const m = u.pathname.match(/\/careersection\/([^/]+)\//i);
      const section = m ? m[1] : "2";
      return { slug: `${u.hostname.split(".")[0]}-${section}`, base: u.origin, section, careerUrl: `${u.origin}/careersection/${section}/jobsearch.ftl?lang=en`, api: `${u.origin}/careersection/rest/jobboard/searchjobs?lang=en&portal=101430233` };
    },
    adapter(parsed, h) {
      const PAGE = 25;
      return {
        pageSize: PAGE,
        fetchPage: async (offset) => {
          const data = await postJson(parsed.api, { multilineEnabled: false, sortingSelection: { sortBySelectionParam: "3", ascendingSortingOrder: "false" }, fieldData: { fields: { KEYWORD: "", LOCATION: "" }, valid: true }, filterSelectionParam: { searchFilterSelections: [{ id: "POSTING_DATE", selectedValues: [] }, { id: "LOCATION", selectedValues: [] }, { id: "JOB_FIELD", selectedValues: [] }] }, advancedSearchFiltersSelectionParam: { searchFilterSelections: [] }, pageNo: Math.floor(offset / PAGE) + 1 }, { tz: "GMT-05:00", tzname: "America/Chicago" });
          const rows = (data?.requisitionList || []).map((raw) => {
            const cols = Array.isArray(raw.column) ? raw.column : [];
            const locIdx = Array.isArray(raw.locationsColumns) && raw.locationsColumns.length ? raw.locationsColumns[0] : -1;
            const loc = locIdx >= 0 ? taleoLocations(cols[locIdx]) : [];
            const dateCol = cols.find((c) => /^\d{1,2}\/\d{1,2}\/\d{4}$|^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(String(c || "").trim()));
            return { id: raw.jobId ? String(raw.jobId) : null, ageDays: dateCol ? h.ageDaysFromIsoDate(toIsoDay(dateCol), h.now) : null, looksUS: loc.length ? loc.some((l) => h.looksUS(l)) : true, raw: { ...raw, title: cols[raw.linkedColumn || 0] || null, locations: loc, date: dateCol || null } };
          });
          return { rows, total: data?.pagingData?.totalCount };
        },
        fetchDetail: async () => null,
        keep: () => true,
      };
    },
    normalize(parsed, { id, list = {} }, h) {
      const locParts = list.locations || [];
      const meta = {};
      if (list.contestNo) meta["Req ID"] = list.contestNo;
      const cols = Array.isArray(list.column) ? list.column : [];
      const field = cols.find((c, i) => i !== (list.linkedColumn || 0) && !(list.locationsColumns || []).includes(i) && c && !/^\[/.test(c) && c !== list.date);
      if (field) meta["Job Field"] = field;
      return { title: list.title || null, jobUrl: `${parsed.base}/careersection/${parsed.section}/jobdetail.ftl?job=${encodeURIComponent(id)}&lang=en`, locParts, us: locParts.length ? locParts.some((l) => h.looksUS(l)) : true, remote: /remote/i.test(locParts.join(" ")), postedDay: toIsoDay(list.date), meta, html: "" };
    },
    async description(parsed, id) {
      const html = await getText(`${parsed.base}/careersection/${parsed.section}/jobdetail.ftl?job=${encodeURIComponent(id)}&lang=en`);
      return ldText(ldJobPosting(html)?.description) || null;
    },
  },

  // ---- UKG Pro Recruiting (UltiPro job boards): a JSON search; the detail page embeds the opportunity JSON.
  ukg: {
    parse(raw) {
      const u = urlOf(raw);
      if (!u || !/(\.ultipro\.com|\.ukg\.net)$/i.test(u.hostname)) return null;
      const m = u.pathname.match(/^\/([^/]+)\/JobBoard\/([0-9a-f-]{36})/i);
      if (!m) return null;
      const base = `${u.origin}/${m[1]}/JobBoard/${m[2]}`;
      return { slug: `${m[1]}-${m[2].slice(0, 8)}`, base, careerUrl: `${base}/?q=&o=postedDateDesc` };
    },
    adapter(parsed, h) {
      const PAGE = 50;
      return {
        pageSize: PAGE,
        fetchPage: async (offset) => {
          const data = await postJson(`${parsed.base}/JobBoardView/LoadSearchResults`, { opportunitySearch: { Top: PAGE, Skip: offset, QueryString: "", OrderBy: [{ Value: "postedDateDesc", PropertyName: "PostedDate", Ascending: false }], Filters: [] }, matchCriteria: { PreferredJobs: [], Educations: [], LicenseAndCertifications: [], Skills: [], hasNoLicenses: false, SkippedSkills: [] } });
          const rows = (data?.opportunities || []).map((raw) => ({ id: raw.Id || null, ageDays: h.ageDaysFromIsoDate(isoDay(raw.PostedDate), h.now), looksUS: ukgLooksUS(raw, h), raw }));
          return { rows, total: data?.totalCount };
        },
        fetchDetail: async (row) => inlineJson(await getText(`${parsed.base}/OpportunityDetail?opportunityId=${encodeURIComponent(row.id)}`), /CandidateOpportunityDetail\(\s*/),
        keep: (row, detail) => ukgLooksUS(detail || row.raw, h),
      };
    },
    normalize(parsed, { id, list = {}, detail }, h) {
      const d = detail || list;
      const locs = (d.Locations || list.Locations || []).map((l) => [l.Address?.City, l.Address?.State?.Code].filter(Boolean).join(", ") || l.LocalizedName).filter(Boolean);
      const meta = {};
      if (d.JobCategoryName) meta["Category"] = d.JobCategoryName;
      if (d.RequisitionNumber) meta["Req ID"] = d.RequisitionNumber;
      if (d.FullTime != null) meta["Employment Type"] = d.FullTime ? "Full-time" : "Part-time";
      return { title: d.Title || list.Title || null, jobUrl: `${parsed.base}/OpportunityDetail?opportunityId=${encodeURIComponent(id)}`, locParts: locs, us: ukgLooksUS(d, h), remote: /remote/i.test(locs.join(" ")) || d.JobLocationType === 2, postedIso: d.PostedDate || list.PostedDate || null, meta, html: d.Description || list.BriefDescription || "" };
    },
    async description(parsed, id) { return inlineJson(await getText(`${parsed.base}/OpportunityDetail?opportunityId=${encodeURIComponent(id)}`), /CandidateOpportunityDetail\(\s*/)?.Description || null; },
  },

  // ---- Interfolio (Faculty Search): a public JSON job board per institution, descriptions included.
  interfolio: {
    parse(raw) {
      const u = urlOf(raw);
      if (!u || !/^apply\.interfolio\.com$/i.test(u.hostname)) return null;
      const m = u.pathname.match(/^\/(\d+)\/positions/i);
      if (!m) return null;
      return { slug: m[1], institution: m[1], careerUrl: `https://apply.interfolio.com/${m[1]}/positions`, api: `https://logic.interfolio.com/byc-search/${m[1]}/public_job_boards` };
    },
    adapter(parsed, h) {
      const PAGE = 50;
      return {
        pageSize: PAGE,
        fetchPage: async (offset) => {
          const data = await getJson(`${parsed.api}?limit=${PAGE}&page=${Math.floor(offset / PAGE) + 1}&search=&sort_by=open_date&sort_order=desc&unit_name=`);
          const rows = (data?.results || []).map((raw) => ({ id: raw.id != null ? String(raw.id) : null, ageDays: h.ageDaysFromIsoDate(isoDay(raw.open_date_raw), h.now), looksUS: raw.location ? h.looksUS(raw.location) : true, raw }));
          return { rows, total: data?.total ?? data?.count };
        },
        fetchDetail: async (row) => row.raw,
        keep: () => true,
      };
    },
    normalize(parsed, { id, list = {} }, h) {
      const loc = list.location ? [String(list.location).trim()] : [];
      return { title: (list.name || "").trim() || null, jobUrl: `https://apply.interfolio.com/${id}`, locParts: loc, us: loc.length ? h.looksUS(loc[0]) : true, remote: /remote/i.test(loc.join(" ")), postedDay: isoDay(list.open_date_raw), meta: list.unit_name ? { Department: list.unit_name } : {}, html: list.description || "" };
    },
    async description(parsed, id) { const d = await getJson(`https://logic.interfolio.com/dossier-api/positions/${id}`); return d?.landing_page_description || null; },
  },

  // ---- SilkRoad: paged HTML list; the job page has the posted date and description.
  silkroad: {
    parse(raw) {
      const u = urlOf(raw);
      if (!u || !/^jobs\.silkroad\.com$/i.test(u.hostname)) return null;
      const m = u.pathname.match(/^\/([^/]+)\/([^/]+)/);
      if (!m) return null;
      const base = `https://jobs.silkroad.com/${m[1]}/${m[2]}`;
      return { slug: `${m[1]}-${m[2]}`, base, careerUrl: base };
    },
    adapter(parsed, h) {
      let pageSize = 20;
      return {
        get pageSize() { return pageSize; },
        fetchPage: async (offset) => {
          const page = Math.floor(offset / pageSize) + 1;
          const html = await getText(`${parsed.base}?page=${page}`);
          const rows = [];
          for (const m of html.matchAll(/<a[^>]*id="Jobs_PagedJobList_Job-(\d+)"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
            const title = textOf((m[3].match(/class="sr-panel__title"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || "");
            const loc = textOf((m[3].match(/class="sr-panel__meta"[^>]*>([\s\S]*?)<\/span>/) || [])[1] || "");
            rows.push({ id: m[1], ageDays: null, looksUS: loc ? h.looksUS(loc) : true, raw: { id: m[1], href: decodeEntities(m[2]), title, loc } });
          }
          if (page === 1 && rows.length) pageSize = rows.length;
          const pages = Number((textOf(html).match(/Page \d+ of (\d+)/i) || [])[1]) || null;
          return { rows, total: pages ? pages * pageSize : undefined };
        },
        fetchDetail: async (row) => silkroadDetail(row.raw.href.startsWith("http") ? row.raw.href : `https://jobs.silkroad.com${row.raw.href}`),
        keep: (row, detail) => h.recentEnough(detail?.postedDay),
      };
    },
    normalize(parsed, { id, list = {}, detail }, h) {
      const loc = list.loc ? [list.loc] : [];
      return { title: list.title || detail?.title || null, jobUrl: list.href?.startsWith("http") ? list.href : `https://jobs.silkroad.com${list.href || `${new URL(parsed.base).pathname}/jobs/${id}`}`, locParts: loc, us: loc.length ? h.looksUS(loc[0]) : true, remote: /remote/i.test(loc.join(" ")), postedDay: detail?.postedDay || null, meta: detail?.meta || {}, html: detail?.html || "" };
    },
    async description(parsed, id) { return (await silkroadDetail(`${parsed.base}/jobs/${id}`))?.html || null; },
  },

  // ---- ApplicantPro: the jobs page names a domain id; a JSON API lists the board; job pages carry JSON-LD.
  applicantpro: {
    parse(raw) {
      const u = urlOf(raw);
      if (!u) return null;
      let slug = null;
      let m = u.hostname.match(/^([a-z0-9-]+)\.applicantpro\.com$/i);
      if (m && m[1] !== "www") slug = m[1];
      else if (/^(www\.)?applicantpro\.com$/i.test(u.hostname) && (m = u.pathname.match(/^\/openings\/([^/]+)/i))) slug = m[1];
      if (!slug) return null;
      slug = slug.toLowerCase();
      return { slug, base: `https://${slug}.applicantpro.com`, careerUrl: `https://${slug}.applicantpro.com/jobs/` };
    },
    adapter(parsed, h) {
      return {
        pageSize: Number.MAX_SAFE_INTEGER,
        fetchPage: async (offset) => {
          if (offset > 0) return { rows: [], total: 0 };
          const html = await getText(parsed.careerUrl);
          const domainId = (html.match(/domain_id\s*=\s*['"](\d+)['"]/) || html.match(/core\/jobs\/(\d+)/) || [])[1];
          if (!domainId) throw new Error(`ApplicantPro page has no domain id: ${parsed.careerUrl}`);
          const data = await getJson(`${parsed.base}/core/jobs/${domainId}?getParams=%7B%7D`);
          const rows = (data?.data?.jobs || []).map((raw) => ({ id: raw.id != null ? String(raw.id) : null, ageDays: h.ageDaysFromIsoDate(toIsoDay(raw.startDateRef), h.now), looksUS: raw.iso3 ? usCountry(raw.iso3, h) : true, raw }));
          return { rows, total: rows.length };
        },
        fetchDetail: async (row) => ldJobPosting(await getText(row.raw.jobUrl || `${parsed.base}/jobs/${row.id}`)),
        keep: () => true,
      };
    },
    normalize(parsed, { id, list = {}, detail }, h) {
      const locParts = [[list.city, list.abbreviation].filter(Boolean).join(", ") || list.jobLocation].filter(Boolean);
      const meta = {};
      if (list.employmentType) meta["Employment Type"] = list.employmentType;
      if (list.orgTitle) meta["Department"] = list.orgTitle;
      if (list.minSalary) meta["Pay"] = `${list.minSalary}${list.maxSalary ? `–${list.maxSalary}` : ""} ${list.payTypeFrame || ""}`.trim();
      const remote = /remote/i.test(list.workplaceType || "");
      return { title: list.title || ldText(detail?.title) || null, jobUrl: list.jobUrl || `${parsed.base}/jobs/${id}`, locParts, us: list.iso3 ? usCountry(list.iso3, h) : true, remote, workplaceType: remote ? "remote" : /hybrid/i.test(list.workplaceType || "") ? "hybrid" : null, postedDay: toIsoDay(list.startDateRef), meta, html: ldText(detail?.description) };
    },
    async description(parsed, id) { return ldText(ldJobPosting(await getText(`${parsed.base}/jobs/${id}`))?.description) || null; },
  },

  // ---- Avature: paged HTML list; the job page has "Date Posted" and the description sections.
  avature: {
    parse(raw) {
      const u = urlOf(raw);
      if (!u) return null;
      const m = u.pathname.match(/^\/(jobs|careers)(\/|$)/i);
      if (!m) return null;
      if (!/\.avature\.net$/i.test(u.hostname) && !/SearchJobs|JobDetail/i.test(u.pathname)) return null;
      const base = `${u.origin}/${m[1]}`;
      return { slug: u.hostname, base, careerUrl: base };
    },
    adapter(parsed, h) {
      const PAGE = 50;
      return {
        pageSize: PAGE,
        fetchPage: async (offset) => {
          const html = await getText(`${parsed.base}/SearchJobs/?jobRecordsPerPage=${PAGE}&jobOffset=${offset}`);
          const rows = [];
          for (const m of html.matchAll(/<li class="listSingleColumnItem">([\s\S]*?)<\/li>/g)) {
            const a = m[1].match(/class="listSingleColumnItemTitle"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
            if (!a) continue;
            const href = decodeEntities(a[1]);
            const id = (href.match(/\/(\d+)\/?$/) || [])[1];
            const misc = [...m[1].matchAll(/class="listSingleColumnItemMiscDataItem"[^>]*>([\s\S]*?)<\/span>/g)].map((x) => textOf(x[1])).filter(Boolean);
            const loc = misc.find((x) => h.looksUS(x) || /,\s*[A-Z][a-z]+/.test(x)) || null;
            rows.push({ id, ageDays: null, looksUS: loc ? h.looksUS(loc) : true, raw: { id, href, title: textOf(a[2]), misc, loc } });
          }
          const total = Number((textOf(html).match(/(\d+)\s+(?:jobs|results|positions)/i) || [])[1]) || undefined;
          return { rows, total };
        },
        fetchDetail: async (row) => avatureDetail(row.raw.href),
        keep: (row, detail) => h.recentEnough(detail?.postedDay),
      };
    },
    normalize(parsed, { id, list = {}, detail }, h) {
      const loc = list.loc ? [list.loc] : [];
      const meta = {};
      const req = (list.misc || []).find((x) => /requisition number/i.test(x));
      if (req) meta["Req ID"] = req.replace(/.*:\s*/, "");
      return { title: list.title || detail?.title || null, jobUrl: list.href || `${parsed.base}/JobDetail/${id}`, locParts: loc, us: loc.length ? h.looksUS(loc[0]) : true, remote: /remote/i.test(loc.join(" ")), postedDay: detail?.postedDay || null, meta, html: detail?.html || "" };
    },
    async description(parsed, id) { return (await avatureDetail(`${parsed.base}/JobDetail/${id}`))?.html || null; },
  },

  // ---- IBM Kenexa BrassRing (TGnewUI): a JSON search behind the search page; job pages carry JSON-LD.
  brassring: {
    parse(raw) {
      const u = urlOf(raw);
      if (!u || !/brassring\.com$/i.test(u.hostname)) return null;
      const p = u.searchParams.get("partnerid") || u.searchParams.get("PartnerId");
      const s = u.searchParams.get("siteid") || u.searchParams.get("SiteId");
      if (!p || !s) return null;
      return { slug: `${p}-${s}`, partnerId: p, siteId: s, base: u.origin, careerUrl: `${u.origin}/TGnewUI/Search/Home/Home?partnerid=${p}&siteid=${s}` };
    },
    adapter(parsed, h) {
      let session = null;
      let pageSize = 50;
      return {
        get pageSize() { return pageSize; },
        fetchPage: async (offset) => {
          if (!session) {
            const html = await getText(parsed.careerUrl);
            session = (html.match(/id="CookieValue"[^>]*value="([^"]*)"/) || [])[1] || "";
          }
          const data = await postJson(`${parsed.base}/TgNewUI/Search/Ajax/ProcessSortAndShowMoreJobs`, { partnerId: parsed.partnerId, siteId: parsed.siteId, keyword: "", location: "", keywordCustomSolrFields: "", locationCustomSolrFields: "", linkId: "", Latitude: 0, Longitude: 0, facetfilterfields: { Facet: [] }, powersearchoptions: { PowerSearchOption: [] }, SortType: "LastUpdated", pageNumber: Math.floor(offset / pageSize) + 1, encryptedSessionValue: session });
          const jobs = data?.Jobs?.Job || [];
          if (offset === 0 && jobs.length) pageSize = Math.max(jobs.length, 1);
          const rows = jobs.map((raw) => {
            const f = {};
            for (const q of raw.Questions || []) if (q.QuestionName) f[q.QuestionName.toLowerCase()] = q.Value;
            return { id: f.reqid || null, ageDays: h.ageDaysFromIsoDate(toIsoDay(f.lastupdated), h.now), looksUS: true, raw: { fields: f, link: raw.Link } };
          });
          return { rows, total: data?.JobsCount };
        },
        fetchDetail: async (row) => ldJobPosting(await getText(row.raw.link || `${parsed.careerUrl.replace("/Home/Home?", "/home/HomeWithPreLoad?")}&PageType=JobDetails&jobid=${row.id}`)),
        keep: (row, detail) => { const c = ldLocation(detail).country; return c == null || usCountry(c, h); },
      };
    },
    normalize(parsed, { id, list = {}, detail }, h) {
      const f = list.fields || {};
      const loc = ldLocation(detail);
      const locParts = loc.parts.length ? loc.parts : [f.formtext11, f.location, f.city].filter(Boolean).slice(0, 1);
      const meta = {};
      if (f.autoreq) meta["Req ID"] = f.autoreq;
      if (detail?.occupationalCategory) meta["Category"] = ldText(detail.occupationalCategory);
      return { title: ldText(detail?.title) || f.jobtitle || null, jobUrl: list.link || `${parsed.base}/TGnewUI/Search/home/HomeWithPreLoad?partnerid=${parsed.partnerId}&siteid=${parsed.siteId}&PageType=JobDetails&jobid=${id}`, locParts, us: loc.country ? usCountry(loc.country, h) : locParts.length ? h.looksUS(locParts[0]) : true, remote: /remote/i.test(locParts.join(" ")), postedDay: isoDay(detail?.datePosted) || toIsoDay(f.lastupdated), meta, html: ldText(detail?.description) || f.jobdescription || "" };
    },
    async description(parsed, id) { return ldText(ldJobPosting(await getText(`${parsed.base}/TGnewUI/Search/home/HomeWithPreLoad?partnerid=${parsed.partnerId}&siteid=${parsed.siteId}&PageType=JobDetails&jobid=${id}`))?.description) || null; },
  },

  // ---- Phenom career sites: the page's /widgets search; job pages carry JSON-LD.
  phenom: {
    parse(raw) {
      const u = urlOf(raw);
      if (!u) return null;
      const m = u.pathname.match(/^\/([a-z]{2})\/([a-z]{2})(\/|$)/i);
      const prefix = m ? `/${m[1].toLowerCase()}/${m[2].toLowerCase()}` : "/us/en";
      if (!m && !/\/widgets$/i.test(u.pathname)) return null;
      return { slug: u.hostname, base: u.origin, prefix, careerUrl: `${u.origin}${prefix}`, api: `${u.origin}/widgets` };
    },
    adapter(parsed, h) {
      const PAGE = 50;
      return {
        pageSize: PAGE,
        fetchPage: async (offset) => {
          const data = await postJson(parsed.api, { lang: "en_us", deviceType: "desktop", country: "us", pageName: "search-results", ddoKey: "refineSearch", sortBy: "Most recent", subsearch: "", from: offset, jobs: true, counts: true, all_fields: ["category", "country", "state", "city", "type"], size: PAGE, clearAll: false, jdsource: "facets", isSliderEnable: false, pageId: "page12", siteType: "external", keywords: "", global: true, selected_fields: {}, locationData: {} });
          const r = data?.refineSearch || {};
          const rows = (r.data?.jobs || []).map((raw) => ({ id: raw.jobId || raw.reqId || null, ageDays: h.ageDaysFromIsoDate(isoDay(raw.postedDate), h.now), looksUS: raw.country ? usCountry(raw.country, h) : true, raw }));
          return { rows, total: r.totalHits };
        },
        fetchDetail: async (row) => ldJobPosting(await getText(`${parsed.careerUrl}/job/${encodeURIComponent(row.id)}`)),
        keep: () => true,
      };
    },
    normalize(parsed, { id, list = {}, detail }, h) {
      const locParts = [list.cityState || [list.city, list.state].filter(Boolean).join(", ") || list.location].filter(Boolean);
      const meta = {};
      if (list.category) meta["Category"] = list.category;
      if (list.department) meta["Department"] = list.department;
      if (list.type) meta["Employment Type"] = list.type;
      const remote = /remote/i.test(`${list.type || ""} ${locParts.join(" ")}`);
      return { title: list.title || ldText(detail?.title) || null, jobUrl: `${parsed.careerUrl}/job/${encodeURIComponent(id)}`, locParts, us: list.country ? usCountry(list.country, h) : true, remote, workplaceType: remote ? "remote" : null, postedIso: list.postedDate || null, meta, html: ldText(detail?.description) || list.descriptionTeaser || "" };
    },
    async description(parsed, id) { return ldText(ldJobPosting(await getText(`${parsed.careerUrl}/job/${encodeURIComponent(id)}`))?.description) || null; },
  },

  // ---- JazzHR (applytojob.com): HTML list; job pages carry JSON-LD.
  jazzhr: {
    parse(raw) {
      const u = urlOf(raw);
      if (!u) return null;
      const m = u.hostname.match(/^([a-z0-9-]+)\.applytojob\.com$/i);
      if (!m || m[1] === "www") return null;
      return { slug: m[1].toLowerCase(), base: `https://${m[1].toLowerCase()}.applytojob.com`, careerUrl: `https://${m[1].toLowerCase()}.applytojob.com/apply` };
    },
    adapter(parsed, h) {
      return {
        pageSize: Number.MAX_SAFE_INTEGER,
        fetchPage: async (offset) => {
          if (offset > 0) return { rows: [], total: 0 };
          const html = await getText(`${parsed.careerUrl}/`);
          const rows = [];
          for (const m of html.matchAll(/<li class="list-group-item">([\s\S]*?)<\/li>\s*<\/ul>/g)) {
            const a = m[1].match(/<a[^>]*href="([^"]+\/apply\/([A-Za-z0-9]+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/);
            if (!a) continue;
            const loc = textOf((m[1].match(/fa-map-marker[^>]*><\/i>\s*([^<]+)/) || [])[1] || "");
            rows.push({ id: a[2], ageDays: null, looksUS: loc ? h.looksUS(loc) : true, raw: { id: a[2], href: decodeEntities(a[1]), title: textOf(a[3]), loc } });
          }
          return { rows, total: rows.length };
        },
        fetchDetail: async (row) => ldJobPosting(await getText(row.raw.href)),
        keep: (row, detail) => h.recentEnough(isoDay(detail?.datePosted)),
      };
    },
    normalize(parsed, { id, list = {}, detail }, h) {
      const ld = ldLocation(detail);
      const locParts = list.loc ? [list.loc] : ld.parts;
      const meta = {};
      if (detail?.employmentType) meta["Employment Type"] = ldText(detail.employmentType);
      return { title: list.title || ldText(detail?.title) || null, jobUrl: list.href || `${parsed.careerUrl}/${id}`, locParts, us: ld.country ? usCountry(ld.country, h) : locParts.length ? h.looksUS(locParts[0]) : true, remote: /remote/i.test(locParts.join(" ")), postedDay: isoDay(detail?.datePosted), meta, html: ldText(detail?.description) };
    },
    async description(parsed, id) { return ldText(ldJobPosting(await getText(`${parsed.careerUrl}/${id}`))?.description) || null; },
  },

  // ---- Breezy HR: a JSON list at /json; the position page embeds the description.
  breezy: {
    parse(raw) {
      const u = urlOf(raw);
      if (!u) return null;
      const m = u.hostname.match(/^([a-z0-9-]+)\.breezy\.hr$/i);
      if (!m || /^(www|app|api)$/i.test(m[1])) return null;
      const slug = m[1].toLowerCase();
      return { slug, base: `https://${slug}.breezy.hr`, careerUrl: `https://${slug}.breezy.hr`, listUrl: `https://${slug}.breezy.hr/json` };
    },
    adapter(parsed, h) {
      return {
        pageSize: Number.MAX_SAFE_INTEGER,
        fetchPage: async (offset) => {
          if (offset > 0) return { rows: [], total: 0 };
          const list = await getJson(parsed.listUrl);
          const rows = (Array.isArray(list) ? list : []).map((raw) => ({ id: raw.id || null, ageDays: h.ageDaysFromIsoDate(isoDay(raw.published_date), h.now), looksUS: raw.location?.country?.id ? usCountry(raw.location.country.id, h) : true, raw }));
          return { rows, total: rows.length };
        },
        fetchDetail: async (row) => breezyDetail(row.raw.url || `${parsed.base}/p/${row.raw.friendly_id || row.id}`),
        keep: () => true,
      };
    },
    normalize(parsed, { id, list = {}, detail }, h) {
      const l = list.location || {};
      const locParts = [[l.city, l.state?.id || l.state?.name].filter(Boolean).join(", ") || l.name].filter(Boolean);
      const remote = Boolean(l.is_remote) || /remote/i.test(locParts.join(" "));
      const meta = {};
      if (list.type?.name) meta["Employment Type"] = list.type.name;
      if (list.department) meta["Department"] = list.department;
      return { title: list.name || null, jobUrl: list.url || `${parsed.base}/p/${list.friendly_id || id}`, locParts, us: l.country?.id ? usCountry(l.country.id, h) : true, remote, workplaceType: remote ? "remote" : null, postedIso: list.published_date || null, meta, html: detail?.description || "" };
    },
    async description(parsed, id) { return (await breezyDetail(`${parsed.base}/p/${id}`))?.description || null; },
  },

  // ---- SAP SuccessFactors "Unify" career sites: a JSON search behind /search/; job pages are server-rendered.
  successfactors: {
    parse(raw) {
      const u = urlOf(raw);
      if (!u) return null;
      if (!/^\/(search\/?$|services\/recruiting\/v1\/jobs|[^/]+\/job\/)/i.test(u.pathname)) return null;
      return { slug: u.hostname, base: u.origin, careerUrl: `${u.origin}/search/`, api: `${u.origin}/services/recruiting/v1/jobs` };
    },
    adapter(parsed, h) {
      const PAGE = 10;
      return {
        pageSize: PAGE,
        fetchPage: async (offset) => {
          const data = await postJson(parsed.api, { locale: "en_US", pageNumber: Math.floor(offset / PAGE) + 1, sortBy: "referencedate_desc" });
          const rows = (data?.jobSearchResult || []).map((x) => x.response || {}).map((raw) => ({ id: raw.id != null ? String(raw.id) : null, ageDays: h.ageDaysFromIsoDate(toIsoDay(raw.unifiedStandardStart), h.now), looksUS: true, raw }));
          return { rows, total: data?.totalJobs };
        },
        fetchDetail: async (row) => sfDetail(sfJobUrl(parsed, row.raw)),
        keep: (row, detail) => !detail?.country || usCountry(detail.country, h),
      };
    },
    normalize(parsed, { id, list = {}, detail }, h) {
      const locParts = [detail?.location || [list.city, list.state].filter(Boolean).join(", ")].filter(Boolean);
      const meta = {};
      if (Array.isArray(list.cat) && list.cat.length) meta["Category"] = list.cat.join(", ");
      return { title: list.unifiedStandardTitle || detail?.title || null, jobUrl: sfJobUrl(parsed, { ...list, id }), locParts, us: detail?.country ? usCountry(detail.country, h) : locParts.length ? h.looksUS(locParts[0]) || true : true, remote: /remote/i.test(locParts.join(" ")), postedDay: toIsoDay(list.unifiedStandardStart), meta, html: detail?.html || "" };
    },
    async description() { return null; },
  },
};

// ---------------------------------------------------------------- per-platform helpers

async function peopleAdminDetail(url) {
  const html = await getText(url);
  const fields = {};
  for (const m of html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) {
    const k = textOf(m[1]).replace(/:$/, "");
    if (k && !(k in fields)) fields[k] = textOf(m[2]);
  }
  const desc = ["Job Summary", "Job Description", "Description", "Responsibilities", "Duties", "Duties and Responsibilities", "Minimum Qualifications", "Preferred Qualifications", "Qualifications", "Required Qualifications", "Essential Functions"]
    .filter((k) => fields[k]).map((k) => `<p><b>${k}</b></p><p>${fields[k]}</p>`).join("\n");
  return { fields, html: desc };
}

function neogovAge(posted, h) {
  const s = String(posted || "");
  if (/today/i.test(s)) return 0;
  const d = s.match(/(\d+)\s+day/i);
  if (d) return Number(d[1]);
  if (/yesterday/i.test(s)) return 1;
  return h.ageDaysFromIsoDate(toIsoDay(s.replace(/^Posted:?\s*/i, "")), h.now);
}

function adpLooksUS(req, h) {
  const locs = req?.requisitionLocations || [];
  if (!locs.length) return true;
  return locs.some((l) => {
    const c = l.address?.countryCode || (l.nameCode?.shortName || "").trim().split(/,\s*/).pop();
    return c ? usCountry(c, h) !== false : h.looksUS(l.nameCode?.shortName || "");
  });
}

function ukgLooksUS(o, h) {
  const locs = o?.Locations || [];
  if (!locs.length) return true;
  return locs.some((l) => { const c = l.Address?.Country?.Code || l.Address?.Country?.Name; return c ? usCountry(c, h) : true; });
}

function taleoLocations(col) {
  const s = String(col || "").trim();
  if (!s) return [];
  if (s.startsWith("[")) { try { return JSON.parse(s).map((x) => String(x).replace(/-/g, ", ")); } catch { /* fall through */ } }
  return [s.replace(/-/g, ", ")];
}

/** Parse a JSON object literal that follows `prefix` in a page's inline script. */
function inlineJson(html, prefix) {
  const m = String(html || "").match(prefix);
  if (!m) return null;
  let i = m.index + m[0].length;
  const s = String(html);
  if (s[i] !== "{" && s[i] !== "[") return null;
  const open = s[i];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (inStr) { if (ch === "\\") j++; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) { try { return JSON.parse(s.slice(i, j + 1)); } catch { return null; } } }
  }
  return null;
}

async function silkroadDetail(url) {
  const html = await getText(url);
  const text = textOf(html);
  const postedDay = toIsoDay((text.match(/Posted Date\s+(\d{1,2}\/\d{1,2}\/\d{4})/i) || [])[1]);
  const body = (html.match(/class="sr-job-detail__description"[^>]*>([\s\S]*?)(?:<div class="sr-job-detail__cta"|<footer|<\/main)/) || [])[1] || "";
  const title = textOf((html.match(/class="sr-job-detail__job-title"[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || "");
  const meta = {};
  const grade = text.match(/Salary Grade\s+(Grade \d+)/i);
  if (grade) meta["Salary Grade"] = grade[1];
  return { postedDay, html: body, title: title || null, meta };
}

async function avatureDetail(url) {
  const html = await getText(url);
  const fields = {};
  for (const m of html.matchAll(/<p class="fieldSetLabel">([\s\S]*?)<\/p>\s*<div class="fieldSetValue">([\s\S]*?)<\/div>/g)) {
    const k = textOf(m[1]).replace(/:$/, "");
    if (k) fields[k] = m[2];
  }
  const postedDay = toIsoDay(textOf(fields["Date Posted"] || fields["Posted"] || ""));
  // Accordion sections: <h3 class="js-accordion__header">Heading</h3><div class="jobDetailDescription …">body</div>
  const main = [...html.matchAll(/<h3 class="js-accordion__header"[^>]*>([\s\S]*?)<\/h3>\s*<div[^>]*class="jobDetailDescription[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g)]
    .map((m) => `<p><b>${textOf(m[1])}</b></p>${m[2]}`).join("\n");
  const sections = Object.entries(fields).filter(([k]) => !/date|requisition|location|posted|^$/i.test(k)).map(([k, v]) => `<p><b>${k}</b></p>${v}`).join("\n");
  const title = textOf((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || "");
  return { postedDay, html: [main, sections].filter((x) => textOf(x)).join("\n"), title: title || null };
}

async function breezyDetail(url) {
  const html = await getText(url);
  const m = html.match(/"description":"((?:[^"\\]|\\.)*)"/);
  let description = null;
  if (m) { try { description = JSON.parse(`"${m[1]}"`); } catch { description = null; } }
  if (!description) description = (html.match(/<div[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/) || [])[1] || null;
  return { description };
}

function sfJobUrl(parsed, raw) {
  const brand = raw.brandUrl || "default";
  const slug = raw.unifiedUrlTitle || raw.urlTitle || "job";
  return `${parsed.base}/${brand}/job/${slug}/${raw.id}-en_US`;
}

async function sfDetail(url) {
  const html = await getText(url);
  const ld = ldJobPosting(html);
  if (ld) { const loc = ldLocation(ld); return { title: ldText(ld.title), html: ldText(ld.description), location: loc.parts[0] || null, country: loc.country }; }
  const body = (html.match(/class="jobDisplay"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/) || html.match(/class="jobdescription"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || "";
  const text = textOf(html);
  const location = (text.match(/Location:\s*([^|]{3,60}?)(?:\s{2,}|Date|Start Date|$)/) || [])[1]?.trim() || null;
  return { title: null, html: body, location, country: null };
}

// ---------------------------------------------------------------- public API

const SOURCES = Object.keys(ADAPTERS);
const has = (source) => Object.prototype.hasOwnProperty.call(ADAPTERS, String(source || "").toLowerCase());

function parse(source, url) {
  const a = ADAPTERS[String(source || "").toLowerCase()];
  if (!a) return null;
  try { return a.parse(String(url || "").trim()); } catch { return null; }
}

/** Build the { fetchPage, fetchDetail, keep, pageSize } trio fetchNewJobsById expects. */
function adapter(source, parsed, h) {
  const a = ADAPTERS[String(source || "").toLowerCase()];
  if (!a) throw new Error(`No adapter for ${source}`);
  const helpers = { ...h, recentEnough: h.recentEnough || ((day) => { const age = h.ageDaysFromIsoDate(day, h.now); return age == null || age <= (h.maxAge ?? 3) + 1; }) };
  return a.adapter(parsed, helpers);
}

function normalize(source, parsed, raw, h) {
  const a = ADAPTERS[String(source || "").toLowerCase()];
  if (!a) return null;
  const n = a.normalize(parsed, raw, h);
  return { title: null, jobUrl: null, locParts: [], us: true, remote: false, workplaceType: null, postedIso: null, postedDay: null, meta: {}, html: "", ...n, locParts: (n.locParts || []).map((x) => String(x).trim()).filter(Boolean) };
}

async function description(source, parsed, externalId, h) {
  const a = ADAPTERS[String(source || "").toLowerCase()];
  if (!a) return null;
  return a.description(parsed, externalId, h);
}

/** Which adapter claims a pasted URL, if any (for the Feeds page and discovery scripts). */
function detect(url) {
  for (const s of SOURCES) { const p = parse(s, url); if (p) return { source: s, parsed: p }; }
  return null;
}

module.exports = { SOURCES, has, parse, adapter, normalize, description, detect, __internals: { ldJobPosting, ldLocation, toIsoDay, inlineJson, textOf, decodeEntities, taleoLocations, neogovAge } };
