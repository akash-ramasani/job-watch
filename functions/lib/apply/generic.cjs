// generic.cjs — compute an application for any job board the extension can
// scan: Workday, iCIMS, SmartRecruiters, Workable, BambooHR, Taleo,
// SuccessFactors, Oracle Recruiting Cloud, Jobvite, and plain HTML forms on a
// company's own careers site.
//
// The content script (extension/lib/generic-dom.js scan()) reads the fields off
// the page, including custom widgets (Workday's listbox buttons and prompt
// pickers, ARIA comboboxes), and sends them here as
// { id, label, description, type, required, options:[{label, value}] }.
// Same engine as Ashby, Greenhouse and Lever: profile facts, rules, AI only for
// free text in the plain style, compliance from the profile only, the
// four-pass gate, and a review list of what still needs the person.
//
// On top of the engine, a few board fields the engine has no key for are
// answered here (phone device type, phone country code, "I have a preferred
// name", the self-identification date), and the resume's roles, schools and
// links go back to the content script for Workday's My Experience page.

const { buildProfileForJob, ashbyToQuestions, domFieldsToSections, fillsFrom, locationFill, parsePlace } = require("./ashby.cjs");
const { applicationResume } = require("./applicationResume.cjs");
const { nationalPhone } = require("./prepare.cjs");
const { aiContext, answerFreeText, pool } = require("./ai-text.cjs");

const DEFAULT_FETCH = (...a) => fetch(...a);

let _engine;
async function engine() {
  if (_engine) return _engine;
  const [ae, fk, vf, st] = await Promise.all([
    import("./answer-engine.mjs"),
    import("./fieldkind.mjs"),
    import("./verify.mjs"),
    import("./style.mjs"),
  ]);
  _engine = { startDateFor: ae.startDateFor, mapForm: ae.mapForm, aiTrapIn: ae.aiTrapIn, BARE_LINKS: ae.BARE_LINKS, fieldKind: fk.fieldKind, verifyFourTimes: vf.verifyFourTimes, sanitizeText: st.sanitizeText, sanitizeBlock: st.sanitizeBlock, STYLE_PROMPT: st.STYLE_PROMPT, readability: st.readability };
  return _engine;
}

const stripHtml = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, " ").trim();
const nrm = (s) => String(s || "").replace(/[*✱]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

// ── Workday posting ─────────────────────────────────────────────────────────

/**
 * The CXS endpoint behind a Workday posting or apply URL, or null:
 *   https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Engineer_JR1/apply/applyManually
 *   https://wd1.myworkdaysite.com/recruiting/acme/External/job/Remote/Analyst_R-1
 * -> https://<host>/wday/cxs/<tenant>/<site>/job/<location>/<slug>
 */
function workdayPostingApi(url) {
  let u;
  try { u = new URL(String(url || "")); } catch { return null; }
  const parts = u.pathname.split("/").filter(Boolean);
  let tenant = "";
  const host = u.hostname.toLowerCase();
  const m = host.match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/);
  if (m) tenant = m[1];
  else if (/\.myworkdaysite\.com$/.test(host) && parts[0] === "recruiting") { parts.shift(); tenant = parts.shift() || ""; }
  else return null;
  if (parts.length && /^[a-z]{2}-[a-z]{2}$/i.test(parts[0])) parts.shift();
  const site = parts.shift();
  if (!tenant || !site) return null;
  const kind = parts.shift();
  if (kind !== "job" && kind !== "details") return null;
  const end = parts.findIndex((p) => p === "apply");
  const rest = (end >= 0 ? parts.slice(0, end) : parts).filter(Boolean);
  if (!rest.length) return null;
  const slug = rest[rest.length - 1];
  return {
    tenant,
    site,
    url: `https://${u.hostname}/wday/cxs/${tenant}/${site}/job/${rest.map(encodeURIComponent).join("/")}`,
    reqId: (slug.match(/_([A-Za-z0-9-]+)$/) || [])[1] || slug,
  };
}

/** Title, company, location and description of a Workday posting. */
async function fetchWorkdayPosting(url, fetchFn = DEFAULT_FETCH) {
  const api = workdayPostingApi(url);
  if (!api) return null;
  const r = await fetchFn(api.url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`workday posting ${api.url} -> ${r.status}`);
  const d = await r.json();
  const info = d.jobPostingInfo || {};
  return {
    title: info.title || "",
    // "CN03 NVIDIA SemiconductorChina" -> "NVIDIA SemiconductorChina"; the feed's name wins when known.
    companyName: String(d.hiringOrganization?.name || "").replace(/^[A-Z]{2}\d{2,3}\s+/, "").trim(),
    locationName: [info.location, ...(info.additionalLocations || [])].filter(Boolean).join("; "),
    workplaceType: info.remoteType || "",
    descriptionHtml: info.jobDescription || "",
    reqId: info.jobReqId || api.reqId,
  };
}

