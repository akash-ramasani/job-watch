// prepare.cjs — compute a full Greenhouse application for the extension.
// Fetches the form, maps answers with the tested engine (compliance from the
// profile only), AI-answers free text in the plain style, runs the 4-pass gate,
// and returns fill instructions the content script can apply to the rendered
// form (option LABELS for comboboxes so the script can pick them by text).

const { buildProfileForJob, parsePlace, REMOTE_LOCATION_DEFAULT } = require("./ashby.cjs");
const { eligibilityOf, formEligibility, blockedReason, needsSponsorship } = require("../eligibility.cjs");
const { applicationResume } = require("./applicationResume.cjs");
const { aiContext, answerFreeText, pickOption, coverLetter, coverLetterWords, pool, stripHtml } = require("./ai-text.cjs");

const GH_BASE = "https://boards-api.greenhouse.io/v1/boards";
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
  _engine = { answerQuestion: ae.answerQuestion, mapForm: ae.mapForm, SOURCE: ae.SOURCE, aiTrapIn: ae.aiTrapIn, fieldKind: fk.fieldKind, verifyFourTimes: vf.verifyFourTimes, sanitizeText: st.sanitizeText, sanitizeBlock: st.sanitizeBlock, STYLE_PROMPT: st.STYLE_PROMPT, readability: st.readability };
  return _engine;
}

