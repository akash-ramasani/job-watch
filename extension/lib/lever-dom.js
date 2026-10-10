// lib/lever-dom.js — MAIN-world helpers for Lever application forms.
//
// Injected by the background service worker (chrome.scripting.executeScript,
// world: MAIN) through EXEC_LEVER. Lever's apply page
// (jobs.lever.co/<site>/<posting>/apply) is server-rendered HTML: one
// <form id="application-form"> whose fields carry stable `name`s
// (name, email, phone, location, org, urls[LinkedIn], resume, pronouns,
// cards[<id>][field<n>], surveysResponses[...], eeo[gender], consent[marketing]).
// Each field sits in an li/div.application-question with .application-label
// and .application-field. Fields are addressed by their `name` ("path").
//
// Verified against live forms on 2026-10-10 (Match Group, Veeva):
//   text/email   input[name]            textarea[name]
//   dropdown     select[name] > option  (first option is the blank "Select...")
//   radio        ul[data-qa=multiple-choice] input[type=radio][name]
//   checkboxes   ul[data-qa=checkboxes]  input[type=checkbox][name]
//   location     #location-input (name=location) + hidden #selected-location, suggestions in .dropdown-results
//   resume       #resume-upload-input (input[type=file][name=resume], hidden behind a button)
//   errors       .error-message, .message-banner.error, .upload-error, :invalid

