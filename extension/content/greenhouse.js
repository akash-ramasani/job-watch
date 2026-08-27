// greenhouse.js — auto-fill a Greenhouse application form.
//
// Flow: read token+id from the URL -> ask the background for the computed
// application (prepareGreenhouseApplication) -> fill every field by matching
// the answer's label to the rendered field's label -> upload the resume ->
// STOP before submit. You solve any CAPTCHA and click Submit.
//
// Greenhouse renders a React form: text inputs, custom comboboxes (click then
// pick), file inputs, and a consent checkbox. All DOM mutation that React must
// notice goes through the background's MAIN-world executor (EXEC_MAIN_WORLD).

(function () {
  "use strict";
  const TAG = "[JobWatch/GH]";
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sendMsg = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

  // Normalize a label for matching: drop the required "*", trailing ":", and
  // collapse whitespace. "State:*" and "State:" both become "state".
  const norm = (s) => (s || "").replace(/\*+/g, "").replace(/\s+/g, " ").trim().replace(/:$/, "").toLowerCase();

  // ── Read token + id from the URL ─────────────────────────────────────────
  function jobIds() {
    const u = new URL(location.href);
    // embed: ?for=westmonroe4&token=5801015004
    let token = u.searchParams.get("for");
    let id = u.searchParams.get("token");
    // hosted: job-boards.greenhouse.io/{token}/jobs/{id}
    if (!token || !id) {
      const m = location.pathname.match(/\/([^/]+)\/jobs\/(\d+)/);
      if (m) { token = m[1]; id = m[2]; }
    }
    return token && id ? { token, id } : null;
  }

  // ── Find the rendered field element for a given answer label ──────────────
  // Greenhouse gives each field a wrapper; the label text is in a <label>.
  // Space-insensitive compare: the form API says "VeteranStatus" while the
  // page renders "Veteran Status".
  const squash = (s) => norm(s).replace(/\s+/g, "");

  function findFieldByLabel(label) {
    const want = norm(label);
    const wantSquashed = squash(label);
    const labels = [...document.querySelectorAll("label")];
    for (const lab of labels) {
      if (norm(lab.textContent) !== want && squash(lab.textContent) !== wantSquashed) continue;
      // the control is referenced by "for", or sits inside/next to the label
      const forId = lab.getAttribute("for");
      if (forId) {
        const el = document.getElementById(forId);
        if (el) return el;
      }
      const wrap = lab.closest("div");
      const ctrl = wrap && wrap.querySelector("input, textarea, select, [role=combobox]");
      if (ctrl) return ctrl;
    }
    return null;
  }

  // Prefix variant — the location field renders as "Location (City)" while the
  // form JSON labels it "Location".
  function findFieldByLabelPrefix(prefix) {
    const want = norm(prefix);
    for (const lab of [...document.querySelectorAll("label")]) {
      if (!norm(lab.textContent).startsWith(want)) continue;
      const forId = lab.getAttribute("for");
      if (forId) {
        const el = document.getElementById(forId);
        if (el) return el;
      }
      const wrap = lab.closest("div");
      const ctrl = wrap && wrap.querySelector("input, textarea, select, [role=combobox]");
      if (ctrl) return ctrl;
    }
    return null;
  }

  // Containment variant for EEO fills: "race" finds "Please identify your race".
  function findFieldByLabelContains(token) {
    const want = norm(token);
    for (const lab of [...document.querySelectorAll("label")]) {
      if (!norm(lab.textContent).includes(want)) continue;
      const forId = lab.getAttribute("for");
      if (forId) {
        const el = document.getElementById(forId);
        if (el) return el;
      }
      const wrap = lab.closest("div");
      const ctrl = wrap && wrap.querySelector("input, textarea, select, [role=combobox]");
      if (ctrl) return ctrl;
    }
    return null;
  }

  const isCombobox = (el) => el.getAttribute && (el.getAttribute("role") === "combobox" || el.getAttribute("aria-haspopup") === "listbox");

  // ── Fillers (route through MAIN world). Each returns the MAIN-world result
  // object ({ ok, error?, seen? }) so failures can be logged with details. ──
  async function fillText(el, value) {
    const r = await sendMsg({ type: "EXEC_MAIN_WORLD", action: "setInput", id: el.id, value });
    return r?.result || { ok: false, error: "no result" };
  }
  async function fillCombobox(el, value) {
    const r = await sendMsg({ type: "EXEC_MAIN_WORLD", action: "ghSelectCombobox", id: el.id, value });
    return r?.result || { ok: false, error: "no result" };
  }
  async function checkBox(el) {
    const r = await sendMsg({ type: "EXEC_MAIN_WORLD", action: "ghCheck", id: el.id });
    return r?.result || { ok: false, error: "no result" };
  }
  async function uploadFile(el, b64, name) {
    // el may be null: the resume widget has no <label>, so the MAIN-world side
    // locates the file input itself when the id is empty.
    const r = await sendMsg({ type: "EXEC_MAIN_WORLD", action: "setFile", id: el?.id || "", b64Data: b64, fileName: name });
    return r?.result || { ok: false, error: "no result" };
  }
  async function fillLocation(el, city, match) {
    const r = await sendMsg({ type: "EXEC_MAIN_WORLD", action: "ghLocation", id: el.id, value: city, match });
    return r?.result || { ok: false, error: "no result" };
  }
  async function pasteCoverLetter(text) {
    const r = await sendMsg({ type: "EXEC_MAIN_WORLD", action: "ghCoverText", id: "", value: text });
    return r?.result || { ok: false, error: "no result" };
  }

  // ── Main ──────────────────────────────────────────────────────────────────
  async function run() {
    const ids = jobIds();
    if (!ids) { warn("could not read token/id from URL"); return; }
    log("job", ids.token, ids.id, "— requesting computed application...");

    const pkg = await sendMsg({ type: "GET_GH_FILL_DATA", token: ids.token, id: ids.id });
    if (!pkg || !pkg.ok) { warn("compute failed:", pkg && pkg.error); return; }
    const data = pkg.data;
    log(`computed: ready=${data.ready}, ${data.fills.length} fields, resume=${data.resumeB64 ? "yes" : "no"}`);
    if (!data.ready) warn("gate parked this job:", data.reasons);

    // Attempt one fill; returns the MAIN-world result ({ ok, error?, seen? }).
    async function fillOne(f) {
      let el = findFieldByLabel(f.label);
      if (!el && f.kind === "location") el = findFieldByLabelPrefix("location");
      if (!el && f.eeo) el = findFieldByLabelContains(f.eeo);
      // File and cover-text fills locate their targets in the MAIN world.
      if (!el && f.kind !== "file" && f.kind !== "cover-text") return { ok: false, error: "no field for label" };
      if (f.kind === "file") {
        return data.resumeB64 ? uploadFile(el, data.resumeB64, data.resumeName) : { ok: false, error: "no resume bytes" };
      }
      if (f.kind === "cover-text") return pasteCoverLetter(f.value);
      if (f.kind === "location") return fillLocation(el, f.value, f.match);
      if (el.type === "checkbox") return checkBox(el);
      if (f.kind === "select" || f.kind === "multiselect" || f.kind === "boolean" || isCombobox(el)) {
        return fillCombobox(el, f.value);
      }
      return fillText(el, f.value);
    }

    // Fill in multiple passes: anything missed or failed (field not mounted
    // yet, slow option list, ...) is retried up to 2 more times.
    const MAX_PASSES = 3;
    let ok = 0;
    let pending = data.fills;
    for (let pass = 1; pass <= MAX_PASSES && pending.length; pass++) {
      if (pass > 1) {
        log(`pass ${pass}: retrying ${pending.length} unfilled field(s)...`);
        await sleep(1200);
      }
      const stillFailing = [];
      for (const f of pending) {
        try {
          const res = await fillOne(f);
          if (res.ok) { ok++; log("filled:", f.label, "=>", f.kind === "file" ? "<resume>" : f.kind === "cover-text" ? "<cover letter>" : f.value); }
          else {
            stillFailing.push(f);
            warn(`fill failed (pass ${pass}):`, f.label, "—", res.error || "unknown", res.seen ? "| options seen: " + JSON.stringify(res.seen) : "");
          }
        } catch (e) { stillFailing.push(f); warn(`fill error (pass ${pass}):`, f.label, e.message); }
        await sleep(120);
      }
      pending = stillFailing;
    }

    if (pending.length) warn("STILL UNFILLED after all passes:", pending.map((f) => f.label));
    log(`DONE — filled ${ok}/${data.fills.length}${pending.length ? `, unfilled: ${pending.length}` : ""}. Review the form, solve any CAPTCHA, then click Submit.`);
    banner(pending.length
      ? `JobWatch filled ${ok}/${data.fills.length}. Complete manually: ${pending.map((f) => f.label).join(", ").slice(0, 140)} — then Submit.`
      : `JobWatch filled all ${ok} fields. Review, solve the CAPTCHA, then Submit.`);
  }

  function banner(text) {
    const d = document.createElement("div");
    d.textContent = text;
    d.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#4f46e5;color:#fff;padding:10px 16px;font:600 13px system-ui;text-align:center";
    document.body.appendChild(d);
  }

  // Greenhouse renders the form async; wait for the first name field, then run.
  (async () => {
    for (let i = 0; i < 40; i++) {
      if (document.querySelector("#first_name, input[id^='question_']")) break;
      await sleep(500);
    }
    // small settle for the rest of the comboboxes to mount
    await sleep(800);
    run().catch((e) => warn("run failed:", e.message));
  })();
})();
