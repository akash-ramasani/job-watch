// lever.js — auto-fill a Lever application form (jobs.lever.co/<site>/<id>/apply).
//
// Flow: scrape the form (lib/lever-dom.js scan, MAIN world) -> ask the background
// for the computed application (prepareLeverApplication) -> fill every field
// top to bottom, typing like a person -> verify four times, reading the board's
// own errors -> record the attempt in the ledger -> STOP before submit. You
// solve the hCaptcha and click "Submit application" yourself.

(function () {
  "use strict";
  const TAG = "[JobWatch/Lever]";
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

  // ── Main ──────────────────────────────────────────────────────────────────
  async function run() {
    const ids = pageIds();
    if (!ids) { warn("could not read site/id from URL"); return; }

    // Every form visit is an attempt; a form already submitted is left alone.
    const started = await ledger("start");
    if (started?.duplicate) { banner(`JobWatch: you already applied to ${started.reason === "same role" ? "this role at this company" : "this job"} on ${fmtDay(started.submittedAt)}. Not filling it again. Add #jwforce to the URL and reload to fill anyway.`); return; }
    if (!started?.ok) warn("ledger(start) failed:", started?.error);

    banner("JobWatch is reading the form.");
    const domFields = await lever("scan").then((x) => (Array.isArray(x) ? x : []));
    if (!domFields.length) { warn("no fields found"); banner("JobWatch: no form fields found on this page."); return; }
    const domByPath = new Map(domFields.map((d) => [d.id, d]));
    log(`scanned ${domFields.length} fields`, domFields.map((d) => `${d.type}:${d.label}`));

    banner("JobWatch is working out your answers.");
    const header = pageJob();
    const res = await sendMsg({ type: "GET_LEVER_FILL_DATA", site: ids.site, id: ids.id, eu: ids.eu, domFields, ...header }).catch((e) => ({ ok: false, error: e.message }));
    if (!res?.ok || !res.data) { warn("compute failed:", res?.error); banner(`JobWatch could not compute this application: ${res?.error || "unknown error"}`); ledger("error", { error: String(res?.error || "compute failed") }); return; }
    const pkg = res.data;
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
          await lever("scrollTo", f.path).catch(() => {});
          const r = await applyFill(f, pkg, domByPath);
          await sleep(260);
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
          await lever("scrollTo", d.id).catch(() => {});
          const r = await applyFill(f, pkg, domByPath);
          await sleep(300);
          if (r?.ok) {
            answersLog[f.path] = { label: f.label, answer: String(answerOf(f, r, pkg) ?? ""), type: f.kind, source: f.source || "" };
            const i = failures.findIndex((x) => x.path === f.path);
            if (i >= 0) failures.splice(i, 1);
          } else if (!failures.some((x) => x.path === f.path)) {
            failures.push({ ...f, error: r?.error, seen: r?.seen });
          }
        } catch (e) { if (!failures.some((x) => x.path === f.path)) failures.push({ ...f, error: e.message }); }
      }
    }

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
    const needsAttention = [...manual.entries()].map(([label, v]) => ({ label, path: v.path, note: v.note }));
    const filled = Object.keys(answersLog).length;
    log(`DONE — filled ${filled}/${pkg.fills.length}. answersLog:`, answersLog);
    if (manual.size) {
      const names = [...manual.keys()].slice(0, 3).map((l) => (l.length > 38 ? l.slice(0, 38) + "…" : l));
      banner(`JobWatch filled ${filled}. Complete manually: ${names.join(", ")}${manual.size > 3 ? `, +${manual.size - 3} more` : ""}. Then solve the captcha and Submit. (Saved to your Applications page.)`);
      warn("Needs you:", needsAttention);
    } else {
      banner(`JobWatch filled all ${filled} fields. Review, solve the captcha, then click Submit application yourself.`);
    }
    ledger("filled", {
      ...jobMeta(pendingJob), answersLog, needsAttention,
      filledCount: filled, totalFields: domFields.length, requiredTotal: domFields.filter((d) => d.required).length,
      flow: "engine", schemaSource: "lever-dom", reasons: pkg.reasons || [],
    }).then((r) => { if (!r?.ok) warn("ledger(filled) failed:", r?.error); });
    watchForSubmit(pendingJob, answersLog);
  }

  // Lever shows a confirmation page after the person submits. Poll for 30
  // minutes; never click Submit.
  function watchForSubmit(pendingJob, answersLog) {
    const t0 = Date.now();
    const watch = setInterval(async () => {
      let done = false;
      try { done = (await lever("submitted")) === true; } catch { done = !document.getElementById("application-form"); }
      if (done) {
        clearInterval(watch);
        ledger("submitted", { ...jobMeta(pendingJob), answersLog }).then(() => banner("JobWatch: application recorded as submitted."));
      } else if (Date.now() - t0 > 30 * 60 * 1000) clearInterval(watch);
    }, 2000);
  }

  let bannerEl = null;
  function banner(text) {
    if (!bannerEl) {
      bannerEl = document.createElement("div");
      bannerEl.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#4f46e5;color:#fff;padding:10px 16px;font:600 13px system-ui;text-align:center";
      document.body.appendChild(bannerEl);
    }
    bannerEl.textContent = text;
  }

  (async () => {
    for (let i = 0; i < 40; i++) {
      if (document.querySelector("#application-form input[name=name], #application-form input[name=email]")) break;
      await sleep(500);
    }
    await sleep(600);
    run().catch((e) => { warn("run failed:", e.message); banner(`JobWatch failed: ${e.message}`); ledger("error", { error: e.message }); });
  })();
})();
