// lever.js — auto-fill a Lever application form (jobs.lever.co/<site>/<id>/apply).
//
// Flow: scrape the form (lib/lever-dom.js scan, MAIN world) -> ask the background
// for the computed application (prepareLeverApplication) -> fill every field
// top to bottom, typing like a person -> verify four times, reading the board's
// own errors -> record the attempt in the ledger -> STOP before submit. You
// solve the hCaptcha and click "Submit application" yourself.
// Auto-apply (a tab the background runner opened): fills without the
// Autofill button and submits when nothing is left for the person; a visible
// hCaptcha challenge or a field it cannot finish is reported back and the tab
// stays open.

(function () {
  "use strict";
  const TAG = "[JobWatch/Lever]";
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const sleep = (ms) => (window.__jwWait ? window.__jwWait(ms) : new Promise((r) => setTimeout(r, ms)));
  const sendMsg = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
  async function lever(action, ...args) {
    const r = await sendMsg({ type: "EXEC_LEVER", action, args });
    if (!r?.ok) throw new Error(r?.error || `EXEC_LEVER ${action} failed`);
    return r.result;
  }

  // ── Page identity ─────────────────────────────────────────────────────────
  function pageIds() {
    const m = location.href.match(/jobs\.(eu\.)?lever\.co\/([^/?#]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return m ? { eu: !!m[1], site: decodeURIComponent(m[2]), id: m[3].toLowerCase() } : null;
  }
  function pageJob() {
    const title = (document.querySelector(".posting-headline h2, .posting-header h2, h2")?.textContent || "").trim().slice(0, 200);
    // <title>Veeva Systems - Role</title>; the logo alt reads "Veeva Systems logo".
    const alt = (document.querySelector(".main-header-logo img")?.getAttribute("alt") || "").replace(/\s*logo\s*$/i, "").trim();
    const fromTitle = (document.title || "").split(" - ")[0].trim();
    const company = (alt || fromTitle).slice(0, 120);
    const locationName = (document.querySelector(".posting-categories .location, .posting-category.location")?.textContent || "").trim().slice(0, 120);
    return { jobTitle: title, companyName: company, locationName };
  }

  // ── Application ledger (users/{uid}/applications, one record per form) ────
  function formKeyNow() {
    const ids = pageIds();
    return ids ? { formKey: `lever|${ids.site.toLowerCase()}|${ids.id}`, source: "lever", org: ids.site, postingId: ids.id, applyUrl: location.href.split("#")[0] } : null;
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

  // ── One fill, routed by what the page shows for that field ────────────────
  async function applyFill(f, pkg, domByPath) {
    const dom = domByPath.get(f.path);
    if (!dom) return { ok: false, error: "field not on page" };
    switch (f.kind) {
      case "file":
        return pkg.resumeB64 ? lever("setFile", f.path, pkg.resumeB64, pkg.resumeName) : { ok: false, error: "no resume bytes" };
      case "location":
        return lever("location", f.path, f.value, f.match);
      case "multiselect":
        if (dom.type === "radio") return lever("radio", f.path, f.values[0]);
        if (dom.type === "select") return lever("select", f.path, f.values[0]);
        return lever("checkboxes", f.path, f.values);
      case "select":
      case "boolean":
        if (dom.type === "select") return lever("select", f.path, f.value);
        if (dom.type === "checkbox") return lever("checkboxes", f.path, [f.value]);
        if (dom.type === "radio") return lever("radio", f.path, f.value);
        return lever("fillText", f.path, String(f.value ?? ""));
      default:
        if (dom.type === "select") return lever("select", f.path, f.value);
        if (dom.type === "radio") return lever("radio", f.path, f.value);
        if (dom.type === "checkbox") return lever("checkboxes", f.path, [f.value]);
        return lever("fillText", f.path, String(f.value ?? ""));
    }
  }
  const answerOf = (f, r, pkg) => f.kind === "file" ? pkg.resumeName : (f.values ? f.values.join("; ") : (r?.picked || f.value));

  // The moving outline (content/highlight.js) around the question being filled.
  const hl = window.__jwHL || { focus() {}, mark() {}, hide() {} };
  function blockOf(name) {
    const sel = `#application-form [name="${CSS.escape(name)}"]`;
    const el = document.querySelector(`${sel}:not([type=hidden])`) || document.querySelector(sel);
    if (!el) return null;
    return el.closest(".application-question") || el.closest("li, .application-field")?.parentElement || el.parentElement;
  }

  // ── Unattended auto-apply ─────────────────────────────────────────────────
  let AUTO = null;
  const autoReport = (status, note) => sendMsg({ type: "AUTO_RESULT", status, note }).catch(() => {});
  /** Submit through the shared flow (content/submit-flow.js): press Submit
   *  even when a field is listed for the person (the form says what it really
   *  wants); fields it marks go to the AI with the form's own words, then
   *  Submit again. Never in a test run (jwNoSubmit), never without the resume. */
  async function autoSubmitLever(manual, pendingJob, answersLog, header = {}) {
    const scanNow = () => lever("scan").then((x) => (Array.isArray(x) ? x : [])).catch(() => []);
    const r = await window.__jwSubmit({
      name: "Lever",
      prefix: "Auto-apply",
      say: (t, items) => banner(t, items ? { items } : {}),
      button: () => document.querySelector("#btn-submit, #application-form button[type=submit], button.postings-btn[type=submit]"),
      submitted: async () => { try { return (await lever("submitted")) === true; } catch { return !document.getElementById("application-form"); } },
      errors: async () => (await lever("errors").then((x) => (Array.isArray(x) ? x : [])).catch(() => [])).map((e) => ({ label: e.label || e.path || "", text: e.text || "", path: e.path || "", form: !e.label && !e.path })),
      empty: async () => (await scanNow()).filter((d) => d.required && !d.filled && d.type !== "file").map((d) => d.label),
      resumeMissing: async () => { const d = (await scanNow()).find((x) => x.type === "file" && /resume|cv/i.test(`${x.id} ${x.label}`)); return d && !d.filled ? d.label : null; },
      beforeClick: () => lever("touched").catch(() => {}),
      ledger: (event, extra) => ledger(event, { ...jobMeta(pendingJob), ...extra }),
      answersLog,
      meta: { jobTitle: header.jobTitle || "", companyName: header.companyName || "" },
      needs: [...manual.keys()],
      quietMs: 30000,
    });
    return autoReport(r.status, r.note);
  }

  // ── Main ──────────────────────────────────────────────────────────────────
  async function run() {
    const ids = pageIds();
    if (!ids) { warn("could not read site/id from URL"); return; }

    // Every form visit is an attempt; a form already submitted is left alone.
    const started = await ledger("start");
    if (started?.duplicate && AUTO) { autoReport("skipped", "already applied"); return; }
    if (started?.duplicate) { banner(`JobWatch: you already applied to ${started.reason === "same role" ? "this role at this company" : "this job"} on ${fmtDay(started.submittedAt)}. Not filling it again. Add #jwforce to the URL and reload to fill anyway.`); return; }
    if (!started?.ok) warn("ledger(start) failed:", started?.error);

    banner("JobWatch is reading the form.");
    const domFields = await lever("scan").then((x) => (Array.isArray(x) ? x : []));
    if (!domFields.length) { warn("no fields found"); banner("JobWatch: no form fields found on this page."); if (AUTO) autoReport("error", "no form fields found"); return; }
    const domByPath = new Map(domFields.map((d) => [d.id, d]));
    log(`scanned ${domFields.length} fields`, domFields.map((d) => `${d.type}:${d.label}`));

    banner("JobWatch is working out your answers.");
    const header = pageJob();
    const res = await sendMsg({ type: "GET_LEVER_FILL_DATA", site: ids.site, id: ids.id, eu: ids.eu, domFields, ...header }).catch((e) => ({ ok: false, error: e.message }));
    if (!res?.ok || !res.data) { warn("compute failed:", res?.error); banner(`JobWatch could not compute this application: ${res?.error || "unknown error"}`); ledger("error", { error: String(res?.error || "compute failed") }); if (AUTO) autoReport("error", String(res?.error || "compute failed")); return; }
    const pkg = res.data;
    if (pkg.alreadyApplied && AUTO) { autoReport("skipped", "already applied"); return; }
    if (pkg.alreadyApplied) { banner(`JobWatch: you already applied to this job on ${fmtDay(pkg.submittedAt)}. Not filling it again.`); return; }
    const pendingJob = res.pendingJob || { title: pkg.jobTitle, companyName: pkg.companyName, locationName: pkg.locationName, externalId: ids.id };
    log(`computed: ${pkg.answered} fills for ${pkg.total} fields, ready=${pkg.ready}, review=${pkg.review.length}`, pkg.review);

    // Fill top to bottom in page order; failures are retried twice.
    const order = new Map(domFields.map((d, i) => [d.id, i]));
    let pending = [...pkg.fills].filter((f) => domByPath.has(f.path)).sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));
    const skipped = pkg.fills.filter((f) => !domByPath.has(f.path)).map((f) => f.label);
    if (skipped.length) log("not on page (skipped):", skipped);
    const answersLog = {};
    const failures = [];
    banner(`JobWatch is filling ${pending.length} fields, top to bottom.`);
    for (let pass = 1; pass <= 3 && pending.length; pass++) {
      if (pass > 1) await sleep(900);
      const still = [];
      for (const f of pending) {
        try {
          hl.focus(blockOf(f.path), `Filling: ${f.label || f.path}`);
          await lever("scrollTo", f.path).catch(() => {});
          const r = await applyFill(f, pkg, domByPath);
          await sleep(260);
          hl.mark(!!r?.ok);
          if (r?.ok) {
            answersLog[f.path] = { label: f.label, answer: String(answerOf(f, r, pkg) ?? ""), type: f.kind, source: f.source || "" };
          } else {
            still.push(f);
            if (pass === 3) failures.push({ ...f, error: r?.error, seen: r?.seen });
            warn(`fill failed (pass ${pass}): ${f.label} — ${r?.error || "unknown"}`, r?.seen || "");
          }
        } catch (e) { still.push(f); if (pass === 3) failures.push({ ...f, error: e.message }); }
        await sleep(80);
      }
      pending = still;
    }
    hl.hide();

    // Verify four times, top to bottom: rescan, read what the board itself
    // says is wrong, fix what has a fill, and only then report what is left.
    await lever("touched").catch(() => {});
    const fillByPath = new Map(pkg.fills.map((f) => [f.path, f]));
    let after = [];
    let boardErrors = [];
    for (let pass = 1; pass <= 4; pass++) {
      await sleep(pass === 1 ? 500 : 900);
      window.scrollTo({ top: 0, behavior: "smooth" });
      await sleep(300);
      after = await lever("scan").then((x) => (Array.isArray(x) ? x : [])).catch(() => []);
      boardErrors = await lever("errors").then((x) => (Array.isArray(x) ? x : [])).catch(() => []);
      const problems = after.filter((d) => (d.required && !d.filled) || boardErrors.some((e) => e.path === d.id));
      log(`verify pass ${pass}/4: ${problems.length} problem(s)`, problems.map((d) => d.label), boardErrors);
      if (!problems.length) break;
      banner(`JobWatch is checking the form, pass ${pass} of 4. Fixing ${problems.length} field${problems.length === 1 ? "" : "s"}.`);
      for (const d of problems) {
        const f = fillByPath.get(d.id);
        if (!f) continue; // the engine parked it; it stays for the person
        try {
          hl.focus(blockOf(d.id), `Fixing: ${f.label || d.label || d.id}`);
          await lever("scrollTo", d.id).catch(() => {});
          const r = await applyFill(f, pkg, domByPath);
          await sleep(300);
          hl.mark(!!r?.ok);
          if (r?.ok) {
            answersLog[f.path] = { label: f.label, answer: String(answerOf(f, r, pkg) ?? ""), type: f.kind, source: f.source || "" };
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

    const stillEmpty = after.filter((d) => d.required && !d.filled);
    const manual = new Map(); // label -> { path, note }
    for (const r of pkg.review || []) manual.set(r.label, { path: r.path || "", note: r.note || "needs you" });
    for (const d of stillEmpty) if (!manual.has(d.label)) manual.set(d.label, { path: d.id, note: failures.find((f) => f.path === d.id)?.error || "still empty after four checks" });
    for (const e of boardErrors) {
      if (!e.path) continue;
      const d = after.find((x) => x.id === e.path);
      const label = d?.label || e.label || e.path;
      const prev = manual.get(label);
      manual.set(label, { path: e.path, note: prev ? `${prev.note}. The form says: ${e.text}` : `The form says: ${e.text}` });
    }
    // AI rescue: Claude reads each stuck mandatory field's HTML and says what to do.
    for (const [label, v] of [...manual.entries()].slice(0, 8)) {
      if (!window.__jwRescue) break;
      banner(`JobWatch is asking AI how to finish: ${label}`);
      const r = await window.__jwRescue(label, { jobTitle: header.jobTitle || "", companyName: header.companyName || "" });
      log("rescue:", label, r);
      if (r?.ok) { manual.delete(label); answersLog[`rescue:${label}`] = { label, answer: r.answer || "(AI rescue)", type: "ai-rescue", source: "ai" }; }
      else if (r?.why === "optional (no *)") manual.delete(label);
      else if (r?.why) manual.set(label, { ...v, note: `${v.note}. AI: ${r.why}` });
    }
    const needsAttention = [...manual.entries()].map(([label, v]) => ({ label, path: v.path, note: v.note }));
    const filled = Object.keys(answersLog).length;
    log(`DONE — filled ${filled}/${pkg.fills.length}. answersLog:`, answersLog);
    if (manual.size && window.__jwLearnManual) window.__jwLearnManual([...manual.keys()], { jobTitle: header.jobTitle || "", companyName: header.companyName || "" });
    if (manual.size) {
      banner(`JobWatch filled ${filled}. These still need you, then solve the captcha and submit (saved to your Applications page):`, { items: [...manual.keys()] });
      warn("Needs you:", needsAttention);
    } else {
      banner(`JobWatch filled all ${filled} fields. Submitting…`);
    }
    ledger("filled", {
      ...jobMeta(pendingJob), answersLog, needsAttention,
      filledCount: filled, totalFields: domFields.length, requiredTotal: domFields.filter((d) => d.required).length,
      flow: "engine", schemaSource: "lever-dom", reasons: pkg.reasons || [],
    }).then((r) => { if (!r?.ok) warn("ledger(filled) failed:", r?.error); });
    // Submit, auto-apply or not (the person's call, 2026-11-02).
    return autoSubmitLever(manual, pendingJob, answersLog, header);
  }

  // The JobWatch card, bottom right (content/notify.js).
  function banner(text, { action = null, items = null } = {}) {
    window.__jwNotify.show(text, undefined, { action, items });
  }

  (async () => {
    for (let i = 0; i < 40; i++) {
      if (document.querySelector("#application-form input[name=name], #application-form input[name=email]")) break;
      await sleep(500);
    }
    try { AUTO = (await sendMsg({ type: "AUTO_JOB" }))?.job || null; } catch { AUTO = null; }
    if (!document.querySelector("#application-form")) {
      if (AUTO) autoReport("error", "no application form (the posting may be closed)");
      return;
    }
    if (AUTO) {
      run().catch((e) => { warn("run failed:", e.message); banner(`JobWatch failed: ${e.message}`); ledger("error", { error: e.message }); autoReport("error", e.message); });
      return;
    }
    // Nothing fills until the person presses Autofill.
    window.__jwNotify.launcher({
      onClick: async () => {
        await sleep(300);
        run().catch((e) => { warn("run failed:", e.message); banner(`JobWatch failed: ${e.message}`); ledger("error", { error: e.message }); });
      },
    });
  })();
})();
