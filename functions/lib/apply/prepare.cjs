// prepare.cjs — compute a full Greenhouse application for the extension.
// Fetches the form, maps answers with the tested engine (compliance from the
// profile only), AI-answers free text in the plain style, runs the 4-pass gate,
// and returns fill instructions the content script can apply to the rendered
// form (option LABELS for comboboxes so the script can pick them by text).

const admin = require("firebase-admin");

const GH_BASE = "https://boards-api.greenhouse.io/v1/boards";

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
  _engine = { mapForm: ae.mapForm, SOURCE: ae.SOURCE, fieldKind: fk.fieldKind, verifyFourTimes: vf.verifyFourTimes, sanitizeText: st.sanitizeText, sanitizeBlock: st.sanitizeBlock, STYLE_PROMPT: st.STYLE_PROMPT };
  return _engine;
}

/** Main entry. deps = { db, openai, model }. Returns the fill package. */
async function prepareGreenhouseApplication(uid, token, id, deps) {
  const { db, openai, model } = deps;
  const { mapForm, fieldKind, verifyFourTimes, sanitizeText, sanitizeBlock, STYLE_PROMPT } = await engine();

  // 1. Form schema (public).
  const form = await fetch(`${GH_BASE}/${token}/jobs/${id}?questions=true`).then((r) => {
    if (!r.ok) throw new Error(`greenhouse form ${token}/${id} -> ${r.status}`);
    return r.json();
  });
  const questions = form.questions || [];

  // 2. Profile + resume.
  const [userSnap, resumeSnap] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection("users").doc(uid).collection("resume").doc("profile").get(),
  ]);
  const profile = userSnap.exists ? userSnap.data() : {};
  const resume = resumeSnap.exists ? resumeSnap.data() : {};
  // Sentinel so the resume field maps to "present"; the content script uploads
  // the real bytes we return below. currentCompany comes from the resume's
  // most recent role when the profile doesn't set it.
  const profileForJob = {
    ...profile,
    resumePath: "RESUME",
    currentCompany: profile.currentCompany || (resume.roles || [])[0]?.company || "",
  };

  // 3. AI free-text (two-pass so the engine stays sync).
  const ctx = {
    name: profile.fullName || `${profile.firstName || ""} ${profile.lastName || ""}`.trim(),
    currentTitle: (resume.roles || [])[0]?.title || "",
    skills: (resume.skills || []).slice(0, 20).join(", "),
    summary: resume.summary || "",
    jobTitle: form.title,
    companyName: form.company_name || "",
  };
  const firstPass = mapForm(questions, profileForJob, null);
  // AI-answer every unanswered free-text, optional ones included — an empty
  // optional "why do you want to work here" box reads as low effort.
  const needAi = firstPass.answers.filter((a) => a.answers.length === 0 && /free-text/i.test(a.note));
  const cache = new Map();
  for (const a of needAi) {
    const ans = await answerFreeText(a.label, ctx, { openai, model, sanitizeText, STYLE_PROMPT });
    if (ans) cache.set(a.label, ans);
  }

  // 4. Map + verify.
  const mapped = mapForm(questions, profileForJob, { get: (l) => cache.get(l) });
  const verdict = verifyFourTimes(mapped, questions, profileForJob);

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
      if (ans.isFile) { fills.push({ label: a.label, name: ans.name, kind: "file" }); continue; }
      const value = kind === "select" || kind === "multiselect" || kind === "boolean"
        ? (optLabelByValue[String(ans.value)] ?? ans.value)
        : ans.value;
      fills.push({ label: a.label, name: ans.name, kind, value });
    }
  }

  // 5b. Candidate location typeahead — always the job's posted location.
  const locQ = (form.location_questions || []).find((q) => (q.fields || []).some((f) => f.name === "location"));
  const locName = ((form.location && form.location.name) || "").trim();
  if (locQ && locName) {
    const [city, st] = locName.split(",").map((s) => s.trim());
    const stateFull = US_STATES[(st || "").toUpperCase()] || st || "";
    fills.push({
      label: "Location",
      kind: "location",
      value: city || locName,
      match: stateFull ? `${city}, ${stateFull}` : (city || locName),
    });
  }

  // 5c. Education (School / Degree / Discipline / End date year) from the resume.
  fills.push(...await educationFills(token, form, resume));

  // 5d. Voluntary demographic questions from the profile (decline when unset).
  fills.push(...demographicFills(form, profile));

  // 5e. Standard EEOC compliance section (Gender / Race / Veteran / Disability).
  fills.push(...complianceFills(form, profile));

  // 6. Cover letter (plain style) + resume bytes.
  const coverText = await coverLetter(ctx, resume, form, { openai, model, sanitizeBlock, STYLE_PROMPT });
  // When the form has a cover-letter question with a paste-text variant, add a
  // fill so the content script pastes the generated letter ("enter manually").
  const clQ = questions.find((q) => (q.fields || []).some((f) => f.name === "cover_letter"));
  if (coverText && clQ && (clQ.fields || []).some((f) => f.type === "textarea")) {
    fills.push({ label: "Cover Letter", kind: "cover-text", value: coverText });
  }
  let resumeB64 = null;
  if (resume.resumeUrl) {
    try {
      const buf = Buffer.from(await (await fetch(resume.resumeUrl)).arrayBuffer());
      resumeB64 = buf.toString("base64");
    } catch (_) { /* leave null; content script keeps the manual resume step */ }
  }

  return {
    jobTitle: form.title,
    ready: verdict.ok,
    reasons: verdict.failures,
    fills,
    resumeB64,
    resumeName: resume.fileName || "resume.pdf",
    coverText,
  };
}

