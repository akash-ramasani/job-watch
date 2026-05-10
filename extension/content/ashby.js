

// content/ashby.js -- Injected into Ashby application pages.
// Handles: text, email, tel, textarea, file, yes/no buttons, location combobox, radio

(async function () {
  // ── Wait for form ──────────────────────────────────────────────────────────
  function waitForForm(timeout = 10000) {
    return new Promise((resolve, reject) => {
      const form = document.querySelector(".ashby-application-form-container");
      if (form) return resolve(form);
      const observer = new MutationObserver(() => {
        const f = document.querySelector(".ashby-application-form-container");
        if (f) { observer.disconnect(); resolve(f); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { observer.disconnect(); reject(new Error("Form not found")); }, timeout);
    });
  }

  // ── Set React-controlled input value ──────────────────────────────────────
  function setInputValue(el, value) {
    const proto = el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (nativeSetter) nativeSetter.call(el, value);
    else el.value = value;
    // InputEvent with inputType is more realistic than a plain Event and works
    // better with React Hook Form / Ashby's internal form state tracking.
    el.dispatchEvent(new InputEvent("input",  { bubbles: true, cancelable: true, inputType: "insertText", data: value }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur",   { bubbles: true }));
  }

  // ── Inject resume file from base64 (fetched by background to avoid CORS) ───
  async function setFileInput(input, resumeBase64, fileName) {
    try {
      const name = fileName || "resume.pdf";
      const ext = name.split(".").pop().toLowerCase();
      const mime = ext === "pdf" ? "application/pdf"
        : ext === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/octet-stream";

      // Decode base64 → Uint8Array → Blob → File
      const binary = atob(resumeBase64);
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

  // ── Click a Yes/No button ──────────────────────────────────────────────────
  function clickYesNo(entry, answer) {
    const container = entry.querySelector("[class*='_yesno_']");
    if (!container) return;
    const target = (answer || "").toLowerCase().trim();
    const buttons = [...container.querySelectorAll("button")];
    const btn = buttons.find(b => b.textContent.trim().toLowerCase() === target)
      || buttons[target === "yes" ? 0 : 1];
    if (btn) btn.click();
  }

  // ── Fill location combobox ─────────────────────────────────────────────────
  async function fillLocation(entry, value) {
    const combobox = entry.querySelector("input[role='combobox']") || entry.querySelector("input");
    if (!combobox || !value) return;
    setInputValue(combobox, value);
    combobox.focus();
    combobox.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await new Promise(r => setTimeout(r, 900));
    // Try clicking first dropdown suggestion
    const option = document.querySelector("[role='option']")
      || document.querySelector("[class*='_suggestion_']")
      || document.querySelector("[class*='_listItem_']");
    if (option) option.click();
    else combobox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
  }

  // ── Get the visible label text for a radio input ──────────────────────────
  function getRadioLabel(radio, entry) {
    const parentLabel = radio.closest("label");
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll("input").forEach(i => i.remove());
      return clone.textContent.trim();
    }
    if (radio.id) {
      const assoc = entry.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
      if (assoc) return assoc.textContent.trim();
    }
    return radio.value || "";
  }

  // ── Find best radio match for a profile value (fuzzy) ─────────────────────
  function findBestRadio(radios, container, profileValue) {
    if (!profileValue) return radios[radios.length - 1];
    const pv = profileValue.toLowerCase().trim();

    // "Decline" variant → Ashby always puts it last
    if (pv.includes("decline")) return radios[radios.length - 1];

    // 1. Exact match
    let r = radios.find(radio => getRadioLabel(radio, container).toLowerCase().trim() === pv);
    if (r) return r;

    // 2. Form label starts with profile value ("Asian" → "Asian (Not Hispanic or Latino)")
    r = radios.find(radio => getRadioLabel(radio, container).toLowerCase().trim().startsWith(pv));
    if (r) return r;

    // 3. Form label contains profile value
    r = radios.find(radio => getRadioLabel(radio, container).toLowerCase().includes(pv));
    if (r) return r;

    // 4. All significant words (>4 chars) from profile appear in form label
    const words = pv.split(/\s+/).filter(w => w.length > 4);
    if (words.length) {
      r = radios.find(radio => {
        const lbl = getRadioLabel(radio, container).toLowerCase();
        return words.every(w => lbl.includes(w));
      });
      if (r) return r;
    }

    // 5. Score by how many words from the answer appear in each label (best-of)
    const allWords = pv.split(/\s+/).filter(w => w.length > 1);
    if (allWords.length) {
      let bestScore = 0, bestRadio = null;
      for (const radio of radios) {
        const lbl = getRadioLabel(radio, container).toLowerCase();
        const score = allWords.filter(w => lbl.includes(w)).length;
        if (score > bestScore) { bestScore = score; bestRadio = radio; }
      }
      if (bestScore > 0) return bestRadio;
    }

    return radios[radios.length - 1]; // fallback: decline
  }


  function scrapeFields(form) {
    const entries = form.querySelectorAll(".ashby-application-form-field-entry");
    const fields = [];
    for (const entry of entries) {
      const fieldPath = entry.dataset.fieldPath || "";
      const labelEl = entry.querySelector("label");
      const label = labelEl ? labelEl.textContent.trim().replace(/\s*\*\s*$/, "") : "";
      const required = !!entry.querySelector("label._required_101oc_92, [required]");

      const fileInput = entry.querySelector("input[type=file]");
      const yesNoEl = entry.querySelector("[class*='_yesno_']");
      const combobox = entry.querySelector("input[role='combobox']");
      const radioEl = entry.querySelector("input[type=radio]");
      const input = entry.querySelector("input:not([type=file]):not([role=combobox]):not([type=radio]), textarea");

      let type;
      if (fileInput) type = "file";
      else if (yesNoEl) type = "yesno";
      else if (combobox || fieldPath === "_systemfield_location") type = "location";
      else if (radioEl) type = "radio";
      else type = input?.type || "text";

      const field = { id: fieldPath, label, type, required };

      // Capture radio options so the AI knows what values are available
      if (type === "radio") {
        const radioInputs = [...entry.querySelectorAll("input[type=radio]")];
        field.options = radioInputs.map(r => ({
          label: getRadioLabel(r, entry),
          value: r.value || getRadioLabel(r, entry),
        }));
      }

      fields.push(field);
    }
    return fields;
  }

  // ── Overlay UI ─────────────────────────────────────────────────────────────
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
        "display:flex", "align-items:center", "gap:8px", "max-width:300px",
        "transition:background 0.3s",
      ].join(";");
      document.body.appendChild(el);
    }
    el.style.background = color;
    el.textContent = text;
  }
  function removeOverlay() { document.getElementById("jw-overlay")?.remove(); }

  // ── Main ───────────────────────────────────────────────────────────────────
  try {
    const form = await waitForForm();
    const fields = scrapeFields(form);
    if (!fields.length) return;

    showOverlay("⏳ JobWatch: Fetching your profile…");

    const fillData = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "GET_FILL_DATA", fields }, (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!response?.ok) return reject(new Error(response?.error || "Could not get fill data"));
        resolve(response);
      });
    });

    const { userDoc, mappings, pendingJob, resumeBase64 } = fillData;

    showOverlay("✍️ JobWatch: Filling form…");
    await new Promise(r => setTimeout(r, 800));

    for (const field of fields) {
      const entry = form.querySelector(`[data-field-path="${CSS.escape(field.id)}"]`);
      if (!entry) continue;

      // ── File upload ────────────────────────────────────────────────────
      if (field.type === "file") {
        const fileInput = entry.querySelector("input[type=file]");
        if (fileInput && resumeBase64) {
          await setFileInput(fileInput, resumeBase64, userDoc.resumeFileName || "resume.pdf");
        }
        continue;
      }

      // ── Yes/No buttons ─────────────────────────────────────────────────
      if (field.type === "yesno") {
        const answer = mappings[field.id];
        if (answer) clickYesNo(entry, answer);
        await new Promise(r => setTimeout(r, 200));
        continue;
      }

      // ── Location combobox ──────────────────────────────────────────────
      if (field.type === "location") {
        const value = mappings[field.id] || (field.id === "_systemfield_location" ? userDoc.city : "") || "";
        await fillLocation(entry, value);
        continue;
      }

      // ── Radio buttons ─────────────────────────────────────────────────
      if (field.type === "radio") {
        let answer = mappings[field.id];
        // For office/location radio questions, job location from Firestore is ground truth
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
            await new Promise(r => setTimeout(r, 200));
          }
        }
        continue;
      }

      // ── Standard text / email / tel / textarea ─────────────────────────
      const input = entry.querySelector("input:not([type=file]):not([role=combobox]), textarea");
      if (!input) continue;

      if (field.id === "_systemfield_name") {
        setInputValue(input, userDoc.fullName || `${userDoc.firstName || ""} ${userDoc.lastName || ""}`.trim());
        await new Promise(r => setTimeout(r, 200));
        continue;
      }
      if (field.id === "_systemfield_email") {
        setInputValue(input, userDoc.email || "");
        await new Promise(r => setTimeout(r, 200));
        continue;
      }

      const aiValue = mappings[field.id];
      if (aiValue !== undefined && aiValue !== "__FILE__" && String(aiValue).trim() !== "") {
        setInputValue(input, String(aiValue));
        await new Promise(r => setTimeout(r, 150));
      }
    }

    showOverlay("🔍 JobWatch: Verifying fields…");
    await new Promise(r => setTimeout(r, 500));

    // Pre-submit validation: abort if any required text/file fields are still empty
    const missingFields = [];
    for (const field of fields) {
      if (!field.required) continue;
      const entry = form.querySelector(`[data-field-path="${CSS.escape(field.id)}"]`);
      if (!entry) continue;

      if (field.type === "file") {
        const fi = entry.querySelector("input[type=file]");
        if (fi && (!fi.files || fi.files.length === 0)) missingFields.push(field.label);
      } else if (!["yesno", "radio", "location"].includes(field.type)) {
        const input = entry.querySelector("input:not([type=file]):not([type=radio]):not([role=combobox]), textarea");
        if (input && !input.value?.trim()) missingFields.push(field.label);
      }
    }
    if (missingFields.length > 0) {
      showOverlay(`⚠️ ${missingFields.length} required field(s) not filled — please fill manually and submit.`, "#f59e0b");
      console.warn("[JobWatch] Missing required fields:", missingFields);
      return;
    }

    showOverlay("🚀 JobWatch: Submitting…");
    await new Promise(r => setTimeout(r, 800));

    // ── EEO Survey (separate container — use profile EEO values) ──────────────
    const surveyForm = document.querySelector(".ashby-survey-form-container");
    if (surveyForm) {
      const eeoValues = {
        "_systemfield_eeoc_gender":         userDoc.eeoGender,
        "_systemfield_eeoc_race":           userDoc.eeoEthnicity,
        "_systemfield_eeoc_veteran_status": userDoc.eeoVeteran,
        "_systemfield_eeoc_disability":     userDoc.eeoDisability,
      };
      for (const [fieldPath, profileValue] of Object.entries(eeoValues)) {
        const fieldEl = surveyForm.querySelector(`[data-field-path="${CSS.escape(fieldPath)}"]`);
        if (!fieldEl) continue;
        const radios = [...fieldEl.querySelectorAll("input[type=radio]")];
        if (!radios.length) continue;
        const radio = findBestRadio(radios, fieldEl, profileValue);
        if (radio && !radio.checked) radio.click();
        await new Promise(r => setTimeout(r, 150));
      }
    }

    await new Promise(r => setTimeout(r, 500));

    // Ashby's submit button has a specific class; fall back to generic selectors
    const submitBtn = document.querySelector(".ashby-application-form-submit-button")
      || form.closest("form")?.querySelector("[type=submit]")
      || document.querySelector("[type=submit]")
      || [...document.querySelectorAll("button")].find(b => /submit application|apply/i.test(b.textContent));

    if (submitBtn) {
      submitBtn.click();
      await new Promise(r => setTimeout(r, 2500));

      // Detect validation errors after submit
      const hasErrors = document.querySelector(
        "[class*='_error_'], [class*='_invalid_'], [aria-invalid='true'], .ashby-application-form-field-entry [class*='error']"
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
      setTimeout(removeOverlay, 4000);
    } else {
      showOverlay("⚠️ Submit button not found — please submit manually.", "#f59e0b");
    }

  } catch (err) {
    console.error("[JobWatch Extension]", err);
    showOverlay(`❌ ${err.message}`, "#ef4444");
    setTimeout(removeOverlay, 5000);
  }

})();

