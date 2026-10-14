// Lever, Workable, SmartRecruiters and BambooHR feeds: the company's public
// careers page, pasted as a URL (or just its slug). Mirrors parseBoardFeedUrl
// in functions/index.js, which derives the JSON endpoints from the same URL.
//
//   lever            https://jobs.lever.co/<company>            (EU: jobs.eu.lever.co)
//   workable         https://apply.workable.com/<account>
//   smartrecruiters  https://jobs.smartrecruiters.com/<CompanyId>
//   bamboohr         https://<company>.bamboohr.com/careers

// Platforms handled by functions/lib/boards.cjs. The pasted career-site URL is
// kept as the feed URL; the backend derives the listing endpoint from it.
export const EXTRA_BOARD_RULES = {
  peopleadmin: { title: "PeopleAdmin", placeholder: "https://<school>.peopleadmin.com/postings/search", example: "e.g. University of Utah, UAB", test: (u) => /\.peopleadmin\.com/i.test(u.hostname) || /^\/postings(\/|$)/i.test(u.pathname) },
  neogov: { title: "NEOGOV", placeholder: "https://www.governmentjobs.com/careers/<agency>", example: "e.g. University of Hawaii, Cal State", test: (u) => /(governmentjobs|schooljobs)\.com$/i.test(u.hostname) && /^\/careers\/[^/]+/i.test(u.pathname) },
  paycom: { title: "Paycom", placeholder: "https://www.paycomonline.net/v4/ats/web.php/jobs?clientkey=<KEY>", example: "e.g. University of Kansas", test: (u) => /paycomonline\.net$/i.test(u.hostname) && (u.searchParams.has("clientkey") || /\/portal\//i.test(u.pathname)) },
  adp: { title: "ADP Workforce Now", placeholder: "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=<cid>&ccId=<ccId>", example: "e.g. UT Health, University of Arizona", test: (u) => /workforcenow\.adp\.com$/i.test(u.hostname) && u.searchParams.has("cid") },
  pageup: { title: "PageUp", placeholder: "https://<x>.pageuppeople.com/<n>/ci/en-us/listing", example: "e.g. Virginia Tech", test: (u) => /pageuppeople\.com$/i.test(u.hostname) || /^\/[a-z]{2}-[a-z]{2}\/(listing|rss)/i.test(u.pathname) },
  icims: { title: "iCIMS", placeholder: "https://<company>.icims.com/jobs/search", example: "e.g. OHSU, Emory", test: (u) => /\.icims\.com$/i.test(u.hostname) && !/^(www|login)\./i.test(u.hostname) },
  cornerstone: { title: "Cornerstone", placeholder: "https://<corp>.csod.com/ux/ats/careersite/<n>/home?c=<corp>", example: "e.g. University of Arizona", test: (u) => /\.csod\.com$/i.test(u.hostname) && /\/ux\/ats\/careersite\/\d+/i.test(u.pathname) },
  paylocity: { title: "Paylocity", placeholder: "https://recruiting.paylocity.com/recruiting/jobs/All/<guid>/<Company>", example: "e.g. A.T. Still University", test: (u) => /recruiting\.paylocity\.com$/i.test(u.hostname) && /\/recruiting\/jobs\/(All|List)\//i.test(u.pathname) },
  taleo: { title: "Taleo", placeholder: "https://<org>.taleo.net/careersection/<n>/jobsearch.ftl", example: "e.g. UT Southwestern", test: (u) => /\.taleo\.net$/i.test(u.hostname) },
  ukg: { title: "UKG Pro", placeholder: "https://recruiting2.ultipro.com/<tenant>/JobBoard/<guid>/", example: "e.g. Scripps Research", test: (u) => /(\.ultipro\.com|\.ukg\.net)$/i.test(u.hostname) && /\/JobBoard\//i.test(u.pathname) },
  interfolio: { title: "Interfolio", placeholder: "https://apply.interfolio.com/<institution>/positions", example: "e.g. University of Oklahoma", test: (u) => /^apply\.interfolio\.com$/i.test(u.hostname) && /^\/\d+\/positions/i.test(u.pathname) },
  silkroad: { title: "SilkRoad", placeholder: "https://jobs.silkroad.com/<Company>/<Site>", example: "e.g. Boston University", test: (u) => /^jobs\.silkroad\.com$/i.test(u.hostname) && /^\/[^/]+\/[^/]+/.test(u.pathname) },
  applicantpro: { title: "ApplicantPro", placeholder: "https://<company>.applicantpro.com/jobs/", example: "e.g. PAVIR, Niagara University", test: (u) => /applicantpro\.com$/i.test(u.hostname) },
  avature: { title: "Avature", placeholder: "https://<company>.avature.net/jobs", example: "e.g. University of Colorado", test: (u) => /\.avature\.net$/i.test(u.hostname) || /SearchJobs|JobDetail/i.test(u.pathname) },
  brassring: { title: "BrassRing", placeholder: "https://sjobs.brassring.com/TGnewUI/Search/Home/Home?partnerid=<p>&siteid=<s>", example: "e.g. Texas Tech, University of Kansas", test: (u) => /brassring\.com$/i.test(u.hostname) && u.searchParams.has("partnerid") },
  phenom: { title: "Phenom", placeholder: "https://careers.<company>.com/us/en", example: "e.g. Yale, UVA", test: (u) => /^\/[a-z]{2}\/[a-z]{2}(\/|$)/i.test(u.pathname) },
  jazzhr: { title: "JazzHR", placeholder: "https://<company>.applytojob.com/apply", example: "e.g. University of Mary", test: (u) => /\.applytojob\.com$/i.test(u.hostname) },
  breezy: { title: "Breezy HR", placeholder: "https://<company>.breezy.hr", example: "e.g. Reed College", test: (u) => /\.breezy\.hr$/i.test(u.hostname) },
  successfactors: { title: "SuccessFactors", placeholder: "https://careers.<company>.com/search/", example: "e.g. Purdue", test: (u) => /^\/search\/?$/i.test(u.pathname) || /\/job\//i.test(u.pathname) },
};
export const EXTRA_BOARD_SOURCES = Object.keys(EXTRA_BOARD_RULES);

export const BOARD_SOURCES = ["lever", "workable", "smartrecruiters", "bamboohr", ...EXTRA_BOARD_SOURCES];

export const BOARD_RULES = {
  ...Object.fromEntries(EXTRA_BOARD_SOURCES.map((id) => [id, { title: EXTRA_BOARD_RULES[id].title, label: `${EXTRA_BOARD_RULES[id].title} Careers Page URL`, placeholder: EXTRA_BOARD_RULES[id].placeholder, example: EXTRA_BOARD_RULES[id].example }])),
  lever: {
    title: "Lever",
    label: "Lever Careers Page URL",
    placeholder: "https://jobs.lever.co/<company>",
    example: "e.g. Palantir, Plaid, Mistral",
  },
  workable: {
    title: "Workable",
    label: "Workable Careers Page URL",
    placeholder: "https://apply.workable.com/<company>",
    example: "e.g. Design Pickle, Fullmind",
  },
  smartrecruiters: {
    title: "SmartRecruiters",
    label: "SmartRecruiters Careers Page URL",
    placeholder: "https://jobs.smartrecruiters.com/<CompanyId>",
    example: "e.g. ServiceNow, Western Digital, Experian",
  },
  bamboohr: {
    title: "BambooHR",
    label: "BambooHR Careers Page URL",
    placeholder: "https://<company>.bamboohr.com/careers",
    example: "e.g. RF|Binder",
  },
};

/** { slug, careerUrl, apiUrl, probe? } or null when the URL isn't that board's careers page. */
export function parseBoardCareerUrl(source, raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const bare = /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(text) ? text : null;
  let host = "";
  let parts = [];
  if (!bare) {
    let u;
    try {
      u = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
      return null;
    }
    host = u.hostname.toLowerCase();
    parts = u.pathname.split("/").filter(Boolean);
  }

  if (EXTRA_BOARD_RULES[source]) {
    if (bare) return null;
    const u = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!EXTRA_BOARD_RULES[source].test(u)) return null;
    // The sync derives the listing endpoint; the first run verifies the site.
    return { slug: u.hostname, careerUrl: u.href.replace(/[#].*$/, ""), apiUrl: null };
  }

  if (source === "lever") {
    const eu = /(^|\.)eu\.lever\.co$/.test(host);
    let slug = bare;
    if (/^jobs\.(eu\.)?lever\.co$/.test(host)) slug = parts[0];
    else if (/^api\.(eu\.)?lever\.co$/.test(host) && parts[0] === "v0" && parts[1] === "postings") slug = parts[2];
    if (!slug) return null;
    const apiUrl = `https://api.${eu ? "eu." : ""}lever.co/v0/postings/${slug}?mode=json`;
    return {
      slug,
      careerUrl: `https://jobs.${eu ? "eu." : ""}lever.co/${slug}`,
      apiUrl,
      // The board comes with descriptions, so count at most 100.
      probe: { url: `${apiUrl}&limit=100`, count: (json) => (Array.isArray(json) ? json.length : 0), cap: 100 },
    };
  }

  if (source === "workable") {
    let slug = bare;
    if (host === "apply.workable.com") {
      if (parts[0] === "api") slug = parts[parts.indexOf("accounts") + 1] || null;
      else if (parts[0] !== "j") slug = parts[0];
    } else if (/^[a-z0-9-]+\.workable\.com$/.test(host) && !/^(www|apply|jobs)\./.test(host)) {
      slug = host.split(".")[0];
    }
    if (!slug || parts[0] === "j") return null;
    slug = slug.toLowerCase();
    const apiUrl = `https://apply.workable.com/api/v1/widget/accounts/${slug}`;
    return {
      slug,
      careerUrl: `https://apply.workable.com/${slug}`,
      apiUrl,
      probe: { url: apiUrl, count: (json) => (Array.isArray(json?.jobs) ? json.jobs.length : 0) },
    };
  }

  if (source === "smartrecruiters") {
    let slug = bare;
    if (/^(jobs|careers)\.smartrecruiters\.com$/.test(host)) slug = parts[0];
    else if (host === "api.smartrecruiters.com" && parts[1] === "companies") slug = parts[2];
    if (!slug) return null;
    const apiUrl = `https://api.smartrecruiters.com/v1/companies/${slug}/postings`;
    return {
      slug,
      careerUrl: `https://jobs.smartrecruiters.com/${slug}`,
      apiUrl,
      // Only US postings are synced; an unknown company ID also answers with 0.
      probe: { url: `${apiUrl}?country=us&limit=1`, count: (json) => Number(json?.totalFound) || 0, unit: "US jobs" },
    };
  }

  if (source === "bamboohr") {
    let slug = bare ? bare.toLowerCase() : null;
    const m = host.match(/^([a-z0-9-]+)\.bamboohr\.com$/);
    if (m && !["www", "api", "app"].includes(m[1])) slug = m[1];
    if (!slug) return null;
    // BambooHR sends no CORS headers: the first sync verifies it.
    return { slug, careerUrl: `https://${slug}.bamboohr.com/careers`, apiUrl: `https://${slug}.bamboohr.com/careers/list` };
  }
  return null;
}