/** Main entry. deps = { db, openai, model, fetch? }. Returns the fill package. */
async function prepareGreenhouseApplication(uid, token, id, deps) {
  const { db, openai, model } = deps;
  const fetchFn = deps.fetch || DEFAULT_FETCH;
  const { mapForm, aiTrapIn, fieldKind, verifyFourTimes, sanitizeText, sanitizeBlock, STYLE_PROMPT, readability, answerQuestion } = await engine();

  // 1. Form schema (public).
  const form = await fetchFn(`${GH_BASE}/${token}/jobs/${id}?questions=true`).then((r) => {
    if (!r.ok) throw new Error(`greenhouse form ${token}/${id} -> ${r.status}`);
    return r.json();
  });
  const questions = form.questions || [];
  const job = { title: form.title || "", companyName: form.company_name || "", locationName: ((form.location && form.location.name) || "").trim(), descriptionHtml: form.content || "" };

  // 2. Profile + resume, enriched for this job exactly like Ashby: years from
  //    the resume dates, resume text for experience gates, the applicant's
  //    local day for start dates, metro spellings, low-stakes defaults, and
  //    whether they applied to this company before.
  const [userSnap, resumeSnap] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection("users").doc(uid).collection("resume").doc("profile").get(),
  ]);
  const profile = userSnap.exists ? userSnap.data() : {};
  const resume = applicationResume(profile, resumeSnap.exists ? resumeSnap.data() : {});
  let appliedBefore = null;
  try {
    if (job.companyName) {
      const apps = await db.collection("users").doc(uid).collection("applications").where("companyName", "==", job.companyName).limit(20).get();
      // Submitted applications only: this form's own record (made when it
    // started) and forms never sent do not count (2026-11-10).
    appliedBefore = apps.docs.some((d) => d.data()?.status === "submitted");
    }
  } catch (_) { /* unknown -> the question parks */ }
  const profileForJob = buildProfileForJob(profile, resume, job, { appliedBefore });
  // Needs sponsorship and the posting or the form requires US citizenship, a
  // clearance, or says it won't sponsor: auto-apply stops here, before any AI
  // (General Matter's "Currently a US Citizen…" was filled and held, 2026-11-12).
  // A manual Autofill still fills, with the reason shown.
  const notEligible = blockedReason([...eligibilityOf(`${job.title}. ${job.descriptionHtml}`).flags, ...formEligibility(questions)], needsSponsorship(profile));
  if (notEligible && deps.auto) return { notEligible, ready: false, reasons: [notEligible], review: [], fills: [], answered: 0, total: questions.length, parked: [] };

  // 3. AI free text (two-pass so the engine stays sync), one question per call,
  //    four in flight. Optional boxes too: an empty "anything else" reads as
  //    low effort. The reason an answer was withheld goes to the review list.
  const ctx = aiContext(profileForJob, resume, job);
  const firstPass = mapForm(questions, profileForJob, null);
  const needAi = firstPass.answers.filter((a) => a.answers.length === 0 && /free-text/i.test(a.note));
  const qByLabel0 = new Map(questions.map((q) => [q.label || q.fields?.[0]?.name, q]));
  const aiDeps = { openai, model, sanitizeText, sanitizeBlock, STYLE_PROMPT, aiTrapIn, readability };
  const cache = new Map();
  const aiNotes = new Map();
  if (openai) {
    await pool(needAi, 4, async (a) => {
      const q0 = qByLabel0.get(a.label) || {};
      const long = (q0.fields || []).some((f) => f.type === "textarea");
      try {
        const r = await answerFreeText({ label: a.label, description: stripHtml(q0.description || ""), ashbyType: long ? "LongText" : "String" }, ctx, aiDeps);
        if (r.answer) cache.set(a.label, r.answer); else aiNotes.set(a.label, r.reason || "AI declined");
      } catch (e) { aiNotes.set(a.label, `AI call failed: ${String(e?.message || e).slice(0, 80)}`); }
    });
  } else {
    for (const a of needAi) aiNotes.set(a.label, "no AI available");
  }

  // 4. Map + verify.
  const mapped = mapForm(questions, profileForJob, { get: (l) => cache.get(l) });
  const verdict = verifyFourTimes(mapped, questions, profileForJob);
  const review = mapped.review.map((r) => ({ label: r.label, note: aiNotes.get(r.label) || r.note, path: qByLabel0.get(r.label)?.fields?.[0]?.name || "" }));

  // 5. Build fill instructions. For selects, convert the option value -> label
  //    so the content script can pick it from the rendered listbox by text.
  const optLabelByValue = {};
  const qByLabel = new Map();
  for (const q of questions) {
    qByLabel.set(q.label || q.fields[0]?.name, q);
    (q.fields[0]?.values || []).forEach((v) => (optLabelByValue[String(v.value)] = v.label));
  }
  const fills = [];
  for (const a of mapped.answers) {
    if (!a.answers.length) continue;
    const q = qByLabel.get(a.label);
    const kind = q ? fieldKind(q.fields[0]) : "text";
    for (const ans of a.answers) {
      // `required` lets the page tell a missed optional field from a blocking one.
      if (ans.isFile) { fills.push({ label: a.label, name: ans.name, kind: "file", required: !!q?.required }); continue; }
      const value = kind === "select" || kind === "multiselect" || kind === "boolean"
        ? (optLabelByValue[String(ans.value)] ?? ans.value)
        : ans.value;
      fills.push({ label: a.label, name: ans.name, kind, value: ans.name === "phone" ? nationalPhone(value) : value, required: !!q?.required });
    }
  }

  // 5a. Parked questions the rules could not map ("I understand that working
  //     with relatives ... is prohibited", "How would you rate your Go?"):
  //     the AI picks the true option, or answers a short text / number box,
  //     from the profile and resume, as on Ashby and Lever. Private facts
  //     (a salary number, a link only the person has) stay for the person.
  const aiPicked = new Set();
  if (openai) {
    // Questions the rules leave for the person (criminal history, visa status,
    // AI use, driver's license) never go to the AI.
    const parkedQs = mapped.review.map((r) => ({ r, q: qByLabel0.get(r.label) })).filter(({ r, q }) => q && q.fields?.[0] && !/^(only you can answer|ai-use disclosure)/i.test(r.note || ""));
    await pool(parkedQs, 4, async ({ r, q }) => {
      const kind = fieldKind(q.fields[0]);
      const opts = q.fields[0].values || [];
      try {
        if (["select", "multiselect", "boolean"].includes(kind) && opts.length) {
          const p = await pickOption({ label: q.label, description: stripHtml(q.description || ""), fields: [{ ...q.fields[0], type: kind === "multiselect" ? "multi" : "single", values: opts.map((o) => ({ label: o.label, value: o.label })) }] }, ctx, profileForJob, aiDeps);
          if (!p.values.length) { aiNotes.set(r.label, p.reason); return; }
          fills.push({ label: q.label, name: q.fields[0].name, kind, value: p.values[0], ...(kind === "multiselect" ? { values: p.values } : {}), required: !!q.required, source: "ai", note: `AI pick: ${p.why || ""}`.trim() });
          aiPicked.add(r.label);
        } else if (["text", "longtext", "number"].includes(kind) && !/needs a link|password|no referral|follow-up/i.test(`${r.note || ""} ${q.label}`)
          // Pay only from the person's own Salary Expectation (Application Defaults).
          && (!/salary|compensation/i.test(`${r.note || ""} ${q.label}`) || String(profile.salaryExpectation || "").trim())) {
          const num = kind === "number";
          const a = await answerFreeText({ label: q.label, description: [stripHtml(q.description || ""), num ? "Reply with a single number only, no words." : ""].filter(Boolean).join(" "), ashbyType: num ? "Number" : kind === "longtext" ? "LongText" : "String" }, ctx, aiDeps);
          const value = num ? String(a.answer || "").match(/-?\d+(\.\d+)?/)?.[0] : a.answer;
          if (!value) { aiNotes.set(r.label, a.reason || "AI gave no answer"); return; }
          fills.push({ label: q.label, name: q.fields[0].name, kind: num ? "number" : "text", value, required: !!q.required, source: "ai", note: "AI answer" });
          aiPicked.add(r.label);
        }
      } catch (e) { aiNotes.set(r.label, `AI failed: ${String(e?.message || e).slice(0, 80)}`); }
    });
    for (let i = review.length - 1; i >= 0; i--) if (aiPicked.has(review[i].label)) review.splice(i, 1);
  }

  // 5b. Candidate location typeahead — always the job's posted location.
  const locQ = (form.location_questions || []).find((q) => (q.fields || []).some((f) => f.name === "location"));
  const locName = ((form.location && form.location.name) || "").trim();
  // A remote posting (or one with no real city) gets the person's city for
  // remote roles, users/{uid}.remoteLocation, default San Francisco, CA.
  if (locQ) {
    const place = parsePlace(locName, profile.city || profile.remoteLocation || REMOTE_LOCATION_DEFAULT) || parsePlace(profile.remoteLocation || REMOTE_LOCATION_DEFAULT);
    if (place) {
      const stateFull = place.state || US_STATES[(place.abbr || "").toUpperCase()] || "";
      fills.push({ label: "Location", kind: "location", value: place.city, match: stateFull ? `${place.city}, ${stateFull}` : place.city, required: !!locQ.required });
    }
  }

  // 5c. Education (School / Degree / Discipline / End date year) from the resume.
  fills.push(...await educationFills(token, form, resume));

  // 5d. Voluntary demographic questions from the profile (decline when unset).
  fills.push(...demographicFills(form, profile, answerQuestion));

  // 5e. Standard EEOC compliance section (Gender / Race / Veteran / Disability).
  fills.push(...complianceFills(form, profile));

  // 6. Cover letter (plain style) + resume bytes.
  let coverText = "";
  const coverMustInclude = coverLetterWords([...questions.map((q) => `${q.label} ${stripHtml(q.description || "")}`), ctx.jobDescription]);
  if (openai) { try { coverText = await coverLetter({ ...ctx, coverMustInclude }, aiDeps); } catch (_) { coverText = ""; } }
  // When the form has a cover-letter question with a paste-text variant, add a
  // fill so the content script pastes the generated letter ("enter manually").
  const clQ = questions.find((q) => (q.fields || []).some((f) => f.name === "cover_letter"));
  if (coverText && clQ && (clQ.fields || []).some((f) => f.type === "textarea")) {
    fills.push({ label: "Cover Letter", kind: "cover-text", value: coverText, required: !!clQ.required });
    // Written and pasted: a required cover letter no longer needs the person.
    for (let i = review.length - 1; i >= 0; i--) if (/cover letter/i.test(review[i].label)) review.splice(i, 1);
  }
  let resumeB64 = null;
  const resumeUrl = profile.resumeUrl || resume.resumeUrl;
  if (resumeUrl) {
    try {
      const buf = Buffer.from(await (await fetchFn(resumeUrl)).arrayBuffer());
      resumeB64 = buf.toString("base64");
    } catch (_) { /* leave null; content script keeps the manual resume step */ }
  }

  return {
    notEligible: notEligible || null,
    jobTitle: form.title,
    companyName: job.companyName,
    locationName: job.locationName,
    // A completeness failure the AI answers cleared is not a failure.
    ready: review.length === 0 && (verdict.ok || verdict.failures.every((f) => /completeness/i.test(String(f)))),
    reasons: verdict.failures,
    review,
    fills,
    // The Employment section, filled on the page from the resume (the
    // board's own resume parser only runs after a real upload, and leaves
    // the job's place glued to the title).
    employment: employmentEntries(resume),
    education: (resume.education || []).filter((e) => e.institution || e.school).slice(0, 2).map((e) => ({ start: dateParts(e.startDate), end: dateParts(e.endDate) })),
    resumeB64,
    // The saved resume is the PDF even when its name is the LaTeX source's
    // ("Akash_Ramasani.tex", which Ashby refused, 2026-11-10).
    resumeName: String(profile.resumeFileName || resume.fileName || "resume.pdf").replace(/\.(tex|latex|txt)$/i, ".pdf"),
    coverText,
    answered: mapped.answers.filter((a) => a.answers.length).length,
    total: questions.length,
    totalFields: questions.length,
    requiredTotal: questions.filter((q) => q.required).length,
    // Questions the form marks optional: never "needs you", whatever the page shows.
    optionalLabels: questions.filter((q) => !q.required && q.label).map((q) => q.label),
    parked: review.map((r) => `${r.label.slice(0, 60)} -> ${r.note}`),
  };
}

