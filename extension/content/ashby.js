
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

  // ─── Fill location combobox ───────────────────────────────────────────────
  async function fillLocation(entry, value) {
    const box = entry.querySelector("input[role='combobox']") || entry.querySelector("input");
    if (!box || !value) return;

    // Clear any existing value first
    box.focus();
    box.click();
    await new Promise(r => setTimeout(r, 200));

    // Select-all + delete to clear
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }));
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    await new Promise(r => setTimeout(r, 100));

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
      await new Promise(r => setTimeout(r, 100));
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
      await new Promise(r => setTimeout(r, 400));

      // Verify it accepted by checking the input has a non-empty value
      if (!box.value) {
        // Try mousedown + mouseup combo (some dropdowns require it)
        option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        option.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        option.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
      }
    } else {
      // No dropdown appeared — press Enter as last resort
      console.warn("[JobWatch] Location: no dropdown found, pressing Enter for:", value);
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }
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

  // ─── Deterministic Text Rule Engine ────────────────────────────────────────
  // Instantly maps known text fields using regex — no Claude needed.
  function applyTextRules(fields, mappings, userDoc, resumeDoc = {}) {
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
        patterns: [/phone/i, /tel/i, /mobile/i],
        answer: () => userDoc.phone || ""
      },

      // ── Social / URLs ──────────────────────────────────────────────────────
      {
        patterns: [/linkedin/i, /linked.?in/i],
        answer: () => userDoc.linkedin || ""
      },
      // Combined "GitHub/Portfolio/Twitter/Etc" fields
      {
        patterns: [/github.*portfolio|portfolio.*github|github.*twitter|social.*link/i],
        answer: () => userDoc.github || userDoc.portfolio || ""
      },
      {
        patterns: [/github/i, /git.?hub/i],
        answer: () => userDoc.github || ""
      },
      {
        patterns: [/portfolio/i, /personal.?site/i, /portfolio.?link/i, /portfolio.?url/i],
        answer: () => userDoc.portfolio || ""
      },
      {
        patterns: [/^website$/i, /personal.?website/i],
        answer: () => userDoc.portfolio || ""
      },

      // ── Location (text inputs — the Location widget type is handled separately) ──
      {
        patterns: [/^location$/i, /current.?location/i, /where.*located/i, /where.*based/i, /where.*currently/i],
        answer: () => cityRegion
      },

      // ── Availability / Start Date ──────────────────────────────────────
      {
        patterns: [/start.?date/i, /availability/i, /when can you start/i,
          /soonest.*start/i, /available.*start/i, /earliest.*start/i,
          /when.*available/i, /when.*start.*full/i, /available.*full.?time/i,
          /please list your current availability/i],
        answer: () => userDoc.availability || "Immediately"
      },

      // ── Current Company (from last resume role) ───────────────────────────
      {
        patterns: [/current.?company/i, /current.?employer/i, /where.*currently.*work/i,
          /where.*most.*recently.*work/i, /most.*recent.*employer/i],
        answer: () => (resumeDoc?.roles?.[0]?.company) || ""
      },

      // ── How did you hear about this role ─────────────────────────────
      {
        patterns: [/how did you hear/i, /how.*hear.*about/i, /how.*find.*role/i,
          /how.*discover/i, /referral.*source/i, /source.*referral/i],
        answer: () => "LinkedIn"
      },

      // ── Visa sponsorship as text (some companies use Textarea not yesno) ───
      {
        patterns: [/require.*sponsorship/i, /need.*sponsorship/i, /visa.*sponsorship/i,
          /sponsorship.*visa/i, /h.?1.?b/i],
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
      for (const rule of RULES) {
        if (rule.patterns.some(p => p.test(lbl))) {
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
  // Overrides Claude answers for well-known checkbox questions so we never
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
      // Work authorization — answer YES
      {
        patterns: [
          /authoriz.{0,30}work/i,
          /eligible.{0,30}work/i,
          /legally.{0,30}work/i,
          /right.{0,15}work/i,
          /work.{0,20}authoriz/i,
          /authoriz.{0,20}employ/i,
          /permitted.{0,20}work/i,
        ],
        answer: () => isAuthorized ? "yes" : "no",
      },
      // Visa / sponsorship — answer NO (user does not need it)
      {
        patterns: [
          /require.{0,30}sponsorship/i,
          /need.{0,20}sponsorship/i,
          /sponsorship.{0,30}visa/i,
          /visa.{0,20}sponsorship/i,
          /h.?1.?b/i,
          /immigration.{0,20}sponsor/i,
          /work.{0,20}permit.{0,20}sponsor/i,
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
      // Office / hybrid / in-person — answer YES
      {
        patterns: [
          /comfortable.{0,40}(office|hybrid|in.person|on.?site)/i,
          /work.{0,30}(office|hybrid|in.person|on.?site)/i,
          /in.office.{0,30}(day|week|month)/i,
          /on.?site/i,
          /commut/i,
        ],
        answer: () => openToOffice ? "yes" : "no",
      },
      // Relocation — answer YES
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
    ];

    for (const field of fields) {
      if (field.type !== "yesno") continue;
      const lbl = field.label || "";
      // Fallback for required yesno fields not matched by any rule:
      // job-specific experience questions ("Have you worked at X?", "Do you have X?")
      // default to "no" — safer than leaving blank or letting Claude guess wrong
      if (!mappings[field.id] && field.required) {
        let ruleMatched = false;
        for (const rule of RULES) {
          if (rule.patterns.some(p => p.test(lbl))) { ruleMatched = true; break; }
        }
        if (!ruleMatched) {
          mappings[field.id] = "no";
          console.log(`[JobWatch] YesNo fallback "no" for unrecognised field: "${lbl}"`);
        }
      }
      for (const rule of RULES) {
        if (rule.patterns.some(p => p.test(lbl))) {
          const ans = rule.answer();
          // Only override if Claude's answer doesn't look like a valid yes/no
          const current = (mappings[field.id] || "").toLowerCase().trim();
          if (current !== "yes" && current !== "no") {
            // Claude returned something non-binary — always override
            mappings[field.id] = ans;
            console.log(`[JobWatch] Rule engine overrode "${lbl}" → ${ans}`);
          } else if (current === "yes" && ans === "no") {
            // Claude said yes but rule says no — trust rule engine
            mappings[field.id] = ans;
            console.log(`[JobWatch] Rule engine corrected "${lbl}": yes → no`);
          } else if (current === "no" && ans === "yes") {
            // Claude said no but rule says yes — trust rule engine
            mappings[field.id] = ans;
            console.log(`[JobWatch] Rule engine corrected "${lbl}": no → yes`);
          }
          break; // first matching rule wins
        }
      }
    }
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
        // Priority:
        // 1) Ashby embeds job data as JSON in __NEXT_DATA__ — most reliable
        // 2) JSON-LD schema — used by newer Ashby/Parafin instances
        // 3) pendingJob from session storage (set when auto-apply was triggered)
        // 4) Nothing — never fall back to Claude's answer or user's home city
        let pageJobLocation = null;
        try {
          const nextData = JSON.parse(document.getElementById("__NEXT_DATA__")?.textContent || "{}");
          pageJobLocation =
            nextData?.props?.pageProps?.posting?.locationName
            || nextData?.props?.pageProps?.jobPosting?.locationName
            || nextData?.props?.pageProps?.job?.locationName
            || null;
        } catch (e) { }

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
          } catch (e) { }
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

      // DATE PICKER
      if (field.type === "date" || field.type === "Date Picker") {
        const val = mappings[field.id] || userDoc.availability || "";
        if (val) {
          const input = entry.querySelector("input[type=date], input[type=text]");
          if (input) {
            await setInputValue(field.id, val);
            answersLog[field.id] = { label: field.label, answer: val, type: "date" };
          }
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
  // ─── Premium Toast Notification ──────────────────────────────────────────
  const TOAST_ICONS = {
    "⏳": "⏳", "✍️": "✍️", "🔍": "🔍", "🤖": "🤖",
    "🚀": "🚀", "🔄": "🔄", "✅": "✅", "⚠️": "⚠️", "❌": "❌"
  };

  function showOverlay(text, type = "info") {
    // Inject styles once
    if (!document.getElementById("jw-toast-styles")) {
      const s = document.createElement("style");
      s.id = "jw-toast-styles";
      s.textContent = `
        #jw-overlay {
          position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
          display: flex; align-items: center; gap: 12px;
          padding: 12px 16px; border-radius: 12px; max-width: 380px;
          font-family: 'Inter', system-ui, sans-serif; font-size: 13px; font-weight: 500;
          color: #f1f5f9; background: rgba(15, 15, 26, 0.95);
          backdrop-filter: blur(20px) saturate(180%);
          -webkit-backdrop-filter: blur(20px) saturate(180%);
          border: 1px solid rgba(255,255,255,0.1);
          box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.04);
          transform: translateY(12px); opacity: 0;
          transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.25s ease, border-color 0.3s;
          will-change: transform, opacity;
          box-sizing: border-box;
        }
        #jw-overlay * { box-sizing: border-box; }
        #jw-overlay.jw-visible { transform: translateY(0); opacity: 1; }
        #jw-overlay.jw-hiding  { transform: translateY(8px); opacity: 0; }
        #jw-overlay-icon { 
          font-size: 18px; flex-shrink: 0; 
          line-height: 1 !important; margin: 0 !important; padding: 0 !important;
          display: flex; align-items: center; justify-content: center;
        }
        #jw-overlay-text { 
          flex: 1; word-break: break-word; 
          line-height: 1.5 !important; margin: 0 !important; padding: 0 !important;
        }
      `;
      document.head.appendChild(s);
    }

    const COLORS = {
      info: { border: "rgba(99,102,241,0.35)", bar: "linear-gradient(90deg,#4f46e5,#7c3aed)" },
      success: { border: "rgba(16,185,129,0.35)", bar: "linear-gradient(90deg,#10b981,#34d399)" },
      warning: { border: "rgba(245,158,11,0.35)", bar: "linear-gradient(90deg,#f59e0b,#fbbf24)" },
      error: { border: "rgba(239,68,68,0.35)", bar: "linear-gradient(90deg,#ef4444,#f87171)" },
      ai: { border: "rgba(124,58,237,0.35)", bar: "linear-gradient(90deg,#7c3aed,#a855f7)" },
    };

    // Detect type from emoji prefix if type not explicitly set
    if (type === "info") {
      if (text.startsWith("✅")) type = "success";
      else if (text.startsWith("⚠️")) type = "warning";
      else if (text.startsWith("❌")) type = "error";
      else if (text.startsWith("🤖") || text.startsWith("🔄")) type = "ai";
    }

    const colors = COLORS[type] || COLORS.info;

    // Extract icon (first emoji char cluster)
    const iconMatch = text.match(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F|\p{Extended_Pictographic})\s*/u);
    const icon = iconMatch ? iconMatch[0].trim() : "🔹";
    const message = iconMatch ? text.slice(iconMatch[0].length).trim() : text;

    let el = document.getElementById("jw-overlay");
    if (!el) {
      el = document.createElement("div");
      el.id = "jw-overlay";
      el.innerHTML = `<div id="jw-overlay-icon"></div><div id="jw-overlay-text"></div>`;
      document.body.appendChild(el);
      requestAnimationFrame(() => el.classList.add("jw-visible"));
    }

    el.classList.remove("jw-hiding");
    requestAnimationFrame(() => el.classList.add("jw-visible"));
    el.style.borderColor = colors.border;
    el.querySelector("#jw-overlay-icon").textContent = icon;
    el.querySelector("#jw-overlay-text").textContent = message;
  }

  function removeOverlay() {
    const el = document.getElementById("jw-overlay");
    if (!el) return;
    el.classList.remove("jw-visible");
    el.classList.add("jw-hiding");
    setTimeout(() => el.remove(), 350);
  }

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
    const { userDoc, mappings, pendingJob, resumeBase64, resumeDoc = {} } = fillData;

    // Apply deterministic rule engines BEFORE filling
    // This entirely overrides Claude for standard questions (Phone, LinkedIn, Visa, Office)
    applyTextRules(fields, mappings, userDoc, resumeDoc);
    applyYesNoRules(fields, mappings, userDoc);

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
        applyTextRules(preCheck, retry.mappings, userDoc, resumeDoc);
        applyYesNoRules(preCheck, retry.mappings, userDoc);
        await applyMappings(form, preCheck, retry.mappings, userDoc, pendingJob, resumeBase64, answersLog);
        await new Promise(r => setTimeout(r, 400));
      } catch (e) { console.warn("[JobWatch] Pre-submit retry error:", e.message); }

      const stillEmpty = getUnfilledRequired(form, fields);
      if (stillEmpty.length) {
        const displayLabels = stillEmpty.slice(0, 2).map(f => {
          let l = f.label.replace(/\s*\([^)]*\)/g, '');
          return l.length > 35 ? l.substring(0, 35) + "…" : l;
        });
        let msg = `⚠️ Complete manually: ${displayLabels.join(", ")}`;
        if (stillEmpty.length > 2) msg += `, +${stillEmpty.length - 2} more`;
        showOverlay(msg, "#f59e0b");
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
