// content/ashby-audit.js — Injected programmatically into Ashby application pages during audit.
// Only scrapes form fields; never fills or submits anything.

(async function () {
  const MAX_WAIT = 28000;

  // Resolve as soon as we can find either the Ashby form container or at least
  // one field entry anywhere on the page. Falls back to document.body so the
  // scraper can still collect whatever is present.
  function waitForForm() {
    return new Promise((resolve, reject) => {
      const CONTAINERS = [
        ".ashby-application-form-container",
        "[class*='applicationForm']",
        "[class*='ApplicationForm']",
        "form[class*='application']",
        ".ashby-application-form",
      ];
      const check = () => {
        for (const sel of CONTAINERS) {
          const el = document.querySelector(sel);
          if (el) return el;
        }
        // Fall back: if field entries exist anywhere, use body as container
        if (document.querySelector(".ashby-application-form-field-entry")) return document.body;
        return null;
      };
      const found = check();
      if (found) return resolve(found);
      const obs = new MutationObserver(() => {
        const f = check();
        if (f) { obs.disconnect(); resolve(f); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      // Scroll a couple times to trigger lazy-load
      setTimeout(() => window.scrollTo(0, 300), 2000);
      setTimeout(() => window.scrollTo(0, 0), 4000);
      setTimeout(() => {
        obs.disconnect();
        // Last-chance: if field entries now exist, use them
        if (document.querySelector(".ashby-application-form-field-entry")) {
          resolve(document.body);
        } else {
          reject(new Error(`Form not found after ${MAX_WAIT}ms`));
        }
      }, MAX_WAIT);
    });
  }

  function getFieldLabel(entry) {
    // Grab first label that is a direct field label (not an option label)
    const lbl = entry.querySelector("label:not([class*='_option_']):not([class*='_checkboxLabel_'])");
    return lbl ? lbl.textContent.trim().replace(/\s*\*\s*$/, "").trim() : "";
  }

  function getDescription(entry) {
    const el = entry.querySelector(
      "[class*='_description_'], [class*='_hint_'], [class*='_helpText_'], [class*='_subLabel_']"
    );
    return el ? el.textContent.trim() : "";
  }

  function isRequired(entry) {
    return !!(
      entry.querySelector("[aria-required='true'], [required]") ||
      entry.querySelector("label[class*='_required_']")
    );
  }

  function scrapeEntry(entry) {
    const id = entry.dataset.fieldPath || "";
    const label = getFieldLabel(entry);
    const description = getDescription(entry);
    const required = isRequired(entry);
    let type = "text", options = [], placeholder = "";

    const fileInput  = entry.querySelector("input[type='file']");
    const yesNoEl    = entry.querySelector("[class*='_yesno_'], [class*='_toggleButton_']");
    const dateEl     = entry.querySelector(".react-datepicker-wrapper input, input[type='date']");
    const checkboxes = [...entry.querySelectorAll("input[type='checkbox']")];
    const radios     = [...entry.querySelectorAll("input[type='radio']")];
    const selectEl   = entry.querySelector("select");
    const combobox   = entry.querySelector("input[role='combobox']");
    const textarea   = entry.querySelector("textarea");
    const textInput  = entry.querySelector(
      "input:not([type='file']):not([role='combobox']):not([type='date']):not([type='checkbox']):not([type='radio'])"
    );

    if (fileInput) {
      type = "file";
      placeholder = fileInput.accept || "";
    } else if (yesNoEl) {
      type = "yesno";
      const btns = yesNoEl.tagName === "BUTTON"
        ? [yesNoEl, ...yesNoEl.parentElement?.querySelectorAll("button") || []]
        : [...yesNoEl.querySelectorAll("button")];
      options = [...new Set(btns.map(b => b.textContent.trim()).filter(Boolean))];
      if (!options.length) options = ["Yes", "No"];
    } else if (dateEl) {
      type = "date";
      placeholder = dateEl.placeholder || "MM/DD/YYYY";
    } else if (checkboxes.length > 1) {
      // Multi-select: multiple checkboxes in one field
      type = "multiselect";
      options = checkboxes.map(cb => {
        const wrap = cb.closest("label");
        if (wrap) return wrap.textContent.trim().replace(/\s+/g, " ");
        const sib = cb.nextElementSibling;
        return sib ? sib.textContent.trim() : "";
      }).filter(Boolean);
    } else if (checkboxes.length === 1) {
      // Single checkbox = agreement / mark-done
      type = "checkbox";
      const wrap = checkboxes[0].closest("label");
      if (wrap) options = [wrap.textContent.trim().replace(/\s+/g, " ")];
      else {
        const span = checkboxes[0].nextElementSibling;
        if (span) options = [span.textContent.trim()];
      }
    } else if (radios.length > 0) {
      type = "radio";
      options = radios.map(r => {
        const wrap = r.closest("label");
        if (wrap) return wrap.textContent.trim().replace(/\s+/g, " ");
        const lbl = entry.querySelector(`label[for="${r.id}"]`);
        return lbl ? lbl.textContent.trim() : (r.value || "");
      }).filter(Boolean);
    } else if (selectEl) {
      type = "select";
      placeholder = selectEl.options[0]?.text.trim() || "";
      options = [...selectEl.options]
        .map(o => o.text.trim())
        .filter((t, i) => t && i > 0); // skip first placeholder option
    } else if (combobox || id === "_systemfield_location") {
      type = "location";
      placeholder = combobox?.placeholder || "";
    } else if (textarea) {
      type = "textarea";
      placeholder = textarea.placeholder || "";
    } else if (textInput) {
      type = textInput.type || "text";
      placeholder = textInput.placeholder || "";
    }

    return { id, label, type, required, description, placeholder, options };
  }

  function scrapeAllFields(container) {
    const entries = container.querySelectorAll(".ashby-application-form-field-entry");
    return [...entries].map(scrapeEntry).filter(f => f.label || f.id);
  }

  try {
    const form = await waitForForm();
    const fields = scrapeAllFields(form);

    // Pick up EEO survey fields if rendered below the main form
    const survey = document.querySelector(".ashby-survey-form-container");
    if (survey) {
      // fieldsets for EEO radio groups
      const fieldsets = survey.querySelectorAll("fieldset");
      for (const fs of fieldsets) {
        const legend = fs.querySelector("legend");
        const label = legend ? legend.textContent.trim() : "";
        if (!label) continue;
        const radios = [...fs.querySelectorAll("input[type='radio']")];
        const options = radios.map(r => {
          const wrap = r.closest("label");
          return wrap ? wrap.textContent.trim() : r.value;
        }).filter(Boolean);
        fields.push({
          id: `_eeo_${label.toLowerCase().replace(/\s+/g, "_")}`,
          label,
          type: "radio",
          required: false,
          description: "EEO Survey",
          placeholder: "",
          options,
        });
      }
      // Also try standard field entries inside survey
      const surveyEntries = survey.querySelectorAll(".ashby-application-form-field-entry");
      for (const entry of surveyEntries) {
        const f = scrapeEntry(entry);
        if (f.label || f.id) fields.push(f);
      }
    }

    chrome.runtime.sendMessage({ type: "ASHBY_AUDIT_DATA", fields });
  } catch (err) {
    chrome.runtime.sendMessage({ type: "ASHBY_AUDIT_DATA", error: err.message, fields: [] });
  }
})();
