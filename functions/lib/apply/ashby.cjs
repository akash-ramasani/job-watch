// ashby.cjs — compute a full Ashby application for the extension.
//
// Same shape as prepare.cjs (Greenhouse): fetch the form schema from Ashby's
// public GraphQL, map every field with the tested answer engine (compliance
// from the profile only, never AI), AI-answer the free-text questions one at a
// time in the plain style with the job description and the resume in view,
// render a cover letter PDF when the form asks for one, run the 4-pass gate,
// and return fill instructions keyed by Ashby field path so the content
// script never has to match labels.
//
// Before this, Ashby forms got a label-includes mapper plus ONE 500-token AI
// call for every unknown field (compliance included), which truncated and
// dropped answers on longer forms.

const { METROS } = require("../resumeLocation.cjs");
const { candidateYearsOf, buildProfileText } = require("../jobFit.cjs");
const { renderCoverLetterPdf, contactLine } = require("./coverPdf.cjs");
const { aiContext, answerFreeText, coverLetter, pool } = require("./ai-text.cjs");

const GQL = "https://jobs.ashbyhq.com/api/non-user-graphql";
const DEFAULT_FETCH = (...a) => fetch(...a);

/** Load the ESM engine modules once (Node 22 CJS -> ESM dynamic import). */
let _engine;
async function engine() {
  if (_engine) return _engine;
  const [ae, fk, vf, st] = await Promise.all([
    import("./answer-engine.mjs"),
    import("./fieldkind.mjs"),
    import("./verify.mjs"),
    import("./style.mjs"),
  ]);
  _engine = {
    mapForm: ae.mapForm, SOURCE: ae.SOURCE, aiTrapIn: ae.aiTrapIn, fieldKind: fk.fieldKind, verifyFourTimes: vf.verifyFourTimes,
    sanitizeText: st.sanitizeText, sanitizeBlock: st.sanitizeBlock, STYLE_PROMPT: st.STYLE_PROMPT,
  };
  return _engine;
}

// ── Ashby GraphQL ───────────────────────────────────────────────────────────

const POSTING_QUERY = `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
  jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
    id title locationName workplaceType employmentType teamNames descriptionHtml
    applicationForm { sections { title descriptionHtml fieldEntries { isRequired descriptionHtml field } } }
    surveyForms { id sections { fieldEntries { isRequired descriptionHtml field } } }
  }
}`;
const ORG_QUERY = `query ApiOrganizationFromHostedJobsPageName($organizationHostedJobsPageName: String!) {
  organization: organizationFromHostedJobsPageName(organizationHostedJobsPageName: $organizationHostedJobsPageName) { name }
}`;

async function gql(fetchFn, op, query, variables) {
  const res = await fetchFn(`${GQL}?op=${op}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationName: op, variables, query }),
  });
  if (!res.ok) throw new Error(`ashby graphql ${op} -> ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`ashby graphql ${op}: ${json.errors[0].message}`);
  return json.data || {};
}

/** Title, location, description, form sections and survey sections. */
async function fetchAshbyPosting(org, jobPostingId, fetchFn = DEFAULT_FETCH) {
  const [posting, orgRes] = await Promise.all([
    gql(fetchFn, "ApiJobPosting", POSTING_QUERY, { organizationHostedJobsPageName: org, jobPostingId }),
    gql(fetchFn, "ApiOrganizationFromHostedJobsPageName", ORG_QUERY, { organizationHostedJobsPageName: org }).catch(() => ({})),
  ]);
  const jp = posting.jobPosting;
  if (!jp) throw new Error("ashby posting not found");
  return {
    title: jp.title || "",
    locationName: jp.locationName || "",
    workplaceType: jp.workplaceType || "",
    employmentType: jp.employmentType || "",
    descriptionHtml: jp.descriptionHtml || "",
    companyName: orgRes.organization?.name || org,
    sections: jp.applicationForm?.sections || [],
    surveySections: (jp.surveyForms || []).flatMap((f) => f.sections || []),
  };
}

