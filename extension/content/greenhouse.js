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
  function findFieldByLabel(label) {
    const want = norm(label);
    const labels = [...document.querySelectorAll("label")];
    for (const lab of labels) {
      if (norm(lab.textContent) !== want) continue;
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

  const isCombobox = (el) => el.getAttribute && (el.getAttribute("role") === "combobox" || el.getAttribute("aria-haspopup") === "listbox");

  // ── Fillers (route through MAIN world) ────────────────────────────────────
  async function fillText(el, value) {
    const r = await sendMsg({ type: "EXEC_MAIN_WORLD", action: "setInput", id: el.id, value });
    return r?.result?.ok !== false;
  }
  async function fillCombobox(el, value) {
    const r = await sendMsg({ type: "EXEC_MAIN_WORLD", action: "ghSelectCombobox", id: el.id, value });
    return r?.result?.ok === true;
  }
  async function checkBox(el) {
    const r = await sendMsg({ type: "EXEC_MAIN_WORLD", action: "ghCheck", id: el.id });
    return r?.result?.ok === true;
  }
  async function uploadFile(el, b64, name) {
    await sendMsg({ type: "EXEC_MAIN_WORLD", action: "setFile", id: el.id, b64Data: b64, fileName: name });
    return true;
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

    let ok = 0, miss = 0, fail = 0;
    for (const f of data.fills) {
      const el = findFieldByLabel(f.label);
      if (!el) { miss++; warn("no field for label:", f.label); continue; }
      try {
        let done = false;
        if (f.kind === "file") {
          if (data.resumeB64) done = await uploadFile(el, data.resumeB64, data.resumeName);
        } else if (f.kind === "select" || f.kind === "multiselect" || f.kind === "boolean" || isCombobox(el)) {
          done = await fillCombobox(el, f.value);
        } else {
          done = await fillText(el, f.value);
        }
        if (done) { ok++; log("filled:", f.label, "=>", f.kind === "file" ? "<resume>" : f.value); }
        else { fail++; warn("fill failed:", f.label); }
      } catch (e) { fail++; warn("fill error:", f.label, e.message); }
      await sleep(120);
    }

    log(`DONE — filled ${ok}, missed ${miss}, failed ${fail}. Review the form, solve any CAPTCHA, then click Submit.`);
    banner(`JobWatch filled ${ok}/${data.fills.length} fields. Check the form, solve the CAPTCHA, then Submit.`);
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