// ── Education section (Greenhouse serves the option lists per board) ────────

const normText = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function ghItems(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    return (await res.json()).items || [];
  } catch (_) { return []; }
}

const SCHOOL_GENERIC = new Set(["university", "college", "of", "the", "at", "and", "state", "institute", "school", "campus", "polytechnic"]);
/** The board's school entry for `institution`: every distinctive word present, most words matched. */
async function bestSchool(institution, search) {
  const want = normText(institution).split(" ").filter(Boolean);
  const distinct = want.filter((t) => !SCHOOL_GENERIC.has(t));
  const terms = [institution, want.join(" "), want.slice(0, 3).join(" "), want.slice(0, 2).join(" ")];
  let best = null, bestScore = 0;
  for (const term of [...new Set(terms)]) {
    for (const i of await search(term)) {
      const have = new Set(normText(i.text).split(" "));
      if (!distinct.every((t) => have.has(t))) continue;
      const extra = [...have].filter((t) => t && !want.includes(t)).length;
      const score = want.filter((t) => have.has(t)).length / want.length - extra * 0.01;
      if (score > bestScore) { best = i; bestScore = score; }
    }
    if (bestScore >= 0.95) break;
  }
  return best && bestScore >= 0.6 ? best : null;
}
/** The board's "Other" school, for a school its list lacks (IMC has no Cal
 *  State East Bay; School stayed empty and the form was refused, 2026-11-13). */