// ── Schema -> engine questions ──────────────────────────────────────────────

const stripHtml = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, " ").trim();

/** Ashby fieldEntries -> the Greenhouse-style questions the engine reads.
 *  Boolean fields get Yes/No values so they behave as two-option selects. */
function ashbyToQuestions(sections) {
  const qs = [];
  for (const s of sections || []) {
    for (const e of s.fieldEntries || []) {
      const f = e.field || {};
      if (!f.path || f.isDeactivated) continue;
      let values = (f.selectableValues || []).map((v) => ({
        label: v.label ?? v.value ?? String(v),
        value: v.value ?? v.label ?? String(v),
      }));
      if (f.type === "Boolean") values = [{ label: "Yes", value: "Yes" }, { label: "No", value: "No" }];
      qs.push({
        label: (f.title || f.humanReadablePath || "").replace(/\s*\*\s*$/, "").trim() || f.path,
        description: stripHtml(e.descriptionHtml || ""),
        required: !!e.isRequired,
        path: f.path,
        ashbyType: f.type || "String",
        fields: [{ name: f.path, type: f.type || "String", values }],
      });
    }
  }
  return qs;
}

/** Fields the content script scraped from the DOM (fallback when GraphQL has
 *  nothing): { id, label, description, type, required, options:[{label}] }. */
const DOM_TYPE = {
  text: "String", textarea: "LongText", email: "Email", tel: "Phone", url: "Url", number: "Number",
  file: "File", yesno: "Boolean", radio: "ValueSelect", select: "ValueSelect", checkbox: "MultiValueSelect",
  multiselect: "MultiValueSelect", location: "Location", date: "Date",
};
function domFieldsToSections(domFields) {
  const fieldEntries = (domFields || []).filter((f) => f && f.id).map((f) => ({
    isRequired: !!f.required,
    descriptionHtml: f.description || "",
    field: {
      path: f.id,
      title: f.label || "",
      type: DOM_TYPE[f.type] || "String",
      selectableValues: (f.options || []).map((o) => ({ label: o.label, value: o.value ?? o.label })),
    },
  }));
  return [{ fieldEntries }];
}

// ── Location ────────────────────────────────────────────────────────────────

const STATE_FULL = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin",
  WY: "Wyoming", DC: "District of Columbia",
};
const STATE_ABBR = Object.fromEntries(Object.entries(STATE_FULL).map(([a, f]) => [f.toLowerCase(), a]));

/** The metro a city belongs to (from resumeLocation's table), or null. */
function metroOf(city) {
  const c = String(city || "").toLowerCase().trim();
  if (!c) return null;
  return METROS.find((m) => m.cities.includes(c) || m.display.split(",")[0].toLowerCase() === c) || null;
}

/** Spellings of the applicant's metro for matching office/city option lists.
 *  Short aliases ("la", "sf") are left out: as substrings they match wrongly. */
function metroTerms(city) {
  const m = metroOf(city);
  if (!m) return [];
  const main = m.display.split(",")[0];
  return [...new Set([main, ...m.cities.filter((c) => c.length >= 6 && (c.includes(main.toLowerCase()) || /area|metro/.test(c)))])];
}

/** Parse "San Francisco, CA" / "New York City" / "Remote - US" into parts. */
function parsePlace(locationName) {
  const raw = String(locationName || "").replace(/\s*[-–]\s*US$/i, "").trim();
  if (!raw || /remote|anywhere|distributed|work from home|wfh|global|worldwide/i.test(raw)) return null;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const city = parts[0];
  let state = parts[1] || "";
  if (/^(united states|usa|us)$/i.test(state)) state = "";
  if (!state) { const m = metroOf(city); if (m) state = m.state; }
  const abbr = state.length === 2 ? state.toUpperCase() : STATE_ABBR[state.toLowerCase()] || "";
  return { city, state: STATE_FULL[abbr] || state, abbr };
}

