// lib/generic-dom.js — MAIN-world helpers for any application form.
//
// Injected by the background service worker (chrome.scripting.executeScript,
// world: MAIN) through EXEC_GENERIC, for every board that has no dedicated
// helper: Workday, iCIMS, SmartRecruiters, Workable, BambooHR, Taleo,
// SuccessFactors, Oracle Recruiting Cloud, Jobvite, and plain forms on a
// company's own careers site. MAIN world so React/Angular controlled inputs
// see the value through their own setters and trackers.
//
// scan() reads every visible question as
//   { id, label, description, type, required, options, filled, section }
// type: text | email | tel | url | number | textarea | select | radio |
//       checkbox (a group) | yesno (one checkbox) | typeahead | date | file
// `id` is derived from the label (slug#n), so the same question keeps its id
// across re-renders and steps. Custom widgets understood:
//   listbox buttons   button[aria-haspopup=listbox] -> [role=listbox] [role=option]
//                     (Workday "Select One" dropdowns; options read by opening it)
//   prompt pickers    Workday selectinput / multiselect search boxes,
//                     input[role=combobox], input[aria-autocomplete=list]
//   date widgets      Workday dateSectionMonth/Day/Year inputs, input[type=date]
//   file drop zones   input[type=file] (hidden ones too), Workday drop zone
//
// apply(id, fill, extra) puts one answer in; errors() lists what the page
// itself flags; workday*() drive Workday's My Experience page.

