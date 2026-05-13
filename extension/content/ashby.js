
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
    const container = entry.querySelector("[class*='_yesno_']") || entry;
    const target = (answer || "").toLowerCase().trim();
    const buttons = [...container.querySelectorAll("button")];
    if (buttons.length < 2) return false;
    
    // Find the button that matches the answer text exactly, or fallback to index 0/1 for yes/no
    const btn = buttons.find(b => b.textContent.trim().toLowerCase() === target)
      || (target === "yes" ? buttons[0] : buttons[1]);
    
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
      const buttons = [...entry.querySelectorAll("button")];
      const isYesNo = yesNoEl || (buttons.length === 2 && /yes/i.test(buttons[0].textContent) && /no/i.test(buttons[1].textContent));
      
      const combobox = entry.querySelector("input[role='combobox']");
      const radioEl = entry.querySelector("input[type=radio]");
      const checkboxEl = entry.querySelector("input[type=checkbox]");
      const inputEl = entry.querySelector("input:not([type=file]):not([role=combobox]):not([type=radio]):not([type=checkbox]), textarea");

      let type;
      if (fileInput) type = "file";
      else if (isYesNo) type = "yesno";
      else if (combobox || id === "_systemfield_location") type = "location";
      else if (radioEl) type = "radio";
      else if (checkboxEl) type = "checkbox";
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
          /notice.*required/i, /required.*notice/i, /when.*start.*notice/i],
        answer: () => userDoc.noticePeriod || "2 weeks"
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
      // Work authorization — YES (authorized) or NO (not authorized)
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
    ];

    const FIELD_TYPES_HANDLED = new Set(["yesno", "radio"]);
    for (const field of fields) {
      if (!FIELD_TYPES_HANDLED.has(field.type)) continue;
      const lbl = field.label || "";

      // For RADIO fields that ask yes/no — check if options are just Yes/No
      // and apply the same rule engine
      if (field.type === "radio") {
        const opts = (field.options || []).map(o => o.label.toLowerCase().trim());
        const isYesNoRadio = opts.includes("yes") && opts.includes("no") && opts.length <= 3;
        if (!isYesNoRadio) continue; // not a yes/no radio, skip
      }

      // Do not auto-default required yes/no fields to "no" anymore.
      // Unrecognized questions (e.g. compliance, strict requirements) should fall to AI or manual review.
      for (const rule of RULES) {
        if (rule.patterns.some(p => p.test(lbl))) {
          const ans = rule.answer();
          const current = (mappings[field.id] || "").toLowerCase().trim();
          if (current !== "yes" && current !== "no") {
            mappings[field.id] = ans;
            console.log(`[JobWatch] Rule engine overrode "${lbl}" → ${ans}`);
          } else if (current === "yes" && ans === "no") {
            mappings[field.id] = ans;
            console.log(`[JobWatch] Rule engine corrected "${lbl}": yes → no`);
          } else if (current === "no" && ans === "yes") {
            mappings[field.id] = ans;
            console.log(`[JobWatch] Rule engine corrected "${lbl}": no → yes`);
          }
          break;
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
            if (shouldCheck && !cb.checked) { cb.click(); await new Promise(r => setTimeout(r, 100)); }
            if (cb.checked) checked.push(getInputLabel(cb, entry));
          }
        } else if (isHowDidYouHear) {
          // Only check "LinkedIn" option
          for (const cb of checkboxes) {
            const cbLabel = getInputLabel(cb, entry).toLowerCase();
            if (cbLabel.includes("linkedin")) {
              if (!cb.checked) { cb.click(); await new Promise(r => setTimeout(r, 100)); }
              checked.push(getInputLabel(cb, entry));
              break;
            }
          }
        } else if (lbl.includes("consent") || lbl.includes("acknowledge") || lbl.includes("certify") || lbl.includes("privacy") || lbl.includes("agreement") || lbl.includes("arbitration") || lbl.includes("background") || lbl.includes("drug test")) {
          // Legal agreements / consent / explicitly recognized — check all
          for (const cb of checkboxes) {
            if (!cb.checked) { cb.click(); await new Promise(r => setTimeout(r, 100)); }
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
        const calendarTrigger = entry.querySelector("[data-testid='date-picker'], [class*='datePicker'], [class*='DatePicker'], [class*='calendar'], button[aria-label*='calendar']")
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
            await new Promise(r => setTimeout(r, 400));
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
                if (arrowBtn) { arrowBtn.click(); await new Promise(r => setTimeout(r, 250)); }
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
              await new Promise(r => setTimeout(r, 300));
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

        // For yes/no radios: the applyYesNoRules already set mappings[field.id] = "yes"/"no"
        // For location/office radios: try to match job location
        if (!answer && (lbl.includes("location") || lbl.includes("office") || lbl.includes("which city") ||
          lbl.includes("interested in") || lbl.includes("which site"))) {
          if (pendingJob?.locationName) answer = pendingJob.locationName;
        }

        // For "where are you based" with city/state hint — answer with user's city
        if (!answer && (lbl.includes("where are you based") || lbl.includes("where do you live") || lbl.includes("which city are you in"))) {
          answer = [userDoc.city, userDoc.region].filter(Boolean).join(", ");
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
      } else if (field.type === "yesno") {
        const activeBtn = entry.querySelector("button[aria-pressed='true'], button._active_101oc_20, [class*='_active_']");
        if (!activeBtn) missing.push(field);
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
        showOverlay(msg, "warning");
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
      showOverlay("⚠️ Submit button not found — please submit manually.", "warning");
      return;
    }

    // ── Submit loop with error-recovery (up to 2 retries) ────────────────
    const MAX_RETRIES = 2;
    let submitted = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      showOverlay(attempt === 0 ? "🚀 JobWatch: Submitting…" : `🔄 Retrying submission (${attempt}/${MAX_RETRIES})…`);
      console.log("[JobWatch] Submitting. answersLog:", JSON.stringify(answersLog, null, 2));
      submitBtn.click();
      
      // Poll for success or errors over ~5 seconds
      let formErrors = [];
      for (let poll = 0; poll < 10; poll++) {
        await new Promise(r => setTimeout(r, 500));
        
        // 1. Check for success (unmounted form, success URL, or success container)
        const isSuccess = !document.querySelector(".ashby-application-form-container") || 
                          window.location.href.includes("success") || 
                          !!document.querySelector(".ashby-application-success, [class*='successContainer']");
        
        if (isSuccess) {
          submitted = true;
          break;
        }

        // 2. Check for validation errors
        formErrors = scrapeFormErrors(form);
        const hasIndicators = !!document.querySelector("[class*='_errorsContainer_'], [aria-invalid='true'], [class*='_error_']");
        
        if (formErrors.length > 0 || hasIndicators) {
          break; // Stop polling, we have errors
        }
      }

      if (submitted) break;

      if (attempt < MAX_RETRIES && formErrors.length) {
        showOverlay(`🤖 AI resolving ${formErrors.length} error(s)…`, "ai");
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
      showOverlay("⚠️ Form has errors — please fix and resubmit manually.", "warning");
      return;
    }

    // ── Success ───────────────────────────────────────────────────────────
    showOverlay("✅ Application submitted!", "success");

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
    showOverlay(`❌ ${err.message}`, "error");
    setTimeout(removeOverlay, 6000);
  }

})();
