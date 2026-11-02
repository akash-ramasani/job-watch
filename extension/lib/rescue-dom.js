// lib/rescue-dom.js — MAIN-world helpers for the AI rescue of a stuck field.
//
// snapshot(question): find the field block whose question reads `question`,
// tag every control in it (and any dropdown options open elsewhere on the
// page) with data-jw-ref="rN", and return a small, cleaned copy of its HTML,
// whether it is mandatory (a "*" by the question, or required/aria-required),
// and whether it already holds an answer.
// act(steps): run the steps the AI chose on those refs (click, type, select,
// check, uncheck, key), like a person would.
// valueOf(question): the answer the field holds now, as text ("" if none),
// for the answer bank. Also loaded in the content scripts' own world, where
// it reads the same DOM.

(function () {
  if (window.__jwRescueDom) return;

  const sleep = (ms) => (window.__jwMainWait ? window.__jwMainWait(ms) : window.__jwWait ? window.__jwWait(ms) : new Promise((r) => setTimeout(r, ms)));
  const nrm = (s) => String(s || "").replace(/[*✱]/g, " ").replace(/\s+/g, " ").trim().toLowerCase().replace(/[:?]$/, "");
  const CONTROL = "input:not([type=hidden]), select, textarea, button, [role=combobox], [role=listbox], [role=option], [role=radio], [role=checkbox], [role=button], [contenteditable=true]";
  const PLACEHOLDER = /^[-–—\s]*(select( one| an option|\.\.\.|…)?|choose( one| an option)?|please (select|choose)( one)?|none selected|search)?[-–—\s]*$/i;

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** The smallest block that holds the question text and its controls. */
  function findBlock(question) {
    const want = nrm(question);
    if (!want) return null;
    const heads = [...document.querySelectorAll("label, legend, span, div, p, h3, h4, h5")]
      .filter((e) => e.children.length <= 4 && e.textContent.length < want.length + 80)
      .filter((e) => { const t = nrm(e.textContent); return t === want || (want.length > 12 && (t.startsWith(want) || want.startsWith(t) && t.length > 12)); });
    // An answer option that reads like the question ("LinkedIn" under "How
    // did you hear about us?") is not the question: question labels first,
    // exact text before partial, options only when nothing else matches.
    const isOption = (e) => !!(e.querySelector?.("input[type=radio], input[type=checkbox]")
      || (e.htmlFor && document.getElementById(e.htmlFor)?.matches?.("input[type=radio], input[type=checkbox]"))
      || e.closest?.("label")?.querySelector("input[type=radio], input[type=checkbox]")
      || e.closest?.("[role=option], [role=radio], [role=checkbox]"));
    const rank = (e) => (isOption(e) ? 2 : 0) + (nrm(e.textContent) === want ? 0 : 1);
    heads.sort((a, b) => rank(a) - rank(b));
    for (const h of heads) {
      let node = h;
      for (let k = 0; node && k < 6 && node !== document.body; k++, node = node.parentElement) {
        const controls = [...node.querySelectorAll(CONTROL)].filter((c) => visible(c) || c.type === "radio" || c.type === "checkbox");
        if (!controls.length) continue;
        // One question per block: stop before swallowing the next questions.
        // (Option labels wrapping a checkbox or radio are answers, not questions.)
        const questions = [...node.querySelectorAll("label, legend")].filter((l) => !l.querySelector("input, select, textarea")
          && !(l.htmlFor && document.getElementById(l.htmlFor)?.matches?.("input[type=radio], input[type=checkbox]"))).length;
        // A long <select>'s options are not the block's own text.
        let textLen = node.textContent.length;
        for (const sel of node.querySelectorAll("select")) textLen -= sel.textContent.length;
        if (textLen > 4000 || questions > 12) break;
        return node;
      }
    }
    return null;
  }

  function requiredOf(block, question) {
    if (block.querySelector("[required], [aria-required=true]")) return true;
    const head = [...block.querySelectorAll("label, legend, span, div, p")].find((e) => nrm(e.textContent).startsWith(nrm(question).slice(0, 20)));
    return /[*✱]/.test(head ? head.textContent : block.textContent.slice(0, question.length + 40));
  }

  function filledOf(block) {
    for (const el of block.querySelectorAll("input, select, textarea")) {
      if (el.type === "hidden" || el.type === "file" || el.type === "submit" || el.type === "button") continue;
      if ((el.type === "radio" || el.type === "checkbox") && el.checked) return true;
      if (el.tagName === "SELECT" && el.value && !PLACEHOLDER.test(el.options[el.selectedIndex]?.textContent || "")) return true;
      if (!["radio", "checkbox"].includes(el.type) && el.tagName !== "SELECT" && el.getAttribute("role") !== "combobox" && el.value?.trim()) return true;
    }
    // Custom pickers show the chosen value next to the box.
    if (block.querySelector("[class*=single-value i], [class*=singleValue], [class*=multi-value i], [class*=multiValue], [data-automation-id=selectedItem], [aria-selected=true][role=option]")) return true;
    // Text typed into a picker's search box is not a choice.
    return false;
  }

  const KEEP = new Set(["id", "name", "type", "role", "placeholder", "value", "for", "checked", "selected", "disabled", "required", "data-jw-ref", "href", "maxlength", "multiple"]);
  function cleanHtml(root) {
    const clone = root.cloneNode(true);
    clone.querySelectorAll("script, style, svg, img, noscript, iframe, link, meta").forEach((n) => n.remove());
    const walk = (el) => {
      for (const a of [...el.attributes]) if (!KEEP.has(a.name) && !a.name.startsWith("aria-")) el.removeAttribute(a.name);
      for (const c of el.children) walk(c);
    };
    walk(clone);
    // A long list (every university) is cut to its ends; any option can still be
    // chosen by its exact text with "select".
    for (const sel of clone.querySelectorAll("select")) {
      const opts = [...sel.querySelectorAll("option")];
      if (opts.length <= 80) continue;
      opts.slice(40, -20).forEach((o) => o.remove());
      sel.setAttribute("data-options-shown", `first 40 and last 20 of ${opts.length}`);
    }
    // Current values, which live in properties rather than attributes.
    const live = root.querySelectorAll("input, select, textarea");
    clone.querySelectorAll("input, select, textarea").forEach((n, i) => {
      const src = live[i];
      if (!src) return;
      if (src.type === "radio" || src.type === "checkbox") { if (src.checked) n.setAttribute("checked", ""); }
      else if (src.tagName !== "SELECT" && src.value) n.setAttribute("value", src.value.slice(0, 200));
    });
    return clone.outerHTML.replace(/\s+/g, " ").replace(/>\s+</g, "><");
  }

  function snapshot(question) {
    const block = findBlock(question);
    if (!block) return { ok: false, error: "field not found on the page" };
    document.querySelectorAll("[data-jw-ref]").forEach((e) => e.removeAttribute("data-jw-ref"));
    let n = 0;
    const tag = (el) => { if (!el.hasAttribute("data-jw-ref")) el.setAttribute("data-jw-ref", `r${n++}`); };
    block.querySelectorAll(CONTROL).forEach(tag);
    block.querySelectorAll("label").forEach(tag);
    // Options of a dropdown this field opened (often rendered elsewhere on the page).
    const open = [...document.querySelectorAll("[role=listbox] [role=option], [role=menu] [role=menuitem], [data-automation-id=promptOption], [class*=option i][id*=option i]")]
      .filter((o) => visible(o) && !block.contains(o)).slice(0, 80);
    open.forEach(tag);
    let html = cleanHtml(block);
    if (open.length) html += `\n<!-- open dropdown options -->\n<ul>${open.map((o) => `<li data-jw-ref="${o.getAttribute("data-jw-ref")}">${o.textContent.replace(/\s+/g, " ").trim().slice(0, 140)}</li>`).join("")}</ul>`;
    return { ok: true, html: html.slice(0, 12000), required: requiredOf(block, question), filled: filledOf(block), refs: n };
  }

  function setNative(node, value) {
    const proto = node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : node.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const old = node.value;
    if (setter) setter.call(node, value); else node.value = value;
    if (node._valueTracker) node._valueTracker.setValue(old);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function realClick(el) {
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    const opt = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup"]) el.dispatchEvent(new (t.startsWith("pointer") ? PointerEvent : MouseEvent)(t, opt));
    el.click();
  }
  function press(el, key) {
    const code = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, Tab: 9, " ": 32 }[key] || 0;
    for (const type of ["keydown", "keypress", "keyup"]) el.dispatchEvent(new KeyboardEvent(type, { key, code: key === " " ? "Space" : key, keyCode: code, which: code, bubbles: true, cancelable: true }));
  }

  async function act(steps) {
    const log = [];
    for (const s of steps || []) {
      const el = document.querySelector(`[data-jw-ref="${CSS.escape(String(s.ref))}"]`);
      if (!el) { log.push(`${s.ref}: gone`); continue; }
      try {
        if (s.op === "click") realClick(el);
        else if (s.op === "type") {
          const node = el.matches("input, textarea") ? el : el.querySelector("input, textarea") || el;
          // Pickers open on a press plus focus; a background tab may never send focus.
          realClick(node);
          node.focus();
          node.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
          node.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
          setNative(node, "");
          let typed = "";
          for (const ch of String(s.text || "")) { typed += ch; setNative(node, typed); await sleep(12); }
          node.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (s.op === "select") {
          const sel = el.tagName === "SELECT" ? el : el.querySelector("select");
          if (sel) {
            const want = nrm(s.text);
            const o = [...sel.options].find((x) => nrm(x.textContent) === want) || [...sel.options].find((x) => nrm(x.textContent).startsWith(want));
            if (o) { setNative(sel, o.value); sel.dispatchEvent(new Event("change", { bubbles: true })); } else log.push(`${s.ref}: no option "${s.text}"`);
          } else realClick(el);
        } else if (s.op === "check" || s.op === "uncheck") {
          const box = el.matches("input") ? el : el.querySelector("input[type=checkbox], input[type=radio]") || el;
          const want = s.op === "check";
          if (box.checked !== want) { realClick(box.closest("label") || box); await sleep(150); if (box.checked !== want) realClick(box); }
        } else if (s.op === "key") press(el, String(s.text || "Enter"));
        log.push(`${s.op} ${s.ref}: ok`);
      } catch (e) { log.push(`${s.op} ${s.ref}: ${e.message}`); }
      await sleep(400);
    }
    return { ok: true, log };
  }

  function valueOf(question) {
    const block = findBlock(question);
    if (!block) return "";
    const out = [];
    const labelOf = (el) => (el.labels?.[0]?.textContent || el.closest("label")?.textContent || el.getAttribute("aria-label") || el.value || "").replace(/\s+/g, " ").trim();
    for (const el of block.querySelectorAll("input, select, textarea")) {
      if (["hidden", "file", "submit", "button", "password"].includes(el.type)) continue;
      if (el.type === "radio" || el.type === "checkbox") { if (el.checked) out.push(labelOf(el)); continue; }
      if (el.tagName === "SELECT") { const t = el.options[el.selectedIndex]?.textContent?.trim() || ""; if (el.value && !PLACEHOLDER.test(t)) out.push(t); continue; }
      // A picker's search box holds typing, not the choice.
      if (el.getAttribute("role") === "combobox" || el.closest("[class*=select__] , [class*=Select]")) continue;
      if (el.value?.trim()) out.push(el.value.trim());
    }
    for (const el of block.querySelectorAll("[class*=single-value i], [class*=singleValue], [class*=multi-value__label i], [class*=multiValue] [class*=label i], [data-automation-id=selectedItem]")) {
      const t = el.textContent.replace(/\s+/g, " ").trim();
      if (t) out.push(t);
    }
    return [...new Set(out.filter(Boolean))].join("; ").slice(0, 300);
  }

  window.__jwRescueDom = { snapshot, act, valueOf };
})();
