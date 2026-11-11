// lever.cjs — compute a full Lever application for the extension.
//
// Lever's apply page (jobs.lever.co/<site>/<posting>/apply) is server-rendered
// HTML and its public postings API carries the job but not the form, so the
// content script scrapes the form (extension/lib/lever-dom.js scan()) and sends
// the fields here. Same engine as Ashby and Greenhouse: profile facts, rules,
// AI only for free text in the plain style, compliance from the profile only,
// the four-pass gate, and a review list of what still needs the person.
//
// Field names are Lever's stable form names: name, email, phone, location, org,
// urls[LinkedIn] ..., resume, pronouns, comments, cards[<id>][field<n>],
// surveysResponses[...][responses][field<n>], eeo[gender|race|veteran|disability],
// consent[marketing]. Fills are keyed by that name (`path`).

const { buildProfileForJob, ashbyToQuestions, domFieldsToSections, fillsFrom, locationFill, parsePlace } = require("./ashby.cjs");
const { applicationResume } = require("./applicationResume.cjs");
const { aiContext, answerFreeText, pickOption, pool } = require("./ai-text.cjs");

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
  _engine = { mapForm: ae.mapForm, aiTrapIn: ae.aiTrapIn, BARE_LINKS: ae.BARE_LINKS, fieldKind: fk.fieldKind, verifyFourTimes: vf.verifyFourTimes, sanitizeText: st.sanitizeText, sanitizeBlock: st.sanitizeBlock, STYLE_PROMPT: st.STYLE_PROMPT, readability: st.readability };
  return _engine;
}

/** The posting from Lever's public API: title, location, description. */
async function fetchLeverPosting(site, postingId, fetchFn = DEFAULT_FETCH, { eu = false } = {}) {
  const r = await fetchFn(`https://api.${eu ? "eu." : ""}lever.co/v0/postings/${encodeURIComponent(site)}/${encodeURIComponent(postingId)}`);
  if (!r.ok) throw new Error(`lever posting ${site}/${postingId} -> ${r.status}`);
  const p = await r.json();
  // The role and its requirement lists first, the company blurb last.
  const lists = Array.isArray(p.lists) ? p.lists.map((l) => `<p>${l.text || ""}</p><ul>${l.content || ""}</ul>`) : [];
  const parts = p.descriptionBody != null ? [p.descriptionBody, ...lists, p.additional, p.opening] : [p.description, ...lists, p.additional];
  return {
    title: p.text || "",
    locationName: String(p.categories?.location || "").trim(),
    workplaceType: p.workplaceType || "",
    descriptionHtml: parts.filter(Boolean).join("\n"),
    team: p.categories?.team || "",
    commitment: p.categories?.commitment || "",
  };
}

/** Lever's fixed contact/link fields, filled straight from the profile. */
const SYSTEM_NAMES = new Set(["name", "email", "phone", "location", "org", "resume", "pronouns"]);
const URL_FIELDS = { linkedin: ["linkedin", "linkedinUrl"], github: ["github", "githubUrl"], portfolio: ["portfolio", "website", "portfolioUrl"], twitter: ["twitter", "x"], other: ["website", "portfolio", "personalWebsite"] };

function firstOf(obj, keys) {
  for (const k of keys) if (obj[k] && String(obj[k]).trim()) return String(obj[k]).trim();
  return "";
}

/**
 * deps = { db, openai, model, fetch? }.
 * opts = { domFields, jobTitle?, companyName?, jobLocationName?, eu? } — the
 * fields scraped from the page ({ id (= name), label, description, type,
 * required, options:[{label, value}] }) and what the page header says.
 */
