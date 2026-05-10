// content/greenhouse.js — Injected into Greenhouse job board pages.
// Fill+submit mode: scrapes fields, maps via AI, fills and submits.

(async function () {
  await runFill();

  // ── Utilities ──────────────────────────────────────────────────────────────
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function showOverlay(text, color = "#4f46e5") {
    let el = document.getElementById("jw-overlay");
    if (!el) {
      el = document.createElement("div");
      el.id = "jw-overlay";
      el.style.cssText = [
        "position:fixed", "bottom:24px", "right:24px", "z-index:99999",
        "color:white", "font-family:system-ui,sans-serif",
        "font-size:13px", "font-weight:600", "padding:12px 18px",
        "border-radius:12px", "box-shadow:0 8px 32px rgba(0,0,0,0.2)",
        "max-width:300px", "transition:background 0.3s",
      ].join(";");
      document.body.appendChild(el);
    }
    el.style.background = color;
    el.textContent = text;
  }

  function waitFor(sel, timeout = 12000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(sel);
      if (el) return resolve(el);
      const obs = new MutationObserver(() => {
        const found = document.querySelector(sel);
        if (found) { obs.disconnect(); resolve(found); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); reject(new Error(`Timeout: ${sel}`)); }, timeout);
    });
  }

  // React-controlled input setter
  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (nativeSetter) nativeSetter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input",  { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur",   { bubbles: true }));
  }

  // Resume file injection
  async function setFileInput(input, base64, fileName) {
    try {
      const name = fileName || "resume.pdf";
      const ext = name.split(".").pop().toLowerCase();
      const mime = ext === "pdf" ? "application/pdf"
        : ext === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/octet-stream";
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], name, { type: mime });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("input",  { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (e) {
      console.warn("[JobWatch] Resume inject failed:", e.message);
      return false;
    }
  }

  // Fill a Greenhouse React Select combobox
  async function fillCombobox(combobox, value) {
    if (!combobox || !value) return;
    combobox.click();
    combobox.focus();
    await sleep(400);

    if (value === "__ALL__") {
      // Multi-select: keep clicking all unselected options until none remain
      for (let pass = 0; pass < 10; pass++) {
        const opts = [...document.querySelectorAll(
          ".select__option:not(.select__option--is-selected), [class*='select__option']:not([class*='is-selected'])"
        )].filter(o => o.offsetParent !== null); // visible only
        if (!opts.length) break;
        for (const opt of opts) { opt.click(); await sleep(150); }
        await sleep(300);
      }
      combobox.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(200);
      return;
    }

    // Type to filter
    setNativeValue(combobox, value);
    await sleep(700);

    let opts = [...document.querySelectorAll(".select__option, [class*='select__option']")]
      .filter(o => o.offsetParent !== null);
    if (!opts.length) opts = [...document.querySelectorAll("[role=option]")].filter(o => o.offsetParent !== null);

    if (opts.length > 0) {
      const lv = value.toLowerCase();
      const match = opts.find(o => o.textContent.trim().toLowerCase() === lv)
        || opts.find(o => o.textContent.trim().toLowerCase().includes(lv))
        || opts[0];
      match.click();
    } else {
      combobox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }
    await sleep(300);
  }

  // Extract a clean semantic field ID from an input/select/textarea element.
  function extractFieldId(el, forAttr, label) {
    const name = (el.name || "")
      .replace(/^job_application\[|\]$/g, "")   // Greenhouse native select names
      .replace(/^files\[|\]$/g, "")             // Okta file input names
      .replace(/\[\d+\]$/, "");                 // Okta checkbox names like question_xxx[id]
    const elId   = (el.id    || "").replace(/^edit-/, "");  // strip Drupal "edit-" prefix
    const forClean = (forAttr || "").replace(/^edit-/, "");
    return name || elId || forClean || label.replace(/[^a-z0-9]/gi, "_").toLowerCase();
  }

  // Scrape one field-wrapper (returns field descriptor + DOM refs).
  // Supports three form flavors:
  //   1. Greenhouse embed (div.field-wrapper) — label.label, input.input / React Select
  //   2. UDig / grnhse_app (div.field)        — label.label, native <select> / Select2
  //   3. Okta ODS (fieldset.ods-fieldset)     — label>span.ods-label, input.ods-text-input
  function scrapeWrapper(wrapper) {
    // ── Greenhouse-style multi-checkbox fieldset ──────────────────────────────
    const cbFieldset = wrapper.querySelector("fieldset.checkbox");
    if (cbFieldset) {
      const legend = cbFieldset.querySelector("legend");
      const label = legend ? legend.textContent.replace(/\*/g, "").trim() : "";
      const checkboxes = [...cbFieldset.querySelectorAll("input[type=checkbox]")];
      const options = checkboxes.map(cb => {
        const lbl = cbFieldset.querySelector(`label[for="${cb.id}"]`);
        return lbl ? lbl.textContent.trim() : cb.value;
      });
      const required = !!cbFieldset.querySelector("span.required, [required]");
      const id = cbFieldset.id || label.replace(/[^a-z0-9]/gi, "_").toLowerCase();
      return { id, label, type: "checkbox", required, options, _checkboxes: checkboxes };
    }

    // ── ODS single-checkbox (Okta consent / acknowledge) ─────────────────────
    const odsCb = wrapper.querySelector("input[type=checkbox]");
    if (odsCb) {
      // The human-readable label comes from the closest parent legend, not label.option
      const legend = wrapper.closest("fieldset[id$='--wrapper']")?.querySelector("legend .fieldset-legend")
        || wrapper.closest("fieldset")?.querySelector("legend .fieldset-legend");
      const optLabel = wrapper.querySelector("label.option span.ods-label, label.option");
      const label = legend ? legend.textContent.trim() : (optLabel?.textContent.trim() || "Checkbox");
      const id = extractFieldId(odsCb, "", label);
      const required = !!odsCb.required || odsCb.getAttribute("aria-required") === "true";
      return { id, label, type: "checkbox", required, options: ["I acknowledge"], _checkboxes: [odsCb] };
    }

    // ── Label detection: Greenhouse label.label OR any non-option label ───────
    const labelEl = wrapper.querySelector("label.label")
      || wrapper.querySelector("label:not(.option)");
    if (!labelEl) return null;

    const odsSpan = labelEl.querySelector("span.ods-label");
    const rawText = (odsSpan || labelEl).textContent.trim();
    const label = rawText.replace(/\*/g, "").trim();
    if (!label) return null;

    const forAttr = labelEl.getAttribute("for") || "";
    const required = labelEl.classList.contains("js-form-required")
      || labelEl.classList.contains("form-required")
      || rawText.includes("*")
      || !!wrapper.querySelector("[aria-required='true'], [required]:not([type=radio]):not([type=hidden])");

    // ── File upload ───────────────────────────────────────────────────────────
    const fileInput = wrapper.querySelector("input[type=file]");
    if (fileInput) {
      const id = extractFieldId(fileInput, forAttr, label);
      return { id, label, type: "file", required, options: [], _el: fileInput };
    }

    // ── React Select combobox (boards.greenhouse.io embed) ───────────────────
    const combobox = wrapper.querySelector("input.select__input[role=combobox]");
    if (combobox) {
      const id = combobox.id || forAttr;
      const placeholder = wrapper.querySelector(".select__placeholder")?.textContent?.trim() || "";
      const descEl = wrapper.querySelector("[id$='-description']");
      const description = descEl ? descEl.textContent.trim() : "";
      return { id, label, type: "select", required, options: [], placeholder, description, _el: combobox };
    }

    // ── Native <select> (Select2 / UDig / Okta ODS) ──────────────────────────
    const nativeSelect = wrapper.querySelector("select");
    if (nativeSelect) {
      const id = extractFieldId(nativeSelect, forAttr, label);
      const options = [...nativeSelect.options]
        .filter(o => o.value !== "")
        .map(o => o.text.trim());
      return { id, label, type: "select", required, options, placeholder: "Select...", description: "", _el: nativeSelect };
    }

    // ── Text / textarea (Greenhouse input.input OR Okta input.ods-text-input) ─
    const textarea = wrapper.querySelector("textarea");
    const textInput = wrapper.querySelector(
      "input.input, input.ods-text-input, " +
      "input.form-text:not([type=radio]):not([type=checkbox]):not([type=file]):not([type=hidden])"
    );
    const el = textarea || textInput;
    if (!el) return null;
    const id = extractFieldId(el, forAttr, label);
    const type = textarea ? "textarea" : (el.type === "email" ? "email" : el.type === "tel" ? "tel" : "text");
    const placeholder = el.placeholder || "";
    const descEl = wrapper.querySelector("[id$='-description'], .description");
    const description = descEl ? descEl.textContent.trim() : "";
    return { id, label, type, required, options: [], placeholder, description, _el: el };
  }

  // Pick the right field-wrapper selector for this form:
  //   Greenhouse embed → div.field-wrapper
  //   Okta ODS        → fieldset.ods-fieldset
  //   UDig / grnhse_app → div.field
  function fieldWrapperSel(form) {
    if (form.querySelectorAll("div.field-wrapper").length > 0)   return "div.field-wrapper";
    if (form.querySelectorAll("fieldset.ods-fieldset").length > 0) return "fieldset.ods-fieldset";
    return "div.field";
  }

  // ── Fill mode ──────────────────────────────────────────────────────────────
  async function runFill() {
    try {
      showOverlay("⏳ JobWatch: Loading form…");

      // Click Apply button if form is hidden behind it
      const applyBtn = document.querySelector("#apply_button, a[href*='#app'], .apply-button, .cta--emphasis")
        || [...document.querySelectorAll("a, button")].find(el =>
            /^apply(\s+(now|for(\s+this)?\s+job))?$/i.test(el.textContent.trim())
          );
      if (applyBtn) { applyBtn.click(); await sleep(1800); }

      // ── Try to find form directly ───────────────────────────────────────────
      const FORM_SEL = [
        "#application-form",
        "form.application--form",
        "#application_form",
        "#okta-careers-job-form",
        "form.okta-careers-job-form",
        "form[action*='greenhouse']",
        "form[action*='job-boards']",
        "form[action*='embed/job_app']",
      ].join(", ");

      let form = await waitFor(FORM_SEL, 5000);

      // ── No form found — check for Greenhouse iframe (boards pages) ──────────
      if (!form) {
        const IFRAME_SEL = [
          "iframe#grnhse_iframe",
          "iframe#grnhse_app",
          "iframe[src*='greenhouse.io']",
          "iframe[id*='grnhse']",
        ].join(", ");

        showOverlay("⏳ Waiting for Greenhouse iframe…", "#6366f1");
        const iframe = await waitFor(IFRAME_SEL, 8000);

        if (iframe?.src) {
          showOverlay("🔄 Redirecting to embedded form…", "#6366f1");
          chrome.runtime.sendMessage({ type: "GREENHOUSE_FILL_REDIRECT", newUrl: iframe.src }, () => {});
          return; // background navigates tab; greenhouse.js re-runs on embed URL
        }

        showOverlay("⚠️ No form found — try opening the job and clicking Apply manually.", "#f59e0b");
        return;
      }

      // Scrape fields with DOM refs
      const fields = [];
      const seenIds = new Set();
      for (const wrapper of form.querySelectorAll(fieldWrapperSel(form))) {
        const f = scrapeWrapper(wrapper);
        if (f && f.label && !seenIds.has(f.id)) {
          seenIds.add(f.id);
          f._wrapper = wrapper;
          fields.push(f);
        }
      }

      if (!fields.length) {
        showOverlay("⚠️ No fields found in form", "#f59e0b");
        return;
      }

      showOverlay("⏳ JobWatch: Fetching your profile…");

      // Strip DOM refs before sending to background
      const fieldsForApi = fields.map(({ id, label, type, required, options, placeholder, description }) =>
        ({ id, label, type, required, options, placeholder, description })
      );

      const fillData = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: "GET_FILL_DATA", fields: fieldsForApi }, (response) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!response?.ok) return reject(new Error(response?.error || "Could not get fill data"));
          resolve(response);
        });
      });

      const { userDoc, mappings, pendingJob, resumeBase64 } = fillData;

      showOverlay("✍️ JobWatch: Filling form…");
      await sleep(500);

      for (const field of fields) {
        const { id, type, label, _el, _checkboxes } = field;

        if (type === "file") {
          if (_el && resumeBase64 && (id === "resume" || label.toLowerCase().includes("resume"))) {
            await setFileInput(_el, resumeBase64, userDoc?.resumeFileName || "resume.pdf");
          }
          await sleep(300);
          continue;
        }

        if (type === "checkbox") {
          // Check all (policy agreements, multi-select checkboxes)
          if (_checkboxes) {
            for (const cb of _checkboxes) {
              if (!cb.checked) cb.click();
              await sleep(100);
            }
          }
          continue;
        }

        const value = mappings[id];
        if (!value) continue;

        if (type === "select") {
          if (_el && _el.tagName === "SELECT") {
            // Native <select> (Select2 / UDig style) — just set value directly
            const lv = String(value).toLowerCase();
            const opt = [..._el.options].find(o =>
              o.text.trim().toLowerCase() === lv || o.value.toLowerCase() === lv
            ) || [..._el.options].find(o => o.text.trim().toLowerCase().includes(lv));
            if (opt) {
              setNativeValue(_el, opt.value);
              // Trigger Select2 if present
              if (window.jQuery && window.jQuery(_el).trigger) window.jQuery(_el).trigger("change");
            }
            await sleep(150);
          } else {
            await fillCombobox(_el, value);
          }
          continue;
        }

        // Text / email / tel / textarea
        if (_el) {
          setNativeValue(_el, String(value));
          await sleep(150);
        }
      }

      // EEO fields (may live outside field-wrappers)
      const eeoIds = ["gender", "hispanic_ethnicity", "veteran_status", "disability_status"];
      for (const eeoId of eeoIds) {
        const eeoCombobox = form.querySelector(`input#${eeoId}[role=combobox], input[name="${eeoId}"][role=combobox]`);
        if (eeoCombobox) {
          await fillCombobox(eeoCombobox, mappings[eeoId] || "Decline to self-identify");
          await sleep(200);
        }
      }

      showOverlay("🚀 JobWatch: Submitting…");
      await sleep(800);

      const submitBtn =
        form.querySelector("[type=submit]") ||
        document.querySelector("#submit_app, button[type=submit]") ||
        [...document.querySelectorAll("button")].find(b =>
          /submit application|apply now|^submit$/i.test(b.textContent.trim())
        );

      if (submitBtn) {
        submitBtn.click();
        await sleep(2500);

        // Detect form validation errors after submit
        const hasErrors = form.querySelector(
          ".error-message, .field-error, [class*='error']:not([class*='color']), [class*='invalid'], [aria-invalid='true']"
        );
        if (hasErrors) {
          showOverlay("⚠️ Form has errors — please fix and submit manually.", "#f59e0b");
          return;
        }

        showOverlay("✅ Application submitted!", "#10b981");
        chrome.runtime.sendMessage({
          type: "APPLICATION_DONE",
          jobId: pendingJob?.id,
          jobTitle: pendingJob?.title,
          companyName: pendingJob?.companyName,
          status: "submitted",
        });
        setTimeout(() => document.getElementById("jw-overlay")?.remove(), 4000);
      } else {
        showOverlay("⚠️ Submit button not found — please submit manually.", "#f59e0b");
      }

    } catch (err) {
      console.error("[JobWatch Greenhouse]", err);
      showOverlay(`❌ ${err.message}`, "#ef4444");
      setTimeout(() => document.getElementById("jw-overlay")?.remove(), 6000);
    }
  }

})();
