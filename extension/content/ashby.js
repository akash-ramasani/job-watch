
// content/ashby.js — Injected into Ashby application pages.
// Handles: text, email, tel, textarea, file, yesno, location, radio, checkbox
// Features: AI field mapping · pre-submit validation · error-recovery loop · answer logging

(async function () {

  // ─── Wait for form ────────────────────────────────────────────────────────
  function waitForForm(timeout = 10000) {
    return new Promise((resolve, reject) => {
      const f = document.querySelector(".ashby-application-form-container");
      if (f) return resolve(f);
      const obs = new MutationObserver(() => {
        const f2 = document.querySelector(".ashby-application-form-container");
        if (f2) { obs.disconnect(); resolve(f2); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); reject(new Error("Form not found")); }, timeout);
    });
  }

  // ─── Set React-controlled input value ────────────────────────────────────
  async function setInputValue(fieldId, value) {
    const res = await sendMsg({
      type: "EXEC_MAIN_WORLD",
      action: "setInput",
      id: fieldId,
      value: value
    });
    return res?.result || { ok: false, error: "no result from main world" };
  }

  // ─── Inject resume PDF from base64 ───────────────────────────────────────
  async function setFileInput(fieldId, b64, fileName) {
    try {
      await sendMsg({
        type: "EXEC_MAIN_WORLD",
        action: "setFile",
        id: fieldId,
        b64Data: b64,
        fileName: fileName
      });
      return true;
    } catch (e) {
      console.warn("[JobWatch] Resume inject failed:", e.message);
      return false;
    }
  }

  // ─── Click a Yes/No button ────────────────────────────────────────────────
  function clickYesNo(entry, answer) {
    const container = entry.querySelector("[class*='_yesno_']");
    if (!container) return false;
    const target = (answer || "").toLowerCase().trim();
    const buttons = [...container.querySelectorAll("button")];
    const btn = buttons.find(b => b.textContent.trim().toLowerCase() === target)
      || buttons[target === "yes" ? 0 : 1];
    if (btn) { btn.click(); return true; }
    return false;
  }

  // ─── Fill location combobox (polls instead of fixed wait) ────────────────
  async function fillLocation(entry, value) {
    const box = entry.querySelector("input[role='combobox']") || entry.querySelector("input");
    if (!box || !value) return;
    await setInputValue(entry.dataset.fieldPath, value);
    box.focus();
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    let option = null;
    for (let i = 0; i < 18; i++) {
      await new Promise(r => setTimeout(r, 100));
      option = document.querySelector("[role='option']")
        || document.querySelector("[class*='_suggestion_']")
        || document.querySelector("[class*='_listItem_']");
      if (option) break;
    }
    if (option) option.click();
    else box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
  }

  // ─── Get visible label for a radio/checkbox input ────────────────────────
  function getInputLabel(input, scope) {
    const parent = input.closest("label");
    if (parent) {
      const c = parent.cloneNode(true);
      c.querySelectorAll("input").forEach(i => i.remove());
      return c.textContent.trim();
    }
    if (input.id) {
      const assoc = (scope || document).querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (assoc) return assoc.textContent.trim();
    }
    return input.value || "";
  }

  // ─── Fuzzy radio matcher ──────────────────────────────────────────────────
  function findBestRadio(radios, scope, profileValue) {
    if (!profileValue) return radios[radios.length - 1];
    const pv = profileValue.toLowerCase().trim();
    if (pv.includes("decline")) return radios[radios.length - 1];
    const lbl = r => getInputLabel(r, scope).toLowerCase().trim();
    return (
      radios.find(r => lbl(r) === pv) ||
      radios.find(r => lbl(r).startsWith(pv)) ||
      radios.find(r => lbl(r).includes(pv)) ||
      radios.find(r => pv.split(/\s+/).filter(w => w.length > 4).every(w => lbl(r).includes(w))) ||
      (() => {
        const words = pv.split(/\s+/).filter(w => w.length > 1);
        let best = 0, bestR = null;
        for (const r of radios) {
          const score = words.filter(w => lbl(r).includes(w)).length;
          if (score > best) { best = score; bestR = r; }
        }
        return best > 0 ? bestR : radios[radios.length - 1];
      })()
    );
  }

  // ─── Scrape ALL fields (including fieldset checkboxes) ───────────────────
  function scrapeFields(form) {
    const fields = [];

    // 1. Standard .ashby-application-form-field-entry fields
    for (const entry of form.querySelectorAll(".ashby-application-form-field-entry")) {
      const id = entry.dataset.fieldPath || "";
      const labelEl = entry.querySelector("label.ashby-application-form-question-title");
      const label = labelEl ? labelEl.textContent.trim().replace(/\s*\*\s*$/, "") : "";
      const required = !!(labelEl?.classList.contains("_required_101oc_92") || entry.querySelector("[required]"));

      const fileInput = entry.querySelector("input[type=file]");
      const yesNoEl = entry.querySelector("[class*='_yesno_']");
      const combobox = entry.querySelector("input[role='combobox']");
      const radioEl = entry.querySelector("input[type=radio]");
      const inputEl = entry.querySelector("input:not([type=file]):not([role=combobox]):not([type=radio]):not([type=checkbox]), textarea");

      let type;
      if (fileInput) type = "file";
      else if (yesNoEl) type = "yesno";
      else if (combobox || id === "_systemfield_location") type = "location";
      else if (radioEl) type = "radio";
      else type = inputEl?.type || "text";

      const field = { id, label, type, required };
      if (type === "radio") {
        field.options = [...entry.querySelectorAll("input[type=radio]")]
          .map(r => ({ label: getInputLabel(r, entry), value: r.value || getInputLabel(r, entry) }));
      }
      fields.push(field);
    }

    // 2. Fieldset-based fields (checkboxes & EEO radios NOT inside field-entry)
    for (const wrapper of form.querySelectorAll("[data-field-path]")) {
      if (wrapper.classList.contains("ashby-application-form-field-entry")) continue; // already handled
      const id = wrapper.dataset.fieldPath || "";
      if (!id) continue;
      const fs = wrapper.querySelector("fieldset");
      if (!fs) continue;
      const labelEl = fs.querySelector("label.ashby-application-form-question-title");
      const label = labelEl ? labelEl.textContent.trim().replace(/\s*\*\s*$/, "") : "";
      const required = !!(labelEl?.classList.contains("_required_101oc_92"));

      const radios = [...fs.querySelectorAll("input[type=radio]")];
      const checkboxes = [...fs.querySelectorAll("input[type=checkbox]")];

      if (radios.length) {
        fields.push({
          id, label, type: "radio", required,
          options: radios.map(r => ({ label: getInputLabel(r, fs), value: r.value || getInputLabel(r, fs) })),
        });
      } else if (checkboxes.length) {
        fields.push({
          id, label, type: "checkbox", required,
          options: checkboxes.map(cb => ({ label: getInputLabel(cb, fs), inputId: cb.id })),
        });
      }
    }

    return fields;
  }

  // ─── Read Ashby's validation error list ──────────────────────────────────
  function scrapeFormErrors(form) {
    const container = document.querySelector(
      "._errorsContainer_135ul_78, [class*='_errorsContainer_'], [role='alert'][aria-live]"
    );
    if (!container) return [];
    return [...container.querySelectorAll("li, [class*='_error_135ul']")]
      .map(li => li.textContent.trim())
      .filter(Boolean);
  }

  // ─── Apply a mappings object to the form ─────────────────────────────────
  async function applyMappings(form, fields, mappings, userDoc, pendingJob, resumeBase64, answersLog) {
    for (const field of fields) {
      const entry = form.querySelector(`[data-field-path="${CSS.escape(field.id)}"]`);
      if (!entry) continue;

      // FILE
      if (field.type === "file") {
        if (resumeBase64) {
          const ok = await setFileInput(field.id, resumeBase64, userDoc.resumeFileName || "resume.pdf");
          if (ok) answersLog[field.id] = { label: field.label, answer: userDoc.resumeFileName || "resume.pdf", type: "file" };
        }
        continue;
      }

      // CHECKBOX — auto-check all required checkboxes (always legal agreements)
      if (field.type === "checkbox") {
        const checkboxes = [...entry.querySelectorAll("input[type=checkbox]")];
        const checked = [];
        for (const cb of checkboxes) {
          if (!cb.checked) { cb.click(); await new Promise(r => setTimeout(r, 100)); }
          checked.push(getInputLabel(cb, entry) || "acknowledged");
        }
        if (checked.length) answersLog[field.id] = { label: field.label, answer: checked.join("; "), type: "checkbox" };
        continue;
      }

      // YESNO
      if (field.type === "yesno") {
        const answer = mappings[field.id];
        if (answer) {
          const ok = clickYesNo(entry, answer);
          if (ok) answersLog[field.id] = { label: field.label, answer, type: "yesno" };
          await new Promise(r => setTimeout(r, 200));
        }
        continue;
      }

      // LOCATION
      if (field.type === "location") {
        const value = mappings[field.id]
          || (field.id === "_systemfield_location" ? (pendingJob?.locationName || userDoc.city) : "")
          || "";
        if (value) {
          await fillLocation(entry, value);
          answersLog[field.id] = { label: field.label, answer: value, type: "location" };
        }
        continue;
      }

      // RADIO
      if (field.type === "radio") {
        let answer = mappings[field.id];
        if (!answer && pendingJob?.locationName) {
          const lbl = field.label.toLowerCase();
          if (lbl.includes("location") || lbl.includes("office") || lbl.includes("which city") ||
            lbl.includes("interested in") || lbl.includes("which site")) {
            answer = pendingJob.locationName;
          }
        }
        if (answer) {
          const radios = [...entry.querySelectorAll("input[type=radio]")];
          const target = findBestRadio(radios, entry, answer);
          if (target && !target.checked) {
            target.click();
            answersLog[field.id] = { label: field.label, answer: getInputLabel(target, entry), type: "radio" };
            await new Promise(r => setTimeout(r, 200));
          }
        }
        continue;
      }

      // TEXT / EMAIL / TEL / TEXTAREA
      const input = entry.querySelector("input:not([type=file]):not([role=combobox]):not([type=radio]):not([type=checkbox]), textarea");
      if (!input) continue;

      let value = null;
      if (field.id === "_systemfield_name") {
        value = userDoc.fullName || `${userDoc.firstName || ""} ${userDoc.lastName || ""}`.trim();
      } else if (field.id === "_systemfield_email") {
        value = userDoc.email || "";
      } else {
        const ai = mappings[field.id];
        if (ai !== undefined && ai !== "__FILE__" && String(ai).trim()) value = String(ai).trim();
      }

      if (value) {
        const fillResult = await setInputValue(field.id, value);

        // Verification step (requested by user): Verify the MAIN world actually accepted it
        if (!fillResult?.ok) {
          console.error("[JobWatch] Fill failed verification in Main World", {
            fieldId: field.id,
            label: field.label,
            expected: value,
            actual: fillResult?.actual || "",
            error: fillResult?.error
          });
        } else {
          answersLog[field.id] = { label: field.label, answer: value, type: field.type };
        }
      }
    }
  }

  // ─── Fill EEO survey (separate container) ────────────────────────────────
  async function fillEEOSurvey(userDoc, answersLog) {
    const survey = document.querySelector(".ashby-survey-form-container");
    if (!survey) return;
    const map = {
      "_systemfield_eeoc_gender": userDoc.eeoGender,
      "_systemfield_eeoc_race": userDoc.eeoEthnicity,
      "_systemfield_eeoc_veteran_status": userDoc.eeoVeteran,
      "_systemfield_eeoc_disability": userDoc.eeoDisability,
      "_systemfield_eeoc_disability_status": userDoc.eeoDisability,
    };
    for (const [path, val] of Object.entries(map)) {
      const el = survey.querySelector(`[data-field-path="${CSS.escape(path)}"]`);
      if (!el) continue;
      const radios = [...el.querySelectorAll("input[type=radio]")];
      if (!radios.length) continue;
      const radio = findBestRadio(radios, el, val);
      if (radio && !radio.checked) {
        radio.click();
        answersLog[path] = { label: path.replace(/_systemfield_eeoc_/, "EEO "), answer: getInputLabel(radio, el), type: "eeo" };
      }
      await new Promise(r => setTimeout(r, 150));
    }
  }

  // ─── Return list of required fields that are still empty ─────────────────
  function getUnfilledRequired(form, fields) {
    const missing = [];
    for (const field of fields) {
      if (!field.required) continue;
      const entry = form.querySelector(`[data-field-path="${CSS.escape(field.id)}"]`);
      if (!entry) continue;

      if (field.type === "file") {
        const fi = entry.querySelector("input[type=file]");
        if (fi && (!fi.files || fi.files.length === 0)) missing.push(field);
      } else if (field.type === "radio") {
        if (!entry.querySelector("input[type=radio]:checked")) missing.push(field);
      } else if (field.type === "location") {
        const box = entry.querySelector("input[role='combobox']") || entry.querySelector("input");
        if (!box?.value?.trim()) missing.push(field);
      } else if (field.type === "yesno" || field.type === "checkbox") {
        // Difficult to verify from DOM; trust that our click registered
      } else {
        const input = entry.querySelector("input:not([type=file]):not([type=radio]):not([type=checkbox]):not([role=combobox]), textarea");
        if (input && !input.value?.trim()) missing.push(field);
      }
    }
    return missing;
  }

  // ─── Overlay UI ──────────────────────────────────────────────────────────
  function showOverlay(text, color = "#4f46e5") {
    let el = document.getElementById("jw-overlay");
    if (!el) {
      el = Object.assign(document.createElement("div"), { id: "jw-overlay" });
      el.style.cssText = [
        "position:fixed", "bottom:24px", "right:24px", "z-index:99999",
        "color:white", "font-family:system-ui,sans-serif", "font-size:13px",
        "font-weight:600", "padding:12px 18px", "border-radius:12px",
        "box-shadow:0 8px 32px rgba(0,0,0,0.2)", "display:flex",
        "align-items:center", "gap:8px", "max-width:320px", "transition:background 0.3s",
      ].join(";");
      document.body.appendChild(el);
    }
    el.style.background = color;
    el.textContent = text;
  }
  function removeOverlay() { document.getElementById("jw-overlay")?.remove(); }

  // ─── Send message to background (promisified) ─────────────────────────────
  function sendMsg(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res?.ok) return reject(new Error(res?.error || "Background error"));
        resolve(res);
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MAIN
  // ─────────────────────────────────────────────────────────────────────────
  try {
    const form = await waitForForm();
    const fields = scrapeFields(form);
    if (!fields.length) return;

    const answersLog = {}; // { fieldId: { label, answer, type } }

    showOverlay("⏳ JobWatch: Fetching your profile…");
    const fillData = await sendMsg({ type: "GET_FILL_DATA", fields });
    const { userDoc, mappings, pendingJob, resumeBase64 } = fillData;

    showOverlay("✍️ JobWatch: Filling form…");
    await new Promise(r => setTimeout(r, 600));
    await applyMappings(form, fields, mappings, userDoc, pendingJob, resumeBase64, answersLog);
    await fillEEOSurvey(userDoc, answersLog);

    // ── Pre-submit: fix any still-empty required fields ───────────────────
    showOverlay("🔍 JobWatch: Verifying required fields…");
    await new Promise(r => setTimeout(r, 400));
    const preCheck = getUnfilledRequired(form, fields);

    if (preCheck.length) {
      showOverlay(`🤖 AI filling ${preCheck.length} missing field(s)…`);
      try {
        const retry = await sendMsg({ type: "GET_FILL_DATA", fields: preCheck });
        await applyMappings(form, preCheck, retry.mappings, userDoc, pendingJob, resumeBase64, answersLog);
        await new Promise(r => setTimeout(r, 400));
      } catch (e) { console.warn("[JobWatch] Pre-submit retry error:", e.message); }

      const stillEmpty = getUnfilledRequired(form, fields);
      if (stillEmpty.length) {
        showOverlay(`⚠️ Complete manually: ${stillEmpty.map(f => f.label).join(", ")}`, "#f59e0b");
        console.warn("[JobWatch] Still missing:", stillEmpty);
        return;
      }
    }

    // ── Find submit button ────────────────────────────────────────────────
    const submitBtn =
      document.querySelector(".ashby-application-form-submit-button") ||
      form.closest("form")?.querySelector("[type=submit]") ||
      document.querySelector("[type=submit]") ||
      [...document.querySelectorAll("button")].find(b => /submit application|apply/i.test(b.textContent));

    if (!submitBtn) {
      showOverlay("⚠️ Submit button not found — please submit manually.", "#f59e0b");
      return;
    }

    // ── Submit loop with error-recovery (up to 2 retries) ────────────────
    const MAX_RETRIES = 2;
    let submitted = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      showOverlay(attempt === 0 ? "🚀 JobWatch: Submitting…" : `🔄 Retrying submission (${attempt}/${MAX_RETRIES})…`);
      console.log("[JobWatch] Submitting. answersLog:", JSON.stringify(answersLog, null, 2));
      submitBtn.click();
      await new Promise(r => setTimeout(r, 2200));

      const formErrors = scrapeFormErrors(form);

      if (!formErrors.length) {
        // Double-check with generic error indicators
        const hasIndicators = !!document.querySelector(
          "[class*='_errorsContainer_'], [aria-invalid='true'], [class*='_error_135ul_78']"
        );
        if (!hasIndicators) { submitted = true; break; }
      }

      if (attempt < MAX_RETRIES && formErrors.length) {
        showOverlay(`🤖 AI resolving ${formErrors.length} error(s)…`, "#7c3aed");
        console.warn("[JobWatch] Submission errors:", formErrors);

        // Match error labels → fields
        const errorLabels = formErrors
          .map(e => e.replace(/missing entry for required field:/i, "").trim().toLowerCase())
          .filter(Boolean);

        const errorFields = errorLabels.length
          ? fields.filter(f => errorLabels.some(lbl =>
            f.label.toLowerCase().includes(lbl) || lbl.includes(f.label.toLowerCase())))
          : fields.filter(f => f.required);

        try {
          const errRetry = await sendMsg({
            type: "GET_FILL_DATA",
            fields: errorFields,
            errorContext: formErrors, // AI sees the exact error messages
          });
          await applyMappings(form, errorFields, errRetry.mappings, userDoc, pendingJob, resumeBase64, answersLog);
          await fillEEOSurvey(userDoc, answersLog);
          await new Promise(r => setTimeout(r, 500));
        } catch (e) { console.warn("[JobWatch] Error-recovery retry failed:", e.message); }
      }
    }

    if (!submitted) {
      showOverlay("⚠️ Form has errors — please fix and resubmit manually.", "#f59e0b");
      return;
    }

    // ── Success ───────────────────────────────────────────────────────────
    showOverlay("✅ Application submitted!", "#10b981");

    chrome.runtime.sendMessage({
      type: "APPLICATION_DONE",
      jobId: pendingJob?.id,
      jobTitle: pendingJob?.title,
      companyName: pendingJob?.companyName,
      status: "submitted",
      answersLog,  // ← full record of every question + answer
    });

    setTimeout(removeOverlay, 4000);

  } catch (err) {
    console.error("[JobWatch Extension]", err);
    showOverlay(`❌ ${err.message}`, "#ef4444");
    setTimeout(removeOverlay, 6000);
  }

})();
