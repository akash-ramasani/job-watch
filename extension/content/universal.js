// universal.js — auto-fill an application on any board without a dedicated
// script: Workday, iCIMS, SmartRecruiters, Workable, BambooHR, Taleo,
// SuccessFactors, Oracle Recruiting Cloud, Jobvite, and the popup's "Fill this
// page" on a company's own careers site.
//
// Flow, per page or wizard step: scan the form (lib/generic-dom.js, MAIN world)
// -> ask the background for the computed application (prepareGenericApplication,
// same engine as Ashby/Greenhouse/Lever) -> fill empty fields top to bottom,
// typing like a person -> verify four times, reading the page's own errors ->
// record the attempt in the ledger -> STOP. You press Next / Save and Continue
// and Submit yourself; when the next step appears, JobWatch fills it too.
//
// Workday: sign-in and account creation stay with the person (only the email
// is filled); My Experience gets the resume upload plus work history,
// education and links from the resume when Workday did not already add them.

(function () {
  "use strict";
  if (window.__jwUniversal) return;
  window.__jwUniversal = true;

  const host = location.hostname.toLowerCase();
  // Boards with their own scripts.
  if (/(^|\.)ashbyhq\.com$|(^|\.)greenhouse\.io$|(^|\.)lever\.co$/.test(host)) return;

  const TAG = "[JobWatch/Universal]";
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sendMsg = (msg) => new Promise((res) => { try { chrome.runtime.sendMessage(msg, res); } catch (e) { res({ ok: false, error: e.message }); } });
  async function gen(action, ...args) {
    const r = await sendMsg({ type: "EXEC_GENERIC", action, args });
    if (!r?.ok) throw new Error(r?.error || `EXEC_GENERIC ${action} failed`);
    return r.result;
  }
  const nrm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

  // ── Board identity ────────────────────────────────────────────────────────
  const SOURCES = [
    [/myworkdayjobs\.com$|myworkdaysite\.com$|\.workday\.com$/, "workday"],
    [/icims\.com$/, "icims"], [/taleo\.net$/, "taleo"], [/successfactors\.(com|eu)$|sapsf\.(com|eu)$/, "successfactors"],
    [/smartrecruiters\.com$/, "smartrecruiters"], [/workable\.com$/, "workable"], [/bamboohr\.com$/, "bamboohr"],
    [/jobvite\.com$/, "jobvite"], [/oraclecloud\.com$/, "oracle"], [/eightfold\.ai$/, "eightfold"], [/applytojob\.com$/, "jazzhr"],
    [/breezy\.hr$/, "breezy"], [/paylocity\.com$/, "paylocity"], [/ultipro\.com$|ukg\.net$/, "ukg"], [/adp\.com$/, "adp"],
    [/paycomonline\.net$/, "paycom"], [/pageuppeople\.com$/, "pageup"], [/csod\.com$/, "cornerstone"], [/avature\.net$/, "avature"],
    [/brassring\.com$/, "brassring"], [/silkroad\.com$/, "silkroad"], [/applicantpro\.com$/, "applicantpro"], [/interfolio\.com$/, "interfolio"],
    [/peopleadmin\.com$/, "peopleadmin"], [/governmentjobs\.com$|schooljobs\.com$/, "neogov"], [/rippling\.com$/, "rippling"],
    [/recruitee\.com$/, "recruitee"], [/teamtailor\.com$/, "teamtailor"], [/personio\.(com|de)$/, "personio"], [/dover\.com$/, "dover"],
    [/pinpointhq\.com$/, "pinpoint"], [/freshteam\.com$/, "freshteam"], [/zohorecruit\.com$/, "zoho"],
  ];
  const source = (SOURCES.find(([re]) => re.test(host)) || [null, "web"])[1];
  const isWorkday = source === "workday";
  // The popup's "Fill this page": counts as pressing Autofill on this page.
  const manual = () => !!window.__jwManualStart;
  let forced = false; // the popup was used here: skip the "is this an application?" checks

  /** A stable key for this posting: Workday's req id, else an id in the URL. */
  function postingKey() {
    const u = new URL(location.href);
    if (isWorkday) {
      const parts = u.pathname.split("/").filter(Boolean);
      const end = parts.indexOf("apply");
      const slugPart = (end > 0 ? parts[end - 1] : parts[parts.length - 1]) || "";
      const req = (slugPart.match(/_([A-Za-z0-9-]+)$/) || [])[1];
      const tenant = (host.match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/) || [])[1] || (parts[0] === "recruiting" ? parts[1] : host);
      return req ? { org: tenant, id: req } : null;
    }
    for (const k of ["jobId", "jobid", "job_id", "reqId", "requisitionId", "jobReqId", "jid", "id", "job", "posting", "pid"]) {
      const v = u.searchParams.get(k);
      if (v && /\w{3,}/.test(v)) return { org: host, id: v };
    }
    const seg = u.pathname.split("/").filter(Boolean).reverse().find((p) => /\d{3,}|[0-9a-f]{8}-[0-9a-f]{4}/i.test(p));
    if (seg) return { org: host, id: seg.slice(0, 80) };
    return { org: host, id: u.pathname.replace(/\/(apply|application|login|register)(\/.*)?$/i, "").slice(0, 120) || "/" };
  }
  function formKeyNow() {
    const k = postingKey();
    if (!k) return null;
    return { formKey: [source, k.org.toLowerCase(), k.id].join("|"), source, org: k.org, postingId: k.id, applyUrl: location.href.split("#")[0] };
  }
  let header = { jobTitle: "", companyName: "", locationName: "" };
  async function ledger(event, extra = {}) {
    const k = formKeyNow();
    if (!k) return { ok: false, error: "no form key" };
    const force = /jwforce/.test(location.hash);
    const meta = event === "start" ? { ...header, force } : {};
    try { return (await sendMsg({ type: "APPLICATION_EVENT", event, ...k, ...meta, ...extra })) || { ok: false }; } catch (e) { return { ok: false, error: e.message }; }
  }
  const fmtDay = (iso) => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "an earlier date"; };

  // ── Banner and outline ────────────────────────────────────────────────────
  // The JobWatch card, bottom right (content/notify.js).
  function banner(text, { action = null, items = null } = {}) {
    if (window.top !== window && !document.querySelector("[data-jw-id]")) return; // quiet in frames without a form
    window.__jwNotify.show(text, undefined, { action, items });
  }
  const hl = window.__jwHL || { focus() {}, mark() {}, hide() {} };
  const elOf = (id) => {
    const el = document.querySelector(`[data-jw-id="${CSS.escape(id)}"]`);
    return el ? (el.closest("[data-automation-id^=formField-], fieldset, .form-group, .field") || el.parentElement || el) : null;
  };

  // ── Fill one batch of fields ──────────────────────────────────────────────
  let pkgCache = null; // the last computed package (resume bytes, history)
  const answersLog = {};
  const attention = new Map(); // label -> { path, note }
  let started = false;

  const answerOf = (f, r, pkg) => f.kind === "file" ? pkg.resumeName : (f.values ? f.values.join("; ") : (r?.picked || f.value));

  async function applyWithRetry(f, pkg) {
    let r = await gen("apply", f.path, f, { resumeB64: pkg.resumeB64, resumeName: pkg.resumeName }).catch((e) => ({ ok: false, error: e.message }));
    if (!r?.ok && r?.error === "field not on page") {
      await gen("scan", { readOptions: false }).catch(() => []);
      r = await gen("apply", f.path, f, { resumeB64: pkg.resumeB64, resumeName: pkg.resumeName }).catch((e) => ({ ok: false, error: e.message }));
    }
    return r || { ok: false, error: "no result" };
  }

  async function fillFields(fills, pkg, order) {
    let pending = fills.filter((f) => order.has(f.path)).sort((a, b) => order.get(a.path) - order.get(b.path));
    const failures = [];
    for (let pass = 1; pass <= 3 && pending.length; pass++) {
      if (pass > 1) await sleep(900);
      const still = [];
      for (const f of pending) {
        hl.focus(elOf(f.path), `Filling: ${f.label || f.path}`);
        const r = await applyWithRetry(f, pkg);
        await sleep(220);
        hl.mark(!!r.ok);
        if (r.ok) {
          answersLog[f.path] = { label: f.label, answer: String(answerOf(f, r, pkg) ?? ""), type: f.kind, source: f.source || "" };
          attention.delete(f.label);
        } else {
          still.push(f);
          if (pass === 3) failures.push({ ...f, error: r.error, seen: r.seen });
          warn(`fill failed (pass ${pass}): ${f.label} — ${r.error || "unknown"}`, r.seen || "");
        }
        await sleep(80);
      }
      pending = still;
    }
    hl.hide();
    return failures;
  }

  /** Compute and fill what is empty on the page now. Returns the scanned fields. */
  async function fillPage(domFields, { onlyIds = null } = {}) {
    const sendable = domFields.filter((d) => !d.filled && (!onlyIds || onlyIds.has(d.id)) && !(isWorkday && EXPERIENCE_SECTION.test(d.section || "")));
    if (!sendable.length && pkgCache) return [];
    banner("JobWatch is working out your answers.");
    const res = await sendMsg({
      type: "GET_GENERIC_FILL_DATA", source, applyUrl: location.href, formKey: formKeyNow()?.formKey || "",
      externalId: postingKey()?.id || "", domFields: sendable.map(({ section: _s, parts: _p, filled: _f, ...d }) => d),
      ...header, descriptionText: await gen("descriptionText").catch(() => ""),
    });
    if (!res?.ok || !res.data) { banner(`JobWatch could not compute this application: ${res?.error || "unknown error"}`); ledger("error", { error: String(res?.error || "compute failed") }); return null; }
    const pkg = res.data;
    if (pkg.alreadyApplied) { banner(`JobWatch: you already applied to this job on ${fmtDay(pkg.submittedAt)}. Not filling it again.`); stopped = true; return null; }
    pkgCache = { ...(pkgCache || {}), ...pkg, resumeB64: pkg.resumeB64 || pkgCache?.resumeB64 };
    // The posting's own title and company (Workday's API, or the job JobWatch holds) beat the page header.
    if (pkg.jobTitle) header.jobTitle = pkg.jobTitle;
    if (pkg.companyName) header.companyName = pkg.companyName;
    for (const r of pkg.review || []) attention.set(r.label, { path: r.path || "", note: r.note || "needs you" });
    log(`computed: ${pkg.answered} fills for ${pkg.total} fields, review=${pkg.review?.length || 0}`, pkg.review);

    const order = new Map(domFields.map((d, i) => [d.id, i]));
    if (pkg.fills.length) banner(`JobWatch is filling ${pkg.fills.length} field${pkg.fills.length === 1 ? "" : "s"}, top to bottom.`);
    const failures = await fillFields(pkg.fills, pkgCache, order);
    for (const f of failures) attention.set(f.label, { path: f.path, note: f.error || "could not fill" });
    return pkg.fills;
  }

  // ── Workday My Experience: history from the resume ────────────────────────
  const EXPERIENCE_SECTION = /^(work experience|education|websites?|languages?|certifications?)\b/i;
  const MONTH = (m) => String(m).padStart(2, "0");
  function roleFill(field, role) {
    const l = nrm(field.label);
    const mk = (kind, value, more = {}) => ({ path: field.id, label: field.label, kind, value, source: "resume", ...more });
    if (/job title|^title$|position/.test(l)) return role.title ? mk("text", role.title) : null;
    if (/company|employer|organization/.test(l)) return role.company ? mk("text", role.company) : null;
    if (/^location$/.test(l)) return role.location ? mk("text", role.location) : null;
    if (/currently work here|current(ly)? (employed|position|job)/.test(l)) return mk("boolean", role.current ? "Yes" : "No");
    if (/^from$|start date/.test(l)) return role.from ? mk("date", role.from.month ? `${MONTH(role.from.month)}/${role.from.year}` : `01/${role.from.year}`) : null;
    if (/^to$|end date/.test(l)) return !role.current && role.to ? mk("date", role.to.month ? `${MONTH(role.to.month)}/${role.to.year}` : `12/${role.to.year}`) : null;
    if (/description|responsibilit|summary/.test(l)) return role.description ? mk("text", role.description) : null;
    return null;
  }
  function eduFill(field, ed) {
    const l = nrm(field.label);
    const mk = (kind, value, more = {}) => ({ path: field.id, label: field.label, kind, value, source: "resume", ...more });
    if (/school|university|institution|college/.test(l)) return ed.school ? mk(field.type === "typeahead" ? "typeahead" : "text", ed.school, { match: ed.school, alternates: ["Other"] }) : null;
    if (/^degree$|degree type|degree/.test(l)) {
      if (!ed.degree) return null;
      const d = nrm(ed.degree);
      const want = /ph\.?d|doctor/.test(d) ? "Doctor" : /master|m\.?s\b|mba|m\.?eng/.test(d) ? "Master" : /bachelor|b\.?s\b|b\.?a\b|b\.?tech|b\.?e\b/.test(d) ? "Bachelor" : /associate/.test(d) ? "Associate" : ed.degree;
      return mk("select", want);
    }
    if (/field of study|major|discipline/.test(l)) return ed.field ? mk(field.type === "typeahead" || field.type === "select" ? "typeahead" : "text", ed.field, { match: ed.field }) : null;
    if (/gpa|overall result|grade/.test(l)) return ed.gpa ? mk("text", String(ed.gpa)) : null;
    if (/^from$|start/.test(l)) return ed.from ? mk("date", `01/${ed.from.year}`) : null;
    if (/^to$|end|graduation/.test(l)) return ed.to ? mk("date", `${ed.to.month ? MONTH(ed.to.month) : "05"}/${ed.to.year}`) : null;
    return null;
  }

  async function workdayExperience(pkg) {
    const hist = pkg.history || {};
    const plan = [
      { name: "Work Experience", items: (hist.roles || []).slice(0, 5), fillFor: roleFill },
      { name: "Education", items: (hist.education || []).slice(0, 3), fillFor: eduFill },
      { name: "Websites", items: (hist.links || []).slice(0, 3), fillFor: (field, url) => (/url|website|link/i.test(field.label) ? { path: field.id, label: field.label, kind: "text", value: url, source: "profile" } : null) },
    ];
    for (const sec of plan) {
      if (!sec.items.length) continue;
      let fields = await gen("scan", { readOptions: false });
      const blocks = () => [...new Set(fields.filter((f) => new RegExp(`^${sec.name}\\b`, "i").test(f.section)).map((f) => f.section))];
      // Workday parsed the resume already: leave its entries to the person.
      if (blocks().length && fields.some((f) => new RegExp(`^${sec.name}\\b`, "i").test(f.section) && f.filled && f.type !== "yesno")) { log(`${sec.name}: already has entries, leaving them`); continue; }
      for (let i = 0; i < sec.items.length; i++) {
        if (blocks().length <= i) {
          const added = await gen("workdayAdd", sec.name).catch((e) => ({ ok: false, error: e.message }));
          if (!added?.ok) { warn(`${sec.name}: could not add entry ${i + 1}`, added?.error); break; }
          await sleep(700);
        }
        fields = await gen("scan", { readOptions: true });
        const name = blocks()[i];
        if (!name) break;
        // An unchecked optional box reads as answered; "I currently work here" still needs its answer.
        const mine = fields.filter((f) => f.section === name && (!f.filled || f.type === "yesno"));
        const order = new Map(fields.map((d, k) => [d.id, k]));
        const fills = mine.map((f) => sec.fillFor(f, sec.items[i])).filter(Boolean);
        banner(`JobWatch is adding ${name} from your resume.`);
        const failures = await fillFields(fills, pkg, order);
        for (const f of failures) attention.set(`${name}: ${f.label}`, { path: f.path, note: f.error || "could not fill" });
      }
    }
  }

  // ── Verify ────────────────────────────────────────────────────────────────
  async function verify(allFills) {
    const byPath = new Map(allFills.map((f) => [f.path, f]));
    let after = [];
    let errs = [];
    for (let pass = 1; pass <= 4; pass++) {
      await sleep(pass === 1 ? 500 : 900);
      after = await gen("scan", { readOptions: false }).catch(() => []);
      errs = await gen("errors").catch(() => []);
      const problems = after.filter((d) => (d.required && !d.filled) || errs.some((e) => e.path === d.id));
      log(`verify pass ${pass}/4: ${problems.length} problem(s)`, problems.map((d) => d.label), errs);
      const fixable = problems.filter((d) => byPath.has(d.id));
      if (!fixable.length) break;
      banner(`JobWatch is checking the form, pass ${pass} of 4. Fixing ${fixable.length} field${fixable.length === 1 ? "" : "s"}.`);
      await fillFields(fixable.map((d) => byPath.get(d.id)), pkgCache, new Map(after.map((d, i) => [d.id, i])));
    }
    for (const d of after.filter((x) => x.required && !x.filled)) {
      if (!attention.has(d.label)) attention.set(d.label, { path: d.id, note: "still empty after four checks" });
    }
    for (const e of errs) {
      if (!e.path) continue;
      const d = after.find((x) => x.id === e.path);
      const label = d?.label || e.label || e.path;
      const prev = attention.get(label);
      attention.set(label, { path: e.path, note: prev ? `${prev.note}. The form says: ${e.text}` : `The form says: ${e.text}` });
    }
    // Answered since: no longer needs the person.
    for (const d of after) if (d.filled && attention.has(d.label) && !errs.some((e) => e.path === d.id)) attention.delete(d.label);
    return after;
  }

  /** AI rescue for what still needs the person: Claude reads each field's HTML
   *  and says what to click, type or pick (optional fields, no "*", are skipped). */
  async function rescueStuck() {
    if (!window.__jwRescue) return;
    for (const [label, v] of [...attention.entries()].slice(0, 8)) {
      banner(`JobWatch is asking AI how to finish: ${label}`);
      const r = await window.__jwRescue(label, { jobTitle: header.jobTitle || "", companyName: header.companyName || "" });
      log("rescue:", label, r);
      if (r?.ok) { attention.delete(label); answersLog[`rescue:${label}`] = { label, answer: r.answer || "(AI rescue)", type: "ai-rescue", source: "ai" }; }
      else if (r?.why === "optional (no *)") attention.delete(label);
      else if (r?.why) attention.set(label, { ...v, note: `${v.note}. AI: ${r.why}` });
    }
  }

  function report(stepLabel) {
    const filled = Object.keys(answersLog).length;
    const next = isWorkday ? "click Save and Continue" : "go on to the next step or submit";
    if (attention.size) {
      banner(`JobWatch filled ${filled}${stepLabel ? ` (${stepLabel})` : ""}. These still need you, then ${next} yourself:`, { items: [...attention.keys()] });
      warn("Needs you:", [...attention.entries()]);
    } else {
      banner(`JobWatch filled ${filled} field${filled === 1 ? "" : "s"}${stepLabel ? ` (${stepLabel})` : ""}. Review, then ${next} yourself.`);
    }
    ledger("filled", {
      jobTitle: header.jobTitle, companyName: header.companyName, answersLog,
      needsAttention: [...attention.entries()].map(([label, v]) => ({ label, path: v.path, note: v.note })),
      filledCount: filled, flow: "engine", schemaSource: `${source}-dom`, reasons: pkgCache?.reasons || [],
    }).then((r) => { if (!r?.ok) warn("ledger(filled) failed:", r?.error); });
  }

  // ── The step loop ─────────────────────────────────────────────────────────
  let stopped = false;
  let busy = false;
  let armedFor = ""; // the page/step the person pressed Autofill on
  let armNext = false;
  const done = new Set(); // field ids already computed (filled or parked)
  let lastStep = "";
  let submittedSeen = false;

  function looksLikeApplication(fields) {
    const has = (re) => fields.some((f) => re.test(f.label));
    const files = fields.some((f) => f.type === "file");
    const email = fields.some((f) => f.type === "email" || /e-?mail/i.test(f.label));
    const name = has(/\b(first|last|full|legal|given|family) ?name\b|^name$/i);
    return fields.length >= 3 && (files || (email && name) || (isWorkday && fields.length >= 2));
  }
  function onApplyFlow() {
    if (!isWorkday) return true;
    return /\/apply(\/|$)|\/login|\/createAccount|userHome|\/myApplication/i.test(location.pathname) || !!document.querySelector("[data-automation-id=applyFlowPage]");
  }

  // Cheap checks in this world before any MAIN-world scan: a page with no form
  // (job search, posting text) costs nothing per tick.
  let notAFormSig = "";
  const pageSig = () => `${location.href}|${document.querySelectorAll("input:not([type=hidden]), textarea, select, button[aria-haspopup]").length}`;
  const formish = () => !!document.querySelector("[data-automation-id=applyFlowPage], input[type=file], input[type=email]")
    || document.querySelectorAll("input:not([type=hidden]):not([type=search]), textarea, select").length >= 3;

  async function tick() {
    if (stopped || busy) return;
    if (!onApplyFlow()) return;
    if (manual()) { window.__jwManualStart = false; forced = true; armNext = true; }
    if (!started && !forced && (!formish() || pageSig() === notAFormSig)) return;
    busy = true;
    try {
      if (started && await gen("submitted").catch(() => false)) {
        if (started && !submittedSeen) {
          submittedSeen = true;
          ledger("submitted", { jobTitle: header.jobTitle, companyName: header.companyName, answersLog }).then(() => banner("JobWatch: application recorded as submitted."));
        }
        return;
      }
      if (isWorkday && await gen("workdayStartModal").catch(() => false)) {
        banner("JobWatch: choose Autofill with Resume or Apply Manually. JobWatch fills each step after you sign in.");
        return;
      }
      const step = await gen("stepName").catch(() => "");
      let fields = await gen("scan", { readOptions: false }).catch(() => []);
      if (isWorkday && !fields.length && /sign in|create account/i.test(step)) {
        banner("JobWatch: sign in or create your Workday account. JobWatch fills the application once you are in.");
        return;
      }
      if (!fields.length) { if (!started) notAFormSig = pageSig(); return; }
      if (!started && !forced && !looksLikeApplication(fields)) { notAFormSig = pageSig(); return; }

      // Sign-in and account pages: only the email; the password is the person's.
      if (await gen("hasPassword").catch(() => false)) {
        const email = fields.find((f) => (f.type === "email" || /e-?mail/i.test(f.label)) && !f.filled);
        if (email && !done.has(email.id)) {
          done.add(email.id);
          const res = await sendMsg({ type: "GET_GENERIC_FILL_DATA", source, applyUrl: location.href, formKey: "", domFields: [{ id: email.id, label: "Email", type: "email", required: true, options: [] }] });
          const f = res?.data?.fills?.[0];
          if (f) await gen("apply", f.path, f, {}).catch(() => {});
        }
        banner(isWorkday ? "JobWatch: sign in or create your Workday account. JobWatch fills the application once you are in." : "JobWatch: sign in to continue. JobWatch fills the application once you are in.");
        return;
      }

      const newStep = step !== lastStep;
      // Ids come from labels, so a new wizard step can reuse one ("Resume/CV"
      // on My Information and on My Experience): forget the last step's.
      if (newStep && started) done.clear();
      const fresh = fields.filter((f) => !done.has(f.id) && !f.filled);
      if (!fresh.length && !(isWorkday && newStep && /experience/i.test(step))) { lastStep = step; return; }

      // Nothing fills until the person presses Autofill, once per page or step.
      const stepKey = `${location.pathname}|${step}`;
      if (armNext) { armedFor = stepKey; armNext = false; }
      if (armedFor !== stepKey) {
        window.__jwNotify.launcher({
          text: step && started ? `Next step: ${step}. Fill it from your JobWatch profile.` : "Fill this application from your JobWatch profile. You review and submit.",
          onClick: () => { armedFor = stepKey; banner("JobWatch is reading the form…"); setTimeout(tick, 50); },
        });
        return;
      }

      if (!started) {
        header = await gen("pageJob").catch(() => header);
        // Boards that put the company in the URL: apply.workable.com/<company>/..., <company>.bamboohr.com, ...
        if (!header.companyName) {
          const seg = location.pathname.split("/").filter(Boolean)[0] || "";
          const sub = host.split(".")[0];
          const raw = /^(apply|jobs|careers|www|app|ats|recruiting|boards)$/.test(sub) ? seg : sub;
          header.companyName = raw && !/^(en|us|en-us|job|jobs|apply|o)$/i.test(raw) ? raw.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "";
        }
        const st = await ledger("start");
        if (st?.duplicate) { banner(`JobWatch: you already applied to ${st.reason === "same role" ? "this role at this company" : "this job"} on ${fmtDay(st.submittedAt)}. Not filling it again. Add #jwforce to the URL and reload to fill anyway.`); stopped = true; return; }
        if (!st?.ok) warn("ledger(start) failed:", st?.error);
        started = true;
      }
      lastStep = step;
      banner(`JobWatch is reading the form${step ? `: ${step}` : ""}…`);
      // Read options of the fresh pick lists (opens each dropdown once).
      fields = await gen("scan", { readOptions: true }).catch(() => fields);
      const ids = new Set(fields.filter((f) => !done.has(f.id) && !f.filled).map((f) => f.id));
      ids.forEach((id) => done.add(id));
      const fills = (await fillPage(fields, { onlyIds: ids })) || [];
      if (stopped) return;
      if (isWorkday && /experience/i.test(step) && pkgCache) {
        await workdayExperience(pkgCache);
        const now = await gen("scan", { readOptions: false }).catch(() => []);
        now.forEach((f) => done.add(f.id));
      }
      await verify(fills);
      await rescueStuck();
      const review = await gen("onReviewStep").catch(() => false);
      if (review) banner("JobWatch: this is the review page. Check every answer, then click Submit yourself.");
      else report(step);
      // Ids seen after filling (conditional questions that just appeared are new).
      const seenNow = await gen("scan", { readOptions: false }).catch(() => []);
      for (const f of seenNow) if (f.filled) done.add(f.id);
    } catch (e) {
      warn("tick failed:", e.message);
    } finally {
      busy = false;
    }
  }

  // Start once the page settles, then follow steps and new questions.
  (async () => {
    await sleep(manual() ? 200 : 1500);
    await tick();
    let lastUrl = location.href;
    let quietUntil = 0;
    const obs = new MutationObserver(() => { quietUntil = Date.now() + 1200; });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (stopped || Date.now() - t0 > 90 * 60 * 1000) { clearInterval(timer); obs.disconnect(); return; }
      if (location.href !== lastUrl) { lastUrl = location.href; quietUntil = Date.now() + 1500; }
      if (Date.now() < quietUntil || busy) return;
      tick();
    }, 1500);
  })();
})();
