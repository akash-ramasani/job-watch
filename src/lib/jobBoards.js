// Lever, Workable, SmartRecruiters and BambooHR feeds: the company's public
// careers page, pasted as a URL (or just its slug). Mirrors parseBoardFeedUrl
// in functions/index.js, which derives the JSON endpoints from the same URL.
//
//   lever            https://jobs.lever.co/<company>            (EU: jobs.eu.lever.co)
//   workable         https://apply.workable.com/<account>
//   smartrecruiters  https://jobs.smartrecruiters.com/<CompanyId>
//   bamboohr         https://<company>.bamboohr.com/careers

export const BOARD_SOURCES = ["lever", "workable", "smartrecruiters", "bamboohr"];

export const BOARD_RULES = {
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
