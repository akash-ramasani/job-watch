
// content/ashby.js — Injected into Ashby application pages.
// Flow (2026-10-09): scan the form with lib/ashby-dom.js (stable Ashby class
// names), ask the background for the computed application
// (prepareAshbyApplication: answer engine + per-question AI + cover letter PDF),
// fill by field path, rescan, and tell the person exactly what is left. The
// older label-regex mapper below (legacyMain) runs only if that fails.

(async function () {

  // ─── Extract Ashby form schema ────────────────────────────────────────────
  // Returns a Map<fieldPath, { type, title, required, options }>
  // Primary source: Ashby's public GraphQL endpoint (the page's __appData no
  // longer embeds fieldEntries — form audit 2026-08-26). Falls back to the
  // legacy MAIN-world __appData extraction, then to pure DOM scraping.
  async function extractAshbySchema() {
    const schemaMap = new Map();
    try {
      const m = location.href.match(/ashbyhq\.com\/([^/]+)\/([0-9a-f-]{36})/i);
      if (m) {
        const res = await sendMsg({ type: "GET_ASHBY_SCHEMA", org: decodeURIComponent(m[1]), id: m[2] });
        for (const entry of res?.entries || []) schemaMap.set(entry.path, entry);
        if (schemaMap.size) {
          console.log(`[JobWatch] Schema: ${schemaMap.size} fields via GraphQL`);
          return schemaMap;
        }
      }
    } catch (e) {
      console.warn("[JobWatch] GraphQL schema fetch failed (trying __appData):", e.message);
    }
    try {
      const res = await sendMsg({ type: "EXEC_MAIN_WORLD", action: "extractSchema" });
      const entries = res?.result || [];
      for (const entry of entries) {
        schemaMap.set(entry.path, entry);
      }
      console.log(`[JobWatch] Schema: extracted ${schemaMap.size} fields from __appData`);
    } catch (e) {
      console.warn("[JobWatch] Schema extraction failed (falling back to DOM):", e.message);
    }
    return schemaMap;
  }

  // Map Ashby schema types → internal types
  const ASHBY_TYPE_MAP = {
    Boolean: "yesno",
    ValueSelect: "select",
    MultiValueSelect: "multiselect",
    String: "text",
    LongText: "textarea",
    Email: "email",
    Phone: "tel",
    Url: "url",
    File: "file",
    Location: "location",
    Date: "date",
    Number: "number",
    EducationHistory: "education",
  };

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
  async function clickYesNo(fieldId, answer) {
    try {
      const res = await sendMsg({
        type: "EXEC_MAIN_WORLD",
        action: "clickYesNo",
        id: fieldId,
        value: answer
      });

      return res?.result || { ok: false, error: "no result" };
    } catch (e) {
      console.warn("[JobWatch] Yes/No click failed:", e.message);
      return { ok: false, error: e.message };
    }
  }

  // ─── Click a Radio button ──────────────────────────────────────────────────
  async function clickRadio(fieldId, index) {
    try {
      const res = await sendMsg({
        type: "EXEC_MAIN_WORLD",
        action: "clickRadio",
        id: fieldId,
        value: index
      });
      return res?.result || { ok: false, error: "no result" };
    } catch (e) {
      console.warn("[JobWatch] Radio click failed:", e.message);
      return { ok: false, error: e.message };
    }
  }

  // ─── Fill location combobox ───────────────────────────────────────────────
  async function fillLocation(entry, value) {
    const box = entry.querySelector("input[role='combobox']") || entry.querySelector("input");
    if (!box || !value) return;

    // Clear any existing value first
    box.focus();
    box.click();
    await window.__jwWait(200);

    // Select-all + delete to clear
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }));
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    await window.__jwWait(100);

    // Type character by character from the MAIN world to bypass CSP/Isolated World restrictions
    await sendMsg({
      type: "EXEC_MAIN_WORLD",
      action: "typeCharByChar",
      id: entry.dataset.fieldPath || box.id,
      value: value
    });

    // Poll for a suggestion dropdown (up to 4 seconds)
    let option = null;
    for (let i = 0; i < 40; i++) {
      await window.__jwWait(100);
      const allOptions = [
        ...entry.querySelectorAll("[role='option']"),
        ...entry.querySelectorAll("[class*='_suggestion_']"),
        ...document.querySelectorAll("[role='listbox'] [role='option']"),
        ...document.querySelectorAll("[class*='_suggestion_']"),
        ...document.querySelectorAll("[class*='_listItem_']"),
      ];
      if (!allOptions.length) continue;

      // Find best match: prefer option whose text contains the city name
      const city = value.split(",")[0].trim().toLowerCase();
      option = allOptions.find(o => o.textContent.toLowerCase().includes(city))
        || allOptions[0];
      break;
    }

    if (option) {
      console.log("[JobWatch] Location: clicking option:", option.textContent.trim());
      option.click();
      await window.__jwWait(400);

      // Verify it accepted by checking the input has a non-empty value
      if (!box.value) {
        // Try mousedown + mouseup combo (some dropdowns require it)
        option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        option.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        option.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await window.__jwWait(300);
      }
    } else {
      // No dropdown appeared — press Enter as last resort
      console.warn("[JobWatch] Location: no dropdown found, pressing Enter for:", value);
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }
    await window.__jwWait(300);
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
  // Uses Ashby schema as PRIMARY type source, DOM as fallback.
  function scrapeFields(form, schemaMap = new Map()) {
    const fields = [];

    // 1. Standard .ashby-application-form-field-entry fields
    for (const entry of form.querySelectorAll(".ashby-application-form-field-entry")) {
      const id = entry.dataset.fieldPath || "";
      const labelEl = entry.querySelector("label.ashby-application-form-question-title");
      const label = labelEl ? labelEl.textContent.trim().replace(/\s*\*\s*$/, "") : "";
      const descEl = entry.querySelector(".ashby-application-form-question-description, [class*='_description_']");
      const description = descEl ? descEl.textContent.trim() : "";
      const required = !!(/(^|\s)_required_/.test(labelEl?.className || "") || entry.querySelector("[required]"));

      // ── Schema-first type detection ──
      const schema = schemaMap.get(id);
      let type;
      let options = null;

      if (schema) {
        // Use Ashby's authoritative type
        type = ASHBY_TYPE_MAP[schema.type] || schema.type?.toLowerCase() || "text";
        if (schema.options?.length) {
          options = schema.options.map(o => ({ label: o.label || o, value: o.id || o.label || o }));
        }
        // Override required from schema if available
        if (schema.required !== undefined) {
          // Keep DOM-detected required OR schema required (either is authoritative)
        }
        console.log(`[JobWatch] Schema type for "${label}": ${schema.type} → ${type}`);
      } else {
        // ── DOM fallback ──
        const fileInput = entry.querySelector("input[type=file]");
        const yesNoEl = entry.querySelector("[class*='_yesno_']");
        const buttons = [...entry.querySelectorAll("button")];
        const isYesNo = yesNoEl || (buttons.length === 2 && /yes/i.test(buttons[0].textContent) && /no/i.test(buttons[1].textContent));

        const combobox = entry.querySelector("input[role='combobox']");
        const radioEl = entry.querySelector("input[type=radio]");
        const checkboxEl = entry.querySelector("input[type=checkbox]");
        const inputEl = entry.querySelector("input:not([type=file]):not([role=combobox]):not([type=radio]):not([type=checkbox]), textarea");

        if (fileInput) type = "file";
        else if (isYesNo) type = "yesno";
        else if (combobox || id === "_systemfield_location") type = "location";
        else if (radioEl) type = "radio";
        else if (checkboxEl) type = "checkbox";
        else type = inputEl?.type || "text";
      }

      const field = { id, label, description, type, required };
      if (options) {
        field.options = options;
      } else if (type === "radio") {
        field.options = [...entry.querySelectorAll("input[type=radio]")]
          .map(r => ({ label: getInputLabel(r, entry), value: r.value || getInputLabel(r, entry) }));
      } else if (type === "checkbox" || type === "multiselect") {
        const cbs = [...entry.querySelectorAll("input[type=checkbox]")];
        if (cbs.length) {
          field.options = cbs.map(cb => ({ label: getInputLabel(cb, entry), inputId: cb.id }));
        }
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
      const required = !!(/(^|\s)_required_/.test(labelEl?.className || ""));

      const schema = schemaMap.get(id);

      const radios = [...fs.querySelectorAll("input[type=radio]")];
      const checkboxes = [...fs.querySelectorAll("input[type=checkbox]")];

      if (radios.length) {
        fields.push({
          id,
          label,
          type: "radio",
          required,
          options: radios.map(r => ({
            label: getInputLabel(r, fs),
            value: r.value || getInputLabel(r, fs)
          })),
        });

        console.log(`[JobWatch] Fieldset DOM override: "${label}" → radio`);
        continue;
      }

      if (checkboxes.length) {
        fields.push({
          id,
          label,
          type: "checkbox",
          required,
          options: checkboxes.map(cb => ({
            label: getInputLabel(cb, fs),
            inputId: cb.id
          })),
        });

        console.log(`[JobWatch] Fieldset DOM override: "${label}" → checkbox`);
        continue;
      }

      // Only fall back to schema if fieldset DOM did not reveal a control type
      if (schema) {
        const type =
          ASHBY_TYPE_MAP[schema.type] ||
          schema.type?.toLowerCase() ||
          "radio";

        const field = { id, label, type, required };

        if (schema.options?.length) {
          field.options = schema.options.map(o => ({
            label: o.label || o,
            value: o.id || o.label || o
          }));
        }

        fields.push(field);
        continue;
      }
    }

    return fields;
  }

  // ─── Read Ashby's validation error list ──────────────────────────────────
  function scrapeFormErrors(_form) {
    const container = document.querySelector(
      "._errorsContainer_135ul_78, [class*='_errorsContainer_'], [role='alert'][aria-live]"
    );
    if (!container) return [];
    return [...container.querySelectorAll("li, [class*='_error_135ul']")]
      .map(li => li.textContent.trim())
      .filter(Boolean);
  }

  // ─── Deterministic Text Rule Engine ────────────────────────────────────────
  // Instantly maps known text fields using regex — no AI needed.
  // ─── Job location from the page (JSON-LD / __NEXT_DATA__ / embedded JSON) ──
  // Used for every location-type answer so they stay consistent with the job's
  // posted location, never the user's home city.
  function getPageJobLocation(pendingJob) {
    let loc = null;
    try {
      const nextData = JSON.parse(document.getElementById("__NEXT_DATA__")?.textContent || "{}");
      loc = nextData?.props?.pageProps?.posting?.locationName
        || nextData?.props?.pageProps?.jobPosting?.locationName
        || nextData?.props?.pageProps?.job?.locationName
        || null;
    } catch { /* no __NEXT_DATA__ */ }
    if (!loc) {
      try {
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
          const data = JSON.parse(script.textContent || "{}");
          if (data["@type"] === "JobPosting" && data.jobLocation?.address?.addressLocality) {
            loc = data.jobLocation.address.addressLocality;
            if (data.jobLocation.address.addressRegion) loc += ", " + data.jobLocation.address.addressRegion;
            break;
          }
        }
      } catch { /* no JSON-LD */ }
    }
    if (!loc) {
      const m = document.body.innerHTML.match(/"locationName":"([^"]+)"/);
      if (m) loc = m[1];
    }
    if (loc) loc = loc.replace(/\s*-\s*US$/i, "").trim();
    return loc || pendingJob?.locationName || "";
  }

  function applyTextRules(fields, mappings, userDoc, resumeDoc = {}, jobLocation = "") {
    const cityRegion = [userDoc.city, userDoc.region].filter(Boolean).join(", ");

    const RULES = [
      // ── Identity ──────────────────────────────────────────────────────────
      {
        patterns: [/^email(\s*address)?$/i],
        answer: () => userDoc.email || ""
      },
      {
        patterns: [/^first.?name/i, /preferred.?first/i],
        answer: () => userDoc.firstName || ""
      },
      {
        patterns: [/^last.?name/i, /surname/i],
        answer: () => userDoc.lastName || ""
      },
      {
        patterns: [/middle.?name/i],
        answer: () => userDoc.middleName || ""
      },
      {
        patterns: [/preferred.?name/i, /nickname/i],
        answer: () => userDoc.firstName || ""
      },
      // Full/legal — after preferred/first/last so it doesn't steal them
      {
        patterns: [/^name$/i, /full.?name/i, /legal.?name/i, /legal.?full/i],
        answer: () => userDoc.fullName || `${userDoc.firstName || ""} ${userDoc.lastName || ""}`.trim()
      },
      {
        patterns: [/pronouns/i],
        answer: () => userDoc.pronouns || ""
      },
      {
        patterns: [/pronounc/i, /name.*sound/i, /how.*say.*name/i],
        answer: () => userDoc.namePronunciation || ""
      },

      // ── Contact ───────────────────────────────────────────────────────────────
      {
        // Intentionally narrow: only exact phone/tel/mobile labels — avoid matching textarea questions
        patterns: [/^phone(\s*(number)?)?$/i, /^(cell|mobile)(\s*number)?$/i, /^tel(ephone)?(\s*number)?$/i, /contact.*number/i, /your.*phone/i],
        answer: () => userDoc.phone || ""
      },

      // ── Social / URLs ──────────────────────────────────────────────────────
      {
        patterns: [/linkedin/i, /linked.?in/i],
        answer: () => userDoc.linkedin || ""
      },
      // Combined "GitHub/Portfolio/Twitter/Etc" fields — must come before individual checks
      {
        patterns: [/github.*portfolio|portfolio.*github|github.*twitter|social.*link/i,
          /a link we should look at/i, /website.*link.*(github|portfolio)/i],
        answer: () => userDoc.github || userDoc.portfolio || ""
      },
      {
        patterns: [/github/i, /git.?hub/i, /github url/i],
        answer: () => userDoc.github || ""
      },
      {
        patterns: [/google.?scholar/i],
        answer: () => userDoc.googleScholar || userDoc.portfolio || ""
      },
      {
        patterns: [/^x \(formerly twitter\)/i, /twitter.*url/i, /^twitter$/i],
        answer: () => userDoc.twitter || ""
      },
      {
        patterns: [/portfolio/i, /personal.?site/i, /portfolio.?link/i, /portfolio.?url/i],
        answer: () => userDoc.portfolio || ""
      },
      {
        patterns: [/^website$/i, /personal.?website/i, /other.?website/i],
        answer: () => userDoc.portfolio || ""
      },

      // ── Location (text inputs — the Location widget type is handled separately) ──
      {
        patterns: [/^location$/i, /current.?location/i, /where.*located/i, /where.*based/i,
          /where.*currently/i, /what.*city.*live/i, /what.*city.*state.*reside/i,
          /city.*state.*country/i, /physical.*location/i],
        answer: () => cityRegion
      },
      // City-only text field
      {
        patterns: [/^what city do you live/i, /^which city are you/i, /^city$/i],
        answer: () => userDoc.city || ""
      },
      // State-only / payroll state
      {
        patterns: [/state.*work.*from/i, /payroll.*state/i, /which state.*work/i,
          /from which.*state/i, /^state$/i],
        answer: () => userDoc.region || "California"
      },

      // ── Availability / Start Date ──────────────────────────────────────
      {
        patterns: [/start.?date/i, /availability/i, /when can you start/i,
          /soonest.*start/i, /available.*start/i, /earliest.*start/i,
          /when.*available/i, /when.*start.*full/i, /available.*full.?time/i,
          /please list your current availability/i],
        answer: () => userDoc.availability || "Immediately"
      },

      // ── Notice period ──────────────────────────────────────────────────
      {
        patterns: [/notice.{0,30}(period|give|employer|current)/i, /how.{0,20}notice/i,
          /notice.*required/i, /required.*notice/i, /when.*start.*notice/i,
          /time ?line.{0,15}start/i, /when can you start/i, /how soon.{0,20}start/i],
        answer: () => userDoc.noticePeriod || "2 weeks"
      },

      // ── Where are you based / located → the JOB's posted location ─────
      // (keeps text answers consistent with the location widget + radios)
      {
        patterns: [/where are you (currently )?(based|located)/i,
          /where do you (currently )?(live|reside)/i,
          /current location/i, /^location$/i, /what city.{0,20}(based|located|live)/i],
        answer: () => jobLocation || [userDoc.city, userDoc.region].filter(Boolean).join(", ")
      },

      // ── Full / legal name variants (custom String fields) ─────────────
      {
        patterns: [/^(full|legal)\s?name$/i, /^name$/i],
        answer: () => userDoc.fullName || `${userDoc.firstName || ""} ${userDoc.lastName || ""}`.trim()
      },
      {
        patterns: [/^(preferred )?first name( \(if applicable\))?$/i, /^preferred name/i],
        answer: () => userDoc.firstName || ""
      },
      {
        patterns: [/^(last name|surname)([ /]+surname)?$/i],
        answer: () => userDoc.lastName || ""
      },

      // ── Current Job Title ─────────────────────────────────────────────
      {
        patterns: [/current.?job.?title/i, /current.?title/i, /your.?current.?title/i,
          /^job.?title$/i, /^(your )?title$/i, /position.?title/i],
        answer: () => resumeDoc?.roles?.[0]?.title || ""
      },

      // ── Current Company (from last resume role) ───────────────────────────
      {
        patterns: [/current.?company/i, /current.?employer/i, /where.*currently.*work/i,
          /where.*most.*recently.*work/i, /most.*recent.*employer/i,
          /current or most recent employer/i],
        answer: () => (resumeDoc?.roles?.[0]?.company) || ""
      },

      // ── University / Education ────────────────────────────────────────
      {
        patterns: [/university.*attend/i, /school.*attend/i, /^university$/i,
          /^college$/i, /^institution$/i, /degree.*from/i, /where.*study/i,
          /undergraduate.*institution/i, /alma mater/i],
        answer: () => userDoc.university || ""
      },

      // ── Salary / Compensation ─────────────────────────────────────────
      {
        patterns: [/salary/i, /compensation/i, /pay.{0,15}expect/i, /target.*comp/i,
          /desired.*pay/i, /minimum.*salary/i, /annual.*expectation/i, /total.*cash/i,
          /base.*salary/i, /what.*looking.*for.*comp/i, /comp.*expect/i,
          /salary.*range/i, /expected.*salary/i, /target.*salary/i,
          /what.*salary.*targeting/i, /desired.*annual/i, /annual.*base/i,
          /ote/i],
        answer: () => userDoc.salaryExpectation || "Open to discussion"
      },

      // ── How did you hear about this role ─────────────────────────────
      {
        patterns: [/how did you hear/i, /how.*hear.*about/i, /how.*find.*role/i,
          /how.*discover/i, /referral.*source/i, /source.*referral/i,
          /where.*find.*posting/i, /where.*find.*job/i, /how.*find.*out/i,
          /where.*hear.*about/i, /what brought you.*posting/i,
          /how.*learn.*about.*position/i, /how.*learn.*about.*opportunit/i],
        answer: () => "LinkedIn"
      },

      // ── "If you selected Other, please specify" ───────────────────────
      {
        patterns: [/if.{0,20}(selected|chose).{0,20}other/i, /if other.*specify/i,
          /if.*other.*please/i, /other.*not listed.*list/i],
        answer: () => "LinkedIn"
      },

      // ── Visa sponsorship as text (some companies use Textarea not yesno) ───
      {
        patterns: [/require.*sponsorship/i, /need.*sponsorship/i, /visa.*sponsorship/i,
          /sponsorship.*visa/i, /h.?1.?b/i, /require.*employer.*sponsor/i,
          /sponsor.*immigr/i],
        answer: () => userDoc.requiresSponsorship === "Yes"
          ? "Yes, I will require visa sponsorship in the future"
          : "No, I do not require visa sponsorship"
      },
    ];

    for (const field of fields) {
      if (field.type !== "text" && field.type !== "tel" && field.type !== "url" && field.type !== "textarea") continue;
      // Skip built-in system fields — those are hardcoded in applyMappings
      if (field.id.startsWith("_systemfield_")) continue;
      // Skip location-widget fields — their value is determined by the job, not the user
      if (field.type === "location") continue;

      const lbl = field.label || "";
      const textToTest = `${lbl} ${field.description || ""}`;
      for (const rule of RULES) {
        if (rule.patterns.some(p => p.test(lbl)) || rule.patterns.some(p => p.test(textToTest))) {
          const ans = rule.answer();
          if (ans) {
            mappings[field.id] = ans;
            console.log(`[JobWatch] Text rule: "${lbl}" → ${ans}`);
          }
          break;
        }
      }
    }
  }

  // ─── Deterministic Yes/No rule engine ──────────────────────────────────────
  // Overrides AI answers for well-known checkbox questions so we never
  // misanswer visa / work-auth / office questions.
  function applyYesNoRules(fields, mappings, userDoc) {
    // User profile flags (with safe defaults matching Firestore strings)
    const isAuthorized = userDoc.workAuthorized === "Yes";
    const needsSponsorship = userDoc.requiresSponsorship === "Yes";
    const isUsPerson = userDoc.usPersonExportControl === "Yes";
    const openToRelocate = userDoc.willingToRelocate === "Yes";
    const openToOffice = userDoc.willingToWorkHybrid === "Yes";

    // Pattern buckets → answer
    const RULES = [
      // "Will you require work authorization?" = "Will you need sponsorship?"
      // Someone who needs sponsorship DOES require work authorization support.
      // This MUST come before the general work-auth rule to match first.
      {
        patterns: [
          /require.{0,40}work.?auth/i,
          /will you.{0,40}require.{0,40}work.?auth/i,
          /now or in the future require.{0,40}work.?auth/i,
          /require.{0,30}u\.?s\.?.{0,15}work.?auth/i,
          /need.{0,30}work.?auth/i,
        ],
        answer: () => needsSponsorship ? "yes" : "no",
      },
      // Work authorization — "Are you authorized?" → authorized people answer YES
      // NOTE: "without sponsorship" phrasing still means authorized=YES even if we need future sponsorship
      {
        patterns: [
          /authoriz.{0,30}work/i,
          /eligible.{0,30}work/i,
          /legally.{0,30}work/i,
          /right.{0,15}work/i,
          /work.{0,20}authoriz/i,
          /authoriz.{0,20}employ/i,
          /permitted.{0,20}work/i,
          /authoriz.{0,50}without.{0,20}sponsorship/i,
          /eligible.{0,50}without.{0,20}sponsorship/i,
          /indefinitely.{0,30}without/i,
          /right.{0,20}work.{0,20}indefinitely/i,
          /legally.{0,30}eligible.{0,30}employ/i,
          /legally.{0,30}eligible.{0,30}work/i,
          /without.{0,20}restriction/i,
          /without.{0,20}sponsorship.{0,30}(any|your)/i,
        ],
        answer: () => isAuthorized ? "yes" : "no",
      },
      // US residency — are you IN the US right now?
      {
        patterns: [
          /currently reside in.{0,20}(us|united states)/i,
          /live in.{0,20}(us|united states)/i,
          /currently located in.{0,20}(us|united states)/i,
          /reside.{0,20}(us|united states)/i,
          /based in.{0,20}(us|united states)/i,
          /currently in.{0,20}(us|united states)/i,
          /^do you currently reside in the us/i,
          /are you.{0,15}located in.{0,15}(the\s+)?(united states|usa?\b|u\.?s\.?)/i,
          /located in.{0,15}(the\s+)?(united states|usa\b)/i,
          /physically.{0,15}(located|present|based).{0,20}(united states|usa?\b|u\.?s\.?)/i,
        ],
        answer: () => (userDoc.country === "United States" || !userDoc.country) ? "yes" : "no",
      },
      // Visa / sponsorship — YES if needs it, NO if doesn't
      {
        patterns: [
          /require.{0,30}sponsorship/i,
          /need.{0,20}sponsorship/i,
          /sponsorship.{0,30}visa/i,
          /visa.{0,20}sponsorship/i,
          /h.?1.?b/i,
          /immigration.{0,20}sponsor/i,
          /work.{0,20}permit.{0,20}sponsor/i,
          /require.{0,40}employ.{0,20}visa/i,
          /require.{0,30}employer.{0,30}sponsor/i,
          /employer.{0,30}sponsor.{0,30}(case|status)/i,
          /sponsor.{0,40}immigr/i,
          /employment.*visa.*(e\.?g|h.?1|tn|o.?1)/i,
          /visa.*(status|case).*(sponsor|petition)/i,
        ],
        answer: () => needsSponsorship ? "yes" : "no",
      },
      // U.S. Person / export control
      {
        patterns: [
          /u\.?s\.?.{0,10}person/i,
          /export.{0,20}control/i,
          /itar/i,
          /citizen.{0,20}legal.{0,20}resident/i,
        ],
        answer: () => isUsPerson ? "yes" : "no",
      },
      // Office / hybrid / in-person — answer YES (or user preference)
      {
        patterns: [
          /comfortable.{0,40}(office|hybrid|in.person|on.?site)/i,
          /work.{0,30}(office|hybrid|in.person|on.?site)/i,
          /in.office.{0,30}(day|week|month)/i,
          /on.?site/i,
          /commut/i,
          /able.{0,30}(office|on.?site|in.person)/i,
          /work.{0,30}(monday|tuesday|wednesday|thursday|friday)/i,
        ],
        answer: () => openToOffice ? "yes" : "no",
      },
      // Availability / scheduling (weekends, evenings, shifts) — answer YES
      {
        patterns: [
          /availab.{0,40}(weekend|evening|holiday|night|shift)/i,
          /work.{0,30}(weekend|evening|holiday|night|shift)/i,
          /weekend/i,
          /evening/i,
          /minimum.{0,20}hour/i,
          /hours.{0,20}week/i,
          /flexible.{0,20}hour/i,
          /part.?time/i,
        ],
        answer: () => "yes",
      },
      // Relocation — answer based on user preference
      {
        patterns: [
          /reloca/i,
          /willing.{0,20}move/i,
        ],
        answer: () => openToRelocate ? "yes" : "no",
      },
      // Background / consent questions — always YES
      {
        patterns: [
          /consent.{0,30}(background|check)/i,
          /background.{0,20}check/i,
          /drug.{0,20}test/i,
          /consent.{0,20}(sms|text|email|contact)/i,
          /receive.{0,30}(sms|text|message)/i,
          /acknowledge/i,
        ],
        answer: () => "yes",
      },
      // Prior government employment — NO for a private-sector applicant
      {
        patterns: [/government.{0,20}employ/i, /employed.{0,25}government/i],
        answer: () => "no",
      },
    ];

    const FIELD_TYPES_HANDLED = new Set(["yesno", "radio", "select"]);
    for (const field of fields) {
      if (!FIELD_TYPES_HANDLED.has(field.type)) continue;
      const lbl = field.label || "";

      // For RADIO and SELECT fields: only apply if options are Yes/No style
      if (field.type === "radio" || field.type === "select") {
        const opts = (field.options || []).map(o => (o.label || "").toLowerCase().trim());
        const isYesNoStyle = opts.includes("yes") && opts.includes("no") && opts.length <= 3;
        if (!isYesNoStyle) continue;
      }

      // Do not auto-default required yes/no fields to "no" anymore.
      // Unrecognized questions (e.g. compliance, strict requirements) should fall to AI or manual review.

      // Match rules against DESCRIPTION first (contains the actual question),
      // then fall back to LABEL. This prevents label="Work Authorization" from
      // overriding description="Do you require sponsorship?"
      let matchedRule = null;
      const desc = field.description || "";

      // 1. Try description first (most specific)
      if (desc) {
        for (const rule of RULES) {
          if (rule.patterns.some(p => p.test(desc))) { matchedRule = rule; break; }
        }
      }
      // 2. Fall back to label if no description match
      if (!matchedRule) {
        for (const rule of RULES) {
          if (rule.patterns.some(p => p.test(lbl))) { matchedRule = rule; break; }
        }
      }

      if (matchedRule) {
        const ans = matchedRule.answer();
        const current = (mappings[field.id] || "").toLowerCase().trim();

        console.log("[JobWatch] YESNO mapped:", {
          id: field.id,
          label: lbl,
          answer: ans
        });

        if (current !== "yes" && current !== "no") {
          mappings[field.id] = ans;
          console.log(`[JobWatch] Rule engine overrode "${lbl}" → ${ans} (desc: "${desc.substring(0, 60)}…")`);
        } else if (current !== ans) {
          mappings[field.id] = ans;
          console.log(`[JobWatch] Rule engine corrected "${lbl}": ${current} → ${ans}`);
        }
      }
    }
  }

  // ─── Apply a mappings object to the form ─────────────────────────────────
  async function applyMappings(form, fields, mappings, userDoc, pendingJob, resumeBase64, answersLog) {
    for (const field of fields) {
      const entry = form.querySelector(`[data-field-path="${CSS.escape(field.id)}"]`);
      if (!entry) continue;

      // EDUCATION HISTORY — compound widget (school/degree/discipline pickers);
      // not automated yet, so never let the generic text filler touch it.
      if (field.type === "education") {
        console.log("[JobWatch] Education section — complete manually:", field.label);
        continue;
      }

      // FILE
      if (field.type === "file") {
        const lbl = (field.label || "").toLowerCase();
        // Only upload resume for explicit resume/CV fields
        if (lbl.includes("resume") || lbl.includes("cv") || field.id === "_systemfield_resume") {
          if (resumeBase64) {
            const ok = await setFileInput(field.id, resumeBase64, userDoc.resumeFileName || "resume.pdf");
            if (ok) answersLog[field.id] = { label: field.label, answer: userDoc.resumeFileName || "resume.pdf", type: "file" };
          }
        }
        continue;
      }

      // SELECT (ValueSelect) — Ashby dropdown/single-select fields
      if (field.type === "select") {
        const answer = mappings[field.id];
        const lbl = (field.label || "").toLowerCase();

        // Determine what to select based on label context
        let targetAnswer = answer;
        if (!targetAnswer) {
          if (/how did you hear|how.*find|where.*hear|referral.*source/i.test(lbl)) targetAnswer = "LinkedIn";
          else if (/work.?auth|authoriz/i.test(lbl)) targetAnswer = userDoc.workAuthorized || "Yes";
          else if (/sponsorship|visa/i.test(lbl)) targetAnswer = userDoc.requiresSponsorship || "No";
        }

        if (targetAnswer && field.options?.length) {
          // Find the best matching option
          const target = targetAnswer.toLowerCase().trim();
          const bestOpt = field.options.find(o => o.label.toLowerCase() === target)
            || field.options.find(o => o.label.toLowerCase().includes(target))
            || field.options.find(o => target.includes(o.label.toLowerCase()));

          if (bestOpt) {
            // Click the dropdown trigger to open it
            const trigger = entry.querySelector("button, [role='combobox'], [role='listbox'], [class*='select'], [class*='Select']") 
              || entry.querySelector("div[tabindex]");
            if (trigger) {
              trigger.click();
              await window.__jwWait(300);

              // Find and click the matching option in the opened dropdown
              const allOptions = [
                ...document.querySelectorAll("[role='option']"),
                ...document.querySelectorAll("[role='listbox'] li"),
                ...document.querySelectorAll("[class*='_option_'], [class*='_menuItem_']"),
              ];
              const optEl = allOptions.find(o => o.textContent.trim().toLowerCase().includes(bestOpt.label.toLowerCase()));
              if (optEl) {
                optEl.click();
                answersLog[field.id] = { label: field.label, answer: bestOpt.label, type: "select" };
              }
              await window.__jwWait(200);
            }
          }
        }
        continue;
      }

      // MULTISELECT (MultiValueSelect) — Ashby multi-choice fields
      // These render as checkboxes in DOM, so reuse checkbox logic but with schema awareness
      if (field.type === "multiselect") {
        const checkboxes = [...entry.querySelectorAll("input[type=checkbox]")];
        const lbl = (field.label || "").toLowerCase();
        const checked = [];

        const isPronounField = lbl.includes("pronoun");
        const isHowDidYouHear = /how did you hear|how.*find|where.*hear|how.*learn|where.*find|referral.*source/i.test(lbl);

        if (isPronounField) {
          const userPronoun = (userDoc.pronouns || "He/Him").toLowerCase();
          for (const cb of checkboxes) {
            const cbLabel = getInputLabel(cb, entry).toLowerCase();
            const shouldCheck = cbLabel.includes(userPronoun) ||
              (userPronoun.includes("he") && cbLabel.includes("he/him")) ||
              (userPronoun.includes("she") && cbLabel.includes("she/her")) ||
              (userPronoun.includes("they") && cbLabel.includes("they/them"));
            if (shouldCheck && !cb.checked) { cb.click(); await window.__jwWait(100); }
            if (cb.checked) checked.push(getInputLabel(cb, entry));
          }
        } else if (isHowDidYouHear) {
          for (const cb of checkboxes) {
            const cbLabel = getInputLabel(cb, entry).toLowerCase();
            if (cbLabel.includes("linkedin")) {
              if (!cb.checked) { cb.click(); await window.__jwWait(100); }
              checked.push(getInputLabel(cb, entry));
              break;
            }
          }
        } else if (lbl.includes("consent") || lbl.includes("acknowledge") || lbl.includes("certify") || lbl.includes("privacy") || lbl.includes("agreement")) {
          for (const cb of checkboxes) {
            if (!cb.checked) { cb.click(); await window.__jwWait(100); }
            checked.push(getInputLabel(cb, entry) || "acknowledged");
          }
        } else {
          // Unrecognized multiselect — skip for safety
          console.log(`[JobWatch] Multiselect skipped (unrecognized): "${field.label}"`);
        }

        if (checked.length) answersLog[field.id] = { label: field.label, answer: checked.join("; "), type: "multiselect" };
        continue;
      }

      // CHECKBOX — smart selection: match by label when possible, else check all
      if (field.type === "checkbox") {
        const checkboxes = [...entry.querySelectorAll("input[type=checkbox]")];
        const lbl = (field.label || "").toLowerCase();
        const checked = [];

        // Detect special multi-select checkbox groups
        const isPronounField = lbl.includes("pronoun");
        const isHowDidYouHear = lbl.includes("how did you hear") || lbl.includes("how did you find") || lbl.includes("how did you learn") || lbl.includes("where did you hear");

        if (isPronounField) {
          // Only check the checkbox that matches the user's pronoun setting
          const userPronoun = (userDoc.pronouns || "He/Him").toLowerCase();
          for (const cb of checkboxes) {
            const cbLabel = getInputLabel(cb, entry).toLowerCase();
            const shouldCheck = cbLabel.includes(userPronoun) ||
              (userPronoun.includes("he") && cbLabel.includes("he/him")) ||
              (userPronoun.includes("she") && cbLabel.includes("she/her")) ||
              (userPronoun.includes("they") && cbLabel.includes("they/them"));
            if (shouldCheck && !cb.checked) { cb.click(); await window.__jwWait(100); }
            if (cb.checked) checked.push(getInputLabel(cb, entry));
          }
        } else if (isHowDidYouHear) {
          // Only check "LinkedIn" option
          for (const cb of checkboxes) {
            const cbLabel = getInputLabel(cb, entry).toLowerCase();
            if (cbLabel.includes("linkedin")) {
              if (!cb.checked) { cb.click(); await window.__jwWait(100); }
              checked.push(getInputLabel(cb, entry));
              break;
            }
          }
        } else if (lbl.includes("consent") || lbl.includes("acknowledge") || lbl.includes("certify") || lbl.includes("privacy") || lbl.includes("agreement") || lbl.includes("arbitration") || lbl.includes("background") || lbl.includes("drug test")) {
          // Legal agreements / consent / explicitly recognized — check all
          for (const cb of checkboxes) {
            if (!cb.checked) { cb.click(); await window.__jwWait(100); }
            checked.push(getInputLabel(cb, entry) || "acknowledged");
          }
        } else {
          // Unrecognized multi-select checkbox — leave alone
          // The AI or manual review should handle complex structured multi-selects
        }

        if (checked.length) answersLog[field.id] = { label: field.label, answer: checked.join("; "), type: "checkbox" };
        continue;
      }

      // YESNO
      if (field.type === "yesno") {
        const answer = mappings[field.id];

        console.log("[JobWatch] YESNO attempting:", {
          id: field.id,
          label: field.label,
          answer
        });

        if (answer) {
          const result = await clickYesNo(field.id, answer);

          console.log("[JobWatch] YESNO result:", result);

          if (result?.ok) {
            answersLog[field.id] = {
              label: field.label,
              answer,
              type: "yesno"
            };
          }
        }

        await window.__jwWait(250);
        continue;
      }

      // LOCATION
      if (field.type === "location") {
        // Priority:
        // 1) Ashby embeds job data as JSON in __NEXT_DATA__ — most reliable
        // 2) JSON-LD schema — used by newer Ashby/Parafin instances
        // 3) pendingJob from session storage (set when auto-apply was triggered)
        // 4) Nothing — never fall back to AI's answer or user's home city
        let pageJobLocation = null;
        try {
          const nextData = JSON.parse(document.getElementById("__NEXT_DATA__")?.textContent || "{}");
          pageJobLocation =
            nextData?.props?.pageProps?.posting?.locationName
            || nextData?.props?.pageProps?.jobPosting?.locationName
            || nextData?.props?.pageProps?.job?.locationName
            || null;
        } catch { }

        if (!pageJobLocation) {
          try {
            const ldScripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
            for (const script of ldScripts) {
              const data = JSON.parse(script.textContent || "{}");
              if (data["@type"] === "JobPosting" && data.jobLocation?.address?.addressLocality) {
                pageJobLocation = data.jobLocation.address.addressLocality;
                if (data.jobLocation.address.addressRegion) {
                  pageJobLocation += ", " + data.jobLocation.address.addressRegion;
                }
                break;
              }
            }
          } catch { }
        }

        // Just in case it's literally just embedded anywhere as locationName:"..."
        if (!pageJobLocation) {
          const match = document.body.innerHTML.match(/"locationName":"([^"]+)"/);
          if (match) pageJobLocation = match[1];
        }

        if (pageJobLocation) pageJobLocation = pageJobLocation.replace(/\s*-\s*US$/i, "").trim();

        const value = pageJobLocation || pendingJob?.locationName || "";
        console.log("[JobWatch] Location →", { pageJobLocation, pendingJobLoc: pendingJob?.locationName, final: value });
        if (!value) console.warn("[JobWatch] Location is empty! pendingJob:", JSON.stringify(pendingJob));

        if (value) {
          await fillLocation(entry, value);
          answersLog[field.id] = { label: field.label, answer: value, type: "location" };
        }
        continue;
      }

      // DATE PICKER — handles both native <input type=date> and custom calendar widgets (Ashby)
      if (field.type === "date" || field.type === "Date Picker") {
        // Compute target date: availableStartDate, noticePeriod, or default to 20 days
        let targetDate = new Date();
        if (userDoc.availableStartDate && !isNaN(new Date(userDoc.availableStartDate))) {
          targetDate = new Date(userDoc.availableStartDate);
        } else if (userDoc.noticePeriod && typeof userDoc.noticePeriod === 'string' && userDoc.noticePeriod.toLowerCase().includes("week")) {
          const weeks = parseInt(userDoc.noticePeriod) || 2;
          targetDate.setDate(targetDate.getDate() + (weeks * 7));
        } else {
          targetDate.setDate(targetDate.getDate() + 20);
        }

        // Check if this field has a custom calendar widget (Ashby's date picker)
        const _calendarTrigger = entry.querySelector("[data-testid='date-picker'], [class*='datePicker'], [class*='DatePicker'], [class*='calendar'], button[aria-label*='calendar']")
          || entry.querySelector("input[readonly]")  // Ashby uses readonly inputs for calendar triggers
          || entry.querySelector("button svg")?.closest("button"); // calendar icon button

        const nativeInput = entry.querySelector("input[type='date']");

        if (nativeInput) {
          // Native date input — just set the value
          const mm = String(targetDate.getMonth() + 1).padStart(2, "0");
          const dd = String(targetDate.getDate()).padStart(2, "0");
          const yyyy = targetDate.getFullYear();
          await setInputValue(field.id, `${mm}/${dd}/${yyyy}`);
          answersLog[field.id] = { label: field.label, answer: `${mm}/${dd}/${yyyy}`, type: "date" };
        } else {
          // Custom calendar widget — click to open, navigate months, click day
          const openBtn = entry.querySelector("button") || entry.querySelector("input");
          if (openBtn) {
            openBtn.click();
            await window.__jwWait(400);
          }

          // Calendar should now be open somewhere on the page
          const tryPickDate = async () => {
            const targetMonth = targetDate.getMonth(); // 0-indexed
            const targetYear = targetDate.getFullYear();
            const targetDay = targetDate.getDate();

            for (let attempt = 0; attempt < 24; attempt++) {
              // Detect the visible month/year header
              const header = document.querySelector("[class*='calendar'] [class*='month'], [class*='Calendar'] [class*='Month'], [class*='datepicker'] h2, [class*='DatePicker'] h2, [aria-label*='month'], [class*='header']")
                || document.querySelector("h2, [role='heading']");

              if (header) {
                const headerText = header.textContent.trim();
                // Parse month name from header (e.g. "May 2026")
                const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
                let visibleMonth = -1, visibleYear = -1;
                months.forEach((m, i) => { if (headerText.toLowerCase().includes(m)) visibleMonth = i; });
                const yearMatch = headerText.match(/\d{4}/);
                if (yearMatch) visibleYear = parseInt(yearMatch[0]);

                if (visibleMonth === targetMonth && visibleYear === targetYear) break; // correct month

                // Need to advance or go back — find next/prev buttons
                const navBtns = document.querySelectorAll("[class*='calendar'] button, [class*='Calendar'] button, [class*='DatePicker'] button");
                const isAfter = (visibleYear > targetYear) || (visibleYear === targetYear && visibleMonth > targetMonth);
                // Pick left (prev) or right (next) arrow
                const arrowBtn = isAfter ? navBtns[0] : navBtns[navBtns.length - 1];
                if (arrowBtn) { arrowBtn.click(); await window.__jwWait(250); }
                else break;
              } else break;
            }

            // Now click the target day cell
            const dayCells = [...document.querySelectorAll("[class*='calendar'] td, [class*='Calendar'] td, [class*='day']:not([class*='disabled']):not([class*='outside'])")];
            const dayCell = dayCells.find(el => {
              const t = el.textContent.trim();
              return t === String(targetDay) || t === String(targetDay).padStart(2, "0");
            });
            if (dayCell) {
              dayCell.click();
              await window.__jwWait(300);
              answersLog[field.id] = { label: field.label, answer: targetDate.toDateString(), type: "date" };
            }
          };

          await tryPickDate();
        }
        continue;
      }

      // RADIO
      if (field.type === "radio") {
        let answer = mappings[field.id];
        const lbl = (field.label || "").toLowerCase();

        if (!answer && (
          lbl.includes("location") ||
          lbl.includes("office") ||
          lbl.includes("which city") ||
          lbl.includes("interested in") ||
          lbl.includes("which site")
        )) {
          if (pendingJob?.locationName) answer = pendingJob.locationName;
        }

        if (!answer && (
          lbl.includes("where are you based") ||
          lbl.includes("where do you live") ||
          lbl.includes("which city are you in")
        )) {
          answer = [userDoc.city, userDoc.region].filter(Boolean).join(", ");
        }

        if (answer) {
          const radios = [...entry.querySelectorAll("input[type=radio]")];
          const target = findBestRadio(radios, entry, answer);
          if (target && !target.checked) {
            const index = radios.indexOf(target);
            const result = await clickRadio(field.id, index);

            console.log("[JobWatch] RADIO result:", result);

            if (result?.ok) {
              answersLog[field.id] = { label: field.label, answer: getInputLabel(target, entry), type: "radio" };
            }
            await window.__jwWait(200);
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
      await window.__jwWait(150);
    }
  }

  // ─── Return list of required fields that are still empty ─────────────────
  function getUnfilledRequired(form, fields, answersLog = {}) {
    const missing = [];
    for (const field of fields) {
      if (!field.required) continue;
      const entry = form.querySelector(`[data-field-path="${CSS.escape(field.id)}"]`);
      if (!entry) continue;

      // If the AI already successfully filled it this session, trust the log
      // (Bypasses brittle DOM checks for base64 files and React yes/no states)
      if (answersLog[field.id]) continue;

      if (field.type === "file") {
        const fi = entry.querySelector("input[type=file]");
        if (fi && (!fi.files || fi.files.length === 0)) missing.push(field);
      } else if (field.type === "radio") {
        if (!entry.querySelector("input[type=radio]:checked")) missing.push(field);
      } else if (field.type === "location") {
        const box = entry.querySelector("input[role='combobox']") || entry.querySelector("input");
        if (!box?.value?.trim()) missing.push(field);
      } else if (field.type === "yesno") {
        if (!answersLog[field.id]) {
          missing.push(field);
        }
      } else if (field.type === "checkbox") {
        const checkedBox = entry.querySelector("input[type=checkbox]:checked");
        if (!checkedBox) missing.push(field);
      } else {
        const input = entry.querySelector("input:not([type=file]):not([type=radio]):not([type=checkbox]):not([role=combobox]), textarea");
        if (input && !input.value?.trim()) missing.push(field);
      }
    }
    return missing;
  }

  // ─── Unattended auto-apply (background.js runs the queue) ──────────────────
  let AUTO = null;
  try { AUTO = (await sendMsg({ type: "AUTO_JOB" })).job || null; } catch { AUTO = null; }
  async function autoReport(status, note) { try { await sendMsg({ type: "AUTO_RESULT", status, note }); } catch { /* the runner times out instead */ } }
  // A challenge counts only when a person could see it: reCAPTCHA keeps its
  // challenge frame on the page all the time, hidden or parked off screen.
  function onScreen(el) {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 100 && r.height > 100 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }
  function captchaVisible() {
    return [...document.querySelectorAll("iframe[src*='recaptcha'][src*='bframe'], iframe[src*='hcaptcha'][src*='challenge'], iframe[title*='challenge' i]")].some(onScreen);
  }
  /** Submit when nothing is left for the person, wait for Ashby's confirmation, report. */
  async function autoSubmitAshby(manual, pendingJob, answersLog, refill = null, round = 0) {
    // Test runs set jwNoSubmit: fill, never send.
    if ((await chrome.storage.local.get("jwNoSubmit").catch(() => ({}))).jwNoSubmit) return autoReport("needs_attention", "test run: not submitted");
    // Last look before Submit: every required field filled (the resume included).
    const scanEmpty = async () => (await execAshby("scan").then((x) => (Array.isArray(x) ? x : [])).catch(() => [])).filter((d) => (d.required || d.id === "_systemfield_resume") && !d.filled && !d.survey).map((d) => d.label);
    let empty = await scanEmpty();
    if (empty.length && refill && await refill()) empty = await scanEmpty();
    // A field still open does not stop the attempt: Submit, and the form
    // says what it really wants; the repair rounds below hand that to the AI.
    // Only the resume is a hard stop (Ashby never takes an application without it).
    if (empty.includes("Resume") || empty.some((l) => /^resume\b/i.test(l))) {
      window.__jwNotify.show("Auto-apply: the resume would not attach. Left open for you; the queue moves on.", "warning", { items: empty });
      return autoReport("needs_attention", `still empty: ${empty.slice(0, 4).join("; ")}`);
    }
    if (manual.size || empty.length) console.log("[JobWatch] submitting with open fields; the form will say what it needs:", [...manual.keys(), ...empty]);
    const btn = ashbySubmitButton();
    if (!btn) return autoReport("needs_attention", "could not find Ashby's Submit button");
    showOverlay(`⏳ Auto-apply: submitting${round ? ` (try ${round + 1})` : ""}…`);
    try {
      const res = (await execAshby("scan").then((x) => (Array.isArray(x) ? x : [])).catch(() => [])).find((d) => d.id === "_systemfield_resume");
      fileTrace.push(`before submit ${round + 1}: resume ${res ? (res.filled ? "shown" : "EMPTY") : "field absent"}`);
    } catch (_) { /* trace only */ }
    btn.scrollIntoView({ block: "center" });
    await sleep(3000 + Math.random() * 5000); // a person reads the form over before Submit
    await sendMsg({ type: "AUTO_SUBMITTING" }).catch(() => {}); // the runner watches for a thank-you page
    btn.click();
    // Ten seconds for Ashby to confirm; longer only while the application is
    // still on its way (a second press then could send it twice).
    for (let i = 0; i < 45; i++) {
      await sleep(2000);
      let done = false;
      try { done = (await execAshby("submitted")) === true; } catch { done = !document.querySelector(".ashby-application-form-container"); }
      if (done) {
        await ledger("submitted", { ...jobMeta(pendingJob), answersLog });
        showOverlay("✅ Auto-apply: submitted and recorded.", "success");
        return autoReport("submitted", "");
      }
      if (captchaVisible()) {
        showOverlay("⚠️ Auto-apply: Ashby is showing a CAPTCHA. Solve it and press Submit; the queue moves on.", "warning");
        return autoReport("needs_attention", "CAPTCHA challenge");
      }
      if (i >= 4 && (await execAshby("sending").catch(() => false)) !== true) break;
      // The board flagged fields and the form is still here: fix them now.
      if (i >= 3 && refill && round < 3) {
        const flagged = await execAshby("errors").then((x) => (Array.isArray(x) ? x.filter((e) => e.path) : [])).catch(() => []);
        if (flagged.length) break;
      }
    }
    // A success that showed up just after the last look is still a success.
    if ((await execAshby("submitted").catch(() => false)) === true) {
      await ledger("submitted", { ...jobMeta(pendingJob), answersLog });
      showOverlay("✅ Auto-apply: submitted and recorded.", "success");
      return autoReport("submitted", "");
    }
    const look = await execAshby("afterSubmit").catch(() => "");
    if (typeof look === "string" && look) fileTrace.push(`after submit ${round + 1}: ${look}`);
    // Ashby's bot check turned it away: pressing Submit again won't change that.
    const formSaid = (await execAshby("errors").then((x) => (Array.isArray(x) ? x : [])).catch(() => [])).find((e) => !e.path && e.label === "form")?.text || "";
    if (/spam|flagged|bot|suspicious/i.test(formSaid)) {
      ledger("filled", { ...jobMeta(pendingJob), answersLog, needsAttention: [{ label: "form", path: "", note: `after Submit: ${formSaid}` }], reasons: traceNow() }).catch(() => {});
      showOverlay(`⚠️ Auto-apply: Ashby's spam check turned this one away: "${formSaid}". Press Submit yourself.`, "warning");
      return autoReport("needs_attention", `Ashby spam check: ${formSaid}`);
    }
    // Refused: refill what went missing (a dropped resume), let the AI fix
    // every field the board flags, and press Submit again. Three rounds.
    if (refill && round < 3) {
      const n = await refill();
      if (n) { showOverlay(`⏳ Auto-apply: Ashby refused it; fixed ${n} field${n === 1 ? "" : "s"}, submitting again (try ${round + 2} of 4)…`); return autoSubmitAshby(manual, pendingJob, answersLog, refill, round + 1); }
      // Nothing to fix: Ashby sometimes takes the same form on a second press
      // (Applied Intuition, 2026-11-02). One more try after a pause.
      if (round === 0) { showOverlay("⏳ Auto-apply: Ashby did not confirm; trying Submit once more…"); await sleep(1500); return autoSubmitAshby(manual, pendingJob, answersLog, refill, round + 1); }
    }
    const errs = await execAshby("errors").then((x) => (Array.isArray(x) ? x : [])).catch(() => []);
    const said = errs.map((e) => e.text).filter(Boolean).slice(0, 2).join("; ");
    ledger("filled", { ...jobMeta(pendingJob), answersLog, needsAttention: errs.slice(0, 8).map((e) => ({ label: e.label || e.path || "form", path: e.path || "", note: `after Submit: ${e.text}` })), reasons: traceNow() }).catch(() => {});
    const open = [...new Set([...errs.filter((e) => e.path).map((e) => e.label || e.path), ...await scanEmpty()])].filter(Boolean);
    if (open.length) window.__jwNotify.show(`Auto-apply: Ashby did not accept it after ${round + 1} tries. These need you, then press Submit:`, "warning", { items: open });
    else showOverlay(`⚠️ Auto-apply: Ashby did not accept the submission${said ? `: ${said}` : ""}. Check the form and press Submit.`, "warning");
    return autoReport("needs_attention", `Ashby did not accept the submission${said ? `: ${said}` : " (no message shown)"}`);
  }

  // ─── Overlay UI: the shared JobWatch card (content/notify.js) ─────────────
  function showOverlay(text, type = "info", { action = null } = {}) {
    // The "Complete manually: a, b" messages list the fields as items.
    const m = String(text).match(/complete manually:\s*(.+?)(?:,\s*then press submit\.?)?$/i);
    const items = m ? m[1].split(/,\s*/).filter((x) => !/^\+\d+ more$/.test(x)) : null;
    window.__jwNotify.show(m ? "These still need you. Fill them in, then submit." : text, type === "info" ? undefined : type, { action, items });
  }

  // ─── Submit from the overlay ───────────────────────────────────────────────
  // The person presses the JobWatch button; it clicks Ashby's own Submit.
  // Nothing submits without that press. The existing submission watchers
  // record the application once Ashby shows its success page.
  // By its words, never by type: every Ashby button is type=submit (the
  // resume's Delete, "Upload file"), and clicking the first of those deleted
  // the resume (Applied Intuition) or did nothing (Reducto), 2026-11-02.
  function ashbySubmitButton() {
    const ok = (b) => b.offsetParent !== null && !b.closest("[data-field-path]") && !b.closest("[class*='autofill' i]");
    const all = [...document.querySelectorAll("button, input[type=submit]")].filter(ok);
    const words = (b) => (b.textContent || b.value || "").replace(/\s+/g, " ").trim();
    return all.find((b) => /^submit application$/i.test(words(b)))
      || all.find((b) => /^(submit|submit your application|apply|send application)$/i.test(words(b)))
      || all.find((b) => /\bsubmit application\b/i.test(words(b)))
      || null;
  }
  function submitAction(message, type) {
    return {
      label: "Submit application",
      onClick: async () => {
        const btn = ashbySubmitButton();
        if (!btn) { showOverlay("❌ Could not find Ashby's Submit button. Scroll down and click it yourself.", "error"); return; }
        btn.scrollIntoView({ block: "center" });
        btn.click();
        showOverlay("⏳ Submitting…");
        await sleep(3000);
        let done = false;
        try { done = (await execAshby("submitted")) === true; } catch { done = !document.querySelector(".ashby-application-form-container"); }
        if (!done) showOverlay("⚠️ Ashby did not accept it yet. Fix any field marked in red, then press Submit again.", "warning", { action: submitAction(message, type) });
      },
    };
  }
  /** Show the end-of-fill message with the Submit button attached. */
  function offerSubmit(message, type) { showOverlay(message, type, { action: submitAction(message, type) }); }

  function removeOverlay() { window.__jwNotify.hide(); }

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


  // ─── Header / stable-class helpers ─────────────────────────────────────────
  const sleep = (ms) => (window.__jwWait ? window.__jwWait(ms) : new Promise((r) => setTimeout(r, ms)));
  async function execAshby(action, ...args) {
    const res = await sendMsg({ type: "EXEC_ASHBY", action, args });
    return res?.result || { ok: false, error: "no result from main world" };
  }
  function pageIds() {
    const m = location.href.match(/ashbyhq\.com\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return m ? { org: decodeURIComponent(m[1]), id: m[2] } : null;
  }

  // ─── Application ledger (users/{uid}/applications, one record per form) ───
  function formKeyNow() {
    const ids = pageIds();
    return ids ? { formKey: `ashby|${ids.org.toLowerCase()}|${ids.id}`, source: "ashby", org: ids.org, postingId: ids.id, applyUrl: location.href.split("#")[0] } : null;
  }
  // The page's own title and org, for the same-role duplicate check when the
  // job was not queued from JobWatch (the background prefers its cached job).
  function pageJob() {
    const title = (document.querySelector(".ashby-job-posting-heading, h1")?.textContent || "").trim().slice(0, 200);
    const org = pageIds()?.org || "";
    return { jobTitle: title, companyName: org ? org.replace(/[-_]+/g, " ") : "" };
  }
  async function ledger(event, extra = {}) {
    const k = formKeyNow();
    if (!k) return { ok: false, error: "no form key" };
    const force = /jwforce/.test(location.hash);
    const meta = event === "start" ? { ...pageJob(), force } : {};
    try { return (await sendMsg({ type: "APPLICATION_EVENT", event, ...k, ...meta, ...extra })) || { ok: false }; } catch (e) { return { ok: false, error: e.message }; }
  }
  const fmtDay = (iso) => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "an earlier date"; };
  const jobMeta = (pendingJob) => ({ jobId: pendingJob?.id || "", jobTitle: pendingJob?.title || "", companyName: pendingJob?.companyName || "" });

  // ─── Apply one computed fill through the MAIN world ────────────────────────
  // The moving outline (content/highlight.js) around the question being filled.
  const hl = window.__jwHL || { focus() {}, mark() {}, hide() {} };
  const blockOf = (path) => document.querySelector(`[data-field-path="${CSS.escape(path)}"]`);

  // What happened to the resume and cover letter uploads, for the ledger log.
  const fileTrace = [];
  const traceNow = () => fileTrace.slice(-10).map((t) => `trace: ${t}`);
  async function applyFill(f, pkg, domByPath) {
    const dom = domByPath.get(f.path);
    if (!dom) return { ok: false, error: "field not on page" };
    switch (f.kind) {
      case "file": {
        const b64 = f.file === "cover" ? pkg.coverB64 : pkg.resumeB64;
        const name = f.file === "cover" ? pkg.coverName : pkg.resumeName;
        if (!b64) { fileTrace.push(`${f.file || "resume"}: no bytes`); return { ok: false, error: f.file === "cover" ? "no cover letter bytes" : "no resume bytes" }; }
        const r = await execAshby("setFile", f.path, b64, name).catch((e) => ({ ok: false, error: e.message }));
        fileTrace.push(`${f.file || "resume"} ${name} (${Math.round(b64.length * 0.75 / 1024)} KB): ${r?.ok ? `shown${r.via ? " via " + r.via : ""}` : `failed: ${r?.error || "?"}${r?.actual ? ` (input has ${r.actual})` : ""}`}`);
        return r;
      }
      case "boolean":
        if (dom.type === "radio") return execAshby("radio", f.path, f.value);
        if (dom.type === "checkbox") return execAshby("checkboxes", f.path, [f.value]);
        return execAshby("yesNo", f.path, f.value);
      case "select":
        if (dom.type === "yesno") return execAshby("yesNo", f.path, f.value);
        if (dom.type === "checkbox") return execAshby("checkboxes", f.path, [f.value]);
        // A list behind a "Start typing..." box (the scan calls every such box "location").
        if (dom.type === "location") return execAshby("choose", f.path, f.value);
        return execAshby("radio", f.path, f.value);
      case "multiselect":
        if (dom.type === "radio") return execAshby("radio", f.path, f.values[0]);
        return execAshby("checkboxes", f.path, f.values);
      case "location":
        return execAshby("location", f.path, f.value, f.match, f.alternates || []);
      case "education":
        return execAshby("education", f.path, f.entries || []);
      case "date":
        if (dom.type !== "date") return execAshby("fillText", f.path, f.value);
        return execAshby("date", f.path, f.value);
      default:
        // A phone box with SMS-consent radios inside it: number first, consent second.
        if (dom.type === "tel" && dom.consent) return execAshby("phone", f.path, String(f.value ?? ""), f.smsConsent || "Yes");
        if (dom.type === "yesno") return execAshby("yesNo", f.path, f.value);
        if (dom.type === "radio") return execAshby("radio", f.path, f.value);
        if (dom.type === "checkbox") return execAshby("checkboxes", f.path, [f.value]);
        // A digits-only box (type=number) wipes "+1 (510) 935-6846": digits
        // only, a US phone without its leading 1.
        if (dom.type === "number" || f.kind === "number") {
          const phone = /phone|mobile|cell/i.test(f.label || dom.label || "");
          let v = String(f.value ?? "").replace(phone ? /\D/g : /[^\d.-]/g, "");
          if (phone && /^1\d{10}$/.test(v)) v = v.slice(1);
          return execAshby("fillText", f.path, v);
        }
        return execAshby("fillText", f.path, String(f.value ?? ""));
    }
  }

  // ─── New flow: computed application from prepareAshbyApplication ──────────
  // Returns false when the package could not be fetched (caller falls back).
  async function engineMain() {
    const ids = pageIds();
    if (!ids) return false;
    showOverlay("⏳ JobWatch: Reading the form…");
    const scanned = await execAshby("scan");
    const domFields = Array.isArray(scanned) ? scanned : [];
    if (!domFields.length) return false;
    const domByPath = new Map(domFields.map((d) => [d.id, d]));

    showOverlay("🤖 JobWatch: Computing your answers…");
    const res = await sendMsg({ type: "GET_ASHBY_FILL_DATA", org: ids.org, id: ids.id, domFields: domFields.filter((d) => !d.survey) }).catch((e) => ({ ok: false, error: e.message }));
    if (!res?.ok || !res.data) { console.warn("[JobWatch] computed application unavailable:", res?.error); return false; }
    const pkg = res.data;
    if (pkg.alreadyApplied) {
      showOverlay(`🛑 JobWatch: you already applied to this job on ${fmtDay(pkg.submittedAt)}. Not filling it again.`, "warning");
      if (AUTO) autoReport("skipped", "already applied");
      return true;
    }
    const pendingJob = res.pendingJob || { title: pkg.jobTitle, companyName: pkg.companyName, locationName: pkg.locationName, externalId: ids.id };
    console.log(`[JobWatch] computed: ${pkg.answered}/${pkg.total} answered, ready=${pkg.ready}, schema=${pkg.schemaSource}, review=${pkg.review.length}`, pkg.review);

    // Fill in page order; anything that fails is retried twice (slow widgets).
    const order = new Map(domFields.map((d, i) => [d.id, i]));
    let pending = [...pkg.fills].filter((f) => domByPath.has(f.path)).sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));
    const skipped = pkg.fills.filter((f) => !domByPath.has(f.path)).map((f) => f.label);
    if (skipped.length) console.log("[JobWatch] not on page (skipped):", skipped);
    const answersLog = {};
    const failures = [];
    showOverlay(`✍️ JobWatch: Filling ${pending.length} fields, top to bottom…`);
    for (let pass = 1; pass <= 3 && pending.length; pass++) {
      if (pass > 1) await sleep(900);
      const still = [];
      for (const f of pending) {
        try {
          hl.focus(blockOf(f.path), `Filling: ${f.label || f.path}`);
          await execAshby("scrollTo", f.path).catch(() => {});
          const r = await applyFill(f, pkg, domByPath);
          await sleep(260);
          hl.mark(!!r?.ok);
          if (r?.ok) {
            answersLog[f.path] = { label: f.label, answer: f.kind === "file" ? (f.file === "cover" ? pkg.coverName : pkg.resumeName) : (f.values ? f.values.join("; ") : (r.picked || f.value)), type: f.kind, source: f.source };
          } else {
            still.push(f);
            if (pass === 3) failures.push({ ...f, error: r?.error, seen: r?.seen });
            console.warn(`[JobWatch] fill failed (pass ${pass}): ${f.label} — ${r?.error || "unknown"}`, r?.seen ? r.seen : "");
          }
        } catch (e) { still.push(f); if (pass === 3) failures.push({ ...f, error: e.message }); }
        await sleep(80);
      }
      pending = still;
    }
    hl.hide();

    // Verify four times, top to bottom: rescan, read the errors the board
    // itself shows, fix what can be fixed, and only then report what is left.
    const fillByPath = new Map(pkg.fills.map((f) => [f.path, f]));
    let after = [];
    let boardErrors = [];
    for (let pass = 1; pass <= 4; pass++) {
      await sleep(pass === 1 ? 500 : 900);
      window.scrollTo({ top: 0, behavior: "smooth" });
      await sleep(300);
      after = await execAshby("scan").then((x) => (Array.isArray(x) ? x : [])).catch(() => []);
      boardErrors = await execAshby("errors").then((x) => (Array.isArray(x) ? x : [])).catch(() => []);
      const problems = after.filter((d) => !d.survey && ((d.required && !d.filled) || boardErrors.some((e) => e.path === d.id)));
      console.log(`[JobWatch] verify pass ${pass}/4: ${problems.length} problem(s)`, problems.map((d) => d.label), boardErrors);
      if (!problems.length) break;
      showOverlay(`🔍 JobWatch: Checking the form, pass ${pass} of 4. Fixing ${problems.length} field${problems.length === 1 ? "" : "s"}…`);
      for (const d of problems) {
        const f = fillByPath.get(d.id);
        if (!f) continue; // the engine parked it; it stays for the person
        try {
          hl.focus(blockOf(d.id), `Fixing: ${f.label || d.label || d.id}`);
          await execAshby("scrollTo", d.id).catch(() => {});
          const r = await applyFill(f, pkg, domByPath);
          await sleep(300);
          hl.mark(!!r?.ok);
          if (r?.ok) {
            answersLog[f.path] = { label: f.label, answer: f.kind === "file" ? (f.file === "cover" ? pkg.coverName : pkg.resumeName) : (f.values ? f.values.join("; ") : (r.picked || f.value)), type: f.kind, source: f.source };
            const i = failures.findIndex((x) => x.path === f.path);
            if (i >= 0) failures.splice(i, 1);
          } else if (!failures.some((x) => x.path === f.path)) {
            failures.push({ ...f, error: r?.error, seen: r?.seen });
          }
        } catch (e) { if (!failures.some((x) => x.path === f.path)) failures.push({ ...f, error: e.message }); }
      }
      hl.hide();
    }
    hl.hide();
    // AI rescue: every mandatory field still empty or flagged goes to Claude
    // with its HTML; it says what to click, type or pick from the profile.
    const rescued = new Set();
    const rescueNotes = new Map();
    const stuck = [...new Set([
      ...after.filter((d) => d.required && !d.filled && !d.survey).map((d) => d.label),
      ...pkg.review.map((r) => r.label),
      ...boardErrors.map((e) => after.find((x) => x.id === e.path)?.label || e.label),
    ])].filter(Boolean);
    const errorOf = (label) => boardErrors.find((e) => (after.find((x) => x.id === e.path)?.label || e.label) === label)?.text || "";
    for (const label of stuck.slice(0, 10)) {
      if (!window.__jwRescue) break;
      showOverlay(`🤖 JobWatch is asking AI how to finish: ${label}`);
      const error = errorOf(label);
      // A field the board flags is fixed even when optional: it blocks Submit all the same.
      const r = await window.__jwRescue(label, { jobTitle: pkg.jobTitle || "", companyName: pkg.companyName || "", error, force: !!error });
      console.log("[JobWatch] rescue:", label, r);
      if (r?.ok) { rescued.add(label); answersLog[`rescue:${label}`] = { label, answer: r.answer || "(AI rescue)", type: "ai-rescue", source: "ai" }; }
      else if (r?.why) rescueNotes.set(label, r.why);
    }
    if (stuck.length) {
      await sleep(500);
      after = await execAshby("scan").then((x) => (Array.isArray(x) ? x : [])).catch(() => after);
      boardErrors = await execAshby("errors").then((x) => (Array.isArray(x) ? x : [])).catch(() => boardErrors);
    }
    const stillEmpty = after.filter((d) => d.required && !d.filled && !d.survey);
    const manual = new Map(); // label -> { path, note }
    // A parked question the page does not show (a follow-up to an answer we
    // did not give, "If you selected Other above...") needs nothing.
    const onPage = new Set(after.map((d) => d.id));
    for (const r of pkg.review) {
      if (r.path && after.length && !onPage.has(r.path)) continue;
      if (rescued.has(r.label) && !stillEmpty.some((d) => d.label === r.label)) continue;
      manual.set(r.label, { path: r.path || "", note: rescueNotes.has(r.label) ? `${r.note || "needs you"}. AI: ${rescueNotes.get(r.label)}` : r.note || "needs you" });
    }
    for (const d of stillEmpty) if (!manual.has(d.label)) manual.set(d.label, { path: d.id, note: failures.find((f) => f.path === d.id)?.error || "still empty after four checks" });
    for (const e of boardErrors) {
      if (!e.path) continue;
      const d = after.find((x) => x.id === e.path);
      const label = d?.label || e.label || e.path;
      const prev = manual.get(label);
      manual.set(label, { path: e.path, note: prev ? `${prev.note}. The form says: ${e.text}` : `The form says: ${e.text}` });
    }
    const needsAttention = [...manual.entries()].map(([label, v]) => ({ label, path: v.path, note: v.note }));
    // What the person types into these before Submit goes to the answer bank.
    if (manual.size && window.__jwLearnManual) window.__jwLearnManual([...manual.keys()], { jobTitle: pkg.jobTitle || "", companyName: pkg.companyName || "" });
    console.log("[JobWatch] Filled. answersLog:", JSON.stringify(answersLog, null, 2));
    if (manual.size) {
      const names = [...manual.keys()].slice(0, 3).map((l) => (l.length > 38 ? l.slice(0, 38) + "…" : l));
      offerSubmit(`⚠️ ${Object.keys(answersLog).length} filled. Complete manually: ${names.join(", ")}${manual.size > 3 ? `, +${manual.size - 3} more` : ""}, then press Submit.`, "warning");
      console.warn("[JobWatch] Needs you:", needsAttention);
    } else {
      offerSubmit(`✅ ${Object.keys(answersLog).length} fields filled — review it, then press Submit.`, "success");
    }
    // Record the attempt: every answer, everything left for the person.
    const mainFields = domFields.filter((d) => !d.survey);
    ledger("filled", {
      ...jobMeta(pendingJob), answersLog, needsAttention,
      filledCount: Object.keys(answersLog).length, totalFields: mainFields.length, requiredTotal: mainFields.filter((d) => d.required).length,
      flow: "engine", schemaSource: pkg.schemaSource || "", reasons: [...(pkg.reasons || []), ...traceNow()],
    }).then((r) => { if (!r?.ok) console.warn("[JobWatch] ledger(filled) failed:", r?.error); });

    // Submit, auto-apply or not (the person's call, 2026-11-02): a form
    // JobWatch filled goes in on its own, with the same repair rounds.
    {
      // After a refused Submit: fill again whatever the form has lost (Ashby
      // can drop an uploaded resume), from the same computed answers.
      // Then every field the board flags (or left empty) goes to the AI with
      // its HTML and the board's own error text, which says what to change.
      const refill = async () => {
        const now = await execAshby("scan").then((x) => (Array.isArray(x) ? x : [])).catch(() => []);
        const errs = await execAshby("errors").then((x) => (Array.isArray(x) ? x : [])).catch(() => []);
        const byPath = new Map(now.map((d) => [d.id, d]));
        let n = 0;
        // The resume always goes in, also where the form calls it optional.
        for (const d of now.filter((x) => (x.required || x.id === "_systemfield_resume") && !x.filled && !x.survey)) {
          const f = fillByPath.get(d.id);
          if (!f) continue;
          const r = await applyFill(f, pkg, byPath).catch(() => null);
          if (r?.ok) n++;
        }
        if (!window.__jwRescue) return n;
        const after2 = await execAshby("scan").then((x) => (Array.isArray(x) ? x : [])).catch(() => now);
        const targets = new Map(); // label -> error text
        for (const e of errs) {
          if (!e.path && e.label === "form") continue; // the whole form's message, not a field
          const d = after2.find((x) => x.id === e.path);
          const label = d?.label || e.label;
          if (label && !targets.has(label)) targets.set(label, e.text);
        }
        for (const d of after2.filter((x) => x.required && !x.filled && !x.survey)) if (!targets.has(d.label)) targets.set(d.label, "");
        // A file box is not the AI's to fill (the resume goes in from its bytes above).
        for (const d of after2.filter((x) => x.type === "file" || x.id === "_systemfield_resume")) targets.delete(d.label);
        for (const [label, error] of [...targets].slice(0, 10)) {
          showOverlay(`🤖 JobWatch is asking AI to fix: ${label}`);
          const r = await window.__jwRescue(label, { jobTitle: pkg.jobTitle || "", companyName: pkg.companyName || "", error, force: !!error }).catch(() => null);
          console.log("[JobWatch] repair:", label, error, r);
          if (r?.ok) { n++; answersLog[`rescue:${label}`] = { label, answer: r.answer || "(AI rescue)", type: "ai-rescue", source: "ai" }; }
        }
        return n;
      };
      await autoSubmitAshby(manual, pendingJob, answersLog, refill);
      return true;
    }
    // Otherwise never auto-submit. Watch for the person's own submission (30
    // min) so the job is logged as applied and the queue advances.
    const watchStart = Date.now();
    const watch = setInterval(async () => {
      let done = false;
      try { done = (await execAshby("submitted")) === true; } catch { done = !document.querySelector(".ashby-application-form-container"); }
      if (done) {
        clearInterval(watch);
        ledger("submitted", { ...jobMeta(pendingJob), answersLog });
        showOverlay("✅ Application submitted and recorded.", "success");
        setTimeout(removeOverlay, 4000);
      } else if (Date.now() - watchStart > 30 * 60 * 1000) {
        clearInterval(watch);
      }
    }, 2000);
    return true;
  }

  async function legacyMain(form) {
  try {

    // Extract Ashby's schema from MAIN world FIRST — gives us authoritative field types
    const schemaMap = await extractAshbySchema();
    const fields = scrapeFields(form, schemaMap);
    if (!fields.length) return;

    const answersLog = {}; // { fieldId: { label, answer, type } }

    showOverlay("⏳ JobWatch: Fetching your profile…");
    const fillData = await sendMsg({ type: "GET_FILL_DATA", fields });
    const { userDoc, mappings, pendingJob, resumeBase64, resumeDoc = {} } = fillData;

    // Apply deterministic rule engines BEFORE filling
    // This entirely overrides AI for standard questions (Phone, LinkedIn, Visa, Office)
    const jobLocation = getPageJobLocation(pendingJob);
    applyTextRules(fields, mappings, userDoc, resumeDoc, jobLocation);
    applyYesNoRules(fields, mappings, userDoc);

    showOverlay("✍️ JobWatch: Filling form…");
    await window.__jwWait(600);
    await applyMappings(form, fields, mappings, userDoc, pendingJob, resumeBase64, answersLog);
    await fillEEOSurvey(userDoc, answersLog);

    // ── Pre-submit: fix any still-empty required fields ───────────────────
    showOverlay("🔍 JobWatch: Verifying required fields…");
    await window.__jwWait(400);
    const preCheck = getUnfilledRequired(form, fields, answersLog);

    if (preCheck.length) {
      showOverlay(`🤖 AI filling ${preCheck.length} missing field(s)…`);
      try {
        const retry = await sendMsg({ type: "GET_FILL_DATA", fields: preCheck });
        applyTextRules(preCheck, retry.mappings, userDoc, resumeDoc, jobLocation);
        applyYesNoRules(preCheck, retry.mappings, userDoc);
        await applyMappings(form, preCheck, retry.mappings, userDoc, pendingJob, resumeBase64, answersLog);
        await window.__jwWait(400);
      } catch (e) { console.warn("[JobWatch] Pre-submit retry error:", e.message); }

      const stillEmpty = getUnfilledRequired(form, fields, answersLog);
      if (stillEmpty.length) {
        const displayLabels = stillEmpty.slice(0, 2).map(f => {
          let l = f.label.replace(/\s*\([^)]*\)/g, '');
          return l.length > 35 ? l.substring(0, 35) + "…" : l;
        });
        let msg = `⚠️ Complete manually: ${displayLabels.join(", ")}`;
        if (stillEmpty.length > 2) msg += `, +${stillEmpty.length - 2} more`;
        offerSubmit(msg + ", then press Submit.", "warning");
        console.warn("[JobWatch] Still missing:", stillEmpty);
        ledger("filled", {
          ...jobMeta(pendingJob), answersLog,
          needsAttention: stillEmpty.map((f) => ({ path: f.id || "", label: f.label || "", note: "still empty after the legacy fill" })),
          filledCount: Object.keys(answersLog).length, totalFields: fields.length, requiredTotal: fields.filter((f) => f.required).length, flow: "legacy",
        });
        watchForSubmit(pendingJob, answersLog);
        return;
      }
    }

    // ── NEVER auto-submit: you review the form and click Submit yourself. ──
    console.log("[JobWatch] Filled. answersLog:", JSON.stringify(answersLog, null, 2));
    ledger("filled", { ...jobMeta(pendingJob), answersLog, needsAttention: [], filledCount: Object.keys(answersLog).length, totalFields: fields.length, requiredTotal: fields.filter((f) => f.required).length, flow: "legacy" });
    offerSubmit("✅ Form filled — review it, then press Submit.", "success");

    watchForSubmit(pendingJob, answersLog);

  } catch (err) {
    console.error("[JobWatch Extension]", err);
    showOverlay(`❌ ${err.message}`, "error");
    ledger("error", { error: err.message });
  }

  }

  // Watch for the person's own submission (30 min) so the ledger closes the
  // record and the queue advances. Never clicks Submit.
  function watchForSubmit(pendingJob, answersLog) {
    const watchStart = Date.now();
    const watch = setInterval(() => {
      const isSuccess = !document.querySelector(".ashby-application-form-container") ||
        window.location.href.includes("success") ||
        !!document.querySelector(".ashby-application-success, [class*='successContainer']");
      if (isSuccess) {
        clearInterval(watch);
        ledger("submitted", { ...jobMeta(pendingJob), answersLog });
        showOverlay("✅ Application submitted and recorded.", "success");
        setTimeout(removeOverlay, 4000);
      } else if (Date.now() - watchStart > 30 * 60 * 1000) {
        clearInterval(watch);
      }
    }, 2000);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MAIN — computed application first, legacy mapper as the fallback
  // ─────────────────────────────────────────────────────────────────────────
  // Nothing fills on page load: the card offers Autofill and the person presses
  // it. A tab opened by the unattended auto-apply starts on its own.
  try { await waitForForm(15000); } catch { if (AUTO) autoReport("error", "the Ashby form never appeared"); return; }
  if (AUTO) { showOverlay("🤖 Auto-apply: filling this application…"); autofill(); }
  else window.__jwNotify.launcher({ onClick: () => { autofill(); } });

  async function autofill() {
  try {
    const form = await waitForForm();
    window.__jwNotify.show("JobWatch is reading the form…", "working");
    await sleep(600); // let the yes/no, autocomplete and date widgets mount
    // Every form visit is an attempt in the ledger; a form already submitted
    // is never filled again.
    const started = await ledger("start");
    if (started?.duplicate) {
      showOverlay(`🛑 JobWatch: you already applied to ${started.reason === "same role" ? "this role at this company" : "this job"} on ${fmtDay(started.submittedAt)}. Not filling it again. Add #jwforce to the URL and reload to fill anyway.`, "warning");
      if (AUTO) autoReport("skipped", "already applied");
      return;
    }
    if (!started?.ok) console.warn("[JobWatch] ledger(start) failed:", started?.error);
    let done = false;
    try { done = await engineMain(); } catch (e) { console.warn("[JobWatch] engine flow failed, using legacy fill:", e.message); }
    // Auto-apply never submits from the older label mapper: it reports instead.
    if (!done && AUTO) { showOverlay("❌ Auto-apply: could not compute this application.", "error"); autoReport("error", "the answer engine could not compute this form"); return; }
    if (!done) await legacyMain(form);
  } catch (err) {
    console.error("[JobWatch Extension]", err);
    showOverlay(`❌ ${err.message}`, "error");
    ledger("error", { error: err.message });
    if (AUTO) autoReport("error", err.message);
  }
  }

})();