async function otherSchool(search) {
  for (const term of ["Other", "Not listed", "None of the above"]) {
    const hit = (await search(term)).find((i) => /^(other|other school|school not listed|not listed|none of the above)\b/i.test(String(i.text || "").trim()));
    if (hit) return hit;
  }
  return null;
}
/** "Master of Science" -> "master's"; null when unknown. */
function degreeLevel(s) {
  return /ph\.?\s?d|doctor of philosophy|doctorate/i.test(s) ? "ph.d" :
    /m\.?b\.?a\b|master of business/i.test(s) ? "m.b.a" :
      /master|\bm\.?s\.?\b|\bm\.?tech|\bm\.?eng/i.test(s) ? "master's" :
        /bachelor|\bb\.?s\.?\b|\bb\.?tech|\bb\.?e\.?\b|\bb\.?a\.?\b/i.test(s) ? "bachelor's" :
          /associate/i.test(s) ? "associate's" :
            /high school/i.test(s) ? "high school" : null;
}
/** The plain level ("Master's Degree") over variants ("Accelerated Master's", "Non-Master's ..."). */
function bestDegree(items, key) {
  const t = (i) => String(i.text || "").toLowerCase().replace(/[’]/g, "'");
  const base = key.replace(/'s$/, "");
  const hits = items.filter((i) => t(i).includes(key) || (key === "master's" && /\bmasters?\b/.test(t(i))) || (key === "bachelor's" && /\bbachelors?\b/.test(t(i))));
  const bad = /\bnon[- ]|accelerated|international|equivalent|in progress|some |incomplete|diploma|certificate/;
  const clean = hits.filter((i) => !bad.test(t(i)));
  return clean.find((i) => new RegExp(`^${base}'?s?( degree)?$`).test(t(i).trim()))
    || clean.find((i) => t(i).startsWith(base)) || clean[0] || null;
}
/** The discipline the field of study names in full, longest first ("Computer Science", never "Science"). */
function bestDiscipline(items, field) {
  const want = normText(field);
  if (!want) return null;
  const exact = items.find((i) => normText(i.text) === want);
  if (exact) return exact;
  const inside = items.filter((i) => { const n = normText(i.text); return n.length >= 4 && (` ${want} `).includes(` ${n} `); })
    .sort((a, b) => normText(b.text).length - normText(a.text).length);
  // A one-word discipline that is only part of the field ("Science" of
  // "Computer Science") is not the field.
  const best = inside.find((i) => normText(i.text).split(" ").length > 1 || want.split(" ").length === 1);
  if (best) return best;
  return items.find((i) => normText(i.text).startsWith(want)) || null;
}

async function educationFills(token, form, resume) {
  if (!/education/.test(String(form.education || ""))) return [];
  const ed = (resume.education || [])[0];
  if (!ed) return [];
  const out = [];

  // School — the board's school search is prefix-based ("California State
  // University, East Bay" returns nothing while "California State University"
  // works), so retry with progressively shorter terms. A candidate must carry
  // every distinctive word ("east", "bay"), not just most words: "California
  // State University - Monterey Bay" scored 4 of 5 and was picked (IMC, 2026-11-11).
  if (ed.institution) {
    const pick = bestSchool(ed.institution, async (term) => ghItems(`${GH_BASE}/${token}/education/schools?term=${encodeURIComponent(term)}`));
    const best = await pick || await otherSchool(async (term) => ghItems(`${GH_BASE}/${token}/education/schools?term=${encodeURIComponent(term)}`));
    if (best) out.push({ label: "School", kind: "select", value: best.text });
  }

  // Degree — the board's fixed levels. "Accelerated Master's" and "Non-Master's
  // International Diploma" also contain "master's" and came first (Dropbox,
  // Stage, 2026-11-11): the plain level wins.
  const degreeStr = ed.degree || "";
  const degreeKey = degreeLevel(degreeStr);
  if (degreeKey) {
    const items = await ghItems(`${GH_BASE}/${token}/education/degrees`);
    const best = bestDegree(items, degreeKey);
    if (best) out.push({ label: "Degree", kind: "select", value: best.text });
  }

  // Discipline — the field of study ({ field: "Computer Science" } on the
  // profile's education, else the part after the comma or "in"). Only a
  // discipline the field names in full; the longest one first. Matching the
  // degree text picked "Science" out of "Master of Science" on 33 forms
  // (2026-11-09..12).
  {
    const field = ed.field || (degreeStr.split(",")[1] || "").trim() || ((degreeStr.match(/\bin\s+(.+)$/i) || [])[1] || "").trim();
    const items = await ghItems(`${GH_BASE}/${token}/education/disciplines`);
    const best = bestDiscipline(items, field);
    if (best) out.push({ label: "Discipline", kind: "select", value: best.text });
  }

  // End date year — pull the 4-digit year out of the resume end date.
  const yr = ((ed.endDate || "") + " " + (ed.startDate || "")).match(/(19|20)\d{2}/);
  if (yr) out.push({ label: "End date year", kind: "text", value: yr[0] });

  return out;
}

/** Up to three roles, newest first: { company, title, start: {month, year}, end, current }. */
/** "May 2023", "2023-05", "2021" -> { year, month|null }; "Present" -> null. */
function dateParts(v) {
  const MON = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const t = String(v || "").trim();
  if (!t || /present|current|now/i.test(t)) return null;
  const y = t.match(/(19|20)\d{2}/)?.[0];
  const iso = t.match(/^(\d{4})-(\d{1,2})/);
  const word = t.match(/([A-Za-z]{3,})\.?\s+\d{4}/);
  const m = iso ? Number(iso[2]) : word ? MON.findIndex((x) => x.startsWith(word[1].toLowerCase().slice(0, 3))) + 1 : 0;
  return y ? { year: y, month: m > 0 ? m : null } : null;
}
function employmentEntries(resume) {
  const when = dateParts;
  const roles = resume.roles || resume.experience || [];
  return roles.filter((r) => (r.company || r.employer) && (r.title || r.role)).slice(0, 3).map((r) => ({
    company: String(r.company || r.employer).trim(),
    title: String(r.title || r.role).trim(),
    start: when(r.startDate),
    end: when(r.endDate),
    current: !r.endDate || /present|current|now/i.test(String(r.endDate)),
  }));
}

/** Greenhouse's phone box sits next to its own country picker (+1 already
 *  chosen), so a US number goes in without the country code: "5109356846". */
function nationalPhone(v) {
  // A country code tacked on the end ("5109356846+1") is not part of the number.
  v = String(v || "").replace(/\s*;?\s*\+\d{1,3}\s*$/, "").trim();
  const d = String(v || "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") return d.slice(1);
  if (d.length === 10) return d;
  return String(v || "");
}

// ── Voluntary demographic survey ────────────────────────────────────────────

function demoAnswer(label, profile) {
  const l = label.toLowerCase();
  if (/gender/.test(l)) {
    const g = profile.eeoGender || "";
    return /^male$/i.test(g) ? "Man" : /^female$/i.test(g) ? "Woman" : g || null;
  }
  if (/race|ethnic/.test(l)) return profile.eeoEthnicity || null;
  if (/pronoun/.test(l)) return profile.pronouns || null;
  if (/veteran/.test(l)) return profile.eeoVeteran || null;
  if (/disab/.test(l)) return profile.eeoDisability || null;
  return null; // e.g. sexual orientation — falls through to the decline option
}

function demographicFills(form, profile, answerQuestion = null) {
  const qs = (form.demographic_questions && form.demographic_questions.questions) || [];
  const nrm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const out = [];
  for (const q of qs) {
    const opts = q.answer_options || [];
    if (!opts.length) continue;
    const want = demoAnswer(q.label, profile);
    let pick = null;
    if (want) {
      const w = nrm(want);
      pick = opts.find((o) => nrm(o.label) === w)
        || opts.find((o) => nrm(o.label).startsWith(w))
        || opts.find((o) => w.startsWith(nrm(o.label)));
    }
    // Wording differs per board ("I am not a protected veteran" vs "I am not a
    // veteran"): the engine's EEO matching, then the board's decline option.
    if (!pick && answerQuestion) {
      const a = answerQuestion({ label: q.label, required: false, fields: [{ name: "demo", type: q.type || "multi_value_single_select", values: opts.map((o) => ({ label: o.label, value: o.label })) }] }, profile, null);
      const v = a.answers?.[0]?.value;
      if (v) pick = opts.find((o) => o.label === v) || null;
    }
    if (!pick) pick = opts.find((o) => o.decline_to_answer) || opts.find((o) => /prefer not|decline|do not wish|don't wish|choose not/i.test(o.label));
    if (pick) out.push({ label: q.label, kind: "select", value: pick.label, required: false });
  }
  return out;
}

// ── Standard EEOC compliance section ────────────────────────────────────────
// API labels have no spaces ("VeteranStatus") while the page renders "Veteran
// Status" / "Please identify your race", so each fill carries an `eeo` token
// the content script can match labels by containment.

function complianceFills(form, profile) {
  const out = [];
  const nrm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  for (const section of form.compliance || []) {
    for (const q of section.questions || []) {
      const f = (q.fields || [])[0];
      const opts = (f && f.values) || [];
      if (!opts.length) continue;
      const l = nrm(q.label);
      let want = null, eeo = null;
      if (/hispanic|latino/.test(l)) {
        eeo = "hispanic";
        const e = nrm(profile.eeoEthnicity);
        want = e ? (/hispanic|latino/.test(e) ? "Yes" : "No") : null;
      } else if (/gender/.test(l)) { eeo = "gender"; want = profile.eeoGender; }
      else if (/race|ethnic/.test(l)) { eeo = "race"; want = profile.eeoEthnicity; }
      else if (/veteran/.test(l)) { eeo = "veteran"; want = profile.eeoVeteran; }
      else if (/disab/.test(l)) { eeo = "disability"; want = profile.eeoDisability; }
      else continue;
      const decline = opts.find((v) => /decline|don't wish|do not want|prefer not/i.test(v.label));
      let pick = null;
      if (want) {
        const w = nrm(want);
        pick = opts.find((v) => nrm(v.label) === w)
          || opts.find((v) => nrm(v.label).startsWith(w))
          || opts.find((v) => w.startsWith(nrm(v.label)));
        // Statement options ("No, I do not have a disability and ...") rarely
        // match the profile text verbatim — match by the leading Yes/No.
        if (!pick && /^(yes|no)\b/.test(w)) {
          const lead = w.startsWith("yes") ? /^yes\b/ : /^no\b/;
          pick = opts.find((v) => lead.test(nrm(v.label)));
        }
      }
      if (!pick) pick = decline;
      if (pick) out.push({ label: q.label, kind: "select", value: pick.label, eeo, required: !!q.required });
      // Greenhouse's EEOC survey shows Race only after "Are you Hispanic/Latino?"
      // (Yes / No / Decline To Self Identify), which the form JSON leaves out.
      if (eeo === "race" && !(section.questions || []).some((x) => /hispanic|latino/i.test(x.label || ""))) {
        const e = nrm(profile.eeoEthnicity);
        const h = !e || /decline|prefer not|don't wish/.test(e) ? "Decline To Self Identify" : /hispanic|latino/.test(e) ? "Yes" : "No";
        out.unshift({ label: "Are you Hispanic/Latino?", kind: "select", value: h, eeo: "hispanic", required: !!q.required });
      }
    }
  }
  return out;
}

const US_STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia",
};

module.exports = { prepareGreenhouseApplication, nationalPhone, bestSchool, otherSchool, bestDegree, bestDiscipline, degreeLevel };