async function prepareLeverApplication(uid, site, postingId, deps, opts = {}) {
  const { db, openai, model } = deps;
  const fetchFn = deps.fetch || DEFAULT_FETCH;
  const { mapForm, aiTrapIn, BARE_LINKS, fieldKind, verifyFourTimes, sanitizeText, sanitizeBlock, STYLE_PROMPT, readability } = await engine();
  const domFields = (opts.domFields || []).filter((f) => f && f.id);
  if (!domFields.length) throw new Error("no form fields were scraped from the page");

  // 1. The posting (public API); the page header fills in what the API lacks.
  let posting = { title: "", locationName: "", workplaceType: "", descriptionHtml: "" };
  try { posting = await fetchLeverPosting(site, postingId, fetchFn, { eu: !!opts.eu }); } catch (_) { /* header values below */ }
  const job = {
    title: posting.title || opts.jobTitle || "",
    companyName: String(opts.companyName || "").trim() || site,
    locationName: posting.locationName || opts.jobLocationName || "",
    workplaceType: posting.workplaceType || "",
    descriptionHtml: posting.descriptionHtml || "",
  };

  // 2. Profile + resume + whether this company was applied to before.
  const [userSnap, resumeSnap] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection("users").doc(uid).collection("resume").doc("profile").get(),
  ]);
  const user = userSnap.exists ? userSnap.data() : {};
  const resume = applicationResume(user, resumeSnap.exists ? resumeSnap.data() : {});
  let appliedBefore = null;
  try {
    const apps = await db.collection("users").doc(uid).collection("applications").where("companyName", "==", job.companyName).limit(20).get();
    // Submitted applications only: this form's own record (made when it
    // started) and forms never sent do not count (2026-11-10).
    appliedBefore = apps.docs.some((d) => d.data()?.status === "submitted");
  } catch (_) { /* unknown -> the question parks */ }
  const profile = buildProfileForJob(user, resume, job, { appliedBefore });

  // 3. System fields straight from the profile; everything else to the engine.
  const fills = [];
  const all = ashbyToQuestions(domFieldsToSections(domFields));
  const byPath = new Map(all.map((q) => [q.path, q]));
  const text = (path, value, label) => { if (value) fills.push({ path, kind: "text", label: label || byPath.get(path)?.label || path, value: String(value), source: "profile" }); };
  for (const q of all) {
    const name = q.path;
    if (name === "name") text(name, profile.fullName);
    else if (name === "email") text(name, user.email || profile.email);
    else if (name === "phone") text(name, profile.phone);
    else if (name === "org") text(name, profile.currentCompany);
    else if (name === "resume") fills.push({ path: name, kind: "file", label: q.label, file: "resume", source: "profile" });
    else if (name === "location") {
      const f = locationFill(name, job.locationName, profile);
      // Lever's suggestions read "New York, NY, USA": match on the state code.
      const place = f && parsePlace(f.match);
      if (f) fills.push({ ...f, match: place?.abbr ? `${place.city}, ${place.abbr}` : f.match, label: q.label || "Current location" });
    } else if (/^urls\[/i.test(name)) {
      const which = name.replace(/^urls\[|\]$/g, "").toLowerCase();
      const keys = URL_FIELDS[which] || URL_FIELDS.other;
      // No LinkedIn/GitHub on file: the bare site link stands in (see BARE_LINKS).
      const v = firstOf(profile, keys) || BARE_LINKS[which] || "";
      // "Other website" only when it is not the same link as the portfolio box.
      if (v && !(which === "other" && fills.some((f) => /^urls\[/.test(f.path) && f.value === v))) text(name, v);
    }
  }
  const skip = (q) => SYSTEM_NAMES.has(q.path) && q.path !== "pronouns"
    || /^urls\[/i.test(q.path)
    || (/^consent\[/i.test(q.path) && !q.required); // marketing opt-ins stay unchecked
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

  // 5. Map + verify + fills.
  const mapped = mapForm(questions, profile, { get: (label) => cache.get(label) });
  const verdict = verifyFourTimes(mapped, questions, profile);
  fills.push(...fillsFrom(questions, mapped, fieldKind));

  // 5b. Required choice questions no rule maps ("Language skills (check all
  //     that apply)", "Do you have consistent internet access?", "Which state
  //     would you work from?"): the AI picks the true option from the profile
  //     and resume, as on Ashby. Private facts stay for the person.
  const aiPicked = new Set();
  const parked = mapped.review.map((r) => ({ r, q: questions[mapped.answers.indexOf(r)] })).filter(({ q }) => q);
  if (openai) {
    await pool(parked.filter(({ q }) => ["select", "multiselect", "boolean"].includes(fieldKind(q.fields[0])) && (q.fields[0].values || []).length), 4, async ({ r, q }) => {
      try {
        const opts = q.fields[0].values;
        const kind = fieldKind(q.fields[0]);
        const p = await pickOption({ ...q, fields: [{ ...q.fields[0], type: kind === "multiselect" ? "multi" : "single" }] }, ctx, profile, aiDeps);
        if (!p.values.length) { aiNotes.set(r.label, p.reason); return; }
        const value = p.values[0];
        fills.push({ path: q.path, label: q.label, source: "ai", note: `AI pick: ${p.why || ""}`.trim(), kind, ...(kind === "multiselect" ? { values: p.values } : { value: kind === "boolean" ? (/^y/i.test(value) ? "Yes" : /^n/i.test(value) ? "No" : value) : (opts.find((o) => o.label === value)?.label ?? value) }) });
        aiPicked.add(r.label);
      } catch (e) { aiNotes.set(r.label, `AI pick failed: ${String(e?.message || e).slice(0, 80)}`); }
    });
    // 5c. Required text / number boxes no rule knows ("What university did
    //     you attend?"): the AI answers in the box's own format.
    await pool(parked.filter(({ r, q }) => !aiPicked.has(r.label) && ["number", "text", "longtext"].includes(fieldKind(q.fields[0])) && !/needs a link|password|no referral|follow-up/i.test(r.note || "")), 4, async ({ r, q }) => {
      try {
        const num = fieldKind(q.fields[0]) === "number";
        const a = await answerFreeText({ ...q, ashbyType: num ? "Number" : q.ashbyType, description: [q.description, num ? "Reply with a single number only, no words." : ""].filter(Boolean).join(" ") }, ctx, aiDeps);
        const value = num ? String(a.answer || "").match(/-?\d+(\.\d+)?/)?.[0] : a.answer;
        if (!value) { aiNotes.set(r.label, a.reason || "AI gave no answer"); return; }
        fills.push({ path: q.path, label: q.label, source: "ai", note: "AI answer", kind: num ? "number" : "text", value });
        aiPicked.add(r.label);
      } catch (e) { aiNotes.set(r.label, `AI failed: ${String(e?.message || e).slice(0, 80)}`); }
    });
  }

  // 6. Resume bytes.
  let resumeB64 = null;
  const resumeUrl = user.resumeUrl || resume.resumeUrl;
  if (resumeUrl) {
    try { resumeB64 = Buffer.from(await (await fetchFn(resumeUrl)).arrayBuffer()).toString("base64"); } catch (_) { /* content script reports it */ }
  }

  // Still open: parked questions the AI did not answer and nothing else filled.
  const filledPaths = new Set(fills.map((f) => f.path));
  const review = mapped.review.filter((r) => !aiPicked.has(r.label) && !filledPaths.has(questions[mapped.answers.indexOf(r)]?.path))
    .map((r) => ({ label: r.label, note: aiNotes.get(r.label) || r.note, path: questions[mapped.answers.indexOf(r)]?.path || "" }));
  const required = domFields.filter((f) => f.required);
  return {
    jobTitle: job.title,
    companyName: job.companyName,
    locationName: job.locationName,
    workplaceType: job.workplaceType,
    schemaSource: "dom",
    // A completeness failure the AI answers cleared is not a failure.
    ready: review.length === 0 && (verdict.ok || verdict.failures.every((f) => /completeness/i.test(String(f)))),
    reasons: verdict.failures,
    review,
    fills,
    resumeB64,
    // The saved resume is the PDF even when its name is the LaTeX source's
    // ("Akash_Ramasani.tex", which Ashby refused, 2026-11-10).
    resumeName: String(user.resumeFileName || resume.fileName || "resume.pdf").replace(/\.(tex|latex|txt)$/i, ".pdf"),
    answered: fills.length,
    total: all.length,
    totalFields: all.length,
    requiredTotal: required.length,
    parked: review.map((r) => `${r.label.slice(0, 60)} -> ${r.note}`),
  };
}

module.exports = { prepareLeverApplication, fetchLeverPosting };