// ── Board fields the engine has no key for ──────────────────────────────────

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Pick the option whose label matches one of `wants` (in order of preference). */
function pickOption(q, wants) {
  const opts = q.fields?.[0]?.values || [];
  for (const w of wants) {
    const re = w instanceof RegExp ? w : new RegExp(`^${String(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    const hit = opts.find((o) => re.test(String(o.label).trim()));
    if (hit) return hit.label;
  }
  return null;
}

/**
 * A fill for a field the engine would park or get wrong, or null to let the
 * engine answer it. `dom` is the scanned field.
 */
function presetFill(q, dom, profile, startDateFor = null, { source = "" } = {}) {
  const l = nrm(q.label);
  const base = { path: q.path, label: q.label, source: "rule" };
  const hasOpts = (dom.options || []).length > 0;
  // Workday: "Phone Device Type" (Mobile / Home / Work).
  if (/phone (device )?type|type of phone/.test(l) && hasOpts) {
    const v = pickOption(q, [/^mobile$/i, /^cell/i, /mobile/i, /cell/i, /personal/i]);
    return v ? { ...base, kind: "select", value: v } : null;
  }
  // "Country Phone Code": the country the number belongs to.
  if (/country (phone )?code|phone country|country\/region phone code|dialing code/.test(l)) {
    const country = profile.country || "United States";
    const us = /^(us|usa|united states( of america)?)$/i.test(country);
    if (hasOpts) {
      const v = pickOption(q, us ? [/^united states of america \(\+1\)$/i, /^united states.*\+1/i, /^\+?1\b.*united states/i, /united states/i] : [new RegExp(country, "i")]);
      return v ? { ...base, kind: "select", value: v } : null;
    }
    return { ...base, kind: "typeahead", value: us ? "United States of America" : country, match: us ? "United States of America (+1)" : country };
  }
  // "How did you hear" as a search picker (Workday's category tree: "Online
  // Source" > LinkedIn / Indeed / Glassdoor). Workday picks a board the moment
  // its exact name is searched, so the names come first, then the categories
  // offered, browsed down to the same names (State Street, 2026-11-10).
  if (dom.widget === "typeahead" && /how did you (hear|find|learn)|hear about|referral source|^source$/.test(l)) {
    const heard = profile.heardAboutUs || "LinkedIn";
    const cats = (dom.options || []).map((o) => o.label);
    const boards = ["LinkedIn", "Indeed", "Glassdoor", "Company Website", "Careers Website", "Company Careers Site"];
    // Categories to browse: the plain ones first, never a region's own boards ("Online Source - Asia Job Boards").
    const regional = /asia|europe|emea|apac|latam|latin|china|india|japan|poland|canada|uk\b|mexico|brazil|germany|france/i;
    const prefer = [/^(online )?job boards?$|^job sites?$/i, /^online( source)?$|^internet$|^(company )?website$|^web ?site$/i, /^social media$/i, /job board|online|internet|website|web site/i, /social/i, /^other$/i];
    const alternates = [...boards, ...prefer.map((re) => cats.find((c) => re.test(c) && !regional.test(c))).filter(Boolean), "Job Board", "Social Media", "Other"];
    return { ...base, kind: "typeahead", value: heard, match: heard, alternates: [...new Set(alternates)] };
  }
  // Workday "Type to Add Skills" (required on My Experience): a search that
  // lists matches without picking one. The resume's short, standard skill
  // names, each searched and picked only on an exact match (State Street).
  if (dom.widget === "typeahead" && /^(type to add )?skills?$|^add skills$/.test(l)) {
    const skills = (profile.skills || []).map((x) => String(x || "").trim())
      .filter((x) => x && x.length <= 24 && !/[(),/]/.test(x) && x.split(/\s+/).length <= 3);
    return skills.length ? { ...base, kind: "multi", values: [...new Set(skills)].slice(0, 10) } : null;
  }
  // Workday asks the phone's country in its own box: the number alone, 10 digits.
  if (source === "workday" && /^(phone number|phone|mobile( phone)?( number)?)$/.test(l) && profile.phone) {
    return { ...base, kind: "text", value: nationalPhone(profile.phone) };
  }
  // "Date Available" / "Earliest start date" as a date or mm/dd/yyyy box: the
  // engine's start date (next Monday, or the person's own date).
  if (startDateFor && ["date", "text"].includes(dom.type) && /^(date available|available (start )?date|availability date|earliest (possible )?start date|(desired |preferred |anticipated )?start date|when can you start)\??$/.test(l)) {
    const [y, m, d] = startDateFor(profile).split("-");
    return { ...base, kind: "date", value: `${m}/${d}/${y}`, iso: `${y}-${m}-${d}` };
  }
  // "Phone Extension": blank.
  if (/^(phone )?extension$/.test(l)) return { ...base, kind: "skip" };
  // "I have a preferred name": unchecked unless the person has one.
  if (/^i have a preferred name/.test(l)) return { ...base, kind: "boolean", value: profile.preferredName ? "Yes" : "No" };
  // Self-identification forms: "Date" / "Today's Date" next to the signature name.
  if (/^(today'?s )?date$|^signature date$|^date signed$|^date \(mm\/dd\/yyyy\)$/.test(l)) {
    const [y, m, d] = String(profile.todayISO || new Date().toISOString().slice(0, 10)).split("-");
    return { ...base, kind: "date", value: `${m}/${d}/${y}`, iso: `${y}-${m}-${d}` };
  }
  // "Country" as Workday's address-country listbox: the full country name.
  if (/^country$|^country\/territory$|^country\/region$/.test(l) && hasOpts) {
    const country = profile.country || "United States";
    const us = /^(us|usa|united states( of america)?)$/i.test(country);
    const v = pickOption(q, us ? [/^united states of america$/i, /^united states$/i, /^usa$/i, /^us$/i, /united states/i] : [new RegExp(`^${country}$`, "i"), new RegExp(country, "i")]);
    return v ? { ...base, kind: "select", value: v } : null;
  }
  // State as a picker (Workday "State", iCIMS "State/Province"): full name, then code.
  if (/^(state|state\/province|province|state or province|region)$/.test(l) && hasOpts) {
    const place = parsePlace([profile.city, profile.region || profile.state].filter(Boolean).join(", "));
    if (place) {
      const v = pickOption(q, [place.state, place.abbr, new RegExp(`^${place.state}\\b`, "i")].filter(Boolean));
      if (v) return { ...base, kind: "select", value: v };
    }
  }
  return null;
}

/** The engine's text answer for a field shown as a search-as-you-type picker. */
function typeaheadFrom(fill) {
  if (fill.kind !== "text" || !fill.value) return fill;
  // Workday's "How did you hear" is a category tree (Job Board > LinkedIn):
  // when the search finds nothing, these categories are tried in turn.
  const alternates = /hear about|how did you (find|learn)|referral source|source/i.test(fill.label)
    ? ["Job Board", "Social Media", "Online Job Board", "Internet", "Company Website", "Other"] : [];
  return { ...fill, kind: "typeahead", match: fill.value, alternates };
}

// ── Resume history for Workday's My Experience page ─────────────────────────

/** "Jan 2024" / "2024-01" / "01/2024" / "2024" -> { month: 1..12 | null, year } or null. */
function parseMonthYear(s) {
  const t = String(s || "").trim();
  if (!t || /present|current|now/i.test(t)) return null;
  let m = t.match(/^(\d{4})-(\d{1,2})/);
  if (m) return { year: Number(m[1]), month: Number(m[2]) };
  m = t.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return { year: Number(m[2]), month: Number(m[1]) };
  m = t.match(/([A-Za-z]{3,})\.?\s+(\d{4})/);
  if (m) {
    const i = MONTHS.findIndex((x) => x.toLowerCase().startsWith(m[1].toLowerCase().slice(0, 3)));
    return { year: Number(m[2]), month: i >= 0 ? i + 1 : null };
  }
  m = t.match(/(\d{4})/);
  return m ? { year: Number(m[1]), month: null } : null;
}

function historyOf(resume, user) {
  const roles = (resume.roles || resume.experience || []).slice(0, 8).map((r) => {
    const from = parseMonthYear(r.startDate);
    const to = parseMonthYear(r.endDate);
    return {
      title: r.title || r.role || "",
      company: r.company || r.employer || "",
      location: r.location || "",
      current: !r.endDate || /present|current|now/i.test(String(r.endDate)),
      from, to,
      description: String(r.description || "").replace(/\*\*/g, "").trim().slice(0, 2000),
    };
  }).filter((r) => r.title || r.company);
  const education = (resume.education || []).slice(0, 4).map((e, i) => ({
    school: e.institution || e.school || "",
    degree: e.degree || "",
    field: e.field || e.major || (String(e.degree || "").split(/,\s*| in /i)[1] || ""),
    // The Profile's GPA (Application Defaults) belongs to the latest school.
    gpa: e.gpa || (i === 0 ? user?.gpa || "" : ""),
    from: parseMonthYear(e.startDate),
    to: parseMonthYear(e.endDate),
  })).filter((e) => e.school);
  const links = [user.linkedin, user.github, user.website || user.portfolio].filter((x) => x && String(x).trim()).map(String);
  return { roles, education, links };
}

// ── Main ────────────────────────────────────────────────────────────────────

/**
 * deps = { db, openai, model, fetch?, sharedJobs? } (sharedJobs: the admin's
 * jobs collection, to find the posting's description by its id).
 * opts = { source, applyUrl, externalId?, domFields, jobTitle?, companyName?,
 *          jobLocationName?, descriptionText? }.
 */
async function prepareGenericApplication(uid, deps, opts = {}) {
  const { db, openai, model } = deps;
  const fetchFn = deps.fetch || DEFAULT_FETCH;
  const { mapForm, aiTrapIn, BARE_LINKS, fieldKind, verifyFourTimes, sanitizeText, sanitizeBlock, STYLE_PROMPT, readability, startDateFor } = await engine();
  const domFields = (opts.domFields || []).filter((f) => f && f.id);
  const source = String(opts.source || "web").toLowerCase();

  // 1. The posting: Workday's own API, else the job JobWatch already holds,
  //    else what the page shows.
  let posting = null;
  if (source === "workday") {
    try { posting = await fetchWorkdayPosting(opts.applyUrl, fetchFn); } catch (_) { /* page values below */ }
  }
  // The job JobWatch already holds (Workday postings are stored under their
  // req id): its company name is the feed's ("NVIDIA"), where Workday's
  // hiringOrganization is a legal entity ("CN03 NVIDIA SemiconductorChina").
  const lookupId = opts.externalId || posting?.reqId;
  if (deps.sharedJobs && lookupId) {
    try {
      const snap = await deps.sharedJobs.where("externalId", "==", String(lookupId)).limit(3).get();
      const doc = snap.docs.map((d) => d.data()).find((j) => !source || source === "web" || !j.source || j.source === source) || null;
      if (doc && posting) posting.companyName = doc.companyName || posting.companyName;
      else if (doc) posting = { title: doc.title || "", companyName: doc.companyName || "", locationName: doc.locationName || "", workplaceType: doc.workplaceType || "", descriptionHtml: doc.fullDescription || "" };
    } catch (_) { /* page values below */ }
  }
  posting = posting || {};
  const job = {
    title: posting.title || opts.jobTitle || "",
    companyName: String(posting.companyName || opts.companyName || "").trim(),
    locationName: posting.locationName || opts.jobLocationName || "",
    workplaceType: posting.workplaceType || "",
    descriptionHtml: posting.descriptionHtml || String(opts.descriptionText || "").slice(0, 20000),
  };

  // 2. Profile + resume + whether this company was applied to before.
  const [userSnap, resumeSnap] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection("users").doc(uid).collection("resume").doc("profile").get(),
  ]);
  const user = userSnap.exists ? userSnap.data() : {};
  const resume = applicationResume(user, resumeSnap.exists ? resumeSnap.data() : {});
  let appliedBefore = null;
  if (job.companyName) {
    try {
      const apps = await db.collection("users").doc(uid).collection("applications").where("companyName", "==", job.companyName).limit(1).get();
      appliedBefore = !apps.empty;
    } catch (_) { /* unknown -> the question parks */ }
  }
  const profile = buildProfileForJob(user, resume, job, { appliedBefore });
  const history = historyOf(resume, user);

  // Resume bytes (the person's own PDF); fetched even when the page shows no
  // field yet, since Workday asks for it on a later step.
  let resumeB64 = null;
  const resumeUrl = user.resumeUrl || resume.resumeUrl;
  if (resumeUrl) {
    try { resumeB64 = Buffer.from(await (await fetchFn(resumeUrl)).arrayBuffer()).toString("base64"); } catch (_) { /* content script reports it */ }
  }
  // The saved name can be the LaTeX source's ("Akash_Ramasani.tex") while the
  // file is the PDF: name it for what it is, or Workday refuses the upload.
  let resumeName = user.resumeFileName || resume.fileName || "resume.pdf";
  if (resumeB64 && Buffer.from(resumeB64.slice(0, 8), "base64").toString().startsWith("%PDF") && !/\.pdf$/i.test(resumeName)) resumeName = resumeName.replace(/\.[a-z0-9]+$/i, "") + ".pdf";
  const base = {
    source,
    jobTitle: job.title,
    companyName: job.companyName,
    locationName: job.locationName,
    workplaceType: job.workplaceType,
    schemaSource: "dom",
    history,
    resumeB64,
    resumeName,
  };
  if (!domFields.length) {
    return { ...base, ready: false, reasons: [], review: [], fills: [], answered: 0, total: 0, totalFields: 0, requiredTotal: 0, parked: [] };
  }

  // 3. Board fields answered by rule; the rest go to the engine.
  const domById = new Map(domFields.map((d) => [d.id, d]));
  const all = ashbyToQuestions(domFieldsToSections(domFields));
  const fills = [];
  const presetPaths = new Set();
  for (const q of all) {
    const dom = domById.get(q.path) || {};
    const f = presetFill(q, dom, profile, startDateFor, { source });
    if (f) { presetPaths.add(q.path); if (f.kind !== "skip") fills.push(f); continue; }
    if (dom.type === "location") {
      const lf = locationFill(q.path, job.locationName, { ...profile, locationStrategy: profile.locationStrategy || "profile" });
      if (lf) { presetPaths.add(q.path); fills.push({ ...lf, label: q.label }); }
    }
  }
  const skip = (q) => presetPaths.has(q.path)
    // Marketing and talent-community opt-ins stay unchecked unless required.
    || (!q.required && /(text|sms) message|marketing|newsletter|job alerts?|talent (community|network)|future (job )?opportunit/i.test(q.label) && (domById.get(q.path)?.type === "checkbox" || domById.get(q.path)?.type === "yesno"));
  const questions = all.filter((q) => !skip(q));

  // 4. AI free text (two-pass so the engine stays sync), four in flight.
  const ctx = aiContext(profile, resume, job);
  const firstPass = mapForm(questions, profile, null);
  const needAi = firstPass.answers.map((a, i) => ({ a, q: questions[i] })).filter(({ a }) => a.answers.length === 0 && /free-text/i.test(a.note));
  const aiDeps = { openai, model, sanitizeText, sanitizeBlock, STYLE_PROMPT, aiTrapIn, readability };
  const cache = new Map();
  const aiNotes = new Map();
  if (openai) {
    await pool(needAi, 4, async ({ q }) => {
      try {
        const r = await answerFreeText(q, ctx, aiDeps);
        if (r.answer) cache.set(q.label, r.answer); else aiNotes.set(q.label, r.reason || "AI declined");
      } catch (e) { aiNotes.set(q.label, `AI call failed: ${String(e?.message || e).slice(0, 80)}`); }
    });
  } else {
    for (const { q } of needAi) aiNotes.set(q.label, "no AI available");
  }

  // 5. Map + verify + fills. Social links the profile lacks get the bare site.
  const mapped = mapForm(questions, profile, { get: (label) => cache.get(label) });
  const verdict = verifyFourTimes(mapped, questions, profile);
  for (const f of fillsFrom(questions, mapped, fieldKind)) {
    const dom = domById.get(f.path) || {};
    fills.push(dom.type === "typeahead" ? typeaheadFrom(f) : f);
  }
  for (const q of questions) {
    if (fills.some((f) => f.path === q.path)) continue;
    const l = nrm(q.label);
    const which = /linkedin/.test(l) ? "linkedin" : /github/.test(l) ? "github" : null;
    const dom = domById.get(q.path) || {};
    if (which && q.required && ["text", "url"].includes(dom.type)) fills.push({ path: q.path, label: q.label, kind: "text", value: BARE_LINKS[which], source: "rule" });
  }

  const filledPaths = new Set(fills.map((f) => f.path));
  const review = mapped.review
    .map((r) => ({ label: r.label, note: aiNotes.get(r.label) || r.note, path: questions[mapped.answers.indexOf(r)]?.path || "" }))
    .filter((r) => !filledPaths.has(r.path));
  return {
    ...base,
    ready: verdict.ok && review.length === 0,
    reasons: verdict.failures,
    review,
    fills,
    answered: fills.length,
    total: all.length,
    totalFields: all.length,
    requiredTotal: domFields.filter((f) => f.required).length,
    parked: review.map((r) => `${r.label.slice(0, 60)} -> ${r.note}`),
  };
}

module.exports = { prepareGenericApplication, fetchWorkdayPosting, workdayPostingApi, presetFill, parseMonthYear, historyOf };