async function answerFreeText(question, ctx, { openai, model, sanitizeText, STYLE_PROMPT }) {
  const sys = `You are filling a job application as the candidate. ${STYLE_PROMPT} Answer in first person, two or three short sentences. If you cannot answer honestly from the given info, reply exactly NEEDS_REVIEW.`;
  const user = `Candidate: ${ctx.name}. Role: ${ctx.currentTitle}. Skills: ${ctx.skills}. Job: ${ctx.jobTitle} at ${ctx.companyName}.\nQuestion: ${question}`;
  const res = await openai.chat.completions.create({ model, temperature: 0.4, max_tokens: 160, messages: [{ role: "system", content: sys }, { role: "user", content: user }] });
  const raw = res.choices?.[0]?.message?.content?.trim() || "";
  if (!raw || /NEEDS_REVIEW/i.test(raw)) return null;
  return sanitizeText(raw) || null;
}

async function coverLetter(ctx, resume, form, { openai, model, sanitizeBlock, STYLE_PROMPT }) {
  const jd = (form.content || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200);
  const sys = `You write a short plain cover letter as the candidate. ${STYLE_PROMPT} Three short paragraphs. Do not invent facts.`;
  const user = `Candidate: ${ctx.name}, ${ctx.currentTitle}. Skills: ${ctx.skills}. Summary: ${ctx.summary}. Job: ${ctx.jobTitle} at ${ctx.companyName}. Job description: ${jd}`;
  const res = await openai.chat.completions.create({ model, temperature: 0.6, max_tokens: 380, messages: [{ role: "system", content: sys }, { role: "user", content: user }] });
  return sanitizeBlock(res.choices?.[0]?.message?.content?.trim() || "");
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

async function educationFills(token, form, resume) {
  if (!/education/.test(String(form.education || ""))) return [];
  const ed = (resume.education || [])[0];
  if (!ed) return [];
  const out = [];

  // School — the board's school search is prefix-based ("California State
  // University, East Bay" returns nothing while "California State University"
  // works), so retry with progressively shorter terms and score candidates by
  // how many of the institution's words they contain.
  if (ed.institution) {
    const wantTokens = normText(ed.institution).split(" ").filter(Boolean);
    const terms = [ed.institution, wantTokens.join(" "), wantTokens.slice(0, 3).join(" "), wantTokens.slice(0, 2).join(" ")];
    let best = null, bestScore = 0;
    for (const term of terms) {
      const items = await ghItems(`${GH_BASE}/${token}/education/schools?term=${encodeURIComponent(term)}`);
      for (const i of items) {
        const have = new Set(normText(i.text).split(" "));
        const score = wantTokens.filter((t) => have.has(t)).length / wantTokens.length;
        if (score > bestScore) { best = i; bestScore = score; }
      }
      if (bestScore >= 0.99) break; // all words matched — done
    }
    if (best && bestScore >= 0.6) out.push({ label: "School", kind: "select", value: best.text });
  }

  // Degree — classify the resume degree string into Greenhouse's fixed levels.
  const degreeStr = ed.degree || "";
  const degreeKey =
    /ph\.?\s?d|doctor of philosophy/i.test(degreeStr) ? "ph.d" :
      /m\.?b\.?a|master of business/i.test(degreeStr) ? "m.b.a" :
        /master/i.test(degreeStr) ? "master's" :
          /bachelor/i.test(degreeStr) ? "bachelor's" :
            /associate/i.test(degreeStr) ? "associate's" :
              /high school/i.test(degreeStr) ? "high school" : null;
  if (degreeKey) {
    const items = await ghItems(`${GH_BASE}/${token}/education/degrees`);
    const best = items.find((i) => i.text.toLowerCase().includes(degreeKey));
    if (best) out.push({ label: "Degree", kind: "select", value: best.text });
  }

  // Discipline — the part after the comma ("Master of Science, Computer Science"),
  // else any discipline name that appears inside the degree string.
  const discGuess = (degreeStr.split(",")[1] || "").trim();
  {
    const items = await ghItems(`${GH_BASE}/${token}/education/disciplines`);
    const want = normText(discGuess);
    const best = (want && (items.find((i) => normText(i.text) === want) || items.find((i) => normText(i.text).includes(want))))
      || items.find((i) => normText(degreeStr).includes(normText(i.text)));
    if (best) out.push({ label: "Discipline", kind: "select", value: best.text });
  }

  // End date year — pull the 4-digit year out of the resume end date.
  const yr = ((ed.endDate || "") + " " + (ed.startDate || "")).match(/(19|20)\d{2}/);
  if (yr) out.push({ label: "End date year", kind: "text", value: yr[0] });

  return out;
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

function demographicFills(form, profile) {
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
    if (!pick) pick = opts.find((o) => o.decline_to_answer);
    if (pick) out.push({ label: q.label, kind: "select", value: pick.label });
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
      if (pick) out.push({ label: q.label, kind: "select", value: pick.label, eeo });
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

module.exports = { prepareGreenhouseApplication };