/** Value + match string for Ashby's location autocomplete. Suggestions read
 *  "San Francisco, California, United States". Kept as before: the job's
 *  posted city when it is a real place, the applicant's own city otherwise
 *  (remote roles, or no location on the posting), unless the profile sets
 *  locationStrategy "profile". */
function locationFill(path, jobLocationName, profile) {
  const own = parsePlace([profile.city, profile.region].filter(Boolean).join(", "));
  // users/{uid}.locationStrategy = "profile" switches the widget to the
  // applicant's own city on every form (the engine's text answers already are).
  const place = profile.locationStrategy === "profile" ? (own || parsePlace(jobLocationName)) : (parsePlace(jobLocationName) || own);
  if (!place) return null;
  return { path, kind: "location", label: "Location", value: place.city, match: place.state ? `${place.city}, ${place.state}` : place.city, source: "rule" };
}

// ── Profile for this job ────────────────────────────────────────────────────

/** The engine's profile: the saved user doc, resume-derived facts, and the
 *  defaults the Ashby flow has always used for low-stakes answers. Compliance
 *  fields (work authorization, sponsorship, export control) get NO defaults:
 *  when the profile is silent the question parks for the person. */
/** yyyy-mm-dd for `now` in the applicant's time zone (UTC midnight would
 *  skip a Monday for a Sunday-evening application on the US west coast). */
function localDayISO(now, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch (_) {
    return now.toISOString().slice(0, 10);
  }
}

function buildProfileForJob(user, resume, job, { appliedBefore = null, now = new Date() } = {}) {
  const roles = resume.roles || resume.experience || [];
  const years = candidateYearsOf({ roles }, now);
  const yearsNoInterns = candidateYearsOf({ roles: roles.filter((r) => !/\b(intern|internship|co-?op|teaching assistant|research assistant)\b/i.test(r.title || r.role || "")) }, now);
  const p = {
    ...user,
    fullName: user.fullName || `${user.firstName || ""} ${user.lastName || ""}`.trim(),
    resumePath: "RESUME",
    currentCompany: user.currentCompany || roles[0]?.company || roles[0]?.employer || "",
    currentTitle: user.currentTitle || roles[0]?.title || roles[0]?.role || "",
    university: user.university || (resume.education || [])[0]?.institution || "",
    yearsOfExperience: Number.isFinite(Number(user.yearsOfExperience)) ? Number(user.yearsOfExperience) : (years > 0 ? years : undefined),
    yearsOfExperienceNoInterns: yearsNoInterns > 0 ? yearsNoInterns : undefined,
    resumeText: buildProfileText(resume).toLowerCase(),
    jobLocationName: job.locationName || "",
    country: user.country || "United States",
    heardAboutUs: user.heardAboutUs || "LinkedIn",
    salaryExpectation: user.salaryExpectation || "Open to discussion",
    availability: user.availability || "Immediately",
    // Start dates default to the next Monday after the application date, so
    // the notice-period text must agree with that: "1 week" unless the person
    // set one.
    noticePeriod: user.noticePeriod || "1 week",
    noticePeriodExplicit: !!user.noticePeriod,
    todayISO: localDayISO(now, user.timezone || "America/Los_Angeles"),
    appliedToCompanyBefore: appliedBefore,
  };
  if (!p.metroArea) {
    const m = metroOf(p.city);
    if (m) p.metroArea = m.display.split(",")[0];
  }
  p.metroAreas = [...new Set([...(user.metroAreas || []), ...metroTerms(p.city)])];
  return p;
}

// ── Fills ───────────────────────────────────────────────────────────────────

