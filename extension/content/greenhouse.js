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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

  // Greenhouse shows a confirmation page (or empties the form) once the person
  // submits. Poll for 30 minutes; never click Submit.
  function watchForSubmit(answersLog) {
    const t0 = Date.now();
    const formPresent = () => !!document.querySelector("#application_form, form#application-form, input[id^='question_'], #first_name");
    const watch = setInterval(() => {
      const done = !formPresent() || /confirmation|thank/i.test(location.href) || /thank you for applying|application has been submitted|application submitted/i.test(document.body?.innerText?.slice(0, 4000) || "");
      if (done) {
        clearInterval(watch);
        ledger("submitted", { answersLog }).then(() => banner("JobWatch: application recorded as submitted."));
      } else if (Date.now() - t0 > 30 * 60 * 1000) clearInterval(watch);
    }, 2000);
  }

  // ── Main ──────────────────────────────────────────────────────────────────
  async function run() {
    const ids = jobIds();
    if (!ids) { warn("could not read token/id from URL"); return; }
    log("job", ids.token, ids.id, "— requesting computed application...");

    // Every form visit is an attempt; a form already submitted is left alone.
    const started = await ledger("start");
    if (started?.duplicate) { banner(`JobWatch: you already applied to ${started.reason === "same role" ? "this role at this company" : "this job"} on ${fmtDay(started.submittedAt)}. Not filling it again. Add #jwforce to the URL and reload to fill anyway.`); return; }
    if (!started?.ok) warn("ledger(start) failed:", started?.error);

    const pkg = await sendMsg({ type: "GET_GH_FILL_DATA", token: ids.token, id: ids.id });
    if (!pkg || !pkg.ok) { warn("compute failed:", pkg && pkg.error); ledger("error", { error: String(pkg?.error || "compute failed") }); return; }
    const data = pkg.data;
    if (data.alreadyApplied) { banner(`JobWatch: you already applied to this job on ${fmtDay(data.submittedAt)}. Not filling it again.`); return; }
    log(`computed: ready=${data.ready}, ${data.fills.length} fields, resume=${data.resumeB64 ? "yes" : "no"}`);
    if (!data.ready) warn("gate parked this job:", data.reasons);
    const answersLog = {};

    // Where a fill lands on the page, so the form is filled top to bottom.
    function elementFor(f) {
      if (f.kind === "file") return findFileInput(fileSlot(f));
      let el = findFieldByLabel(f.label);
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
          else {
            stillFailing.push(f);
            warn(`fill failed (pass ${pass}):`, f.label, "—", res.error || "unknown", res.seen ? "| options seen: " + JSON.stringify(res.seen) : "");
          }
        } catch (e) { stillFailing.push(f); warn(`fill error (pass ${pass}):`, f.label, e.message); }
        await sleep(120);
      }
      pending = stillFailing;
    }
    hl.hide();

    if (pending.length) warn("STILL UNFILLED after all passes:", pending.map((f) => f.label));

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
        const f = data.fills.find((x) => norm(x.label) === norm(p.label) || squash(x.label) === squash(p.label));
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
    banner(pending.length
      ? `JobWatch filled ${ok}/${data.fills.length}. Complete manually: ${pending.map((f) => f.label).join(", ").slice(0, 140)} — then Submit. (Saved to your Applications page.)`
      : `JobWatch filled all ${ok} fields. Review, solve the CAPTCHA, then Submit.`);
    // Record the attempt: every answer, everything left for the person
    // (fields that would not fill, plus questions the engine parked).
    const needsAttention = [
      ...pending.map((f) => ({ path: f.name || "", label: f.label, note: boardNotes.has(f.label) ? `could not be filled. The form says: ${boardNotes.get(f.label)}` : "could not be filled on the page" })),
      ...(Array.isArray(data.review) ? data.review.map((r) => ({ path: r.path || "", label: r.label || "", note: r.note || "needs you" })) : []),
      ...[...boardNotes.entries()].filter(([label]) => !pending.some((f) => f.label === label) && !(data.review || []).some((r) => r.label === label)).map(([label, text]) => ({ path: "", label, note: `The form says: ${text}` })),
    ];
    ledger("filled", { answersLog, needsAttention, filledCount: ok, totalFields: data.totalFields || data.fills.length + needsAttention.length, requiredTotal: data.requiredTotal || 0, flow: "engine", schemaSource: "greenhouse-api", reasons: data.reasons || [], jobTitle: data.jobTitle || "", companyName: data.companyName || "" })
      .then((r) => { if (!r?.ok) warn("ledger(filled) failed:", r?.error); });
    watchForSubmit(answersLog);
  }

  // Required fields that are still empty, plus every error message the board
  // shows, each tied to its field label.
  function ghProblems() {
    const out = [];
    const seen = new Set();
    const labelText = (lab) => (lab?.textContent || "").replace(/\*/g, "").replace(/\s+/g, " ").trim();
    const isEmpty = (el) => {
      if (!el) return false;
      if (el.type === "checkbox" || el.type === "radio") { const group = el.closest("fieldset, div"); return !group?.querySelector("input:checked"); }
      if (el.type === "file") return !(el.files && el.files.length) && !el.closest("div")?.querySelector("[class*='file'] [class*='name'], .chosen, [data-testid*='file-name']");
      if (isCombobox(el)) {
        const box = el.closest("[class*='select'], [class*='control']")?.parentElement || el.parentElement;
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
      const required = /\*/.test(lab.textContent || "") || el.required || el.getAttribute("aria-required") === "true";
      const wrap = lab.closest("div.field, div[class*='field'], fieldset, div") || lab.parentElement;
      const errEl = [...(wrap?.querySelectorAll(".field-error, .error-message, [class*='error'], [role=alert]") || [])].find((e) => e.offsetParent !== null && e.textContent.trim());
      const error = errEl ? errEl.textContent.replace(/\s+/g, " ").trim().slice(0, 160) : (el.getAttribute("aria-invalid") === "true" ? "this field is not valid" : "");
      if ((required && isEmpty(el)) || error) {
        if (seen.has(label)) continue;
        seen.add(label);
        out.push({ label, error, empty: isEmpty(el) });
      }
    }
    return out;
  }

  let bannerEl = null;
  function banner(text) {
    if (!bannerEl) {
      bannerEl = document.createElement("div");
      bannerEl.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#4f46e5;color:#fff;padding:10px 16px;font:600 13px system-ui;text-align:center";
      document.body.appendChild(bannerEl);
    }
    bannerEl.textContent = text;
  }

  // Greenhouse renders the form async; wait for the first name field, then run.
  (async () => {
    for (let i = 0; i < 40; i++) {
      if (document.querySelector("#first_name, input[id^='question_']")) break;
      await sleep(500);
    }
    // small settle for the rest of the comboboxes to mount
    await sleep(800);
    run().catch((e) => { warn("run failed:", e.message); ledger("error", { error: e.message }); });
  })();
})();
