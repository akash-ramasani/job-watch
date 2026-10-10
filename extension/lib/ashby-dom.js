// lib/ashby-dom.js — MAIN-world helpers for Ashby application forms.
//
// Injected by the background service worker (chrome.scripting.executeScript,
// world: MAIN) so React sees every change as user input. Everything keys off
// Ashby's STABLE class names (ashby-application-form-input-yesno, -radio-group,
// -checkbox-group, -autocomplete, -date, -text, -textarea, -file) and the
// data-field-path wrapper, never the hashed CSS-module classes
// (_required_f7cvd_91 ...) that change on every Ashby deploy.
//
// Verified against live forms on 2026-10-09:
//   yes/no   .ashby-application-form-input-yesno button[data-option=yes|no]  (aria-pressed)
//   radio    fieldset.ashby-application-form-input-radio-group  label[for] per option
//   checkbox fieldset.ashby-application-form-input-checkbox-group input[type=checkbox] + label[for]
//   location input[role=combobox].ashby-application-form-input-autocomplete -> [role=listbox] [role=option]
//   date     .react-datepicker-wrapper input.ashby-application-form-input-date (typed MM/dd/yyyy sticks)
//   file     input[type=file] (visually hidden) inside .ashby-application-form-input-file

(function () {
  if (window.__jwAshby) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nrm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const wrapperOf = (path) => document.querySelector(`[data-field-path="${CSS.escape(path)}"]`);

  function setNativeValue(node, value) {
    const proto = node.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const old = node.value;
    if (setter) setter.call(node, value); else node.value = value;
    if (node._valueTracker) node._valueTracker.setValue(old);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function controlOf(wrap) {
    if (!wrap) return null;
    return wrap.querySelector("input:not([type=file]):not([type=radio]):not([type=checkbox]), textarea");
  }

  // ── Scan ─────────────────────────────────────────────────────────────────
  function fieldInfo(wrap, survey) {
    const path = wrap.dataset.fieldPath || "";
    const labelEl = wrap.querySelector(".ashby-application-form-question-title");
    const label = labelEl ? labelEl.textContent.replace(/\s*\*\s*$/, "").trim() : "";
    const descEl = wrap.querySelector(".ashby-application-form-question-description");
    const description = descEl ? descEl.textContent.replace(/\s+/g, " ").trim() : "";
    const required = !!(labelEl && /(^|\s)_required_/.test(labelEl.className)) || !!wrap.querySelector("[required]");

    let type = "text", options = [];
    const yesno = wrap.querySelector(".ashby-application-form-input-yesno");
    const radios = wrap.querySelectorAll("input[type=radio]");
    const checks = wrap.querySelectorAll("input[type=checkbox]:not(.ashby-application-form-input-yesno input)");
    const combo = wrap.querySelector("input[role=combobox], .ashby-application-form-input-autocomplete");
    const dateIn = wrap.querySelector(".ashby-application-form-input-date, .react-datepicker-wrapper input");
    const file = wrap.querySelector("input[type=file]");
    const ta = wrap.querySelector("textarea");
    const input = controlOf(wrap);
    let filled = false;

    if (yesno) {
      type = "yesno";
      filled = !!yesno.querySelector("button[aria-pressed=true]");
    } else if (radios.length) {
      type = "radio";
      options = [...radios].map((r) => ({ label: labelFor(r, wrap) }));
      filled = !!wrap.querySelector("input[type=radio]:checked");
    } else if (checks.length) {
      type = "checkbox";
      options = [...checks].map((c) => ({ label: labelFor(c, wrap) }));
      filled = !!wrap.querySelector("input[type=checkbox]:checked");
    } else if (combo) {
      type = "location";
      filled = !!combo.value?.trim();
    } else if (dateIn) {
      type = "date";
      filled = !!dateIn.value?.trim();
    } else if (file) {
      type = "file";
      filled = !!(file.files && file.files.length);
    } else if (ta) {
      type = "textarea";
      filled = !!ta.value?.trim();
    } else if (input) {
      type = input.type === "email" ? "email" : input.type === "tel" ? "tel" : input.type === "url" ? "url" : input.type === "number" ? "number" : "text";
      filled = !!input.value?.trim();
    }
    return { id: path, label, description, required, type, options, filled, survey };
  }

  function labelFor(input, scope) {
    if (input.id) {
      const l = (scope || document).querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (l) return l.textContent.trim();
    }
    const parent = input.closest("label");
    if (parent) return parent.textContent.trim();
    return input.name || input.value || "";
  }

  function scan() {
    const out = [];
    const main = document.querySelector(".ashby-application-form-container");
    const survey = document.querySelector(".ashby-survey-form-container");
    for (const w of document.querySelectorAll("[data-field-path]")) {
      if (!w.dataset.fieldPath) continue;
      // Nested wrappers (the survey re-uses the form container class) count once.
      if (w.parentElement?.closest("[data-field-path]")) continue;
      const inSurvey = !!(survey && survey.contains(w));
      if (!inSurvey && main && !main.contains(w)) continue;
      out.push(fieldInfo(w, inSurvey));
    }
    return out;
  }

  // ── Fillers ──────────────────────────────────────────────────────────────
  async function fillText(path, value) {
    const node = controlOf(wrapperOf(path));
    if (!node) return { ok: false, error: "input not found" };
    for (let attempt = 1; attempt <= 3; attempt++) {
      node.focus();
      setNativeValue(node, value);
      node.dispatchEvent(new Event("blur", { bubbles: true }));
      await sleep(120);
      if (node.value === value) return { ok: true, attempt };
    }
    return { ok: false, error: "React reset the value", actual: node.value };
  }

  async function setFile(path, b64, name) {
    const wrap = wrapperOf(path);
    const node = wrap && wrap.querySelector("input[type=file]");
    if (!node) return { ok: false, error: "file input not found" };
    const ext = (name || "file.pdf").split(".").pop().toLowerCase();
    const mime = ext === "pdf" ? "application/pdf" : ext === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/octet-stream";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name || "file.pdf", { type: mime }));
    node.files = dt.files;
    node.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    node.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
    await sleep(300);
    return { ok: !!(node.files && node.files.length), actual: node.files?.[0]?.name };
  }

  async function yesNo(path, answer) {
    const wrap = wrapperOf(path);
    const box = wrap && (wrap.querySelector(".ashby-application-form-input-yesno") || wrap);
    if (!box) return { ok: false, error: "yes/no field not found" };
    const want = /^y/i.test(String(answer)) ? "yes" : "no";
    const btn = box.querySelector(`button[data-option="${want}"]`)
      || [...box.querySelectorAll("button")].find((b) => nrm(b.textContent) === want);
    if (!btn) return { ok: false, error: `no "${want}" button`, seen: [...box.querySelectorAll("button")].map((b) => b.textContent.trim()) };
    if (btn.getAttribute("aria-pressed") !== "true") {
      btn.click();
      await sleep(200);
    }
    return { ok: btn.getAttribute("aria-pressed") === "true", picked: want };
  }

  function bestOption(inputs, scope, wanted) {
    const want = nrm(wanted);
    const labeled = [...inputs].map((i) => ({ i, l: nrm(labelFor(i, scope)) }));
    return labeled.find((x) => x.l === want)
      || labeled.find((x) => x.l.startsWith(want))
      || labeled.find((x) => want.startsWith(x.l) && x.l.length >= 3)
      || labeled.find((x) => x.l.includes(want) && want.length >= 4)
      || null;
  }

  async function clickOption(input, scope) {
    const label = input.id ? scope.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null;
    (label || input).click();
    await sleep(150);
    if (!input.checked) {
      input.click();
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(150);
    }
    return input.checked;
  }

  async function radio(path, wanted) {
    const wrap = wrapperOf(path);
    if (!wrap) return { ok: false, error: "radio field not found" };
    const hit = bestOption(wrap.querySelectorAll("input[type=radio]"), wrap, wanted);
    if (!hit) return { ok: false, error: "option not found", want: wanted, seen: [...wrap.querySelectorAll("input[type=radio]")].map((r) => labelFor(r, wrap)) };
    const ok = hit.i.checked || await clickOption(hit.i, wrap);
    return { ok, picked: labelFor(hit.i, wrap) };
  }

  async function checkboxes(path, labels) {
    const wrap = wrapperOf(path);
    if (!wrap) return { ok: false, error: "checkbox field not found" };
    const all = wrap.querySelectorAll("input[type=checkbox]");
    const picked = [];
    for (const l of labels || []) {
      const hit = bestOption(all, wrap, l);
      if (!hit) continue;
      if (hit.i.checked || await clickOption(hit.i, wrap)) picked.push(labelFor(hit.i, wrap));
    }
    return { ok: picked.length > 0, picked, seen: picked.length ? undefined : [...all].map((c) => labelFor(c, wrap)) };
  }

  async function date(path, iso) {
    const wrap = wrapperOf(path);
    const node = wrap && (wrap.querySelector(".ashby-application-form-input-date, .react-datepicker-wrapper input") || controlOf(wrap));
    if (!node) return { ok: false, error: "date input not found" };
    const [y, m, d] = String(iso).split("-");
    const text = m && d && y ? `${m}/${d}/${y}` : String(iso);
    node.focus();
    node.click();
    await sleep(150);
    setNativeValue(node, text);
    node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    await sleep(150);
    node.dispatchEvent(new Event("blur", { bubbles: true }));
    document.body.click();
    await sleep(200);
    return { ok: node.value.trim() !== "", actual: node.value };
  }

  async function location(path, city, match) {
    const wrap = wrapperOf(path);
    const box = wrap && (wrap.querySelector("input[role=combobox]") || wrap.querySelector(".ashby-application-form-input-autocomplete") || controlOf(wrap));
    if (!box) return { ok: false, error: "location input not found" };
    const want = nrm(match || city);
    const wantCity = nrm(city);
    box.focus();
    box.click();
    await sleep(120);
    // Type like a person: the suggestion list only queries on input events.
    setNativeValue(box, "");
    let typed = "";
    for (const ch of String(city)) {
      typed += ch;
      setNativeValue(box, typed);
      await sleep(45);
    }
    const options = () => [...document.querySelectorAll("[role=listbox] [role=option], .ashby-application-form-input-autocomplete-popup-result")].filter((o) => o.offsetParent !== null);
    let opts = [];
    for (let i = 0; i < 40 && !opts.length; i++) { await sleep(100); opts = options(); }
    if (!opts.length) {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await sleep(400);
      opts = options();
    }
    if (!opts.length) return { ok: false, error: "no suggestions appeared", typed };
    const texts = opts.map((o) => nrm(o.textContent));
    // "San Francisco, California" first, then city + state anywhere, then city.
    let idx = texts.findIndex((t) => t.startsWith(want));
    if (idx < 0) idx = texts.findIndex((t) => t.startsWith(wantCity) && (!match || t.includes(nrm(match).split(",").pop().trim())));
    if (idx < 0) idx = texts.findIndex((t) => t.startsWith(wantCity));
    if (idx < 0) idx = texts.findIndex((t) => t.includes(wantCity));
    if (idx < 0) idx = 0;
    const opt = opts[idx];
    opt.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    opt.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    opt.click();
    await sleep(300);
    if (!box.value?.trim()) {
      // Keyboard fallback: highlight the option and confirm.
      box.focus();
      for (let i = 0; i <= idx; i++) box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await sleep(300);
    }
    return { ok: !!box.value?.trim(), picked: opt.textContent.trim(), actual: box.value, seen: texts.slice(0, 5) };
  }

  /** Visible validation messages after a submit attempt (best effort). */
  function errors() {
    const out = [];
    for (const el of document.querySelectorAll("[role=alert], [aria-invalid=true], [class*='_error'], [class*='Error']")) {
      if (el.offsetParent === null) continue;
      const wrap = el.closest("[data-field-path]");
      const text = (el.getAttribute("aria-invalid") === "true" ? "invalid" : el.textContent.replace(/\s+/g, " ").trim()).slice(0, 160);
      if (!text) continue;
      out.push({ path: wrap?.dataset.fieldPath || null, text });
    }
    return out;
  }

  function submitted() {
    return !document.querySelector(".ashby-application-form-container")
      || /success|submitted|thank/i.test(location.href)
      || !!document.querySelector(".ashby-application-success, [class*='successContainer'], [class*='_success_']");
  }

  window.__jwAshby = { scan, fillText, setFile, yesNo, radio, checkboxes, date, location, errors, submitted };
})();
