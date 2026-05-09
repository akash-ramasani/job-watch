

// content/ashby.js -- Injected into Ashby application pages.
// Handles: text, email, tel, textarea, file, yes/no buttons, location combobox, radio (EEO)

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
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ── Inject resume file ─────────────────────────────────────────────────────
  async function setFileInput(input, resumeUrl, fileName) {
    try {
      const response = await fetch(resumeUrl);
      const blob = await response.blob();
      const ext = (fileName || "resume.pdf").split(".").pop().toLowerCase();
      const mime = ext === "pdf" ? "application/pdf"
        : ext === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/octet-stream";
      const file = new File([blob], fileName || "resume.pdf", { type: mime });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (e) {
      console.warn("[JobWatch] Resume upload failed:", e.message);
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

  // ── Scrape all form fields and detect their type ───────────────────────────
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
      const input = entry.querySelector("input:not([type=file]):not([role=combobox]), textarea");

      let type;
      if (fileInput) type = "file";
      else if (yesNoEl) type = "yesno";
      else if (combobox || fieldPath === "_systemfield_location") type = "location";
      else type = input?.type || "text";

      fields.push({ id: fieldPath, label, type, required });
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

    const { userDoc, mappings, pendingJob } = fillData;

    showOverlay("✍️ JobWatch: Filling form…");
    await new Promise(r => setTimeout(r, 800));

    for (const field of fields) {
      const entry = form.querySelector(`[data-field-path="${CSS.escape(field.id)}"]`);
      if (!entry) continue;

      // ── File upload ────────────────────────────────────────────────────
      if (field.type === "file") {
        const fileInput = entry.querySelector("input[type=file]");
        if (fileInput && userDoc.resumeUrl) {
          await setFileInput(fileInput, userDoc.resumeUrl, userDoc.resumeFileName || "resume.pdf");
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
        const value = field.id === "_systemfield_location"
          ? (userDoc.city || mappings[field.id] || "")
          : (mappings[field.id] || "");
        await fillLocation(entry, value);
        continue;
      }

      // ── Standard text / email / tel / textarea ─────────────────────────
      const input = entry.querySelector("input:not([type=file]):not([role=combobox]), textarea");
      if (!input) continue;

      if (field.id === "_systemfield_name") {
        setInputValue(input, userDoc.fullName || `${userDoc.firstName || ""} ${userDoc.lastName || ""}`.trim());
        continue;
      }
      if (field.id === "_systemfield_email") {
        setInputValue(input, userDoc.email || "");
        continue;
      }

      const aiValue = mappings[field.id];
      if (aiValue !== undefined && aiValue !== "__FILE__" && String(aiValue).trim() !== "") {
        setInputValue(input, String(aiValue));
        await new Promise(r => setTimeout(r, 150));
      }
    }

    showOverlay("🚀 JobWatch: Submitting…");
    await new Promise(r => setTimeout(r, 800));

    // ── EEO Survey (separate form — always select "Decline to self-identify") ─
    const surveyForm = document.querySelector(".ashby-survey-form-container");
    if (surveyForm) {
      const fieldsets = surveyForm.querySelectorAll("fieldset");
      for (const fieldset of fieldsets) {
        const radios = [...fieldset.querySelectorAll("input[type=radio]")];
        if (!radios.length) continue;
        // "Decline" option is always the last radio in Ashby EEO fields
        const declineRadio = radios[radios.length - 1];
        if (!declineRadio.checked) declineRadio.click();
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