/** Turn mapped answers into fill instructions keyed by Ashby path. */
function fillsFrom(questions, mapped, fieldKind, { survey = false } = {}) {
  const fills = [];
  mapped.answers.forEach((a, i) => {
    const q = questions[i];
    if (!q || !a.answers.length) return;
    const kind = fieldKind(q.fields[0]);
    const labelOf = (v) => (q.fields[0].values || []).find((o) => String(o.value) === String(v))?.label ?? v;
    const base = { path: q.path, label: q.label, source: a.source, note: a.note, survey };
    if (a.answers[0].isFile) { fills.push({ ...base, kind: "file", file: "resume" }); return; }
    if (kind === "multiselect") { fills.push({ ...base, kind: "multiselect", values: a.answers.map((x) => labelOf(x.value)) }); return; }
    if (kind === "select" || kind === "boolean") { fills.push({ ...base, kind, value: labelOf(a.answers[0].value) }); return; }
    fills.push({ ...base, kind: kind === "unknown" ? "text" : kind, value: String(a.answers[0].value) });
  });
  return fills;
}

// ── Main ────────────────────────────────────────────────────────────────────

/**
 * deps = { db, openai, model, fetch? }.
 * opts = { domFields? } fields scraped by the content script (fallback schema).
 */
async function prepareAshbyApplication(uid, org, jobPostingId, deps, opts = {}) {
  const { db, openai, model } = deps;
  const fetchFn = deps.fetch || DEFAULT_FETCH;
  const { mapForm, aiTrapIn, fieldKind, verifyFourTimes, sanitizeText, sanitizeBlock, STYLE_PROMPT } = await engine();

  // 1. Schema (public GraphQL), with the DOM scrape as a fallback.
  let job;
  try {
    job = await fetchAshbyPosting(org, jobPostingId, fetchFn);
  } catch (e) {
    if (!opts.domFields?.length) throw e;
    job = { title: opts.jobTitle || "", locationName: opts.jobLocationName || "", workplaceType: "", descriptionHtml: "", companyName: opts.companyName || org, sections: [], surveySections: [] };
  }
  let sections = job.sections;
  if (!sections.some((s) => (s.fieldEntries || []).length) && opts.domFields?.length) sections = domFieldsToSections(opts.domFields);
  const schemaSource = sections === job.sections ? "graphql" : "dom";

  // 2. Profile + resume + whether this company was applied to before.
  const [userSnap, resumeSnap] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection("users").doc(uid).collection("resume").doc("profile").get(),
  ]);
  const user = userSnap.exists ? userSnap.data() : {};
  const resume = resumeSnap.exists ? resumeSnap.data() : {};
  let appliedBefore = null;
  try {
    const apps = await db.collection("users").doc(uid).collection("applications").where("companyName", "==", job.companyName).limit(1).get();
    appliedBefore = !apps.empty;
  } catch (_) { /* unknown -> the question parks */ }
  const profile = buildProfileForJob(user, resume, job, { appliedBefore });

  // 3. Questions. System fields are filled directly; the engine gets the rest.
  const all = ashbyToQuestions(sections);
  const SYSTEM = new Set(["_systemfield_name", "_systemfield_email", "_systemfield_resume", "_systemfield_location"]);
  const questions = all.filter((q) => !SYSTEM.has(q.path) && q.ashbyType !== "Location");
  const fills = [];
  for (const q of all) {
    if (q.path === "_systemfield_name") fills.push({ path: q.path, kind: "text", label: q.label, value: profile.fullName, source: "profile" });
    if (q.path === "_systemfield_email") fills.push({ path: q.path, kind: "text", label: q.label, value: user.email || "", source: "profile" });
    if (q.path === "_systemfield_resume") fills.push({ path: q.path, kind: "file", label: q.label, file: "resume", source: "profile" });
    if (q.path === "_systemfield_location" || q.ashbyType === "Location") {
      const f = locationFill(q.path, job.locationName, profile);
      if (f) fills.push({ ...f, label: q.label });
    }
  }

  // 4. AI free text (two-pass so the engine stays sync). Optional boxes too:
  //    an empty "anything else you want to share" reads as low effort.
  const ctx = aiContext(profile, resume, job);
  const firstPass = mapForm(questions, profile, null);
  const needAi = firstPass.answers.map((a, i) => ({ a, q: questions[i] })).filter(({ a }) => a.answers.length === 0 && /free-text/i.test(a.note));
  const wantsCover = all.some((q) => /cover letter/i.test(q.label) && (q.ashbyType === "File" || q.ashbyType === "LongText"));
  const aiDeps = { openai, model, sanitizeText, sanitizeBlock, STYLE_PROMPT, aiTrapIn };
  let coverText = "";
  if (wantsCover && openai) {
    try { coverText = await coverLetter(ctx, aiDeps); } catch (_) { coverText = ""; }
  }
  const cache = new Map();
  const aiNotes = new Map();
  if (openai) {
    await pool(needAi, 4, async ({ q }) => {
      try {
        if (/cover letter/i.test(q.label) && coverText) { cache.set(q.label, coverText); return; }
        const r = await answerFreeText(q, ctx, aiDeps);
        if (r.answer) cache.set(q.label, r.answer); else aiNotes.set(q.label, r.reason || "AI declined");
      } catch (e) { aiNotes.set(q.label, `AI call failed: ${String(e?.message || e).slice(0, 80)}`); }
    });
  } else {
    for (const { q } of needAi) aiNotes.set(q.label, "no AI available");
  }

  // 5. Map + verify.
  const mapped = mapForm(questions, profile, { get: (label) => cache.get(label) });
  const verdict = verifyFourTimes(mapped, questions, profile);
  fills.push(...fillsFrom(questions, mapped, fieldKind));

  // 5b. Cover letter File fields get the rendered PDF.
  let coverB64 = null;
  const coverFileQ = all.find((q) => q.ashbyType === "File" && /cover letter/i.test(q.label));
  if (coverFileQ && coverText) {
    try {
      const pdf = await renderCoverLetterPdf(coverText, { name: profile.fullName, contact: contactLine(profile), companyName: job.companyName, jobTitle: job.title });
      coverB64 = pdf.toString("base64");
      fills.push({ path: coverFileQ.path, kind: "file", label: coverFileQ.label, file: "cover", source: "ai" });
    } catch (_) { /* leave for the person */ }
  }

  // 5c. Voluntary survey (EEOC + custom): never blocks readiness.
  const surveyQs = ashbyToQuestions(job.surveySections);
  if (surveyQs.length) {
    const sm = mapForm(surveyQs, profile, null);
    fills.push(...fillsFrom(surveyQs, sm, fieldKind, { survey: true }));
  }

  // 6. Resume bytes.
  let resumeB64 = null;
  const resumeUrl = user.resumeUrl || resume.resumeUrl;
  if (resumeUrl) {
    try { resumeB64 = Buffer.from(await (await fetchFn(resumeUrl)).arrayBuffer()).toString("base64"); } catch (_) { /* content script reports it */ }
  }

  // What still needs the person: required questions with no answer, plus the
  // cover letter when it was asked for and could not be produced.
  const review = mapped.review.map((r) => ({ label: r.label, note: aiNotes.get(r.label) || r.note, path: questions[mapped.answers.indexOf(r)]?.path }));
  if (coverFileQ?.required && !coverB64) review.push({ label: coverFileQ.label, note: "cover letter not generated", path: coverFileQ.path });

  return {
    jobTitle: job.title,
    companyName: job.companyName,
    locationName: job.locationName,
    workplaceType: job.workplaceType,
    schemaSource,
    ready: verdict.ok && review.length === 0,
    reasons: verdict.failures,
    review,
    fills,
    resumeB64,
    resumeName: user.resumeFileName || resume.fileName || "resume.pdf",
    coverB64,
    coverName: "cover-letter.pdf",
    coverText,
    answered: mapped.answers.filter((a) => a.answers.length).length,
    total: questions.length,
    // For the function log: what parked and why (labels only, no answers).
    parked: review.map((r) => `${r.label.slice(0, 60)} -> ${r.note}`),
  };
}

module.exports = {
  prepareAshbyApplication,
  // exported for tests
  answerFreeText, ashbyToQuestions, domFieldsToSections, buildProfileForJob, locationFill, parsePlace, metroTerms, fillsFrom, fetchAshbyPosting, aiContext,
};
