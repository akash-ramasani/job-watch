// greenhouse.js — auto-fill a Greenhouse application form.
//
// Flow: read token+id from the URL -> ask the background for the computed
// application (prepareGreenhouseApplication) -> fill every field by matching
// the answer's label to the rendered field's label -> upload the resume ->
// STOP before submit. You solve any CAPTCHA and click Submit.
//
// Greenhouse renders a React form: text inputs, custom comboboxes (click then
// pick), file inputs, and a consent checkbox. All DOM mutation that React must
// notice goes through the background's MAIN-world executor (EXEC_MAIN_WORLD).

(function () {
  "use strict";
  const TAG = "[JobWatch/GH]";
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const sleep = (ms) => (window.__jwWait ? window.__jwWait(ms) : new Promise((r) => setTimeout(r, ms)));
  const sendMsg = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

  // Normalize a label for matching: drop the required "*", trailing ":", and
  // collapse whitespace. "State:*" and "State:" both become "state".
  const norm = (s) => (s || "").replace(/\*+/g, "").replace(/\s+/g, " ").trim().replace(/:$/, "").toLowerCase();

  // ── Read token + id from the URL ─────────────────────────────────────────
  function jobIds() {
    const u = new URL(location.href);
    // embed: ?for=westmonroe4&token=5801015004
    let token = u.searchParams.get("for");
    let id = u.searchParams.get("token");
    // hosted: job-boards.greenhouse.io/{token}/jobs/{id}
    if (!token || !id) {
      const m = location.pathname.match(/\/([^/]+)\/jobs\/(\d+)/);
      if (m) { token = m[1]; id = m[2]; }
    }
    return token && id ? { token, id } : null;
  }

  // ── Find the rendered field element for a given answer label ──────────────
  // Greenhouse gives each field a wrapper; the label text is in a <label>.
  // Space-insensitive compare: the form API says "VeteranStatus" while the
  // page renders "Veteran Status".
  const squash = (s) => norm(s).replace(/\s+/g, "");

  function findFieldByLabel(label) {
    const want = norm(label);
    const wantSquashed = squash(label);
    const labels = [...document.querySelectorAll("label")];
    for (const lab of labels) {
      if (norm(lab.textContent) !== want && squash(lab.textContent) !== wantSquashed) continue;
      // the control is referenced by "for", or sits inside/next to the label
      const forId = lab.getAttribute("for");
      if (forId) {
        const el = document.getElementById(forId);
        if (el) return el;
      }
      const wrap = lab.closest("div");
      const ctrl = wrap && wrap.querySelector("input, textarea, select, [role=combobox]");
      if (ctrl) return ctrl;
    }
    return null;
  }

  // A question answered with a group of checkboxes or radios ("Have you
  // previously been employed by Stitch Fix in any capacity?" -> four
  // checkboxes): the inputs under the label, legend or heading that reads
  // the question, or null.
  function findChoiceGroup(label) {
    const want = norm(label);
    const wantSquashed = squash(label);
    const heads = [...document.querySelectorAll("legend, label, p, span, h3, h4, div")]
      .filter((e) => e.children.length <= 3 && e.textContent.length < 600 && (norm(e.textContent) === want || squash(e.textContent) === wantSquashed));
    for (const h of heads) {
      let box = h.closest("fieldset") || h.parentElement;
      for (let k = 0; box && k < 4 && box.tagName !== "FORM"; k++, box = box.parentElement) {
        const inputs = [...box.querySelectorAll("input[type=checkbox], input[type=radio]")];
        // One box is a group too: "Please review the points below" -> "I acknowledge ...".
        if (inputs.length >= 1) return inputs;
        if (box.querySelector("input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea, select, [role=combobox]")) break;
      }
    }
    return null;
  }
  function choiceLabel(input) {
    const lab = (input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`)) || input.closest("label");
    return (lab?.textContent || input.nextElementSibling?.textContent || input.value || "").replace(/\s+/g, " ").trim();
  }
  /** Tick the options whose text matches the answers (exact, then prefix, then contains). */
  async function fillChoices(inputs, values) {
    const picked = [];
    for (const v of values) {
      const want = norm(v);
      const opts = inputs.map((i) => ({ i, t: norm(choiceLabel(i)) }));
      const hit = opts.find((o) => o.t === want) || opts.find((o) => o.t.startsWith(want) || want.startsWith(o.t)) || opts.find((o) => want.length >= 4 && o.t.includes(want));
      if (!hit) continue;
      if (!hit.i.checked) {
        if (hit.i.id) await sendMsg({ type: "EXEC_MAIN_WORLD", action: "ghCheck", id: hit.i.id });
        else hit.i.click();
        await sleep(150);
      }
      if (hit.i.checked) picked.push(choiceLabel(hit.i));
    }
    return picked.length ? { ok: true, picked } : { ok: false, error: "no option matched", seen: inputs.map(choiceLabel) };
  }

  // Prefix variant — the location field renders as "Location (City)" while the
  // form JSON labels it "Location".
  function findFieldByLabelPrefix(prefix) {
    const want = norm(prefix);
    for (const lab of [...document.querySelectorAll("label")]) {
      if (!norm(lab.textContent).startsWith(want)) continue;
      const forId = lab.getAttribute("for");
      if (forId) {
        const el = document.getElementById(forId);
        if (el) return el;
      }
      const wrap = lab.closest("div");
      const ctrl = wrap && wrap.querySelector("input, textarea, select, [role=combobox]");
      if (ctrl) return ctrl;
    }
    return null;
  }

  // Containment variant for EEO fills: "race" finds "Please identify your race".
  function findFieldByLabelContains(token) {
    const want = norm(token);
    for (const lab of [...document.querySelectorAll("label")]) {
      if (!norm(lab.textContent).includes(want)) continue;
      const forId = lab.getAttribute("for");
      if (forId) {
        const el = document.getElementById(forId);
        if (el) return el;
      }
      const wrap = lab.closest("div");
      const ctrl = wrap && wrap.querySelector("input, textarea, select, [role=combobox]");
      if (ctrl) return ctrl;
    }
    return null;
  }

  const isCombobox = (el) => el.getAttribute && (el.getAttribute("role") === "combobox" || el.getAttribute("aria-haspopup") === "listbox");

  // ── Fillers (route through MAIN world). Each returns the MAIN-world result
  // object ({ ok, error?, seen? }) so failures can be logged with details. ──
  async function fillText(el, value) {
    // Type like a person first; fall back to the direct setter if React
    // dropped the typed value.
    let r = await sendMsg({ type: "EXEC_MAIN_WORLD", action: "typeHuman", id: el.id, value });
    if (r?.result?.ok) return r.result;
    r = await sendMsg({ type: "EXEC_MAIN_WORLD", action: "setInput", id: el.id, value });
    return r?.result || { ok: false, error: "no result" };
  }
  async function fillCombobox(el, value) {
    const r = await sendMsg({ type: "EXEC_MAIN_WORLD", action: "ghSelectCombobox", id: el.id, value });
    return r?.result || { ok: false, error: "no result" };
  }
  async function checkBox(el) {
    const r = await sendMsg({ type: "EXEC_MAIN_WORLD", action: "ghCheck", id: el.id });
    return r?.result || { ok: false, error: "no result" };
  }
  // Which upload slot a file fill belongs to. Greenhouse drops a file input
  // once a file is attached, so the slot must be named explicitly: a resume
  // must never fall through to the cover letter's input on a retry.
  const fileSlot = (f) => (/cover/i.test(f.label || "") || /cover/i.test(f.name || "") ? "cover" : "resume");
  /** The file input for a slot, by Greenhouse's ids first, then by the section it sits in. */
  function findFileInput(slot) {
    const byId = document.getElementById(slot === "cover" ? "cover_letter" : "resume");
    if (byId && byId.type === "file") return byId;
    for (const i of document.querySelectorAll("input[type=file]")) {
      const attrs = `${i.id} ${i.name} ${i.getAttribute("aria-label") || ""}`;
      let sec = "";
      for (let p = i.parentElement, k = 0; p && k < 6 && p.tagName !== "FORM"; p = p.parentElement, k++) {
        const t = (p.textContent || "").replace(/\s+/g, " ");
        if (/resume|\bcv\b|cover/i.test(t)) { sec = t; break; }
      }
      const cover = /cover/i.test(attrs) || (/cover/i.test(sec) && !/resume|\bcv\b/i.test(sec));
      const resume = /resume|\bcv\b/i.test(attrs) || (/resume|\bcv\b/i.test(sec) && !/cover/i.test(sec));
      if (slot === "cover" ? cover : resume) return i;
    }
    return null;
  }
  async function uploadFile(el, b64, name, slot) {
    // el may be null: the resume widget has no <label>. The MAIN-world side
    // then finds the input for `slot` itself, and reports "already attached"
    // when the slot shows a file name instead of an input.
    const r = await sendMsg({ type: "EXEC_MAIN_WORLD", action: "setFile", id: el?.id || "", b64Data: b64, fileName: name, which: slot });
    return r?.result || { ok: false, error: "no result" };
  }
  async function fillLocation(el, city, match) {
    const r = await sendMsg({ type: "EXEC_MAIN_WORLD", action: "ghLocation", id: el.id, value: city, match });
    return r?.result || { ok: false, error: "no result" };
  }
  async function pasteCoverLetter(text) {
    const r = await sendMsg({ type: "EXEC_MAIN_WORLD", action: "ghCoverText", id: "", value: text });
    return r?.result || { ok: false, error: "no result" };
  }

  // ── Application ledger (users/{uid}/applications, one record per form) ────
  function formKeyNow() {
    const ids = jobIds();
    return ids ? { formKey: `greenhouse|${ids.token.toLowerCase()}|${ids.id}`, source: "greenhouse", org: ids.token, postingId: ids.id, applyUrl: location.href.split("#")[0] } : null;
  }
  function pageJob() {
    const title = (document.querySelector(".job__title h1, .app-title, h1")?.textContent || "").trim().slice(0, 200);
    const company = (document.querySelector(".company-name, .job__company")?.textContent || "").replace(/^at\s+/i, "").trim().slice(0, 120);
    return { jobTitle: title, companyName: company || (jobIds()?.token || "") };
  }
  async function ledger(event, extra = {}) {
    const k = formKeyNow();
    if (!k) return { ok: false, error: "no form key" };
    const force = /jwforce/.test(location.hash);
    const meta = event === "start" ? { ...pageJob(), force } : {};
    try { return (await sendMsg({ type: "APPLICATION_EVENT", event, ...k, ...meta, ...extra })) || { ok: false }; } catch (e) { return { ok: false, error: e.message }; }
  }
  const fmtDay = (iso) => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "an earlier date"; };

  // ── Main ──────────────────────────────────────────────────────────────────
  async function run() {
    const ids = jobIds();
    if (!ids) { warn("could not read token/id from URL"); banner("JobWatch could not read this job's id from the page address."); return; }
    log("job", ids.token, ids.id, "— requesting computed application...");

    // Every form visit is an attempt; a form already submitted is left alone.
    const started = await ledger("start");
    if (started?.duplicate) { if (AUTO) autoReport("skipped", "already applied"); banner(`JobWatch: you already applied to ${started.reason === "same role" ? "this role at this company" : "this job"} on ${fmtDay(started.submittedAt)}. Not filling it again. Add #jwforce to the URL and reload to fill anyway.`); return; }
    if (!started?.ok) warn("ledger(start) failed:", started?.error);

    banner("JobWatch is working out your answers…");
    const pkg = await sendMsg({ type: "GET_GH_FILL_DATA", token: ids.token, id: ids.id });
    if (!pkg || !pkg.ok) { warn("compute failed:", pkg && pkg.error); if (AUTO) autoReport("error", `could not compute: ${pkg?.error || "no answer"}`); banner(`JobWatch could not compute this application: ${pkg?.error || "no answer from the extension"}`, { action: { label: "Try again", onClick: () => run().catch(() => {}) } }); ledger("error", { error: String(pkg?.error || "compute failed") }); return; }
    const data = pkg.data;
    if (data.alreadyApplied) { if (AUTO) autoReport("skipped", "already applied"); banner(`JobWatch: you already applied to this job on ${fmtDay(data.submittedAt)}. Not filling it again.`); return; }
    log(`computed: ready=${data.ready}, ${data.fills.length} fields, resume=${data.resumeB64 ? "yes" : "no"}`);
    banner(`JobWatch is filling ${data.fills.length} fields, top to bottom…`);
    if (!data.ready) warn("gate parked this job:", data.reasons);
    const answersLog = {};

    // Where a fill lands on the page, so the form is filled top to bottom.
    function elementFor(f) {
      if (f.kind === "file") return findFileInput(fileSlot(f));
      // By the question's own id first: new boards use the question name
      // (question_123) as the input id, and a form can ask the same question
      // twice (Pinterest asks work authorization twice). By label, both fills
      // landed on the first box and the second stayed empty.
      let el = f.name && /^question_\d+/.test(f.name) ? document.getElementById(f.name) : null;
      if (!el) el = findFieldByLabel(f.label);
      if (!el && ["select", "multiselect", "boolean"].includes(f.kind)) el = findChoiceGroup(f.label)?.[0] || null;
      if (!el && f.kind === "location") el = findFieldByLabelPrefix("location");
      if (!el && f.eeo) el = findFieldByLabelContains(f.eeo);
      return el;
    }
    const pageTop = (f) => { const el = elementFor(f); return el ? el.getBoundingClientRect().top + window.scrollY : Number.POSITIVE_INFINITY; };
    // The moving outline (content/highlight.js) around the whole question:
    // the smallest block that holds both the control and its label.
    const hl = window.__jwHL || { focus() {}, mark() {}, hide() {} };
    function blockFor(f) {
      let el = elementFor(f);
      if (!el && f.kind === "file") {
        // Attached already: the input is gone, frame the upload group instead.
        const re = fileSlot(f) === "cover" ? /cover/i : /resume|\bcv\b/i;
        el = [...document.querySelectorAll(".file-upload, [class*='file-upload']")].find((g) => re.test(g.textContent || "")) || null;
      }
      if (!el && f.kind === "cover-text") el = document.querySelector("#cover_letter_text, textarea[id*='cover']");
      if (!el) return null;
      let block = el.closest("div.field, div[class*='field'], fieldset") || el.parentElement || el;
      const lab = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      if (lab && !block.contains(lab)) {
        let n = el.parentElement;
        while (n && n.tagName !== "FORM" && n !== document.body && !n.contains(lab)) n = n.parentElement;
        if (n && n.tagName !== "FORM" && n !== document.body) block = n;
      }
      return block;
    }
    async function bringIntoView(f) {
      const el = elementFor(f);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      await sleep(380);
    }

    // Attempt one fill; returns the MAIN-world result ({ ok, error?, seen? }).
    async function fillOne(f) {
      // Choice questions rendered as checkboxes or radios: tick the options.
      if (["select", "multiselect", "boolean"].includes(f.kind)) {
        const group = findChoiceGroup(f.label);
        if (group) return fillChoices(group, f.values?.length ? f.values : [f.value]);
      }
      const el = elementFor(f);
      // File and cover-text fills locate their targets in the MAIN world.
      if (!el && f.kind !== "file" && f.kind !== "cover-text") return { ok: false, error: "no field for label" };
      if (f.kind === "file") {
        const slot = fileSlot(f);
        if (slot !== "resume") return { ok: false, error: `no file for the ${slot} slot` }; // the cover letter goes in as text
        return data.resumeB64 ? uploadFile(el, data.resumeB64, data.resumeName, slot) : { ok: false, error: "no resume bytes" };
      }
      if (f.kind === "cover-text") return pasteCoverLetter(f.value);
      if (f.kind === "location") return fillLocation(el, f.value, f.match);
      if (el.type === "checkbox") return checkBox(el);
      if (f.kind === "select" || f.kind === "multiselect" || f.kind === "boolean" || isCombobox(el)) {
        return fillCombobox(el, f.value);
      }
      return fillText(el, f.value);
    }

    // Fill in multiple passes: anything missed or failed (field not mounted
    // yet, slow option list, ...) is retried up to 2 more times.
    const MAX_PASSES = 3;
    let ok = 0;
    const filledLabels = new Set();
    // Top to bottom, no rush: the order a person would go in.
    let pending = [...data.fills].map((f, i) => ({ f, i, top: pageTop(f) })).sort((a, b) => (a.top - b.top) || (a.i - b.i)).map((x) => x.f);
    for (let pass = 1; pass <= MAX_PASSES && pending.length; pass++) {
      if (pass > 1) {
        log(`pass ${pass}: retrying ${pending.length} unfilled field(s)...`);
        await sleep(1200);
      }
      const stillFailing = [];
      for (const f of pending) {
        try {
          hl.focus(blockFor(f), `Filling: ${f.label}`);
          await bringIntoView(f);
          const res = await fillOne(f);
          await sleep(260);
          hl.mark(!!res.ok);
          if (res.ok) {
            ok++;
            filledLabels.add(f.label);
            log("filled:", f.label, "=>", f.kind === "file" ? "<resume>" : f.kind === "cover-text" ? "<cover letter>" : f.value);
            answersLog[f.name || f.label] = { label: f.label, answer: f.kind === "file" ? data.resumeName || "resume" : f.kind === "cover-text" ? "<cover letter>" : String(f.value ?? ""), type: f.kind || "text", source: f.source || "" };
          }
          else if (res.error === "cover letter section not found") {
            // This form has no cover letter box: nothing to fill.
            f.absent = true;
            log("no cover letter box on this form");
          }
          else if (res.error === "no field for label" && pass === MAX_PASSES) {
            // The form has no such field (e.g. no "Discipline" in its education
            // section): nothing to fill, nothing for the person to do.
            f.absent = true;
            stillFailing.push(f);
          } else {
            stillFailing.push(f);
            // Earlier passes are retries (a list still loading): only the last one is an error.
            (pass === MAX_PASSES ? warn : log)(`fill failed (pass ${pass}):`, f.label, "—", res.error || "unknown", res.seen ? "| options seen: " + JSON.stringify(res.seen) : "");
          }
        } catch (e) { stillFailing.push(f); warn(`fill error (pass ${pass}):`, f.label, e.message); }
        await sleep(120);
      }
      pending = stillFailing;
    }
    hl.hide();

    if (pending.some((f) => !f.absent)) warn("STILL UNFILLED after all passes:", pending.filter((f) => !f.absent).map((f) => f.label));

    // The phone's Country picker: the number goes in without +1, so the country is set here.
    try {
      const lab = [...document.querySelectorAll("label")].find((l) => /^country\s*\*?$/i.test((l.textContent || "").trim()));
      const ctl = lab && (document.getElementById(lab.htmlFor) || lab.parentElement?.querySelector("[role=combobox], select"));
      const box = ctl && (ctl.closest("[class*='select__control'], [class*='-control']") || ctl.parentElement);
      const empty = ctl && !(ctl.tagName === "SELECT" ? ctl.value : box?.querySelector("[class*='single-value'], [class*='singleValue']"));
      if (empty && /^(us|usa|united states)/i.test(String(data.country || "United States"))) {
        const r = await fillCombobox(ctl, "United States");
        log("phone country:", r);
      }
    } catch (e) { warn("phone country:", e.message); }
    // The newer phone box carries its own flag picker; with no country chosen
    // (a globe) Greenhouse can reject the number. US numbers get United States.
    try {
      const flag = document.querySelector(".iti__selected-country");
      const title = flag?.getAttribute("title") || "";
      if (flag && (!title || /select country/i.test(title))) {
        if (/^(us|usa|united states)/i.test(String(data.country || "United States"))) {
          flag.click();
          await sleep(300);
          const us = document.querySelector("li.iti__country[data-country-code='us']");
          if (us) { us.click(); await sleep(200); log("phone flag:", flag.getAttribute("title")); }
        }
      }
    } catch (e) { warn("phone flag:", e.message); }
    // A second Education block the board added from a saved MyGreenhouse
    // profile, with its School left empty, would hold the application back.
    // JobWatch fills one education entry: remove the empty extras.
    try {
      const blocks = [...document.querySelectorAll(".education--form")];
      for (const b of blocks.slice(1).reverse()) {
        const school = b.querySelector("input[id^='school--']");
        const box = school?.closest("[class*='select__control']");
        const chosen = box?.querySelector("[class*='single-value'], [class*='singleValue']");
        if (school && !school.value && !chosen) {
          b.querySelector("button[aria-label='Remove education']")?.click();
          await sleep(300);
          log("removed an extra education block with no school");
        }
      }
    } catch (e) { warn("education extras:", e.message); }
    // The board's resume parser fills Employment blocks from the resume and
    // glues the job's place onto the title ("Senior Software Engineer
    // Remote", "... San Jose, California"). Keep the title only.
    try {
      for (const lab of document.querySelectorAll("label")) {
        if (!/^title\b/i.test((lab.textContent || "").replace(/\*/g, "").trim())) continue;
        const el = document.getElementById(lab.getAttribute("for") || "") || lab.closest("div")?.querySelector("input");
        const block = el?.closest("fieldset, [class*='employment'], [class*='experience']") || el?.closest("div")?.parentElement?.parentElement;
        if (!el || el.tagName !== "INPUT" || !/company name/i.test(block?.textContent || "")) continue;
        const clean = stripPlace(el.value);
        if (clean && clean !== el.value) { await fillText(el, clean); log("employment title:", el.value, "<-", clean); }
      }
    } catch (e) { warn("employment titles:", e.message); }

    // Mandatory consent / acknowledgement boxes the form adds outside its questions.
    const consents = await tickRequiredConsents();
    if (consents.length) { log("ticked required consents:", consents); consents.forEach((c) => (answersLog[`consent:${c}`] = { label: c, answer: "checked", type: "checkbox", source: "rule" })); }

    // Verify four times, top to bottom: what is still empty and required, and
    // what the board itself is complaining about. Fix what has a fill; the
    // rest goes to the person with the board's own words.
    const boardNotes = new Map(); // label -> error text
    for (let pass = 1; pass <= 4; pass++) {
      await sleep(pass === 1 ? 600 : 1000);
      window.scrollTo({ top: 0, behavior: "smooth" });
      await sleep(300);
      const problems = ghProblems();
      log(`verify pass ${pass}/4: ${problems.length} problem(s)`, problems);
      if (!problems.length) break;
      banner(`JobWatch is checking the form, pass ${pass} of 4. Fixing ${problems.length} field${problems.length === 1 ? "" : "s"}.`);
      for (const p of problems) {
        if (p.error) boardNotes.set(p.label, p.error);
        // The page calls the location "Location (City)"; its fill is named "Location".
        const f = (p.id ? data.fills.find((x) => x.name === p.id) : undefined)
          || data.fills.find((x) => norm(x.label) === norm(p.label) || squash(x.label) === squash(p.label))
          || (/^location\b/i.test(p.label || "") ? data.fills.find((x) => x.kind === "location") : undefined);
        if (!f) continue;
        try {
          hl.focus(blockFor(f), `Fixing: ${f.label}`);
          await bringIntoView(f);
          const res = await fillOne(f);
          await sleep(300);
          hl.mark(!!res.ok);
          if (res.ok) {
            if (!filledLabels.has(f.label)) { ok++; filledLabels.add(f.label); }
            answersLog[f.name || f.label] = { label: f.label, answer: f.kind === "file" ? data.resumeName || "resume" : f.kind === "cover-text" ? "<cover letter>" : String(f.value ?? ""), type: f.kind || "text", source: f.source || "" };
            pending = pending.filter((x) => x !== f);
            boardNotes.delete(p.label);
          }
        } catch (e) { warn("verify fix failed:", f.label, e.message); }
      }
      hl.hide();
    }
    hl.hide();
    log(`DONE — filled ${ok}/${data.fills.length}${pending.length ? `, unfilled: ${pending.length}` : ""}. Review the form, solve any CAPTCHA, then click Submit.`);
    // An optional field that would not fill (a cover letter the form doesn't
    // require, a voluntary survey) never holds the application back.
    const optionalLeft = pending.filter((f) => f.required === false || f.absent);
    const optionalSet = new Set([...(data.optionalLabels || []), ...data.fills.filter((f) => f.required === false).map((f) => f.label)].map(squash));
    const isOptional = (l) => optionalSet.has(squash(l));
    if (optionalLeft.length) log("optional fields left empty:", optionalLeft.map((f) => f.label));
    // AI rescue: every mandatory field ("*") still empty or flagged goes to
    // Claude with its HTML; it says what to click, type or pick from the profile.
    const rescued = new Set();
    const rescueNotes = new Map();
    const stuck = [...new Set([...pending.filter((f) => f.required !== false && !f.absent).map((f) => f.label), ...(data.review || []).map((r) => r.label), ...ghProblems().map((p) => p.label)])].filter((l) => l && !isOptional(l));
    // Ask the AI about the page's own label: it looks for "Location (City)",
    // not the fill's name "Location" (which it reported as "field not found").
    const pageLabelFor = (l) => {
      if (!/^location$/i.test(l)) return l;
      const lab = [...document.querySelectorAll("label")].find((x) => /^location\b/i.test((x.textContent || "").trim()));
      return lab ? lab.textContent.replace(/\*/g, "").trim() : l;
    };
    for (const stuckLabel of stuck.slice(0, 8)) {
      const label = pageLabelFor(stuckLabel);
      if (!window.__jwRescue) break;
      banner(`JobWatch is asking AI how to finish: ${label}`);
      const r = await window.__jwRescue(label, { jobTitle: data.jobTitle || "", companyName: data.companyName || "" });
      log("rescue:", label, r);
      if (r?.ok) { rescued.add(label); rescued.add(stuckLabel); answersLog[`rescue:${label}`] = { label, answer: r.answer || "(AI rescue)", type: "ai-rescue", source: "ai" }; }
      else if (r?.why) { rescueNotes.set(label, r.why); rescueNotes.set(stuckLabel, r.why); }
    }
    // What is still wrong after the rescue, by the page's own "*" and errors.
    // An optional question (Cover Letter, the voluntary EEO survey) never
    // holds the application back, even when the page marks it.
    const still = new Map(ghProblems().filter((p) => !isOptional(p.label)).map((p) => [p.label, p]));
    // A field filled after its own fill failed (the AI rescue worked on the
    // page's label, "Location (City)" for the fill "Location") is done.
    const filledNow = (f) => {
      if (f.kind === "file" || f.kind === "cover-text") return false;
      const el = elementFor(f);
      if (!el) return false;
      if (el.type === "checkbox" || el.type === "radio") return !!(el.closest("fieldset, [role=group], [role=radiogroup]") || el.parentElement)?.querySelector("input:checked");
      const box = el.closest("[class*='select__control'], [class*='-control']");
      if (box?.querySelector("[class*='single-value'], [class*='singleValue'], [class*='multi-value'], [class*='multiValue']")) return true;
      return !box && !!String(el.value || "").trim();
    };
    const blocking = pending.filter((f) => f.required !== false && !f.absent && !rescued.has(f.label) && !filledNow(f));
    const needs = [...new Set([
      ...blocking.map((f) => f.label),
      ...(data.review || []).map((r) => r.label).filter((l) => !rescued.has(l)),
      ...[...still.keys()],
    ])].filter((l) => l && !isOptional(l) && (still.has(l) || !rescued.has(l)) && !optionalLeft.some((f) => f.label === l && !still.has(l)))
      // The location fill is named "Location"; the page calls it "Location (City)": list it once.
      .filter((l, _i, all) => !(l === "Location" && all.some((x) => x !== l && x.startsWith("Location"))));
    for (const l of rescueNotes.keys()) if (needs.includes(l)) boardNotes.set(l, `${boardNotes.get(l) ? boardNotes.get(l) + ". " : ""}AI: ${rescueNotes.get(l)}`);
    const doneMsg = needs.length
      ? `JobWatch filled ${ok} of ${data.fills.length}. These still need you, then press Submit:`
      : `JobWatch filled all ${ok} fields. Review, solve the CAPTCHA, then press Submit.`;
    banner(doneMsg, { action: submitAction(doneMsg, needs), items: needs });
    // What the person types into these before Submit goes to the answer bank.
    if (needs.length && window.__jwLearnManual) window.__jwLearnManual(needs, { jobTitle: data.jobTitle || "", companyName: data.companyName || "" });
    // Record the attempt: every answer, everything left for the person
    // (fields that would not fill, plus questions the engine parked).
    const needsAttention = [
      ...blocking.map((f) => ({ path: f.name || "", label: f.label, note: boardNotes.has(f.label) ? `could not be filled. The form says: ${boardNotes.get(f.label)}` : "could not be filled on the page" })),
      ...(Array.isArray(data.review) ? data.review.filter((r) => !rescued.has(r.label)).map((r) => ({ path: r.path || "", label: r.label || "", note: rescueNotes.has(r.label) ? `${r.note || "needs you"}. AI: ${rescueNotes.get(r.label)}` : r.note || "needs you" })) : []),
      ...[...boardNotes.entries()].filter(([label]) => !pending.some((f) => f.label === label) && !(data.review || []).some((r) => r.label === label)).map(([label, text]) => ({ path: "", label, note: `The form says: ${text}` })),
    ];
    ledger("filled", { answersLog, needsAttention, filledCount: ok, totalFields: data.totalFields || data.fills.length + needsAttention.length, requiredTotal: data.requiredTotal || 0, flow: "engine", schemaSource: "greenhouse-api", reasons: data.reasons || [], jobTitle: data.jobTitle || "", companyName: data.companyName || "" })
      .then((r) => { if (!r?.ok) warn("ledger(filled) failed:", r?.error); });
    // Submit, auto-apply or not (the person's call, 2026-11-02): a form
    // JobWatch filled goes in on its own, with the same repair rounds.
    return autoSubmitGreenhouse(needs, answersLog, data);
  }

  // ── Unattended auto-apply (background.js runs the queue) ─────────────────
  let AUTO = null;
  const autoReport = (status, note) => sendMsg({ type: "AUTO_RESULT", status, note }).catch(() => {});
  const visible = (el) => !!el && el.offsetParent !== null;
  function codeInputs() {
    const hint = (i) => `${i.id} ${i.name} ${i.getAttribute("aria-label") || ""} ${i.getAttribute("autocomplete") || ""} ${i.getAttribute("placeholder") || ""}`;
    return [...document.querySelectorAll("input")].filter((i) => visible(i) && !["hidden", "checkbox", "radio", "file"].includes(i.type) && /security|verification|one-time-code|\bcode\b/i.test(hint(i)) && !/zip|postal|phone|country|promo/i.test(hint(i)));
  }
  function confirmed() {
    const text = (document.body?.innerText || "").slice(0, 5000);
    return /confirmation|thank/i.test(location.href) || /thank you for applying|thanks for applying|application (has been |was )?(successfully )?(submitted|received)|we('ve| have) received your application/i.test(text);
  }
  // A challenge counts only when a person could see it (reCAPTCHA keeps a hidden frame on the page).
  function onScreen(el) {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 100 && r.height > 100 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }
  function captchaVisible() {
    return [...document.querySelectorAll("iframe[src*='recaptcha'][src*='bframe'], iframe[src*='hcaptcha'][src*='challenge'], iframe[title*='challenge' i]")].some(onScreen);
  }
  /** Auto-apply: press Submit even when a field is listed for the person.
   *  The form says what it really wants; the AI fixes that and it goes again. */
  async function autoSubmitGreenhouse(needs, answersLog) {
    const r = await submitAndRepair({ answersLog, auto: true, needs });
    if (r.status === "submitted") return autoReport("submitted", "");
    return autoReport("needs_attention", r.note);
  }

  /** Press Submit; enter the security code Greenhouse emails (read from
   *  Gmail); when the form marks fields, hand each with the form's own words
   *  to the AI, then press Submit again. Three repair rounds.
   *  -> { status: "submitted" | "needs_attention", note } */
  async function submitAndRepair({ answersLog = {}, auto = false, needs = [] } = {}) {
    const say = (t, items) => banner(`${auto ? "Auto-apply" : "JobWatch"}: ${t}`, items ? { items, action: submitAction("", items) } : {});
    const meta = { jobTitle: document.title || "", companyName: "" };
    // Test runs set jwNoSubmit: fill, never send.
    if ((await chrome.storage.local.get("jwNoSubmit").catch(() => ({}))).jwNoSubmit) return { status: "needs_attention", note: "test run: not submitted" };
    // Never without the resume.
    const noResume = ghProblems().find((p) => /^(resume|cv)\b/i.test(p.label || ""));
    if (noResume) { say("the resume would not attach. Attach it and press Submit.", [noResume.label]); return { status: "needs_attention", note: "resume would not attach" }; }
    let codeTries = 0;
    for (let round = 0; round <= 3; round++) {
      const btn = ghSubmitButton();
      if (!btn) { say("could not find the Submit button. Scroll down and press it."); return { status: "needs_attention", note: "could not find Greenhouse's Submit button" }; }
      say(round ? `submitting again (try ${round + 1} of 4)…` : "submitting…");
      btn.scrollIntoView({ block: "center" });
      await sleep(600);
      const clickedAt = Date.now();
      await sendMsg({ type: "AUTO_SUBMITTING" }).catch(() => {}); // the runner watches for the thank-you page
      btn.click();
      let flagged = [];
      for (let i = 0; i < 60; i++) {
        await sleep(2000);
        if (confirmed() && !codeInputs().length) {
          await ledger("submitted", { answersLog });
          say("submitted and recorded.");
          return { status: "submitted", note: "" };
        }
        if (codeInputs().length) {
          if (codeTries >= 2) { say("the security code was not accepted. Check your email, enter it and press Submit."); return { status: "needs_attention", note: "security code not accepted" }; }
          codeTries++;
          say("Greenhouse emailed a security code. Reading it from Gmail…");
          const r = await sendMsg({ type: "GET_GH_CODE", since: clickedAt });
          if (!r?.ok || !r.code) {
            say(`could not get the security code (${r?.error || "no email yet"}). Enter it from your email and press Submit.`);
            return { status: "needs_attention", note: `security code: ${r?.error || "no email"}` };
          }
          const put = await sendMsg({ type: "EXEC_MAIN_WORLD", action: "ghCode", value: r.code });
          if (!put?.result?.ok) { say("could not type the security code. Enter it and press Submit."); return { status: "needs_attention", note: `security code: ${put?.result?.error || "could not enter it"}` }; }
          say("security code entered, submitting…");
          await sleep(800);
          const again = ghSubmitButton();
          if (again) { again.scrollIntoView({ block: "center" }); again.click(); }
          continue;
        }
        if (captchaVisible()) {
          say("Greenhouse is showing a CAPTCHA. Solve it and press Submit.");
          return { status: "needs_attention", note: "CAPTCHA challenge" };
        }
        if (i >= 3) { flagged = ghProblems(); if (flagged.length) break; }
      }
      if (!flagged.length) {
        if (confirmed()) { await ledger("submitted", { answersLog }); say("submitted and recorded."); return { status: "submitted", note: "" }; }
        say("no confirmation from Greenhouse after 2 minutes. Check the form.");
        return { status: "needs_attention", note: "no confirmation after 2 minutes" };
      }
      if (round === 3 || !window.__jwRescue) break;
      // The form marked fields: the AI gets each with the form's own words.
      let fixed = 0;
      for (const p of flagged.slice(0, 8)) {
        say(`asking AI to fix: ${p.label}`);
        const r = await window.__jwRescue(p.label, { ...meta, error: p.error || "This field is required.", force: true }).catch(() => null);
        log("repair:", p.label, p.error, r);
        if (r?.ok) { fixed++; answersLog[`rescue:${p.label}`] = { label: p.label, answer: r.answer || "(AI rescue)", type: "ai-rescue", source: "ai" }; }
      }
      if (!fixed) break;
    }
    const left = ghProblems().map((x) => x.label).filter(Boolean);
    const list = left.length ? left : needs;
    ledger("filled", { answersLog, needsAttention: list.map((l) => ({ path: "", label: l, note: "after Submit: the form still marks it" })) }).catch(() => {});
    say("Greenhouse did not accept it. These need you, then press Submit:", list);
    return { status: "needs_attention", note: `Greenhouse flagged: ${list.slice(0, 4).join("; ") || "the form"}` };
  }

  /** Tick every mandatory consent or acknowledgement box ("I acknowledge receipt
   *  of the Privacy Notice", "By checking this box, I consent ..."). Marketing,
   *  SMS and talent-community opt-ins are never ticked. */
  async function tickRequiredConsents() {
    const ticked = [];
    for (const box of document.querySelectorAll("input[type=checkbox]")) {
      if (box.checked || box.offsetParent === null && !box.closest("label")) continue;
      const lab = (box.id && document.querySelector(`label[for="${CSS.escape(box.id)}"]`)) || box.closest("label");
      const block = box.closest("fieldset, div.field, div[class*='field'], div") || box.parentElement;
      const text = `${lab?.textContent || ""} ${(block?.textContent || "").slice(0, 400)}`.replace(/\s+/g, " ");
      const required = box.required || box.getAttribute("aria-required") === "true" || /\*/.test(text);
      if (!required) continue;
      if (!/\b(consent|acknowledge|agree|certify|confirm|i have read|i understand|attest)\b/i.test(text)) continue;
      if (/marketing|newsletter|promotional|text messages?|\bsms\b|whatsapp|future (job )?opportunit|talent (community|network|pool)|job alerts?/i.test(text)) continue;
      if (box.id) await sendMsg({ type: "EXEC_MAIN_WORLD", action: "ghCheck", id: box.id }); else box.click();
      await sleep(150);
      if (box.checked) ticked.push((lab?.textContent || text).trim().slice(0, 80));
    }
    return ticked;
  }

  // Required fields that are still empty, plus every error message the board
  // shows, each tied to its field label.
  // "Senior Software Engineer San Jose, California" -> "Senior Software Engineer".
  const US_STATES = "Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|USA|India";
  const ROLE_WORD = /^(engineer|developer|manager|scientist|lead|analyst|designer|architect|intern|consultant|director|specialist|administrator|associate|programmer|researcher|officer|head|ii|iii|iv|i|sr\.?|jr\.?|senior|staff|principal)$/i;
  function stripPlace(title) {
    let t = String(title || "").trim().replace(/\s*[-–|(]?\s*\(?(remote|hybrid|on-?site)\)?$/i, "").trim();
    const m = t.match(new RegExp(`^(.*?),\\s*(?:${US_STATES})$`));
    if (m) {
      const words = m[1].split(/\s+/);
      let n = 0; // the city: up to three words after the last role word
      while (n < 3 && words.length - n > 1 && !ROLE_WORD.test(words[words.length - 1 - n])) n++;
      if (n && ROLE_WORD.test(words[words.length - 1 - n])) t = words.slice(0, words.length - n).join(" ");
    }
    return t.replace(/[\s,–-]+$/, "");
  }

  function ghProblems() {
    const out = [];
    const seen = new Set();
    const labelText = (lab) => (lab?.textContent || "").replace(/\*/g, "").replace(/\s+/g, " ").trim();
    const isEmpty = (el) => {
      if (!el) return false;
      if (el.type === "checkbox" || el.type === "radio") {
        // The whole group ("Australia, Belgium, ..., US"), not the one option's own box.
        let group = el.closest("fieldset, [role=group], [role=radiogroup]");
        for (let n = el.parentElement; !group && n && n.tagName !== "FORM"; n = n.parentElement) if (n.querySelectorAll(`input[type=${el.type}]`).length > 1) group = n;
        return !(group || el.parentElement)?.querySelector("input:checked");
      }
      if (el.type === "file") return !(el.files && el.files.length) && !el.closest("div")?.querySelector("[class*='file'] [class*='name'], .chosen, [data-testid*='file-name']");
      if (isCombobox(el)) {
        // The whole picker, not the input: on new boards the input's own class
        // reads "select__input", so closest("[class*=select]") was the input.
        const box = el.closest("[class*='select__control'], [class*='-control']") || el.parentElement?.parentElement?.parentElement;
        const chosen = box?.querySelector("[class*='single-value'], [class*='singleValue'], [class*='multi-value'], [class*='multiValue']");
        return !el.value && !chosen;
      }
      return !String(el.value || "").trim();
    };
    for (const lab of document.querySelectorAll("label")) {
      const label = labelText(lab);
      if (!label) continue;
      const forId = lab.getAttribute("for");
      const el = (forId && document.getElementById(forId)) || lab.closest("div")?.querySelector("input, textarea, select, [role=combobox]");
      if (!el) continue;
      // A greyed-out box (End date when "Current role" is ticked) can't be filled and isn't asked for.
      if (el.disabled || el.closest("[aria-disabled='true'], [class*='is-disabled'], [class*='--disabled']")) continue;
      const wrap = lab.closest("div.field, div[class*='field'], fieldset, div") || lab.parentElement;
      // Mandatory = a "*" in the question or right after its <label>, or required markers.
      const next = lab.nextElementSibling;
      const required = /\*/.test(lab.textContent || "") || el.required || el.getAttribute("aria-required") === "true"
        || (!!next && !next.matches("input, select, textarea, div") && /^\s*\*\s*$/.test(next.textContent || ""));
      const errEl = [...(wrap?.querySelectorAll(".field-error, .error-message, [class*='error'], [role=alert]") || [])].find((e) => e.offsetParent !== null && e.textContent.trim());
      const error = errEl ? errEl.textContent.replace(/\s+/g, " ").trim().slice(0, 160) : (el.getAttribute("aria-invalid") === "true" ? "this field is not valid" : "");
      if ((required && isEmpty(el)) || error) {
        // Keyed by the box, not the label: two questions can share one wording.
        const key = el.id || label;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ label, id: el.id || "", error, empty: isEmpty(el) });
      }
    }
    return out;
  }

  // The JobWatch card, bottom right (content/notify.js).
  function banner(text, { action = null, items = null } = {}) {
    window.__jwNotify.show(text, undefined, { action, items });
  }
  function ghSubmitButton() {
    return document.querySelector("#submit_app, button#submit_app, input#submit_app")
      || [...document.querySelectorAll("button, input[type=submit]")].find((b) => /submit application|^submit$/i.test((b.textContent || b.value || "").trim()))
      || null;
  }
  function submitAction(message, items = null) {
    return { label: "Submit application", onClick: () => submitAndRepair({ needs: items || [] }) };
  }

  // Greenhouse renders the form async; wait for the first name field, then
  // offer Autofill. Nothing fills until the person presses it.
  (async () => {
    let found = false;
    for (let i = 0; i < 40; i++) {
      if (document.querySelector("#first_name, input[id^='question_']")) { found = true; break; }
      await sleep(500);
    }
    if (!found) return; // a posting page without the form (or a frame without it)
    AUTO = (await sendMsg({ type: "AUTO_JOB" }))?.job || null;
    if (AUTO) {
      banner("Auto-apply: filling this application…");
      await sleep(800);
      run().catch((e) => { warn("run failed:", e.message); banner(`JobWatch failed: ${e.message}`); ledger("error", { error: e.message }); autoReport("error", e.message); });
      return;
    }
    window.__jwNotify.launcher({
      onClick: async () => {
        banner("JobWatch is reading the form…");
        await sleep(800); // let the rest of the comboboxes mount
        run().catch((e) => { warn("run failed:", e.message); banner(`JobWatch failed: ${e.message}`); ledger("error", { error: e.message }); });
      },
    });
  })();
})();