(function () {
  if (window.__jwLever) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nrm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const form = () => document.getElementById("application-form") || document.querySelector("form.application-form, form");
  const byName = (name) => [...(form()?.querySelectorAll(`[name="${CSS.escape(name)}"]`) || [])].filter((el) => el.type !== "hidden" || el.name === "selectedLocation");
  const questionOf = (el) => el.closest(".application-question") || el.closest("li, .application-field")?.parentElement || el.parentElement;

  function setValue(node, value) {
    node.value = value;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ── Scan ─────────────────────────────────────────────────────────────────
  function labelText(q) {
    const l = q?.querySelector(".application-label .text, .application-label");
    return (l ? l.textContent : "").replace(/✱|\*/g, "").replace(/\s+/g, " ").trim();
  }
  function optionLabel(input) {
    const span = input.closest("label")?.querySelector(".application-answer-alternative");
    return (span ? span.textContent : input.closest("label")?.textContent || input.value || "").replace(/\s+/g, " ").trim();
  }

  /** Every field of the form as { id (= name), label, description, type, required, options, filled }. */
  function scan() {
    const f = form();
    if (!f) return [];
    const out = [];
    const seen = new Set();
    for (const el of f.querySelectorAll("input[name], select[name], textarea[name]")) {
      const name = el.name;
      if (!name || seen.has(name)) continue;
      if (el.type === "hidden" || el.type === "submit" || el.type === "button") continue;
      if (/^(selectedLocation|accountId|linkedInData|origin|referer|timezone|socialReferralKey|socialSource|resumeStorageId|h-captcha-response|source)$/.test(name)) continue;
      if (/\]\[baseTemplate\]$|\]\[surveyId\]$|\]\[candidateSelectedLocation\]$/.test(name)) continue;
      seen.add(name);
      const q = questionOf(el);
      const group = byName(name);
      const label = labelText(q) || (name === "comments" ? "Additional information" : name);
      const description = (q?.querySelector(".description, .application-question-description, p.description")?.textContent || "").replace(/\s+/g, " ").trim();
      const required = group.some((g) => g.required || g.getAttribute("required") != null) || !!q?.querySelector(".required") || !!q?.querySelector(".required-field");
      let type = "text", options = [], filled = false;
      if (el.tagName === "SELECT") {
        type = "select";
        options = [...el.options].filter((o) => o.value !== "").map((o) => ({ label: o.textContent.trim(), value: o.value }));
        filled = !!el.value;
      } else if (el.type === "radio") {
        type = "radio";
        options = group.map((r) => ({ label: optionLabel(r), value: r.value }));
        filled = group.some((r) => r.checked);
      } else if (el.type === "checkbox") {
        type = "checkbox";
        options = group.filter((c) => c.type === "checkbox").map((c) => ({ label: optionLabel(c), value: c.value }));
        filled = group.some((c) => c.checked);
      } else if (el.type === "file") {
        type = "file";
        filled = !!(el.files && el.files.length) || !!q?.querySelector(".filename")?.textContent.trim();
      } else if (el.tagName === "TEXTAREA") {
        type = "textarea";
        filled = !!el.value.trim();
      } else if (name === "location" || el.classList.contains("location-input")) {
        type = "location";
        filled = !!el.value.trim();
      } else {
        type = el.type === "email" ? "email" : el.type === "tel" ? "tel" : el.type === "url" ? "url" : el.type === "number" ? "number" : "text";
        filled = !!el.value.trim();
      }
      out.push({ id: name, label, description, required, type, options, filled });
    }
    return out;
  }

  // ── Fillers ──────────────────────────────────────────────────────────────
  async function scrollTo(name) {
    const el = byName(name)[0];
    const target = el ? questionOf(el) || el : null;
    if (!target) return { ok: false, error: "field not found" };
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(380);
    return { ok: true };
  }

  /** Type like a person: one character at a time, faster for long answers so a
   *  whole paragraph still lands in about a second and a half. */
  async function typeInto(node, value) {
    const text = String(value ?? "");
    const perChar = Math.max(6, Math.min(35, Math.round(1400 / Math.max(1, text.length))));
    setValue(node, "");
    let typed = "";
    for (const ch of text) {
      typed += ch;
      node.value = typed;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(perChar);
    }
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }
  async function fillText(name, value) {
    const node = byName(name).find((el) => el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !["radio", "checkbox", "file"].includes(el.type)));
    if (!node) return { ok: false, error: "input not found" };
    node.focus();
    node.click();
    await sleep(100);
    await typeInto(node, value);
    await sleep(120);
    node.dispatchEvent(new Event("blur", { bubbles: true }));
    if (node.value !== String(value ?? "")) { setValue(node, String(value ?? "")); await sleep(80); }
    return { ok: node.value === String(value ?? ""), actual: node.value };
  }

  async function select(name, wanted) {
    const node = byName(name).find((el) => el.tagName === "SELECT");
    if (!node) return { ok: false, error: "select not found" };
    const want = nrm(wanted);
    const opts = [...node.options].filter((o) => o.value !== "");
    const hit = opts.find((o) => nrm(o.textContent) === want || nrm(o.value) === want)
      || opts.find((o) => nrm(o.textContent).startsWith(want))
      || opts.find((o) => want.startsWith(nrm(o.textContent)) && nrm(o.textContent).length >= 3)
      || opts.find((o) => nrm(o.textContent).includes(want) && want.length >= 4);
    if (!hit) return { ok: false, error: "option not found", want: wanted, seen: opts.map((o) => o.textContent.trim()) };
    node.focus();
    setValue(node, hit.value);
    await sleep(150);
    return { ok: node.value === hit.value, picked: hit.textContent.trim() };
  }

  function bestOption(inputs, wanted) {
    const want = nrm(wanted);
    const labeled = inputs.map((i) => ({ i, l: nrm(optionLabel(i)), v: nrm(i.value) }));
    return labeled.find((x) => x.l === want || x.v === want)
      || labeled.find((x) => x.l.startsWith(want))
      || labeled.find((x) => want.startsWith(x.l) && x.l.length >= 3)
      || labeled.find((x) => x.l.includes(want) && want.length >= 4)
      || null;
  }
  async function clickOption(input) {
    (input.closest("label") || input).click();
    await sleep(150);
    if (!input.checked) {
      input.checked = true;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(100);
    }
    return input.checked;
  }
  async function radio(name, wanted) {
    const inputs = byName(name).filter((el) => el.type === "radio");
    if (!inputs.length) return { ok: false, error: "radio field not found" };
    const hit = bestOption(inputs, wanted);
    if (!hit) return { ok: false, error: "option not found", want: wanted, seen: inputs.map(optionLabel) };
    const ok = hit.i.checked || await clickOption(hit.i);
    return { ok, picked: optionLabel(hit.i) };
  }
  async function checkboxes(name, labels) {
    const inputs = byName(name).filter((el) => el.type === "checkbox");
    if (!inputs.length) return { ok: false, error: "checkbox field not found" };
    const picked = [];
    for (const l of labels || []) {
      const hit = bestOption(inputs, l);
      if (!hit) continue;
      if (hit.i.checked || await clickOption(hit.i)) picked.push(optionLabel(hit.i));
    }
    return { ok: picked.length > 0, picked, seen: picked.length ? undefined : inputs.map(optionLabel) };
  }

  async function setFile(name, b64, fileName) {
    const node = byName(name).find((el) => el.type === "file") || document.getElementById("resume-upload-input");
    if (!node) return { ok: false, error: "file input not found" };
    const ext = (fileName || "file.pdf").split(".").pop().toLowerCase();
    const mime = ext === "pdf" ? "application/pdf" : ext === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/octet-stream";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], fileName || "file.pdf", { type: mime }));
    node.files = dt.files;
    node.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    node.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
    // Lever parses the resume ("Analyzing resume...") and may prefill name/email.
    await sleep(600);
    return { ok: !!(node.files && node.files.length), actual: node.files?.[0]?.name };
  }

  /** Lever's "Current location" box (js/retrieveLocations.js): `input` shows
   *  the list, each non-arrow `keydown` runs the debounced search
   *  (/searchLocations?text=), suggestions render as .dropdown-results >
   *  div.dropdown-location#location-N, `mousedown` on one sets the input and
   *  the hidden #selected-location, and a blur with nothing picked CLEARS the
   *  box. So: type with keydown events, wait for the list, mousedown the match.
   *  Suggestions read "New York, NY, USA"; `match` is "City, ST" or "City, State". */
  async function location(name, city, match) {
    const box = byName(name || "location").find((el) => el.tagName === "INPUT" && el.type !== "hidden") || document.getElementById("location-input");
    if (!box) return { ok: false, error: "location input not found" };
    const want = nrm(match || city);
    const wantCity = nrm(city);
    const statePart = match && match.includes(",") ? nrm(match.split(",").pop()) : "";
    box.focus();
    box.click();
    await sleep(100);
    setValue(box, "");
    let typed = "";
    for (const ch of String(city)) {
      typed += ch;
      box.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
      box.value = typed;
      box.dispatchEvent(new Event("input", { bubbles: true }));
      box.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      await sleep(60);
    }
    const options = () => [...document.querySelectorAll(".dropdown-results .dropdown-location, .dropdown-results > div")].filter((o) => o.textContent.trim());
    let opts = [];
    for (let i = 0; i < 50 && !opts.length; i++) { await sleep(100); opts = options(); }
    if (!opts.length) {
      // Retry the search once (the debounce may have missed the last key).
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true }));
      for (let i = 0; i < 30 && !opts.length; i++) { await sleep(100); opts = options(); }
    }
    if (!opts.length) return { ok: false, error: "no location suggestions appeared", typed, actual: box.value };
    const texts = opts.map((o) => nrm(o.textContent));
    // "new york, ny, usa": the exact "City, ST" first, then city + state anywhere, then the city, US first.
    let idx = texts.findIndex((t) => t.startsWith(want + ","));
    if (idx < 0 && statePart) idx = texts.findIndex((t) => t.startsWith(wantCity + ",") && t.includes(statePart) && t.includes("usa"));
    if (idx < 0) idx = texts.findIndex((t) => t.startsWith(wantCity + ",") && t.includes("usa"));
    if (idx < 0) idx = texts.findIndex((t) => t.startsWith(wantCity));
    if (idx < 0) idx = texts.findIndex((t) => t.includes(wantCity));
    if (idx < 0) idx = 0;
    const opt = opts[idx];
    opt.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await sleep(150);
    opt.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    opt.click();
    await sleep(250);
    const hidden = document.getElementById("selected-location");
    if (!hidden?.value) {
      // Keyboard fallback: highlight the option and press Enter.
      box.focus();
      for (let i = 0; i <= idx; i++) box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await sleep(250);
    }
    return { ok: !!box.value.trim() && !!hidden?.value, picked: opt.textContent.trim(), actual: box.value, structured: !!hidden?.value, seen: texts.slice(0, 5) };
  }

  /** What the board itself is complaining about, per field: Lever's own error
   *  texts after a submit attempt, plus required controls the browser reports
   *  as invalid (empty) — the message a person sees when they tab past. */
  function errors() {
    const out = [];
    const seen = new Set();
    const push = (name, label, text) => { const k = name + "|" + text; if (seen.has(k) || !text) return; seen.add(k); out.push({ path: name, label, text: text.slice(0, 160) }); };
    for (const el of document.querySelectorAll(".error-message, .message-banner.error, .upload-error, .error-section, [class*='error']")) {
      if (el.offsetParent === null) continue;
      const text = el.textContent.replace(/\s+/g, " ").trim();
      if (!text || text.length > 200) continue;
      const q = el.closest(".application-question");
      const ctl = q?.querySelector("[name]");
      push(ctl?.name || null, q ? labelText(q) : "", text);
    }
    const f = form();
    if (f && f.classList.contains("jw-touched")) {
      for (const el of f.querySelectorAll("input:invalid, select:invalid, textarea:invalid")) {
        if (el.type === "hidden" || !el.name) continue;
        const q = questionOf(el);
        push(el.name, labelText(q), el.validationMessage || "this field is required");
      }
    }
    return out;
  }
  /** Mark the form so errors() reports browser validity too (after our fill). */
  function touched() { form()?.classList.add("jw-touched"); return { ok: true }; }

  function submitted() {
    return !document.getElementById("application-form")
      || /thanks|thank-you|confirmation|submitted/i.test(location.href)
      || /application (has been )?submitted|thank you for applying|thanks for applying/i.test((document.body?.innerText || "").slice(0, 4000));
  }

  window.__jwLever = { scan, scrollTo, fillText, select, radio, checkboxes, setFile, location, errors, touched, submitted };
})();