(function () {
  if (window.__jwGeneric) return;

  const sleep = (ms) => (window.__jwMainWait ? window.__jwMainWait(ms) : new Promise((r) => setTimeout(r, ms)));
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const nrm = (s) => clean(s).toLowerCase().replace(/[*✱]/g, "").replace(/\s+/g, " ").trim();
  const PLACEHOLDER = /^[-–—\s]*(select( one| an option| an answer|\.\.\.|…)?|choose( one| an option)?|please (select|choose)( one)?|none selected|search)?[-–—\s]*$/i;
  const reg = new Map(); // id -> record { id, type, el, inputs, box, label }

  // ── Visibility and scope ─────────────────────────────────────────────────
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    // Parked far off the page: a honeypot for bots, never a real question.
    if (r.right < -100 || r.bottom + scrollY < -100 || r.left > document.documentElement.scrollWidth + 1000) return false;
    return r.width > 0 && r.height > 0;
  }
  /** Bot traps: "Please leave this field blank", aria-hidden boxes, password-manager-ignored decoys. */
  function honeypot(el) {
    if (el.type !== "file" && el.closest("[aria-hidden=true]")) return true;
    const hint = `${el.name || ""} ${el.id || ""} ${el.getAttribute("autocomplete") || ""} ${el.getAttribute("data-automation-id") || ""}`;
    if (/honeypot|_hp[a-z]*\b|hp_?field|nickname_hp|beecatcher/i.test(hint)) return true;
    // The warning may sit in a label tied by id, or just beside the box (Workday's, 2026-11-10).
    const l = `${el.id ? textOf(forLabel(el)) : ""} ${textOf(el.closest("label")) || ""} ${el.parentElement ? textOf(el.parentElement).slice(0, 200) : ""}`;
    return /leave (this|it)? ?(field )?(blank|empty)|do not (fill|complete|enter)|if you('| a)re (a )?human|for robots only/i.test(l);
  }
  function outOfScope(el) {
    return !!el.closest("header, nav, footer, [role=banner], [role=navigation], [role=search], [data-automation-id=header], [id^=jw-], [class*=cookie], [id*=cookie], [aria-modal=true][class*=cookie]");
  }
  function root() {
    return document.querySelector("[data-automation-id=applyFlowPage]")
      || document.querySelector("form#application-form, form[name*=apply i], form[id*=apply i], form[class*=apply i]")
      || document.querySelector("main")
      || document.body;
  }

  /** querySelectorAll that also walks open shadow roots, in document order
   *  (SmartRecruiters and other web-component forms). */
  function deepAll(root, sel) {
    const out = [];
    const visit = (node) => {
      for (const c of node.children) {
        if (c.matches(sel)) out.push(c);
        if (c.shadowRoot) visit(c.shadowRoot);
        visit(c);
      }
    };
    visit(root);
    return out;
  }
  /** <label for=id>, looked up in the control's own (shadow) root first. */
  function forLabel(el) {
    if (!el?.id) return null;
    const q = `label[for="${CSS.escape(el.id)}"]`;
    const rootNode = el.getRootNode?.();
    return (rootNode && rootNode !== document && rootNode.querySelector?.(q)) || document.querySelector(q);
  }

  // ── Labels ───────────────────────────────────────────────────────────────
  const textOf = (el) => clean((el?.innerText ?? el?.textContent) || "");
  function stripLabel(s) {
    return clean(String(s || "").replace(/[*✱]/g, " ").replace(/\((required|optional)\)/gi, " ").replace(/\brequired\b\s*$/i, " ").replace(/:\s*$/, ""));
  }
  function byIds(ids) {
    return clean(String(ids || "").split(/\s+/).map((id) => textOf(document.getElementById(id))).filter(Boolean).join(" "));
  }
  // Labels that name the widget, not the question ("file-input", "–Select–").
  const GENERIC_LABEL = /^(file[- ]?input|file|files|upload( a)?( file)?|select files?|choose files?( no files? (selected|chosen))?|no files? (selected|chosen)|browse|attach(ment)?|drop files? here.*|enter your text here|type here|search|[-–—]*\s*select( one)?\s*[-–—]*|choose( one)?)$/i;
  const labelOf = (l) => (l ? textOf(l) : "");
  /** The question a control belongs to, as a person reads it. */
  function labelFor(el) {
    const tries = [
      () => byIds(el.getAttribute("aria-labelledby")),
      () => el.id && labelOf(forLabel(el)),
      // A custom dropdown button over a hidden <select>: the select's own label.
      () => { const sel = el.tagName === "BUTTON" && el.parentElement?.closest("div")?.parentElement?.querySelector("select[id]"); return sel ? labelOf(forLabel(sel)) : ""; },
      () => { const wd = el.closest("[data-automation-id^=formField-]"); return labelOf(wd?.querySelector("label, legend, [data-automation-id=richText], [data-automation-id=promptLabel]")); },
      () => { const wrap = el.closest("label"); return wrap ? clean(textOf(wrap).replace(textOf(el), "")) : ""; },
      () => labelOf(el.closest("fieldset")?.querySelector("legend")),
      () => { const g = el.closest("[role=group], [role=radiogroup]"); return g ? (byIds(g.getAttribute("aria-labelledby")) || g.getAttribute("aria-label") || "") : ""; },
      // The label a person sees next to the control, a few levels up.
      () => {
        let node = el;
        for (let depth = 0; depth < 5 && node && node !== document.body; depth++) {
          let sib = node.previousElementSibling;
          for (let hops = 0; sib && hops < 3; hops++, sib = sib.previousElementSibling) {
            if (sib.matches("input, select, textarea, button, script, style")) break;
            const t = textOf(sib);
            if (t && t.length <= 300 && !sib.querySelector("input, select, textarea") && !GENERIC_LABEL.test(stripLabel(t))) return t;
          }
          node = node.parentElement;
        }
        return "";
      },
      () => (el.tagName === "BUTTON" ? "" : el.getAttribute("aria-label")),
      () => el.getAttribute("placeholder"),
      () => el.getAttribute("title"),
      () => el.name,
    ];
    let fallback = "";
    for (const t of tries) {
      const v = clean(t() || "");
      if (!v || PLACEHOLDER.test(v)) continue;
      if (GENERIC_LABEL.test(stripLabel(v))) { fallback = fallback || v; continue; }
      return v;
    }
    return el.tagName === "BUTTON" ? clean(String(el.getAttribute("aria-label") || "").replace(/\s*[-–—]*\s*select( one)?\s*[-–—]*\s*$/i, "")) || fallback : fallback;
  }
  function descriptionFor(el) {
    const d = el.getAttribute("aria-describedby");
    const t = d ? byIds(d) : "";
    return t.length > 400 ? t.slice(0, 400) : t;
  }
  /** The nearest heading above the control ("Work Experience 2", "Education 1"). */
  function sectionFor(el) {
    const heads = [...document.querySelectorAll("h1, h2, h3, h4, h5, [role=heading]")].filter(visible);
    let best = "";
    for (const h of heads) {
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = textOf(h);
      else break;
    }
    return stripLabel(best).slice(0, 120);
  }
  function requiredOf(el, label, box) {
    if (el.required || el.getAttribute("aria-required") === "true") return true;
    if (box?.querySelector("[required], [aria-required=true]")) return true;
    const raw = el.id ? textOf(forLabel(el)) : "";
    if (/[*✱]/.test(raw)) return true;
    const wd = el.closest("[data-automation-id^=formField-]");
    if (wd && /[*✱]/.test(textOf(wd.querySelector("label, legend")))) return true;
    const fs = el.closest("fieldset");
    if (fs && /[*✱]/.test(textOf(fs.querySelector("legend")))) return true;
    return /\*\s*$|^\*/.test(String(label || ""));
  }

  // ── Options ──────────────────────────────────────────────────────────────
  // Workday shows what is already chosen as a listbox of its own ("selectedItemList",
  // the "+1" pill of Country Phone Code): never an open list (State Street, 2026-11-10).
  const PICKED = "[data-automation-id=selectedItemList], [data-automation-id=selectedItem]";
  function openOptions() {
    const lists = [...document.querySelectorAll("[role=listbox]")].filter((l) => visible(l) && !l.matches(PICKED));
    const opts = [];
    for (const l of lists) for (const o of l.querySelectorAll("[role=option]")) if (visible(o) && !o.closest(PICKED)) opts.push(o);
    if (!opts.length) for (const o of document.querySelectorAll("[data-automation-id=promptOption], [data-automation-id=menuItem], [role=menu] [role=menuitem], [role=menu] [role=menuitemradio], [role=menu] [role=option]")) if (visible(o) && !o.closest(PICKED)) opts.push(o);
    return opts;
  }
  // Workday's tree items say "Online Source not checked" in aria-label; the name is on the inner promptOption.
  const optText = (o) => clean(o.getAttribute("data-automation-label") || o.querySelector?.("[data-automation-id=promptOption]")?.getAttribute("data-automation-label")
    || o.getAttribute("aria-label") || textOf(o)).replace(/\s+(not )?checked$/i, "");
  async function waitOptions(ms = 1800, prev = null) {
    const t0 = Date.now();
    for (;;) {
      const o = openOptions();
      if (o.length && (!prev || o.map(optText).join("|") !== prev)) return o;
      if (Date.now() - t0 > ms) return o;
      await sleep(100);
    }
  }
  function press(el, key) {
    const code = key === "Enter" ? 13 : key === "Escape" ? 27 : key === "ArrowDown" ? 40 : key === "Tab" ? 9 : key === " " ? 32 : 0;
    for (const type of ["keydown", "keypress", "keyup"]) el.dispatchEvent(new KeyboardEvent(type, { key, code: key === " " ? "Space" : key, keyCode: code, which: code, bubbles: true, cancelable: true }));
  }
  /** Open a dropdown: a click, else the keys a keyboard user would press
   *  (BambooHR's menus ignore synthetic clicks but open on Space). */
  async function openPopup(btn) {
    btn.scrollIntoView({ block: "center" });
    realClick(btn);
    let opts = await waitOptions(800);
    for (const key of [" ", "Enter", "ArrowDown"]) {
      if (opts.length) break;
      btn.focus();
      press(btn, key);
      opts = await waitOptions(700);
    }
    return opts;
  }
  /** Choose an open option: click it, else focus it and press Enter. */
  async function chooseOption(hit, done) {
    hit.scrollIntoView({ block: "nearest" });
    realClick(optTarget(hit));
    await sleep(350);
    if (done()) return;
    hit.focus?.();
    press(hit, "Enter");
    await sleep(300);
  }
  /** Where to click an option: Workday's tree items only react on the inner
   *  name (promptLeafNode / promptOption), not on the role=option wrapper
   *  (Field of Study never took "Computer Science", 2026-11-10). */
  function optTarget(o) {
    return o.querySelector?.("[data-automation-id=promptLeafNode], [data-automation-id=promptOption]") || o;
  }
  function realClick(el) {
    const r = el.getBoundingClientRect();
    const opt = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    el.dispatchEvent(new PointerEvent("pointerover", opt));
    el.dispatchEvent(new PointerEvent("pointerdown", opt));
    el.dispatchEvent(new MouseEvent("mousedown", opt));
    el.dispatchEvent(new PointerEvent("pointerup", opt));
    el.dispatchEvent(new MouseEvent("mouseup", opt));
    el.dispatchEvent(new MouseEvent("click", opt));
  }
  async function closeList(trigger) {
    press(trigger || document.activeElement || document.body, "Escape");
    await sleep(120);
    if (openOptions().length) { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); document.body.click(); await sleep(120); }
  }
  /** Read a listbox button's options by opening it, then close it again. */
  async function readListbox(btn) {
    const opts = await openPopup(btn);
    const out = opts.map(optText).filter((t) => t && !PLACEHOLDER.test(t));
    await closeList(btn);
    return [...new Set(out)].slice(0, 300);
  }

  // ── Scan ─────────────────────────────────────────────────────────────────
  function wdDateBox(el) { return el.closest("[data-automation-id=dateInputWrapper], [data-automation-id^=formField-][data-automation-id*=ate]") || null; }
  function isTypeahead(el) {
    return el.getAttribute("data-uxi-widget-type") === "selectinput"
      || el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete") === "list" || el.getAttribute("aria-autocomplete") === "both"
      || !!el.closest("[data-automation-id=multiSelectContainer], [data-automation-id=multiselectInputContainer]");
  }
  function typeaheadFilled(el) {
    const box = el.closest("[data-automation-id^=formField-]") || el.parentElement?.parentElement;
    if (box?.querySelector("[data-automation-id=selectedItem], [data-automation-id=selectedItemList] li, [class*=multi-value], [class*=singleValue], [class*=single-value]")) return true;
    return !!clean(el.value);
  }
  /** A popup button that is really a dropdown: it sits over a hidden <select>,
   *  or reads "Select..." / names its value next to a field label. */
  function selectLikeButton(btn) {
    const wrap = btn.parentElement?.closest("div")?.parentElement;
    if (wrap?.querySelector("select[aria-hidden=true], select[tabindex='-1']")) return true;
    if (/select/i.test(btn.closest("[data-fabric-component]")?.getAttribute("data-fabric-component") || "")) return true;
    return /^[-–—\s]*select\b/i.test(clean(textOf(btn))) && !!labelFor(btn);
  }
  function selectFilled(sel) {
    const o = sel.options[sel.selectedIndex];
    return !!o && !!sel.value && !PLACEHOLDER.test(clean(o.textContent));
  }
  function slug(label) { return nrm(label).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "field"; }

  async function scan(opts = {}) {
    const readOptions = opts.readOptions !== false;
    const scope = root();
    const seenEls = new Set();
    const seenIds = new Map();
    const out = [];
    reg.clear();
    const add = (rec, field) => {
      // The widget kind, not the reported type: a picker is "typeahead" whether
      // or not its options were read, so its id survives a rescan.
      const base = `${slug(field.label)}:${rec.type === "text" ? field.type : rec.type}`;
      const n = (seenIds.get(base) || 0) + 1;
      seenIds.set(base, n);
      const id = `${base}#${n}`;
      rec.id = id;
      rec.domId = (rec.inputs?.[0] || rec.el)?.id || ""; // Workday's ids survive a redraw
      reg.set(id, rec);
      (rec.inputs?.[0] || rec.el).setAttribute?.("data-jw-id", id);
      out.push({ id, ...field });
    };
    const findCandidates = () => deepAll(root(), "input, select, textarea, button[aria-haspopup=listbox], button[aria-haspopup=true], button[aria-haspopup=menu], [role=combobox]:not(input)")
      .filter((el) => el.tagName !== "BUTTON" || el.getAttribute("aria-haspopup") === "listbox" || selectLikeButton(el));
    // Workday redraws whole sections while lists are being read (the Phone
    // boxes vanished from the scan, 2026-11-10): a second pass picks up the new
    // elements whose questions were not read yet.
    let candidates = findCandidates();
    const labelsDone = new Set();
    for (let pass = 0; pass < 2; pass++) {
    if (pass === 1) candidates = findCandidates().filter((el) => !seenEls.has(el) && el.isConnected && !labelsDone.has(nrm(labelFor(el))));
    for (const el of candidates) {
      if (seenEls.has(el) || outOfScope(el)) continue;
      const tag = el.tagName;
      const t = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "INPUT" && ["hidden", "submit", "button", "image", "reset"].includes(t)) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true" || el.readOnly && tag === "INPUT" && !isTypeahead(el)) continue;
      if (/g-recaptcha|h-captcha|cf-turnstile/i.test(el.name || el.id || "") || honeypot(el)) continue;
      if (t !== "file" && !visible(el) && !(t === "radio" || t === "checkbox") ) continue;

      // File uploads (often hidden behind a button or drop zone).
      if (t === "file") {
        seenEls.add(el);
        // The field's own container first: closest() with a list takes the nearest
        // match, a bare <div> around the input, and Workday shows uploaded files
        // beside it, so they were never seen (five copies, 2026-11-10).
        const box = el.closest("[data-automation-id^=formField-]") || el.closest("[data-automation-id=attachmentsSection]") || el.closest(".form-group, .field, fieldset, li") || el.parentElement?.parentElement || el.parentElement;
        let label = labelFor(el);
        if (!label || /^(select files?|upload|browse|choose file|drop files? here.*)$/i.test(label)) label = textOf(box?.querySelector("label, legend, h3, h4")) || "Resume/CV";
        if (/^(attach|upload|drop|select)\b/i.test(label) && !/resume|cv|cover/i.test(label)) label = `Resume/CV (${label})`;
        const shown = box?.querySelector("[data-automation-id=file-upload-item], [data-automation-id=file-upload-successful], [data-automation-id=file-upload-item-name], [data-automation-id=fileName], [class*=file-name], [class*=filename]");
        add({ type: "file", el, box }, { label: stripLabel(label), description: "", type: "file", required: requiredOf(el, label, box), options: [], filled: !!(el.files && el.files.length) || !!(shown && textOf(shown)), section: sectionFor(box || el) });
        continue;
      }
      // Radio groups, by name or by their group container.
      if (t === "radio") {
        const grp = el.closest("fieldset, [role=radiogroup], [data-automation-id^=formField-]") || el.form || scope;
        const inputs = el.name ? [...grp.querySelectorAll(`input[type=radio][name="${CSS.escape(el.name)}"]`)] : [...grp.querySelectorAll("input[type=radio]")];
        inputs.forEach((i) => seenEls.add(i));
        if (!inputs.some((i) => visible(i) || visible(i.closest("label") || i.parentElement))) continue;
        const label = groupLabel(grp, el);
        add({ type: "radio", el, inputs, box: grp }, { label: stripLabel(label), description: "", type: "radio", required: requiredOf(el, label, grp) || inputs.some((i) => i.required), options: inputs.map((i) => ({ label: optionLabel(i), value: optionLabel(i) })), filled: inputs.some((i) => i.checked), section: sectionFor(el) });
        continue;
      }
      // Checkboxes: a group of several is one multi-pick question; a lone one is yes/no.
      if (t === "checkbox") {
        const grp = el.closest("fieldset, [role=group], [data-automation-id^=formField-]");
        const inputs = grp ? [...grp.querySelectorAll("input[type=checkbox]")] : [el];
        inputs.forEach((i) => seenEls.add(i));
        if (!inputs.some((i) => visible(i) || visible(i.closest("label") || i.parentElement))) continue;
        if (inputs.length > 1) {
          const label = groupLabel(grp, el);
          add({ type: "checkbox", el, inputs, box: grp }, { label: stripLabel(label), description: "", type: "checkbox", required: requiredOf(el, label, grp), options: inputs.map((i) => ({ label: optionLabel(i), value: optionLabel(i) })), filled: inputs.some((i) => i.checked), section: sectionFor(el) });
        } else {
          const own = optionLabel(el);
          const q = grp ? groupLabel(grp, el) : "";
          const label = own && own.length > 3 ? own : q || own;
          const required = requiredOf(el, label, grp);
          add({ type: "yesno", el, inputs: [el], box: grp || el.parentElement }, { label: stripLabel(label), description: q && q !== label ? stripLabel(q) : "", type: "yesno", required, options: [], filled: el.checked || !required, section: sectionFor(el) });
        }
        continue;
      }
      // Workday date widget: one question over its month/day/year sections.
      if (tag === "INPUT" && /dateSection(Month|Day|Year)/.test(el.getAttribute("data-automation-id") || "")) {
        const box = wdDateBox(el) || el.parentElement;
        const parts = [...box.querySelectorAll("input[data-automation-id^=dateSection]")];
        parts.forEach((i) => seenEls.add(i));
        const label = labelFor(box.querySelector("input") || el) || labelFor(box);
        add({ type: "date", el, inputs: parts, box }, { label: stripLabel(label), description: "", type: "date", required: requiredOf(el, label, box), options: [], filled: parts.every((p) => clean(p.value) && !/^(mm|dd|yyyy)$/i.test(p.value)), section: sectionFor(el), parts: parts.map((p) => (p.getAttribute("data-automation-id") || "").replace(/^dateSection|-input$/g, "")) });
        continue;
      }
      seenEls.add(el);
      if (tag === "SELECT") {
        const label = labelFor(el);
        add({ type: "select", el }, { label: stripLabel(label), description: descriptionFor(el), type: "select", required: requiredOf(el, label), options: [...el.options].filter((o) => o.value !== "" && !PLACEHOLDER.test(clean(o.textContent))).map((o) => ({ label: clean(o.textContent), value: clean(o.textContent) })), filled: selectFilled(el), section: sectionFor(el) });
        continue;
      }
      if (tag === "BUTTON" || (tag !== "INPUT" && tag !== "TEXTAREA")) {
        // Listbox button (Workday "Select One") or a div combobox.
        const label = labelFor(el);
        const shown = clean(textOf(el));
        const filled = !!shown && !PLACEHOLDER.test(shown) && !/^select/i.test(shown);
        let options = [];
        if (!filled && readOptions) options = (await readListbox(el)).map((x) => ({ label: x, value: x }));
        add({ type: "select", el, listbox: true }, { label: stripLabel(label), description: descriptionFor(el), type: "select", required: requiredOf(el, label), options, filled, section: sectionFor(el) });
        continue;
      }
      if (tag === "TEXTAREA") {
        const label = labelFor(el);
        add({ type: "textarea", el }, { label: stripLabel(label), description: descriptionFor(el), type: "textarea", required: requiredOf(el, label), options: [], filled: !!clean(el.value), section: sectionFor(el) });
        continue;
      }
      if (isTypeahead(el)) {
        const label = labelFor(el);
        const filled = typeaheadFilled(el);
        let options = [];
        if (!filled && readOptions) {
          el.scrollIntoView({ block: "center" });
          el.focus();
          realClick(el);
          const o = await waitOptions(1200);
          const texts = [...new Set(o.map(optText).filter((x) => x && !PLACEHOLDER.test(x)))];
          await closeList(el);
          // A short fixed list is a pick list; a long or empty one is search-as-you-type.
          if (texts.length >= 2 && texts.length <= 60) options = texts.map((x) => ({ label: x, value: x }));
        }
        add({ type: "typeahead", el }, { label: stripLabel(label), description: descriptionFor(el), type: options.length ? "select" : "typeahead", required: requiredOf(el, label), options, filled, section: sectionFor(el), widget: "typeahead" });
        continue;
      }
      if (t === "date") {
        const label = labelFor(el);
        add({ type: "date", el, native: true }, { label: stripLabel(label), description: "", type: "date", required: requiredOf(el, label), options: [], filled: !!el.value, section: sectionFor(el) });
        continue;
      }
      if (t === "password") {
        const label = labelFor(el);
        add({ type: "text", el }, { label: stripLabel(label) || "Password", description: "", type: "password", required: true, options: [], filled: !!el.value, section: sectionFor(el) });
        continue;
      }
      const label = labelFor(el);
      const type = t === "email" ? "email" : t === "tel" ? "tel" : t === "url" ? "url" : t === "number" ? "number" : "text";
      add({ type: "text", el }, { label: stripLabel(label), description: descriptionFor(el), type, required: requiredOf(el, label), options: [], filled: !!clean(el.value), section: sectionFor(el) });
    }
    for (const f of out) labelsDone.add(nrm(f.label));
    }
    return out.filter((f) => f.label);
  }
  function optionLabel(input) {
    if (input.id) { const l = forLabel(input); if (l && textOf(l)) return textOf(l); }
    const al = input.getAttribute("aria-labelledby");
    if (al) { const t = byIds(al); if (t) return t; }
    const wrap = input.closest("label");
    if (wrap && textOf(wrap)) return textOf(wrap);
    const next = input.nextElementSibling;
    if (next && textOf(next)) return textOf(next);
    return input.getAttribute("aria-label") || input.value || "";
  }
  function groupLabel(grp, el) {
    if (!grp) return labelFor(el);
    const lg = grp.querySelector(":scope > legend, legend, [data-automation-id=richText], label:not(:has(input))");
    if (lg && textOf(lg)) return textOf(lg);
    if (grp.getAttribute?.("aria-labelledby")) { const t = byIds(grp.getAttribute("aria-labelledby")); if (t) return t; }
    if (grp.getAttribute?.("aria-label")) return grp.getAttribute("aria-label");
    return labelFor(grp.querySelector("input") || el);
  }

  // ── Fillers ──────────────────────────────────────────────────────────────
  function setNative(node, value) {
    const proto = node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : node.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const old = node.value;
    if (setter) setter.call(node, value); else node.value = value;
    if (node._valueTracker) node._valueTracker.setValue(old);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  }
  /** Type like a person, faster for long answers (about a second and a half). */
  async function typeInto(node, value, { keys = false } = {}) {
    const text = String(value ?? "");
    node.focus();
    setNative(node, "");
    const perChar = Math.max(6, Math.min(35, Math.round(1400 / Math.max(1, text.length))));
    let typed = "";
    for (const ch of text) {
      typed += ch;
      if (keys) node.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
      setNative(node, typed);
      if (keys) node.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      await sleep(perChar);
    }
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function bestMatch(items, wanted, textFn) {
    const want = nrm(wanted);
    if (!want) return null;
    const xs = items.map((i) => ({ i, t: nrm(textFn(i)) }));
    return (xs.find((x) => x.t === want)
      || xs.find((x) => x.t.startsWith(want))
      || xs.find((x) => want.startsWith(x.t) && x.t.length >= 3)
      || xs.find((x) => x.t.includes(want) && want.length >= 3)
      || xs.find((x) => want.length >= 6 && want.includes(x.t) && x.t.length >= 4)
      || null)?.i || null;
  }
  function record(id) {
    let r = reg.get(id);
    if (r && (r.inputs?.[0] || r.el).isConnected) return r;
    // Redrawn (Workday re-renders a section when the one above it is checked):
    // the same element by its id, for single-element fields.
    const again = r?.domId && !r.inputs && document.getElementById(r.domId);
    if (again && visible(again)) { r.el = again; again.setAttribute("data-jw-id", id); return r; }
    return null;
  }

  async function fillText(r, value) {
    let node = r.el;
    node.scrollIntoView({ block: "center" });
    node.click();
    await sleep(80);
    await typeInto(node, value);
    await sleep(100);
    // Redrawn while typing (a Website URL kept only "htt"): type again into the live box.
    if (!node.isConnected && r.domId && document.getElementById(r.domId)) {
      node = r.el = document.getElementById(r.domId);
      node.setAttribute("data-jw-id", r.id);
      await sleep(300);
      await typeInto(node, value);
      await sleep(100);
    }
    node.dispatchEvent(new Event("blur", { bubbles: true }));
    node.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    if (node.value !== String(value ?? "")) { setNative(node, String(value ?? "")); node.dispatchEvent(new Event("change", { bubbles: true })); }
    await sleep(60);
    // Masked inputs reformat what was typed ("4155550100" -> "415-555-0100").
    const alnum = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return { ok: clean(node.value) === clean(value) || (!!alnum(value) && alnum(node.value) === alnum(value)), actual: node.value };
  }
  async function fillSelect(r, wanted) {
    if (!r.listbox) {
      const sel = r.el;
      const opts = [...sel.options].filter((o) => !PLACEHOLDER.test(clean(o.textContent)));
      const hit = bestMatch(opts, wanted, (o) => o.textContent) || opts.find((o) => nrm(o.value) === nrm(wanted));
      if (!hit) return { ok: false, error: "option not found", want: wanted, seen: opts.map((o) => clean(o.textContent)).slice(0, 12) };
      sel.focus();
      setNative(sel, hit.value);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(120);
      return { ok: sel.value === hit.value, picked: clean(hit.textContent) };
    }
    const btn = r.el;
    const shownNow = () => clean(textOf(btn));
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = shownNow();
      const opts = await openPopup(btn);
      const hit = bestMatch(opts, wanted, optText);
      if (!hit) { await closeList(btn); if (attempt) return { ok: false, error: "option not found", want: wanted, seen: opts.map(optText).slice(0, 12) }; continue; }
      await chooseOption(hit, () => shownNow() !== before || !openOptions().length);
      if (openOptions().length) await closeList(btn);
      const shown = clean(textOf(btn));
      if (shown && !PLACEHOLDER.test(shown)) return { ok: nrm(shown).includes(nrm(optText(hit)).slice(0, 20)) || !/^select/i.test(shown), picked: optText(hit) };
    }
    return { ok: false, error: "the dropdown did not keep the choice" };
  }
  /** Search-as-you-type picker: type, Enter, pick the best suggestion; for a
   *  category list (Workday "How did you hear"), open it and drill down. */
  async function fillTypeahead(r, value, match, alternates = []) {
    const el = r.el;
    const pick = async (opts, wants) => {
      for (const w of wants) {
        const hit = bestMatch(opts, w, optText);
        if (hit) { hit.scrollIntoView({ block: "nearest" }); realClick(optTarget(hit)); await sleep(500); return optText(hit); }
      }
      return null;
    };
    const finish = async (picked) => {
      // A category opens a sub-list: take the leaf that matches, else the first.
      await sleep(400);
      const sub = chosen() ? [] : openOptions();
      if (sub.length && picked) {
        let leaf = null;
        for (const w of [match, value, ...alternates].filter(Boolean)) if ((leaf = exact(sub, w) || null)) break;
        for (const w of [match, value, ...alternates].filter(Boolean)) if (!leaf && (leaf = bestMatch(sub, w, optText))) break;
        leaf = leaf || sub[0];
        realClick(optTarget(leaf));
        await sleep(450);
        picked = `${picked} > ${optText(leaf)}`;
      }
      await closeList(el);
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      await sleep(200);
      return { ok: typeaheadFilled(el), picked: chosen() || picked };
    };
    const chosen = () => clean(el.closest("[data-automation-id^=formField-]")?.querySelector("[data-automation-id=selectedItem] [data-automation-id=promptOption]")?.getAttribute("data-automation-label")
      || el.closest("[data-automation-id^=formField-]")?.querySelector("[data-automation-id=selectedItem]")?.textContent || "");
    // Clicking the box opens Workday's whole list; the search results replace it
    // after Enter. Wait for that change, not for any open list (Field of Study
    // read the A–Z list and missed "Computer Science", 2026-11-10).
    let shownBefore = "";
    const search = async (term) => {
      el.scrollIntoView({ block: "center" });
      el.focus();
      realClick(el);
      await sleep(150);
      await typeInto(el, term, { keys: true });
      await sleep(250);
      shownBefore = openOptions().map(optText).join("|");
      press(el, "Enter");
      await sleep(400);
    };
    const results = () => waitOptions(2500, shownBefore || null);
    await search(value);
    // Workday picks the one exact match on Enter and closes the list.
    if (chosen()) { await closeList(el); return { ok: true, picked: chosen() }; }
    let opts = await results();
    // Only an exact suggestion here: "Job Board" must not take "Online Source -
    // Asia Job Boards" (State Street, 2026-11-10).
    const exact = (os, w) => os.find((o) => nrm(optText(o)) === nrm(w));
    let hit = opts.length ? (exact(opts, match || value) || exact(opts, value)) : null;
    if (hit) { hit.scrollIntoView({ block: "nearest" }); realClick(optTarget(hit)); await sleep(500); return finish(optText(hit)); }
    // Other names to search ("LinkedIn", "Indeed"…), each picked the same way.
    for (const alt of alternates.slice(0, 6)) {
      if (nrm(alt) === nrm(value)) continue;
      setNative(el, "");
      await search(alt);
      if (chosen()) { await closeList(el); return { ok: true, picked: chosen() }; }
      const found = exact(await results(), alt);
      if (found) { found.scrollIntoView({ block: "nearest" }); realClick(optTarget(found)); await sleep(500); return finish(optText(found)); }
    }
    let picked = null;
    // Nothing matched the search: clear it and walk the list the widget offers.
    setNative(el, "");
    await sleep(200);
    realClick(el);
    opts = await waitOptions(1500);
    if (opts.length) {
      // Browsing: the fallbacks the server ordered (exact categories first), then the person's words.
      picked = await pick(opts, [...alternates, match, value].filter(Boolean));
      if (picked) return finish(picked);
    }
    await closeList(el);
    // A plain autocomplete box keeps typed text; that is an answer too.
    if (!el.closest("[data-automation-id^=formField-]") && el.getAttribute("data-uxi-widget-type") !== "selectinput") {
      await typeInto(el, value);
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      return { ok: !!clean(el.value), picked: el.value, typedOnly: true };
    }
    return { ok: false, error: "no matching suggestion", want: value, seen: opts.map(optText).slice(0, 12) };
  }
  /** Several picks in one search box (Workday "Type to Add Skills"): clear,
   *  search each value, take only an exact match ("Python", or "Python
   *  (Programming Language)"), next. The search text stays in the box after a
   *  pick, so it is cleared every time. */
  async function fillMultiSearch(r, values) {
    const el = r.el;
    const picked = [];
    const base = (t) => nrm(t).replace(/\s*\([^)]*\)$/, "");
    for (const v of values) {
      el.scrollIntoView({ block: "center" });
      el.focus();
      realClick(el);
      await sleep(150);
      await typeInto(el, v, { keys: true });
      await sleep(300);
      const before = openOptions().map(optText).join("|");
      press(el, "Enter");
      await sleep(400);
      const opts = await waitOptions(2500, before || null);
      const hit = opts.find((o) => nrm(optText(o)) === nrm(v)) || opts.find((o) => base(optText(o)) === nrm(v));
      if (hit) {
        hit.scrollIntoView({ block: "nearest" });
        realClick(optTarget(hit));
        await sleep(600);
        picked.push(optText(hit));
      }
      setNative(el, "");
      await closeList(el);
      await sleep(200);
    }
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return { ok: picked.length > 0 && typeaheadFilled(el), picked: picked.join("; "), seen: picked.length ? undefined : values.slice(0, 5) };
  }
  async function clickInput(input) {
    const target = input.closest("label") || (input.id && forLabel(input)) || input;
    target.scrollIntoView({ block: "center" });
    realClick(target === input ? input : target);
    await sleep(150);
    if (!input.checked) { realClick(input); await sleep(120); }
    if (!input.checked) {
      input.checked = true;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(80);
    }
    return input.checked;
  }
  async function fillRadio(r, wanted) {
    const hit = bestMatch(r.inputs, wanted, optionLabel);
    if (!hit) return { ok: false, error: "option not found", want: wanted, seen: r.inputs.map(optionLabel) };
    const ok = hit.checked || await clickInput(hit);
    return { ok, picked: optionLabel(hit) };
  }
  async function fillChecks(r, wanted) {
    const picked = [];
    for (const w of wanted) {
      const hit = bestMatch(r.inputs, w, optionLabel);
      if (hit && (hit.checked || await clickInput(hit))) picked.push(optionLabel(hit));
    }
    return { ok: picked.length > 0, picked, seen: picked.length ? undefined : r.inputs.map(optionLabel) };
  }
  async function fillYesNo(r, value) {
    const want = /^(y|yes|true|1|checked|agree|i agree|i acknowledge|i consent)/i.test(String(value)) || (value && !/^(n|no|false|0)$/i.test(String(value)) && nrm(value) === nrm(optionLabel(r.el)));
    const box = r.el;
    if (box.checked !== want) {
      const target = box.closest("label") || box;
      target.scrollIntoView({ block: "center" });
      realClick(target);
      await sleep(150);
      if (box.checked !== want) { realClick(box); await sleep(120); }
    }
    return { ok: box.checked === want, picked: want ? "checked" : "unchecked" };
  }
  /** "MM/DD/YYYY" (or { iso }) into a native date input, a Workday date
   *  widget, or a plain text box. */
  async function fillDate(r, value, iso) {
    const m = String(value || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/) || String(value || "").match(/^(\d{1,2})\/(\d{4})$/);
    const isoM = String(iso || value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    let mm = "", dd = "", yyyy = "";
    if (isoM) [yyyy, mm, dd] = [isoM[1], isoM[2], isoM[3]];
    else if (m && m.length === 4) [mm, dd, yyyy] = [m[1], m[2], m[3]];
    else if (m) [mm, yyyy] = [m[1], m[2]];
    mm = mm && mm.padStart(2, "0"); dd = dd && dd.padStart(2, "0");
    if (r.native) {
      setNative(r.el, `${yyyy}-${mm}-${dd || "01"}`);
      r.el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: !!r.el.value, actual: r.el.value };
    }
    if (r.inputs?.length) {
      // Workday redraws an entry while it is typed into (Oracle's start saved
      // as 05/1900, 2026-11-10): find each part again by its id, type, then
      // read back what Workday shows and type once more when it differs.
      const ids = r.inputs.map((p) => p.id);
      const live = () => ids.map((id, i) => (id && document.getElementById(id)) || r.inputs[i]);
      const want = (p) => { const w = p.getAttribute("data-automation-id") || ""; return /Month/.test(w) ? mm : /Day/.test(w) ? dd : /Year/.test(w) ? yyyy : ""; };
      const shownOk = () => live().every((p) => {
        const v = want(p);
        if (!v) return true;
        const disp = clean(document.getElementById(p.id?.replace(/-input$/, "-display"))?.textContent || p.getAttribute("aria-valuetext") || p.value);
        return Number(disp) === Number(v);
      });
      for (let attempt = 0; attempt < 2; attempt++) {
      r.inputs = live();
      for (const p of r.inputs) {
        const which = p.getAttribute("data-automation-id") || "";
        const v = /Month/.test(which) ? mm : /Day/.test(which) ? dd : /Year/.test(which) ? yyyy : "";
        if (!v) continue;
        p.scrollIntoView({ block: "center" });
        p.focus();
        realClick(p);
        await sleep(80);
        for (const ch of v) {
          p.dispatchEvent(new KeyboardEvent("keydown", { key: ch, code: `Digit${ch}`, keyCode: 48 + Number(ch), bubbles: true, cancelable: true }));
          setNative(p, (p.value && /^\d+$/.test(p.value) && p.value.length < v.length ? p.value : "") + ch);
          p.dispatchEvent(new KeyboardEvent("keyup", { key: ch, code: `Digit${ch}`, keyCode: 48 + Number(ch), bubbles: true }));
          await sleep(60);
        }
        if (p.value !== v) setNative(p, v);
        p.dispatchEvent(new Event("change", { bubbles: true }));
        p.dispatchEvent(new Event("blur", { bubbles: true }));
        await sleep(100);
      }
      await sleep(400);
      if (shownOk()) break;
      }
      const parts = live();
      const ok = shownOk() && parts.every((p) => clean(p.value) && !/^(mm|dd|yyyy)$/i.test(p.value));
      return { ok, actual: parts.map((p) => p.value).join("/"), ...(ok ? {} : { error: "the date did not keep (Workday shows another one)" }) };
    }
    return fillText(r, dd ? `${mm}/${dd}/${yyyy}` : `${mm}/${yyyy}`);
  }
  async function fillFile(r, b64, fileName) {
    const node = r.el;
    const SHOWN = "[data-automation-id=file-upload-successful], [data-automation-id=file-upload-item-name], [data-automation-id=fileName]";
    // Workday redraws the upload box once the file is in: look at the live one.
    const liveBox = () => (node.isConnected ? (r.box || node.parentElement)
      : document.querySelector("input[data-automation-id=file-upload-input-ref]")?.closest("[data-automation-id^=formField-]")) || r.box || node.parentElement;
    let box = liveBox();
    // Copies of one file (an upload checked too early and sent again, five of
    // them at State Street, 2026-11-10): keep the first, delete the rest.
    const dedupe = async () => {
      const items = [...(liveBox()?.querySelectorAll("[data-automation-id=file-upload-item]") || [])];
      const seen = new Set();
      for (const it of items) {
        const name = clean(textOf(it.querySelector("[data-automation-id=file-upload-item-name]")));
        if (!name) continue;
        if (!seen.has(name)) { seen.add(name); continue; }
        const del = it.querySelector("[data-automation-id=delete-file]");
        if (del) { realClick(del); await sleep(900); }
      }
    };
    // Already there (a pass before this one uploaded it): never a second copy.
    if (box?.querySelector(SHOWN) || box?.querySelector("[data-automation-id=file-upload-item]")) {
      await dedupe();
      return { ok: true, actual: textOf(liveBox()?.querySelector("[data-automation-id=file-upload-item-name], [data-automation-id=fileName]")) || fileName };
    }
    const ext = (fileName || "file.pdf").split(".").pop().toLowerCase();
    const mime = ext === "pdf" ? "application/pdf" : ext === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/octet-stream";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], fileName || "resume.pdf", { type: mime }));
    node.files = dt.files;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
    const zone = box?.querySelector("[data-automation-id=file-upload-drop-zone], [class*=drop-zone], [class*=dropzone]");
    if (!zone) { await sleep(1200); return { ok: !!(node.files && node.files.length) || !!box?.querySelector(SHOWN), actual: fileName }; }
    // Workday: "Successfully Uploaded!" shows a few seconds later (State Street,
    // 2026-11-10: checking after a second dropped the file three times).
    const shown = async (ms) => { for (const t0 = Date.now(); Date.now() - t0 < ms;) { box = liveBox(); if (box?.querySelector(SHOWN) || box?.querySelector("[data-automation-id=file-upload-item]")) return true; await sleep(300); } return false; };
    if (!(await shown(6000)) && zone.isConnected) {
      for (const type of ["dragenter", "dragover", "drop"]) zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      await shown(6000);
    }
    for (let i = 0; i < 30 && !liveBox()?.querySelector(SHOWN); i++) await sleep(300); // still uploading
    await dedupe();
    // A file in the box is an upload under way, not a failure to retry.
    return { ok: !!liveBox()?.querySelector(SHOWN) || !!liveBox()?.querySelector("[data-automation-id=file-upload-item]"), actual: fileName };
  }

  /** Put one computed fill into its field. extra = { resumeB64, resumeName }. */
  async function apply(id, f, extra = {}) {
    const r = record(id);
    if (!r) return { ok: false, error: "field not on page" };
    try {
      if (f.kind === "file") return extra.resumeB64 ? await fillFile(r, extra.resumeB64, extra.resumeName) : { ok: false, error: "no resume bytes" };
      if (f.kind === "date" || r.type === "date") return await fillDate(r, f.value, f.iso);
      if (f.kind === "location") {
        if (r.type === "typeahead") return await fillTypeahead(r, f.value, f.match, f.alternates || []);
        if (r.type === "select") return await fillSelect(r, f.match || f.value);
        return await fillText(r, f.match || f.value);
      }
      const values = f.values || [f.value];
      if (f.kind === "multi" && r.type === "typeahead") return await fillMultiSearch(r, values);
      switch (r.type) {
        case "select": return await fillSelect(r, values[0]);
        case "typeahead": return await fillTypeahead(r, values[0], f.match, f.alternates || []);
        case "radio": return await fillRadio(r, values[0]);
        case "checkbox": return await fillChecks(r, values);
        case "yesno": return await fillYesNo(r, values[0]);
        default: return await fillText(r, f.values ? values.join(", ") : String(f.value ?? ""));
      }
    } catch (e) {
      return { ok: false, error: String(e?.message || e).slice(0, 160) };
    }
  }

  async function scrollTo(id) {
    const r = record(id);
    const el = r ? (r.box || r.el) : null;
    if (!el) return { ok: false };
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(300);
    return { ok: true };
  }
  /** The element to outline for a field (the content script's highlight). */
  function rectOf(id) {
    const r = record(id);
    const el = r ? (r.el.closest("[data-automation-id^=formField-], fieldset, .form-group, .field") || r.box || r.el) : null;
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { top: b.top + scrollY, left: b.left + scrollX, width: b.width, height: b.height };
  }

  /** What the page flags, per field: { path, label, text }. */
  function errors() {
    const out = [];
    const seen = new Set();
    const ownerId = (el) => {
      const box = el.closest("[data-automation-id^=formField-], fieldset, .form-group, .field, li, div");
      const ctl = box?.querySelector("[data-jw-id]");
      return ctl?.getAttribute("data-jw-id") || "";
    };
    for (const el of document.querySelectorAll("[data-automation-id=errorMessage], [data-automation-id=inputError], [role=alert], .error-message, .field-error, .invalid-feedback, .help-block.error, [class*=errorMessage], [class*=error-text], [class*=ErrorMessage]")) {
      if (!visible(el)) continue;
      const text = clean(textOf(el));
      if (!text || text.length > 220) continue;
      const path = ownerId(el);
      const k = path + "|" + text;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ path, label: path ? (reg.get(path)?.label || "") : "", text });
    }
    for (const el of document.querySelectorAll("[aria-invalid=true][data-jw-id]")) {
      const path = el.getAttribute("data-jw-id");
      if (!out.some((e) => e.path === path)) out.push({ path, label: "", text: "flagged as invalid" });
    }
    return out;
  }

  // ── Page state ───────────────────────────────────────────────────────────
  function stepName() {
    const wd = document.querySelector("[data-automation-id=progressBarActiveStep]");
    if (wd) return clean(textOf(wd)).replace(/^current step \d+ of \d+\s*/i, "");
    const h = document.querySelector("[data-automation-id=applyFlowPage] h2, main h1, main h2, h1");
    return clean(textOf(h)).slice(0, 80);
  }
  function hasPassword() { return [...document.querySelectorAll("input[type=password]")].some(visible); }
  function workdayStartModal() {
    return !!document.querySelector("[data-automation-id=applyManually], [data-automation-id=autofillWithResume], [data-automation-id=useMyLastApplication]");
  }
  function onReviewStep() {
    return /^review\b/i.test(stepName()) || !!document.querySelector("[data-automation-id=reviewPage], [data-automation-id=review-page]");
  }
  function submitted() {
    const body = (document.body?.innerText || "").slice(0, 6000);
    return /application (has been |was )?(successfully )?(submitted|received)|thank you for (applying|your application|submitting)|thanks for applying|we('ve| have) received your application|successfully applied/i.test(body);
  }
  /** The posting's text when the page shows it (non-Workday boards often do). */
  function descriptionText() {
    const d = document.querySelector("[data-automation-id=jobPostingDescription], .job-description, #job-description, [class*=jobDescription], [class*=job-description], .iCIMS_JobContent, article");
    return d ? clean(textOf(d)).slice(0, 20000) : "";
  }
  function pageJob() {
    // Not the cookie notice (Workday's legal notice is an h1 on some sites: "Click 'Accept Cookies'…").
    const titleEl = [...document.querySelectorAll("[data-automation-id=jobPostingHeader], h1, [class*=job-title], [class*=jobTitle]")]
      .find((e) => visible(e) && textOf(e) && !e.closest("[data-automation-id*=legalNotice], [class*=cookie], [id*=cookie]") && !/cookie/i.test(textOf(e)));
    const title = clean(textOf(titleEl)).slice(0, 200);
    // og:site_name, else the part of the tab title that is not the job or a
    // generic page word ("Application", "Careers").
    const generic = /^(apply|application|job application|careers?( site| page)?|jobs?|job details|home|workday|icims|smartrecruiters|workable|bamboohr)$/i;
    const parts = [document.querySelector("meta[property='og:site_name']")?.content || "", ...(document.title || "").split(/ [|\-–—] | at /)]
      .map(clean).filter((x) => x && !generic.test(x) && !nrm(title).includes(nrm(x)));
    const company = (parts[0] || "").slice(0, 120);
    const loc = clean(textOf(document.querySelector("[data-automation-id=locations], [class*=job-location], [class*=jobLocation], .location"))).slice(0, 120);
    return { jobTitle: title, companyName: company, locationName: loc };
  }

  // ── Workday My Experience ────────────────────────────────────────────────
  /** Sections with an Add button: [{ name, entries, button }] for Work
   *  Experience, Education, Websites, Languages, Certifications. */
  function workdaySections() {
    const out = [];
    for (const btn of document.querySelectorAll("button[data-automation-id=add-button], [data-automation-id=add-button] button, button")) {
      const t = clean(textOf(btn));
      if (!/^add( another)?$/i.test(t) || !visible(btn)) continue;
      const sec = btn.closest("[role=group], section, fieldset, [data-automation-id*=Section], [data-automation-id*=section]") || btn.parentElement?.parentElement;
      const name = clean(btn.getAttribute("aria-label") || textOf(sec?.querySelector("h2, h3, h4, legend")) || "").replace(/^add\s+/i, "");
      if (!name) continue;
      const entries = sec ? sec.querySelectorAll("[data-automation-id=panelSet] > div, [role=group] h4, h4").length : 0;
      out.push({ name, entries, button: btn });
    }
    return out;
  }
  async function workdayAdd(sectionName) {
    const s = workdaySections().find((x) => nrm(x.name).startsWith(nrm(sectionName)));
    if (!s) return { ok: false, error: `no Add button for ${sectionName}` };
    s.button.scrollIntoView({ block: "center" });
    realClick(s.button);
    await sleep(900);
    return { ok: true };
  }
  function workdaySectionNames() { return workdaySections().map((s) => ({ name: s.name, entries: s.entries })); }

  // ── Workday unattended: account, start choice, Save and Continue ─────────
  const vis = (sel) => [...document.querySelectorAll(sel)].filter(visible);
  /** Workday puts a transparent click_filter over its buttons: press that when there is one. */
  function press1(btn) {
    const filter = btn.parentElement?.querySelector("[data-automation-id=click_filter]") || (btn.matches("[data-automation-id=click_filter]") ? btn : null);
    const el = filter && visible(filter) ? filter : btn;
    el.scrollIntoView({ block: "center" });
    realClick(el);
    if (el === btn) return;
    btn.click?.();
  }
  function buttonByText(re, scope = document) {
    return [...scope.querySelectorAll("button, [role=button], a, [data-automation-id=click_filter]")]
      .filter(visible).find((b) => re.test(clean(b.getAttribute("aria-label") || textOf(b))));
  }
  /** The sign-in or create-account form now on the page:
   *  { mode: "create" | "signin" | null, errors: [text], message } */
  function workdayAuthState() {
    const pw = vis("input[type=password]");
    // Workday's first screen (2026): Apple / Google / LinkedIn / "Sign in with email", no boxes yet.
    const chooser = !pw.length && !!vis("[data-automation-id=SignInWithEmailButton]").length;
    const mode = chooser ? "chooser" : !pw.length ? null : (pw.length >= 2 || vis("[data-automation-id=verifyPassword], [data-automation-id=createAccountSubmitButton]").length) ? "create" : "signin";
    const errs = vis("[data-automation-id=errorMessage], [data-automation-id=inputError], [role=alert], [data-automation-id=errorBanner]")
      .map((e) => clean(textOf(e))).filter((t) => t && t.length < 300);
    const body = clean((document.body?.innerText || "").slice(0, 4000));
    const message = (body.match(/[^.]*\b(verify|verification|activate)\b[^.]*(email|account)[^.]*\./i) || [""])[0].slice(0, 240);
    return { mode, errors: [...new Set(errs)], message };
  }
  /** Open the email form from the chooser screen; true when it opened. */
  async function workdayEmailForm() {
    const b = vis("[data-automation-id=SignInWithEmailButton]")[0];
    if (!b) return !!vis("input[type=password]").length;
    press1(b);
    for (let i = 0; i < 10 && !vis("input[type=password]").length; i++) await sleep(300);
    return !!vis("input[type=password]").length;
  }
  /** Fill and send the account form: { email, password, mode }. */
  async function workdayAuth({ email, password, mode }) {
    if (workdayAuthState().mode === "chooser" && !(await workdayEmailForm())) return { ok: false, error: "the Sign in with email form did not open" };
    const st = workdayAuthState();
    if (st.mode !== mode) {
      // Switch forms: "Sign In" link on Create Account, "Create Account" on Sign In.
      const link = vis(mode === "signin" ? "[data-automation-id=signInLink]" : "[data-automation-id=createAccountLink]")[0]
        || buttonByText(mode === "signin" ? /^(sign in|already have an account\??\s*sign in)$/i : /^(create account|don't have an account\??\s*create account)$/i);
      if (!link) return { ok: false, error: `no ${mode === "signin" ? "Sign In" : "Create Account"} link` };
      press1(link);
      await sleep(1500);
      // "Sign In" from Create Account goes back to the chooser first.
      if (workdayAuthState().mode === "chooser") await workdayEmailForm();
      if (workdayAuthState().mode !== mode) return { ok: false, error: `the ${mode} form did not open` };
    }
    const form = vis("input[type=password]")[0]?.closest("form, [data-automation-id=signInContent], [data-automation-id=createAccountContent], [role=dialog], main") || document.body;
    const emailEl = vis("input[data-automation-id=email], input[type=email], input[autocomplete=email], input[name*=mail i]").find((e) => form.contains(e) && !honeypot(e)) || [...form.querySelectorAll("input[type=text]")].find((e) => visible(e) && !honeypot(e));
    const pws = vis("input[type=password]").filter((e) => form.contains(e));
    if (!emailEl || !pws.length) return { ok: false, error: "account form fields not found" };
    await typeInto(emailEl, email, { keys: true });
    emailEl.dispatchEvent(new Event("blur", { bubbles: true }));
    for (const p of pws) { await typeInto(p, password, { keys: true }); p.dispatchEvent(new Event("blur", { bubbles: true })); }
    if (mode === "create") {
      // "I agree to the terms" and similar: every unchecked box on the account form.
      for (const cb of [...form.querySelectorAll("input[type=checkbox]")].filter((c) => !c.checked)) {
        const target = visible(cb) ? cb : cb.closest("label, div") || cb;
        realClick(target);
        await sleep(150);
        if (!cb.checked) cb.click();
      }
    }
    await sleep(300);
    const submit = vis(mode === "signin" ? "[data-automation-id=signInSubmitButton]" : "[data-automation-id=createAccountSubmitButton]")[0]
      || buttonByText(mode === "signin" ? /^sign in$/i : /^create account$/i, form) || buttonByText(mode === "signin" ? /^sign in$/i : /^create account$/i);
    if (!submit) return { ok: false, error: "no submit button on the account form" };
    press1(submit);
    return { ok: true };
  }
  /** "Forgot your password?" on the Sign In form, then send the reset email. */
  async function workdayForgot(email) {
    if (workdayAuthState().mode === "chooser") await workdayEmailForm();
    const link = vis("[data-automation-id=forgotPasswordLink]")[0] || buttonByText(/^forgot (your )?password\??$/i);
    if (!link) return { ok: false, error: "no Forgot your password? link" };
    press1(link);
    await sleep(1500);
    const emailEl = vis("input[data-automation-id=email], input[type=email], input[autocomplete=email], input[name*=mail i]").find((e) => !honeypot(e));
    if (!emailEl) return { ok: false, error: "no email box on the reset form" };
    await typeInto(emailEl, email, { keys: true });
    emailEl.dispatchEvent(new Event("blur", { bubbles: true }));
    await sleep(300);
    const submit = vis("[data-automation-id=resetPasswordButton], [data-automation-id=resetPasswordSubmitButton], [data-automation-id=forgotPasswordSubmitButton]")[0]
      || buttonByText(/^(submit|reset password|send|send email|continue)$/i);
    if (!submit) return { ok: false, error: "no submit button on the reset form" };
    press1(submit);
    return { ok: true };
  }
  /** The page from the reset email: the new password in every password box. */
  async function workdaySetPassword({ email, password }) {
    const pws = vis("input[type=password]");
    if (!pws.length) return { ok: false, error: "no password boxes on the reset page" };
    const emailEl = vis("input[data-automation-id=email], input[type=email], input[autocomplete=email]")[0];
    if (emailEl && !emailEl.value) await typeInto(emailEl, email, { keys: true });
    for (const p of pws) { await typeInto(p, password, { keys: true }); p.dispatchEvent(new Event("blur", { bubbles: true })); }
    await sleep(300);
    const submit = vis("[data-automation-id=resetPasswordSubmitButton], [data-automation-id=changePasswordSubmitButton], [data-automation-id=submitButton]")[0]
      || buttonByText(/^(submit|reset password|change password|save|update password|continue)$/i);
    if (!submit) return { ok: false, error: "no submit button on the reset page" };
    press1(submit);
    return { ok: true };
  }
  /** "Verify your account before you sign in or request a verification email":
   *  press the request link so a new email comes (the first may be old). */
  function workdayResendVerify() {
    const el = [...document.querySelectorAll("[data-automation-id=errorMessage] a, [data-automation-id=errorMessage] button, a, button, [role=button]")]
      .filter(visible).find((b) => /request a (new )?verification email|resend (the )?(verification )?email|send (a )?(new )?verification/i.test(clean(textOf(b))));
    if (!el) return false;
    press1(el);
    return true;
  }
  /** Press a Workday button by automation id or text ("applyManually"). */
  function workdayPress(id, textRe = null) {
    const el = vis(`[data-automation-id="${CSS.escape(id)}"]`)[0] || (textRe ? buttonByText(new RegExp(textRe, "i")) : null);
    if (!el) return false;
    press1(el);
    return true;
  }
  /** Save and Continue (or Next / Continue) at the bottom of a step. Never Submit. */
  function workdayNext() {
    const btn = vis("[data-automation-id=bottom-navigation-next-button], [data-automation-id=pageFooterNextButton], [data-automation-id=wd-CommandButton_next]")[0]
      || buttonByText(/^(save and continue|next|continue)$/i);
    if (!btn) return { ok: false, error: "no Save and Continue button" };
    if (/submit/i.test(clean(textOf(btn)))) return { ok: false, error: "the button is Submit" };
    if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return { ok: false, error: "Save and Continue is disabled" };
    press1(btn);
    return { ok: true };
  }
  /** A Workday page that says the posting is gone. */
  function workdayClosed() {
    const t = (document.body?.innerText || "").slice(0, 3000);
    return /page you are looking for (doesn't|does not) exist|this job (posting )?is no longer available|no longer accepting applications|job requisition (is )?closed/i.test(t);
  }

  window.__jwGeneric = { scan, apply, scrollTo, rectOf, errors, stepName, hasPassword, workdayStartModal, onReviewStep, submitted, descriptionText, pageJob, workdaySectionNames, workdayAdd, workdayAuthState, workdayEmailForm, workdayAuth, workdayForgot, workdayResendVerify, workdaySetPassword, workdayPress, workdayNext, workdayClosed };
})();
