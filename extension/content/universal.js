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
//
// Workday auto-apply (a tab the runner opened, 2026-11-10): signs in with the
// password saved in the popup, or makes the company's account (verification
// link from Gmail), fills each step, presses Save and Continue, fixes what
// Workday flags (three presses per step at most), and stops on the Review page
// for the person to check and press Submit.

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
  const sleep = (ms) => (window.__jwWait ? window.__jwWait(ms) : new Promise((r) => setTimeout(r, ms)));
  const sendMsg = (msg) => new Promise((res) => { try { chrome.runtime.sendMessage(msg, res); } catch (e) { res({ ok: false, error: e.message }); } });
  // Every call into the page is bounded: right after a sign-in, Workday switches
  // to the application without a reload and a call could hang for good (RTX and
  // Micron froze silently, 2026-11-10). Three in a row: the page is reloaded.
  let hung = 0;
  async function gen(action, ...args) {
    // Long work has room (a scan opening every list, ten skills, an upload, the account forms).
    const ms = /^(scan|apply|workdayAdd)$/.test(action) ? 120000 : /^workday(Auth|Forgot|SetPassword|EmailForm)$/.test(action) ? 60000 : 20000;
    const r = await Promise.race([
      sendMsg({ type: "EXEC_GENERIC", action, args }),
      new Promise((res) => setTimeout(() => res({ ok: false, error: `no answer from the page in ${ms / 1000} s (${action})`, hung: ms === 20000 }), ms)),
    ]);
    if (r?.hung) {
      hung++;
      if (hung >= 3 && typeof AUTO !== "undefined" && AUTO) { hung = 0; location.reload(); }
    } else hung = 0;
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

  // ── Workday traces (users/{uid}/workdayTraces): every account step and form
  //    step of an auto-apply run, field by field, for measuring and fixing.
  const fillResults = {}; // path -> { ok, error, picked, value, kind, source, label }
  const stepFills = [];   // the computed fills of this step
  const stepReview = [];  // what the server left for the person on this step
  let lastProgress = Date.now(); // the last trace: the watchdog acts on a tab that went quiet
  let currentWork = "";          // what the fill is doing now (for a fill that runs too long)
  let busySince = 0;
  let busyReported = false;
  function trace(kind, data) {
    if (!AUTO || !isWorkday) return;
    lastProgress = Date.now();
    sendMsg({ type: "WORKDAY_TRACE", kind, data: { ...data, page: location.href.slice(0, 300) } }).catch?.(() => {});
  }

  async function fillFields(fills, pkg, order) {
    let pending = fills.filter((f) => order.has(f.path)).sort((a, b) => order.get(a.path) - order.get(b.path));
    const failures = [];
    for (let pass = 1; pass <= 3 && pending.length; pass++) {
      if (pass > 1) await sleep(900);
      const still = [];
      for (const f of pending) {
        currentWork = `filling ${f.label || f.path} (${f.kind}, pass ${pass})`;
        hl.focus(elOf(f.path), `Filling: ${f.label || f.path}`);
        const r = await applyWithRetry(f, pkg);
        fillResults[f.path] = { label: f.label, kind: f.kind, source: f.source || "", value: f.values || f.value, ok: !!r.ok, error: r.error || "", picked: r.picked || r.actual || "", seen: r.ok ? undefined : r.seen, pass };
        await sleep(220);
        hl.mark(!!r.ok);
        if (r.ok) {
          answersLog[f.path] = { label: f.label, answer: String(answerOf(f, r, pkg) ?? ""), type: f.kind, source: f.source || "", step: lastStep };
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
    // Workday question steps: required questions only; optional ones stay blank
    // (the person's call, 2026-11-10). A box Workday flags on Save and Continue
    // (refill) is answered even when it did not read as required.
    const questionStep = isWorkday && /^(application questions|voluntary disclosures|self identify)/i.test(await gen("stepName").catch(() => ""));
    // A field the tick chose (onlyIds) goes even when filled: Workday's answer
    // from an earlier attempt is replaced with today's (State Street's notice
    // period stayed "1 Week" because filled fields were never sent, 2026-11-13).
    const sendable = domFields.filter((d) => (!d.filled || refill.has(d.id) || (AUTO && isWorkday && onlyIds && onlyIds.has(d.id))) && (!onlyIds || onlyIds.has(d.id)) && !(isWorkday && EXPERIENCE_SECTION.test(d.section || ""))
      && (!questionStep || d.required || refill.has(d.id)));
    if (!sendable.length && pkgCache) return [];
    banner("JobWatch is working out your answers.");
    const res = await sendMsg({
      type: "GET_GENERIC_FILL_DATA", source, applyUrl: location.href, formKey: formKeyNow()?.formKey || "",
      externalId: postingKey()?.id || "", domFields: sendable.map(({ section: _s, parts: _p, filled: _f, wd: _w, domId: _d, fkit: _k, ...d }) => d),
      ...header, descriptionText: await gen("descriptionText").catch(() => ""),
    });
    if (!res?.ok || !res.data) { banner(`JobWatch could not compute this application: ${res?.error || "unknown error"}`); ledger("error", { error: String(res?.error || "compute failed") }); autoReport("error", `could not compute the application: ${res?.error || "unknown error"}`); return null; }
    const pkg = res.data;
    if (pkg.alreadyApplied) { banner(`JobWatch: you already applied to this job on ${fmtDay(pkg.submittedAt)}. Not filling it again.`); stopped = true; autoReport("skipped", "already applied"); return null; }
    pkgCache = { ...(pkgCache || {}), ...pkg, resumeB64: pkg.resumeB64 || pkgCache?.resumeB64 };
    // The posting's own title and company (Workday's API, or the job JobWatch holds) beat the page header.
    if (pkg.jobTitle) header.jobTitle = pkg.jobTitle;
    if (pkg.companyName) header.companyName = pkg.companyName;
    for (const r of pkg.review || []) attention.set(r.label, { path: r.path || "", note: r.note || "needs you" });
    stepFills.push(...pkg.fills.map((f) => ({ path: f.path, label: f.label, kind: f.kind, source: f.source || "", value: f.values || f.value, match: f.match, note: f.note })));
    stepReview.push(...(pkg.review || []));
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
    if (/school|university|institution|college/.test(l)) {
      if (!ed.school) return null;
      // A search list (Citi, Cadence): the school's other official names
      // ("KL University" is "Koneru Lakshmaiah…"), then "Other" where offered.
      const STOPW = /^(university|college|institute|school|of|the|and|at|for|in|de|education|foundation|deemed|to|be)$/i;
      const short = (n) => String(n).replace(/\(.*?\)/g, " ").split(/[\s,.-]+/).filter((w) => w.length >= 3 && !STOPW.test(w)).slice(0, 2).join(" ");
      // Two other names at most, then "Other" (the school's name then goes in
      // the box Workday opens for it): trying every spelling, pass after pass,
      // kept Cisco on KL University for minutes (2026-11-11).
      const alts = [...[...(ed.aliases || []), ed.school.replace(/[,.]/g, " ").replace(/\s+/g, " ").trim()].filter((x, i, a) => x && a.indexOf(x) === i && nrm(x) !== nrm(ed.school)).slice(0, 2), "Other"];
      return mk(field.type === "typeahead" || field.widget === "typeahead" ? "typeahead" : "text", ed.school, { match: ed.school, alternates: alts });
    }
    if (/^degree$|degree type|degree/.test(l)) {
      if (!ed.degree) return null;
      const exact = pickDegree(ed.degree, field.options);
      if (exact) return mk("select", exact);
      const d = nrm(ed.degree);
      const want = /ph\.?d|doctor/.test(d) ? "Doctor" : /master|m\.?s\b|mba|m\.?eng/.test(d) ? "Master" : /bachelor|b\.?s\b|b\.?a\b|b\.?tech|b\.?e\b/.test(d) ? "Bachelor" : /associate/.test(d) ? "Associate" : ed.degree;
      return mk("select", want);
    }
    if (/field of study|major|discipline/.test(l)) {
      if (!ed.field) return null;
      // Workday's list has "Computer Science", not "Computer Science and Artificial Intelligence".
      const shorter = [ed.field.replace(/\s*\([^)]*\)/g, ""), ed.field.split(/\s+(and|&|with)\s+|,\s*/i)[0], ed.field.split(/\s+/).slice(0, 2).join(" ")]
        .map((x) => x.trim()).filter((x) => x && nrm(x) !== nrm(ed.field));
      return mk(field.type === "typeahead" || field.type === "select" ? "typeahead" : "text", ed.field, { match: ed.field, alternates: [...new Set(shorter)] });
    }
    // GPA only where Workday requires it.
    if (/gpa|overall result|grade/.test(l)) return ed.gpa && field.required ? mk("text", String(ed.gpa)) : null;
    // The real start month when the resume gives one (Oklahoma: 01/2024 against
    // the resume's Aug 2024, caught before Submit, 2026-11-10).
    if (/^from$|start/.test(l)) return ed.from ? mk("date", `${ed.from.month ? MONTH(ed.from.month) : "01"}/${ed.from.year}`) : null;
    if (/^to\b|end|graduat|expected/.test(l)) return ed.to ? mk("date", `${ed.to.month ? MONTH(ed.to.month) : "05"}/${ed.to.year}`) : null;
    return null;
  }

  function langFill(field, lang) {
    const l = nrm(field.label);
    const mk = (kind, value) => ({ path: field.id, label: field.label, kind, value, source: "profile" });
    if (/^language$/.test(l)) return mk(field.type === "typeahead" || field.widget === "typeahead" ? "typeahead" : "select", lang);
    if (/fluent|native/.test(l) && (field.type === "checkbox" || field.type === "yesno")) return mk("boolean", "Yes");
    if (/overall|reading|speaking|writing|comprehension|proficien|level/.test(l)) {
      const opts = (field.options || []).map((o) => (typeof o === "string" ? o : o?.label)).filter(Boolean);
      const top = [/native|mother tongue/i, /fluent|full professional|bilingual/i, /expert|advanced/i].map((re) => opts.find((o) => re.test(o))).find(Boolean) || opts[opts.length - 1];
      return top ? mk("select", top) : null;
    }
    return null;
  }

  /** The option that names the resume's degree, from lists as different as
   *  "Master's Degree" (State Street), "MS" (Aerospace) and "Masters of Science"
   *  next to "Master of Strategic Leadership" (Wolters Kluwer), 2026-11-10:
   *  the same degree by name or letters, else the same subject at that level
   *  (B.Tech: technology, then engineering, then science), else the plain
   *  level ("Bachelor's Degree"), never a law, medicine or business degree
   *  the person does not have. */
  function pickDegree(degree, options) {
    const opts = (options || []).map((o) => (typeof o === "string" ? o : o?.label)).filter(Boolean);
    if (!opts.length) return null;
    const k = (x) => nrm(x).replace(/[.']/g, "").replace(/\bmasters\b/g, "master").replace(/\bbachelors\b/g, "bachelor").replace(/\s+degree$/, "").trim();
    const d = k(String(degree).split(/,| in /i)[0]);
    const level = /phd|doctor|dsc/.test(d) ? "doctor" : /master|^m(s|sc|tech|eng|e|a|ba)$/.test(d) ? "master"
      : /bachelor|^b(s|sc|tech|e|eng|a|ba|as)$/.test(d) ? "bachelor" : /associate|^a(s|a)$/.test(d) ? "associate" : "";
    if (!level) return null;
    const subj = /technolog|tech$/.test(d) ? "tech" : /engineer|eng$|^[mb]e$/.test(d) ? "eng" : /science|^[mb]sc?$/.test(d) ? "sci" : /arts|^[mb]a$/.test(d) ? "arts" : /business|^mba$|^bba$/.test(d) ? "bus" : "";
    const short = { master: "m", bachelor: "b", doctor: "d", associate: "a" }[level];
    const SUBJ = { tech: new RegExp(`^${short}tech$|technolog`), eng: new RegExp(`^${short}(e|eng)$|engineering`), sci: new RegExp(`^${short}sc?$|science`), arts: new RegExp(`^${short}a$|\\barts\\b`), bus: /business|mba|bba/ };
    const ofLevel = (o) => { const x = k(o); return x.startsWith(level) || (level === "doctor" && /^(phd|doctorate|dsc)/.test(x)) || new RegExp(`^${short}(s|sc|tech|e|eng|a|as|ba)$`).test(x) || (level === "master" && x === "mba"); };
    const others = /laws?\b|medicine|\bmd\b|\bjd\b|commerce|leadership|management|accountancy|divinity|nursing|education|fine arts|social work|public health/;
    const own = (o) => !others.test(k(o)) && (subj === "bus" || !/business|mba|bba/.test(k(o)));
    const same = opts.find((o) => k(o) === d);
    if (same) return same;
    const order = { tech: ["tech", "eng", "sci"], eng: ["eng", "tech", "sci"], sci: ["sci", "eng", "tech"], arts: ["arts"], bus: ["bus"] }[subj] || [];
    // The same subject first, then the plain level ("Master's Degree"), and
    // only then a neighbouring subject (NVIDIA: MTECH for a Master of Science).
    // An option naming its own field ("Master of Science in Administration")
    // fits only when that field is the person's ("…in Computer Science"); a
    // plain "Master of Science (M.S)" beats it (Workiva, 2026-11-11).
    const field = k(String(degree).split(/,| in /i).slice(1).join(" "));
    const optField = (o) => (k(o).match(/\bin ([a-z ]+)/) || [])[1]?.replace(/\s*\(.*$/, "").trim() || "";
    const fieldOk = (o) => { const f = optField(o); return !f || (!!field && (field.includes(f) || f.split(" ").every((w) => field.includes(w)))); };
    const bySubj = (sj) => opts.find((o) => ofLevel(o) && own(o) && fieldOk(o) && SUBJ[sj].test(k(o)));
    if (order[0] && bySubj(order[0])) return bySubj(order[0]);
    const plain = opts.find((o) => new RegExp(`^${level}( degree)?$`).test(k(o)));
    if (plain) return plain;
    for (const sj of order.slice(1)) { const hit = bySubj(sj); if (hit) return hit; }
    return opts.find((o) => ofLevel(o) && own(o) && fieldOk(o) && !/ of /.test(k(o))) || opts.find((o) => ofLevel(o) && own(o) && fieldOk(o)) || opts.find((o) => ofLevel(o) && own(o)) || null;
  }

  /** After My Experience: a Work Experience entry whose "To" shows empty
   *  (Travelers refused "The field To is required", 2026-11-10). The current
   *  job ticks "I currently work here" again, else gets this month; a past job
   *  gets its end date again. */
  async function fixWorkTo(roles) {
    const fields = await gen("scan", { readOptions: false }).catch(() => []);
    const blocks = [...new Set(fields.filter((f) => /^work experience \d+/i.test(f.section || "")).map((f) => f.section))];
    for (let i = 0; i < blocks.length; i++) {
      const role = roles[i];
      const mine = fields.filter((f) => f.section === blocks[i]);
      const to = mine.find((f) => f.type === "date" && /^to\b|end date/i.test(f.label) && !f.filled);
      if (!role || !to) continue;
      if (role.current) {
        const cur = mine.find((f) => f.type === "yesno" && /currently work here|current(ly)? (employed|position|job)/i.test(f.label));
        if (cur) { await gen("apply", cur.id, { kind: "boolean", value: "Yes", path: cur.id, label: cur.label }).catch(() => {}); await sleep(700); }
        const again = (await gen("scan", { readOptions: false }).catch(() => [])).find((f) => f.id === to.id);
        if (!again || again.filled) continue;
        const now = new Date();
        await gen("apply", to.id, { kind: "date", value: `${MONTH(now.getMonth() + 1)}/${now.getFullYear()}`, path: to.id, label: to.label }).catch(() => {});
      } else if (role.to) {
        await gen("apply", to.id, { kind: "date", value: role.to.month ? `${MONTH(role.to.month)}/${role.to.year}` : `12/${role.to.year}`, path: to.id, label: to.label }).catch(() => {});
      }
      log(`workday: fixed an empty To in ${blocks[i]}`);
    }
  }

  /** Saved work-history dates that are not the resume's: Workday once kept
   *  Oracle's start as 05/1900 though 05/2022 was typed and shown (State
   *  Street, submitted that way, 2026-11-13). Every My Experience step reads
   *  each entry's From / To as Workday holds it and types again any that differ. */
  async function fixWorkDates(roles) {
    const fields = await gen("scan", { readOptions: false }).catch(() => []);
    const blocks = [...new Set(fields.filter((f) => /^work experience \d+/i.test(f.section || "")).map((f) => f.section))];
    const ids = fields.filter((f) => blocks.includes(f.section) && (f.type === "date" || /company|employer/i.test(f.label))).map((f) => f.id);
    const vals = ids.length ? await gen("fieldValues", ids).catch(() => ({})) : {};
    const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const mmYY = (d) => (d?.year ? `${Number(d.month || 1)}/${d.year}` : "");
    const asNum = (t) => { const m = String(t || "").match(/(\d{1,2})\/(\d{4})/); return m ? `${Number(m[1])}/${m[2]}` : ""; };
    let fixed = 0;
    for (const b of blocks) {
      const mine = fields.filter((f) => f.section === b);
      const co = mine.find((f) => /company|employer/i.test(f.label));
      const role = roles.find((r) => co && norm(r.company) && norm(vals[co.id]) === norm(r.company));
      if (!role) continue;
      for (const f of mine.filter((x) => x.type === "date")) {
        const isTo = /^to\b|end date/i.test(f.label);
        const want = isTo ? (role.current ? "" : mmYY(role.to)) : mmYY(role.from);
        const have = asNum(vals[f.id]);
        if (!want || !have || have === want) continue;
        const [m, y] = want.split("/");
        await gen("apply", f.id, { kind: "date", value: `${MONTH(Number(m))}/${y}`, path: f.id, label: f.label }).catch(() => {});
        fixed++;
        log(`workday: ${b} ${f.label} was ${vals[f.id]}, typed ${want}`);
      }
    }
    return fixed;
  }

  async function workdayExperience(pkg) {
    const hist = pkg.history || {};
    const plan = [
      { name: "Work Experience", items: (hist.roles || []).slice(0, 5), fillFor: roleFill },
      { name: "Education", items: (hist.education || []).slice(0, 3), fillFor: eduFill },
      // Only an entry the company put there already (HP: "Overall*" proficiency
      // required and left empty, 2026-11-10): English, at the top level.
      { name: "Languages?", items: ["English"], fillFor: langFill, onlyExisting: true },
      { name: "Websites", items: (hist.links || []).slice(0, 3), fillFor: (field, url) => (/url|website|link/i.test(field.label) ? { path: field.id, label: field.label, kind: "text", value: url, source: "profile" } : null) },
    ];
    for (const sec of plan) {
      if (!sec.items.length) continue;
      let fields = await gen("scan", { readOptions: false });
      const blocks = () => [...new Set(fields.filter((f) => new RegExp(`^${sec.name}\\b`, "i").test(f.section)).map((f) => f.section))];
      // Workday parsed the resume already: leave its entries to the person.
      if (!sec.onlyExisting && blocks().length && fields.some((f) => new RegExp(`^${sec.name}\\b`, "i").test(f.section) && f.filled && f.type !== "yesno")) { log(`${sec.name}: already has entries, leaving them`); continue; }
      for (let i = 0; i < sec.items.length; i++) {
        if (blocks().length <= i) {
          if (sec.onlyExisting) break;
          const added = await gen("workdayAdd", sec.name).catch((e) => ({ ok: false, error: e.message }));
          if (!added?.ok) { warn(`${sec.name}: could not add entry ${i + 1}`, added?.error); break; }
          await sleep(1500); // Workday redraws the section after Add: type once it settles
        }
        fields = await gen("scan", { readOptions: true });
        const name = blocks()[i];
        if (!name) break;
        // An unchecked optional box reads as answered; "I currently work here" still needs its answer.
        const mine = fields.filter((f) => f.section === name && (!f.filled || f.type === "yesno"));
        const order = new Map(fields.map((d, k) => [d.id, k]));
        const fills = mine.map((f) => sec.fillFor(f, sec.items[i])).filter(Boolean);
        banner(`JobWatch is adding ${name} from your resume.`);
        currentWork = `adding ${name}`;
        const failures = await fillFields(fills, pkg, order);
        for (const f of failures) attention.set(`${name}: ${f.label}`, { path: f.path, note: f.error || "could not fill" });
        // School picked as "Other": the name goes in the box that opens for it
        // ("School Name", "Other School", "Please specify").
        if (sec.name === "Education" && sec.items[i]?.school) {
          await sleep(800);
          const now = (await gen("scan", { readOptions: false }).catch(() => [])).filter((f) => f.section === name);
          const box = now.find((f) => !f.filled && ["text", "textarea"].includes(f.type) && /(other|name of|specify).{0,30}(school|university|institution|college)|(school|university|institution|college).{0,20}(name|other|specify)|please specify/i.test(f.label));
          if (box) {
            await fillFields([{ path: box.id, label: box.label, kind: "text", value: sec.items[i].school, source: "resume" }], pkg, new Map([[box.id, 0]]));
          }
        }
      }
    }
    await fixWorkTo((hist.roles || []).slice(0, 5));
    await fixWorkDates((hist.roles || []).slice(0, 8));
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
      // A resume once uploaded is never sent again (copies piled up on Workday).
      const fixable = problems.filter((d) => byPath.has(d.id) && !(d.type === "file" && answersLog[d.id]));
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
    // The rescue finds a field by its question text: an internal id
    // ("school-or-university:typeahead#2") or a "Education 2: " prefix never
    // matched, and each pass added another "AI: field not found on the page".
    const asked = new Set();
    for (const [label, v] of [...attention.entries()].slice(0, 8)) {
      const question = String(label).replace(/^(work experience|education|websites?|languages?|certifications?)\s*\d*:\s*/i, "");
      if (/^[a-z0-9-]+:[a-z]+#\d+$/i.test(question)) { attention.delete(label); continue; } // an id: the same field is listed by its label too
      if (asked.has(question) || /\bAI: /.test(v.note || "")) continue;
      asked.add(question);
      banner(`JobWatch is asking AI how to finish: ${question}`);
      const r = await window.__jwRescue(question, { jobTitle: header.jobTitle || "", companyName: header.companyName || "" });
      log("rescue:", question, r);
      if (r?.ok) { attention.delete(label); answersLog[`rescue:${question}`] = { label: question, answer: r.answer || "(AI rescue)", type: "ai-rescue", source: "ai", step: lastStep }; }
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
      if (window.__jwLearnManual) window.__jwLearnManual([...attention.keys()], { jobTitle: header.jobTitle || "", companyName: header.companyName || "" });
    } else {
      banner(`JobWatch filled ${filled} field${filled === 1 ? "" : "s"}${stepLabel ? ` (${stepLabel})` : ""}. Review, then ${next} yourself.`);
    }
    ledger("filled", {
      jobTitle: header.jobTitle, companyName: header.companyName, answersLog,
      needsAttention: [...attention.entries()].map(([label, v]) => ({ label, path: v.path, note: v.note })),
      filledCount: filled, flow: "engine", schemaSource: `${source}-dom`, reasons: pkgCache?.reasons || [],
    }).then((r) => { if (!r?.ok) warn("ledger(filled) failed:", r?.error); });
  }

  // ── Workday auto-apply: account and steps ─────────────────────────────────
  let AUTO = null; // the runner's job when this tab is one of its own
  function autoReport(status, note) {
    if (!AUTO) return;
    trace("result", { status, note: String(note || "").slice(0, 500), step: lastStep });
    AUTO = null; // the tab is the person's from here on
    sendMsg({ type: "AUTO_RESULT", status, note: String(note || "").slice(0, 300) });
  }
  // What the account steps did so far, kept across page loads in this tab.
  const AUTH_KEY = "jwWdAuth";
  const authMem = () => { try { return JSON.parse(sessionStorage.getItem(AUTH_KEY) || "{}"); } catch { return {}; } };
  const authSave = (o) => { try { sessionStorage.setItem(AUTH_KEY, JSON.stringify(o)); } catch { /* private mode */ } };
  const EXISTS = /already (exists|in use|registered|associated)|account (with|for) this email|email address is already/i;
  const WRONG = /(wrong|incorrect|invalid|not valid).{0,40}(password|email|sign in|credentials)|password.{0,20}(incorrect|wrong|invalid)|could not sign you in/i;
  const LOCKED = /lock(ed)?\b|too many (attempts|tries)/i;
  const VERIFY = /verif|activat|confirm your (email|account)/i;

  /** Sign in, or make the account, with the popup's Workday password. */
  async function autoAuth() {
    const creds = await sendMsg({ type: "WORKDAY_CREDS" });
    if (!creds?.ok) return autoReport("needs_attention", `Workday sign-in: ${creds?.error || "no password"}`);
    const mem = authMem();
    mem.tries = (mem.tries || 0) + 1;
    if (mem.tries > 8) { authSave(mem); return autoReport("needs_attention", "Workday sign-in did not go through after eight tries"); }
    if (mem.mode === "reset") return setNewPassword(mem, creds); // the page from the reset email
    const st = await gen("workdayAuthState").catch(() => ({ mode: null, errors: [], message: "" }));
    const said = `${st.errors.join(" ")} ${st.message}`.trim();
    // No account form after a reset, a verification or a new account: Workday
    // often signs in by itself and lands on the posting or the account home
    // (Allstate, Salesforce, 2026-11-10), where looking for the Sign In form
    // gave up. Open the application instead (twice at most).
    if (!st.mode && (mem.resetAt || mem.verified || mem.triedCreate)) {
      if (await gen("workdayInApp").catch(() => false)) {
        sendMsg({ type: "WORKDAY_ACCOUNT" });
        trace("auth", { phase: "signed in", did: "landed", tries: mem.tries, viaReset: !!mem.resetAt, viaCreate: !!mem.triedCreate, verified: !!mem.verified });
        authSave({ done: true });
        return;
      }
      mem.landings = (mem.landings || 0) + 1;
      authSave(mem);
      const target = AUTO?.applyUrl || "";
      if (mem.landings <= 2 && target && location.href.split("?")[0] !== target.split("?")[0]) {
        trace("auth", { phase: "no account form; opening the application", landings: mem.landings, from: location.href.slice(0, 200) });
        banner("Auto-apply: opening the application…");
        location.href = target;
        return;
      }
    }
    // The flow (2026-11-10): Sign In first with the saved email and password.
    // Refused ("You may have entered the wrong email address or password or
    // your account might be locked"): a company with no account yet gets one
    // (Create Account); an account that exists is reset to the saved password
    // (Forgot your password? -> the email's link -> Reset Password), then Sign In.
    // A company with no account saved yet starts at Create Account (2026-11-12:
    // Sign In first was refused 87 of 90 times there, and those failed sign-ins,
    // often then a reset, came just before Workday's "currently unavailable"
    // page, its answer to what looks like password guessing). "Already exists"
    // still leads to the reset.
    let mode = mem.mode || (creds.hasAccount ? "signin" : "create");
    // The company's own password rules ("Password must include: A minimum of 12
    // characters", Citi): only a new saved password helps.
    // Only the refusal ("Error: Password must include: A minimum of 12 characters"),
    // never the requirements list every Create Account page shows (Cadence).
    const rule = said.match(/password must (include|contain|be|have)\b[^.]*/i);
    if (rule) {
      authSave(mem);
      return autoReport("needs_attention", `${header.companyName || "This company"} refuses the saved Workday password: ${said.replace(/\s+/g, " ").slice(0, 160)}. Save a longer one in the JobWatch popup.`);
    }
    if (mem.mode === "signin" && (WRONG.test(said) || LOCKED.test(said))) {
      if (mem.resetAt) { authSave(mem); return autoReport("needs_attention", `Workday at ${header.companyName || "this company"} still refuses the saved password after a reset: ${said.slice(0, 140)}`); }
      if (creds.hasAccount || mem.triedCreate) return resetPassword(mem, creds);
      mode = "create";
    }
    else if (mem.mode === "create" && EXISTS.test(said)) { sendMsg({ type: "WORKDAY_ACCOUNT" }); return resetPassword(mem, creds); }
    // After a reset (the email link proved the address), page text that mentions
    // verification is not a request: sign in first, and wait for a verification
    // email only when Workday refuses with one (Zebra, Labcorp waited three
    // minutes for an email never sent, 2026-11-10).
    else if (mem.mode && VERIFY.test(mem.resetAt && st.mode ? st.errors.join(" ") : said)) return verifyEmail(mem);
    // Made the account; Workday moved on to Sign In, or to its "Sign in with email" chooser (Workday, Jabil).
    else if (mem.mode === "create" && (st.mode === "signin" || st.mode === "chooser") && !st.errors.length) mode = "signin";
    if (mode === "create") mem.triedCreate = true;
    trace("auth", { phase: "decide", screen: st.mode, errors: st.errors, message: st.message, decided: mode, tries: mem.tries, hasAccount: !!creds.hasAccount, resetAt: mem.resetAt || 0 });
    mem.mode = mode; mem.at = mem.at || Date.now();
    authSave(mem);
    banner(mode === "create" ? "Auto-apply: creating your Workday account for this company." : "Auto-apply: signing in to Workday.");
    const r = await gen("workdayAuth", { email: creds.email, password: creds.password, mode }).catch((e) => ({ ok: false, error: e.message }));
    // No Create Account form on this site: Sign In next time, as before.
    if (!r?.ok && mode === "create" && !mem.resetAt) authSave({ ...mem, mode: "signin" });
    if (!r?.ok) { trace("auth", { phase: "action failed", did: mode, error: r?.error }); warn("workday auth:", r?.error); if (mem.tries >= 3) autoReport("needs_attention", `Workday sign-in: ${r?.error}`); return; }
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      // In: the application's own steps are on screen (Morgan Stanley read as
      // signed in between two forms, then refused the password, 2026-11-10).
      if (await gen("workdayInApp").catch(() => false)) {
        sendMsg({ type: "WORKDAY_ACCOUNT" });
        trace("auth", { phase: "signed in", did: mode, tries: mem.tries, viaReset: !!mem.resetAt, viaCreate: !!mem.triedCreate, verified: !!mem.verified });
        authSave({ done: true });
        log("workday: signed in");
        return;
      }
    }
    const after = await gen("workdayAuthState").catch(() => ({ errors: [], message: "" }));
    trace("auth", { phase: "after action", did: mode, screen: after.mode, errors: after.errors, message: after.message });
    if (mode === "create" && VERIFY.test(`${after.errors.join(" ")} ${after.message}`)) return verifyEmail(mem);
    // Anything else the page said is read on the next tick.
  }

  /** "Forgot your password?", then the reset email's link opens in this tab. */
  async function resetPassword(mem, creds) {
    mem.resetAt = Date.now();
    authSave(mem);
    banner("Auto-apply: this Workday account has another password. Resetting it to your saved one…");
    const r = await gen("workdayForgot", creds.email).catch((e) => ({ ok: false, error: e.message }));
    trace("auth", { phase: "reset requested", ok: !!r?.ok, error: r?.error || "" });
    if (!r?.ok) return autoReport("needs_attention", `Workday password reset: ${r?.error || "could not start"}`);
    for (let i = 0; i < 18; i++) { // three minutes
      await sleep(10000);
      const m = await sendMsg({ type: "WORKDAY_VERIFY_LINK", kind: "reset", since: mem.resetAt });
      if (!m?.ok) return autoReport("needs_attention", `Workday reset email: ${m?.error || "Gmail unavailable"}`);
      if (m.link) {
        trace("auth", { phase: "reset email found", afterSeconds: Math.round((Date.now() - mem.resetAt) / 1000) });
        authSave({ ...mem, mode: "reset" });
        location.href = m.link;
        return;
      }
    }
    autoReport("needs_attention", "Workday's password reset email did not arrive within three minutes");
  }
  /** On the reset email's page: the saved password, then back to the application. */
  async function setNewPassword(mem, creds) {
    banner("Auto-apply: setting your Workday password…");
    const r = await gen("workdaySetPassword", { email: creds.email, password: creds.password }).catch((e) => ({ ok: false, error: e.message }));
    trace("auth", { phase: "new password set", ok: !!r?.ok, error: r?.error || "" });
    if (!r?.ok) return autoReport("needs_attention", `Workday password reset: ${r?.error}`);
    await sleep(5000);
    const after = await gen("workdayAuthState").catch(() => ({ errors: [] }));
    if (after.errors.length && await gen("hasPassword").catch(() => false) && after.mode !== "signin") {
      return autoReport("needs_attention", `Workday did not take the new password: ${after.errors.join(" ").slice(0, 160)}`);
    }
    sendMsg({ type: "WORKDAY_ACCOUNT" });
    authSave({ ...mem, mode: "signin", tries: 0 });
    banner("Auto-apply: password set. Signing in…");
    // Workday redirects by itself after a reset (signed in, to the posting or
    // the account home). Jumping to Sign In during that redirect showed
    // "Workday is currently unavailable" (HPE, Johnson Controls, Fox, Target,
    // 2026-11-10). Let it land; the next page signs in or opens the application.
    const from = location.href;
    for (let i = 0; i < 12 && location.href === from; i++) await sleep(1000);
    if (location.href !== from) return;
    location.href = AUTO?.applyUrl || loginUrl();
  }

  /** Workday emailed a verification link: open it from Gmail, then sign in. */
  async function verifyEmail(mem) {
    sendMsg({ type: "WORKDAY_ACCOUNT" });
    // An account made earlier and never verified: ask for a new email, so the
    // link looked for is one sent from now on.
    if (await gen("workdayResendVerify").catch(() => false)) { mem.at = Date.now(); authSave(mem); await sleep(2000); }
    banner("Auto-apply: Workday sent a verification email. Opening its link from Gmail…");
    for (let i = 0; i < 18; i++) { // three minutes
      const r = await sendMsg({ type: "WORKDAY_VERIFY_LINK", since: mem.at || Date.now() - 600000, open: true });
      if (!r?.ok) return autoReport("needs_attention", `Workday verification email: ${r?.error || "Gmail unavailable"}`);
      if (r.link) {
        trace("auth", { phase: "verification email found", afterSeconds: Math.round((Date.now() - (mem.at || Date.now())) / 1000) });
        authSave({ ...mem, mode: "signin", verified: true });
        banner("Auto-apply: account verified. Signing in…");
        await sleep(1500);
        location.href = loginUrl();
        return;
      }
      await sleep(10000);
    }
    autoReport("needs_attention", "Workday's verification email did not arrive within three minutes");
  }

  /** Workday's Sign In page that returns to this application (background.js workdayLoginUrl). */
  function loginUrl() {
    const apply = AUTO?.applyUrl || location.href;
    try {
      const u = new URL(apply);
      const parts = u.pathname.split("/").filter(Boolean);
      const at = parts.findIndex((x) => x === "job" || x === "details");
      return at < 1 ? apply : `${u.origin}/${parts.slice(0, at).join("/")}/login?redirect=${encodeURIComponent(u.pathname)}`;
    } catch { return apply; }
  }

  // Fields Workday refused although they had a value (a phone saved earlier as
  // "+1 (510) 935-6846", Analog Devices 2026-11-10): computed and filled again.
  const refill = new Set();

  /** The step is filled: Save and Continue, or stop on Review. */
  const stepPresses = new Map();
  /** The questions and answers on Workday's Review page, as text pairs: each
   *  label line, then its answer (the page lists them that way). Only the
   *  question steps; My Information and My Experience come from the Profile and
   *  resume and were checked as they were filled. */
  function reviewItems(text) {
    const lines = String(text).split("\n").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
    const HEAD = /^(application questions( \d+ of \d+)?|voluntary disclosures|self identify|disability|review|my information|my experience|terms and conditions|personal information|e\.?e\.?o\.?.{0,30})$/i;
    // The voluntary sections (gender, race, disability, veteran) are never
    // judged, and their sub-headings ("Personal Information") shifted every
    // question/answer pair after them (Target, 2026-11-13): stop there.
    const END = /^(voluntary disclosures|self identify|self-identification|disability|veteran status|terms and conditions|back|submit)$/i;
    const start = lines.findIndex((l, i) => i > 0 && /^application questions/i.test(l) && !/^(completed|current) step/i.test(lines[i - 1] || ""));
    if (start < 0) return [];
    let end = lines.findIndex((l, i) => i > start && END.test(l));
    if (end < 0) end = lines.length;
    const body = lines.slice(start, end).filter((l) => !HEAD.test(l) && !/^(completed|current) step/i.test(l));
    // A required question ends with "*"; its answer is the line after it.
    // An unmarked line is an optional question, its answer the next line.
    const items = [];
    for (let i = 0; i < body.length; i++) {
      const line = body[i];
      const next = body[i + 1];
      if (next == null || /\*$/.test(next)) continue; // a question with no answer line, or a stray line
      // Prose between questions ("Thank you for sharing your information!")
      // when a question follows it: skip it, or every pair after shifts.
      const asks = (t) => /[?:]\s*$/.test(t);
      if (!/\*$/.test(line) && !asks(line) && asks(next)) continue;
      // A select-all answer is one choice per line ("Evenings", "Weekends",
      // "Overnight" at Target, read as a question "Weekends" -> "Overnight"):
      // short lines that do not read as a question belong to the answer.
      const parts = [next];
      i++;
      if (/\*$/.test(line)) {
        while (i + 1 < body.length) {
          const t = body[i + 1];
          if (/\*$/.test(t) || asks(t) || t.length > 40 || /^(if|please|do|did|are|have|has|will|would|what|which|how|when|why|where)\b/i.test(t)) break;
          parts.push(t); i++;
        }
      }
      items.push({ question: line.replace(/\*$/, "").trim(), answer: parts.join(", "), required: /\*$/.test(line) });
    }
    return items.slice(0, 120);
  }


  /** Review with Submit allowed for this job: one AI look at every answer,
   *  then Submit, then Workday's confirmation. Anything off stops at Review
   *  for the person, with the reason. */
  /** The Workday company of a URL: acme.wd5.myworkdayjobs.com, or wdN.myworkdaysite.com/recruiting/acme. */
  function wdSite(url) {
    try {
      const u = new URL(url);
      const m = u.hostname.match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/i);
      if (m) return m[1].toLowerCase();
      const p = u.pathname.split("/").filter(Boolean);
      return /myworkdaysite\.com$/i.test(u.hostname) && p[0] === "recruiting" ? String(p[1] || "").toLowerCase() : "";
    } catch { return ""; }
  }
  /** This page is the job JobWatch was given: the same Workday company and
   *  the same requisition (the "_JR-0107838" end of the posting). */
  function onOwnJob() {
    try {
      const want = new URL(AUTO?.applyUrl || ""), here = new URL(location.href);
      if (want.hostname !== here.hostname) return false;
      const req = (want.pathname.match(/_([A-Za-z0-9-]+)(?:\/apply|\/?$)/) || [])[1];
      return !!req && here.pathname.includes(`_${req}`);
    } catch { return false; }
  }

  async function workdaySubmitFlow(reviewText) {
    // Never Submit a page that is not this job (the Workday job's tab once
    // landed on NVIDIA's application and submitted it, 2026-11-10).
    if (!onOwnJob()) {
      trace("submit", { refused: "not this job", page: location.href, want: AUTO?.applyUrl || "" });
      return autoReport("needs_attention", `not submitted: this tab is on another posting (${location.href.slice(0, 120)}), not the job it was given`);
    }
    // A date Workday saved wrong (Oracle's start as 05/1900 though 05/2022 was
    // typed, State Street, submitted that way, 2026-11-13): never Submit it.
    // The retry's My Experience step types it again (fixWorkDates).
    const badDate = String(reviewText).match(/\b(0?[1-9]|1[0-2])\/(1[0-8]\d\d|19[0-4]\d)\b/);
    if (badDate) {
      trace("submit", { refused: "bad date", date: badDate[0] });
      banner(`Auto-apply did not submit: Workday saved a date as ${badDate[0]}. It will fix the date and try again.`);
      return autoReport("needs_attention", `not submitted: Workday saved a date as ${badDate[0]}; the next try types it again`);
    }
    // What JobWatch filled on every step of this application (exact labels and
    // answers); the Review page's text only when that record is gone (a reload).
    const filled = Object.values(answersLog).filter((x) => x && x.label && x.type !== "file").map((x) => ({ question: String(x.label), answer: String(x.answer ?? ""), required: false }));
    const items = filled.length >= 3 ? filled.slice(0, 120) : reviewItems(reviewText);
    banner("Auto-apply: checking every answer once more before Submit…");
    const chk = await sendMsg({ type: "REVIEW_FORM", items, jobTitle: header.jobTitle || "", companyName: header.companyName || "" });
    trace("precheck", { items: items.length, ok: !!chk?.ok, error: chk?.error || "", issues: chk?.issues || [] });
    if (!chk?.ok) return autoReport("review", `filled to Review; not submitted: the answer check failed (${String(chk?.error || "no reply").slice(0, 120)})`);
    if ((chk.issues || []).length) {
      const say = chk.issues.slice(0, 3).map((i) => `${String(i.question).slice(0, 80)}: ${String(i.problem).slice(0, 120)}`).join("; ");
      banner(`Auto-apply did not submit: ${say}`);
      return autoReport("review", `filled to Review; not submitted, check: ${say}`);
    }
    if (await gen("submitted").catch(() => false)) return autoReport("review", "filled to Review; not submitted: the page already reads as submitted, check it");
    await sendMsg({ type: "WORKDAY_FOCUS" });
    banner("Auto-apply: every answer checks out. Pressing Submit.");
    const r = await gen("workdaySubmit").catch((e) => ({ ok: false, error: e.message }));
    trace("submit", { pressed: !!r?.ok, error: r?.error || "" });
    if (!r?.ok) return autoReport("review", `filled to Review; not submitted: ${r?.error || "Submit could not be pressed"}`);
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      if (await gen("submitted").catch(() => false)) {
        const text = (document.body?.innerText || "").slice(0, 3000);
        trace("result", { status: "submitted", note: "", confirmation: text.slice(0, 1500) });
        await ledger("submitted", { jobTitle: header.jobTitle, companyName: header.companyName, answersLog });
        submittedSeen = true;
        banner("JobWatch: submitted. Workday confirmed the application.");
        return autoReport("submitted", "");
      }
      // Still on Review with an error (a required answer Workday checks only now).
      if (i > 5 && await gen("onReviewStep").catch(() => false)) {
        const errs = await gen("errors").catch(() => []);
        const said = (await gen("workdayAuthState").catch(() => ({ errors: [] }))).errors;
        if (errs.length || said.length) {
          trace("submit", { refused: true, errors: errs, banner: said });
          return autoReport("needs_attention", `pressed Submit; Workday refused: ${[...said, ...errs.map((e) => e.text)].join(" ").slice(0, 200)}`);
        }
      }
    }
    trace("submit", { confirmed: false, url: location.href, text: (document.body?.innerText || "").slice(0, 2000) });
    return autoReport("needs_attention", "pressed Submit, but no confirmation showed within 40 seconds: check the application in Workday");
  }

  /** Workday: one AI look at this step's answers (with the steps before it
   *  for context) before Save and Continue, while they can still be changed.
   *  Each answer it calls wrong goes to the AI rescue with the problem as the
   *  field's error. Workday's Review page cannot be edited, so a wrong answer
   *  found only there stopped the application: 21 of 53 unsubmitted Workday
   *  applications, 2026-11-10 to 11-13 (HPE three times on the same answer). */
  const checkedSteps = new Set();
  async function stepCheck(step) {
    if (!step || checkedSteps.has(step) || !window.__jwRescue) return;
    checkedSteps.add(step);
    if (/voluntary|self.?identif|disclosure|disabilit|veteran|review/i.test(step)) return;
    const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();
    const all = Object.values(answersLog).filter((x) => x && x.label && x.type !== "file");
    const mine = all.filter((x) => x.step === step);
    if (!mine.length) return;
    const count = new Map();
    for (const x of mine) count.set(norm(x.label), (count.get(norm(x.label)) || 0) + 1);
    const items = all.slice(-120).map((x) => ({ question: norm(x.label), answer: String(x.answer ?? ""), required: false }));
    banner(`Auto-apply: checking the answers on ${step} before Save and Continue…`);
    const chk = await sendMsg({ type: "REVIEW_FORM", items, jobTitle: header.jobTitle || "", companyName: header.companyName || "" });
    // Only this step's questions can still be changed; a label the step holds
    // twice ("School or University" for each school) cannot be told apart by
    // the rescue, so it is left for the check at Review.
    const issues = (chk?.ok ? chk.issues || [] : []).filter((i) => count.get(norm(i.question)) === 1);
    const out = [];
    for (const i of issues.slice(0, 5)) {
      banner(`Auto-apply: fixing before Save and Continue: ${String(i.question).slice(0, 90)}`);
      const r = await window.__jwRescue(i.question, { jobTitle: header.jobTitle || "", companyName: header.companyName || "", force: true, error: `${i.problem}${i.fix ? ` The right answer: ${i.fix}` : ""}` });
      const entry = mine.find((x) => norm(x.label) === norm(i.question));
      if (r?.ok && entry) { entry.answer = String(r.answer || i.fix || entry.answer); entry.source = "ai-review"; }
      out.push({ question: i.question, problem: i.problem, fix: i.fix, fixed: !!r?.ok, answer: r?.answer || "", why: r?.why || "" });
    }
    trace("stepcheck", { step, items: items.length, ok: !!chk?.ok, error: chk?.error || "", issues: chk?.issues || [], fixes: out });
  }

  async function autoAdvance(step) {
    // A page still loading has no step name: wait for it, never press Save and
    // Continue there (Micron used up its three presses on a blank page).
    if (!step && !(await gen("onReviewStep").catch(() => false))) return;
    if (await gen("onReviewStep").catch(() => false)) {
      // The whole Review page, to check every answer as Workday will send it.
      const reviewText = (document.querySelector("[data-automation-id=applyFlowPage]") || document.body).innerText.slice(0, 60000);
      trace("review", { text: reviewText });
      if (AUTO?.submit && !AUTO?.test) return await workdaySubmitFlow(reviewText);
      banner("Auto-apply filled every step. This is the Review page: check each answer, then press Submit yourself.");
      return autoReport("review", "filled to Review: check it and press Submit");
    }
    await stepCheck(step);
    if (!AUTO) return; // the person took over while it ran
    const n = (stepPresses.get(step) || 0) + 1;
    stepPresses.set(step, n);
    if (n > 3) {
      const left = [...attention.keys()].slice(0, 5).join("; ");
      return autoReport("needs_attention", `stuck on ${step || "a step"}${left ? `: ${left}` : ": Save and Continue did not move on"}`);
    }
    banner(`Auto-apply: ${step || "this step"} is filled. Pressing Save and Continue.`);
    await sendMsg({ type: "WORKDAY_FOCUS" });
    // Workday greys Save and Continue out while it works (an upload, a check):
    // wait for it, up to half a minute (Autodesk, 2026-11-10).
    let r = await gen("workdayNext").catch((e) => ({ ok: false, error: e.message }));
    for (let i = 0; i < 15 && !r?.ok && /disabled/i.test(r?.error || ""); i++) {
      await sleep(2000);
      r = await gen("workdayNext").catch((e) => ({ ok: false, error: e.message }));
    }
    if (!r?.ok) {
      // Stuck with no message: what the page shows, for the fix.
      trace("stuck", {
        step, error: r?.error || "",
        buttons: [...document.querySelectorAll("button, [role=button]")].filter((x) => x.offsetParent).map((x) => `${x.getAttribute("data-automation-id") || ""}|${(x.innerText || x.getAttribute("aria-label") || "").trim().slice(0, 60)}|${x.disabled || x.getAttribute("aria-disabled") === "true" ? "disabled" : ""}`).slice(0, 80),
        problems: await gen("fieldHtml", []).catch(() => []),
        html: (document.querySelector("[data-automation-id=applyFlowPage]") || document.body).outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, "<svg/>").replace(/ (style|class)="[^"]*"/g, "").replace(/\s+/g, " ").slice(0, 300000),
      });
      return autoReport("needs_attention", `${step || "step"}: ${r?.error || "could not press Save and Continue"}`);
    }
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      const now = await gen("stepName").catch(() => step);
      if (now !== step) { trace("advance", { step, press: n, moved: true, next: now }); return; } // the next tick fills the new step
    }
    // Same step: what Workday flags is filled again on the next tick, and the
    // AI reads what it still refuses.
    const errs = await gen("errors").catch(() => []);
    const pageSays = await gen("workdayAuthState").catch(() => ({ errors: [] }));
    trace("advance", { step, press: n, moved: false, errors: errs, banner: pageSays.errors, problems: await gen("fieldHtml", errs.map((e) => e.path).filter(Boolean)).catch(() => []) });
    log(`workday: ${step} refused`, errs);
    // The question right before a refused one may be what opened it (a saved
    // "Yes" to "Do you have a license or certification?" behind "Please provide
    // the Type, Number…", University of Miami): computed again with it.
    const order = await gen("scan", { readOptions: false }).catch(() => []);
    for (const e of errs) {
      const at = e.path ? order.findIndex((f) => f.id === e.path) : -1;
      if (at > 0 && order[at - 1].section === order[at].section) { done.delete(order[at - 1].id); refill.add(order[at - 1].id); }
    }
    for (const e of errs) {
      if (e.path) { done.delete(e.path); refill.add(e.path); }
      attention.set(e.label || e.path || e.text, { path: e.path || "", note: `The form says: ${e.text}` });
    }
    await rescueStuck();
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
    if (AUTO && await gen("workdayClosed").catch(() => false)) { stopped = true; return autoReport("error", "job closed: no longer available"); }
    const resetting = !!AUTO && authMem().mode === "reset";
    if (AUTO && isWorkday && !busy) {
      // Coming back to an application already started: "Something went wrong.
      // Please refresh the page" on Apply Manually; a refresh opens the saved one.
      if (/something went wrong[\s\S]{0,80}refresh the page/i.test((document.body?.innerText || "").slice(0, 4000))) {
        const mem = authMem();
        mem.refreshes = (mem.refreshes || 0) + 1;
        authSave(mem);
        if (mem.refreshes <= 2) { location.reload(); return; }
        stopped = true;
        return autoReport("error", "Workday kept saying \"Something went wrong\" (try again later)");
      }
      // The posting page: "Continue Application" (started before) or the Apply button.
      if (!onApplyFlow() && !resetting && await gen("workdayPress", "continueButton", "^continue application$").catch(() => false)) { banner("Auto-apply: continuing the application started before."); return; }
    }
    // Submitted by hand after auto-apply stopped on Review: Workday then shows
    // Candidate Home ("Thank you for applying to State Street!"), off the
    // application, and the submit was never recorded (State Street, 2026-11-13).
    if (isWorkday && started && !submittedSeen && !onApplyFlow() && await gen("submitted").catch(() => false)) {
      submittedSeen = true;
      trace("result", { status: "submitted", note: "submitted by hand", page: location.href });
      await ledger("submitted", { jobTitle: header.jobTitle, companyName: header.companyName, answersLog });
      banner("JobWatch: application recorded as submitted.");
      if (AUTO) autoReport("submitted", "submitted by hand");
      return;
    }
    if (!onApplyFlow() && !resetting) return;
    if (manual()) { window.__jwManualStart = false; forced = true; armNext = true; }
    if (!started && !forced && (!formish() || pageSig() === notAFormSig)) return;
    busy = true;
    busySince = Date.now();
    busyReported = false;
    try {
      if (started && await gen("submitted").catch(() => false)) {
        if (started && !submittedSeen) {
          submittedSeen = true;
          ledger("submitted", { jobTitle: header.jobTitle, companyName: header.companyName, answersLog }).then(() => banner("JobWatch: application recorded as submitted."));
        }
        return;
      }
      if (isWorkday && await gen("workdayStartModal").catch(() => false)) {
        if (AUTO && await gen("workdayPress", "applyManually", "^apply manually$").catch(() => false)) { banner("Auto-apply: choosing Apply Manually."); return; }
        banner("JobWatch: choose Autofill with Resume or Apply Manually. JobWatch fills each step after you sign in.");
        return;
      }
      // Auto-apply on another company's Workday site (a wrong email link): stop, fill nothing.
      if (AUTO && isWorkday && wdSite(location.href) && wdSite(AUTO.applyUrl || "") && wdSite(location.href) !== wdSite(AUTO.applyUrl || "")) {
        trace("stray", { page: location.href, want: AUTO.applyUrl || "" });
        return autoReport("needs_attention", `this tab reached another company's Workday site (${location.hostname}); nothing was filled there`);
      }
      // "You've already applied for this job" on this job's own page (HPE, submitted
      // by hand from its Review tab, 2026-11-10): record it and finish.
      if (AUTO && isWorkday && onOwnJob() && /you('ve| have) already applied for this job/i.test((document.body?.innerText || "").slice(0, 4000))) {
        trace("result", { status: "submitted", note: "already applied", page: location.href });
        await ledger("submitted", { jobTitle: header.jobTitle, companyName: header.companyName });
        submittedSeen = true;
        banner("JobWatch: you have already applied for this job. Recorded.");
        return autoReport("submitted", "already applied");
      }
      // Auto-apply: Workday's cookie banner, then the account form (whatever the scan makes of it).
      if (AUTO) await gen("workdayPress", "legalNoticeAcceptButton", "^accept cookies$").catch(() => false);
      if (AUTO && (await gen("hasPassword").catch(() => false) || (await gen("workdayAuthState").catch(() => ({})))?.mode === "chooser")) return await autoAuth();
      if (resetting) {
        // The reset page has not shown its password boxes: give it a minute.
        const mem = authMem();
        mem.resetWaits = (mem.resetWaits || 0) + 1;
        authSave(mem);
        if (mem.resetWaits > 40) autoReport("needs_attention", "Workday's password reset page did not open (the link may have expired)");
        return;
      }
      const step = await gen("stepName").catch(() => "");
      // Auto-apply on Review (a page with no questions): stop for the person.
      if (AUTO && started && await gen("onReviewStep").catch(() => false)) return await autoAdvance(step);
      let fields = await gen("scan", { readOptions: false }).catch(() => []);
      if (isWorkday && !fields.length && /sign in|create account/i.test(step)) {
        if (AUTO) return await autoAuth();
        banner("JobWatch: sign in or create your Workday account. JobWatch fills the application once you are in.");
        return;
      }
      if (!fields.length) { if (!started) notAFormSig = pageSig(); return; }
      if (!started && !forced && !looksLikeApplication(fields)) { notAFormSig = pageSig(); return; }

      // Sign-in and account pages: only the email; the password is the person's
      // (auto-apply on Workday: the popup's password, autoAuth).
      if (await gen("hasPassword").catch(() => false)) {
        if (AUTO) return await autoAuth();
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
      // Workday keeps the answers of an earlier attempt at the same job: on its
      // question steps those are filled again from today's answers (NCR's
      // salary still read "75", the hourly rate, from a Nov 11 run, and the
      // check held it, 2026-11-13). Each field once per step (done).
      const stale = (f) => AUTO && isWorkday && f.filled && /questionnaire/i.test(`${f.domId || ""} ${f.fkit || ""}`) && f.type !== "file";
      const fresh = fields.filter((f) => !done.has(f.id) && (!f.filled || refill.has(f.id) || stale(f)));
      // (Auto-apply's first step goes on even when Workday filled all of it: the
      // application is computed and recorded once, then Save and Continue.)
      if (!fresh.length && !(AUTO && !started) && !(isWorkday && newStep && /experience/i.test(step))) {
        lastStep = step;
        // Auto-apply: a step with nothing left to fill (Workday kept it from before)
        // moves on, after its questions are recorded like any other step's.
        if (AUTO && started && isWorkday && newStep) {
          const all = await gen("scan", { readOptions: true }).catch(() => fields);
          const opts = (f) => (f.options || []).map((o) => (typeof o === "string" ? o : o.label)).slice(0, 120);
          trace("step", { step, prefilledStep: true, fields: all.map((f) => ({ id: f.id, label: f.label, description: f.description || "", type: f.type, widget: f.widget || "", required: !!f.required, filledBefore: !!f.filled, section: f.section || "", wd: f.wd || "", domId: f.domId || "", fkit: f.fkit || "", options: opts(f) })), fills: [], results: {}, review: [], attention: [], after: [], errors: [] });
        }
        if (AUTO && started) await autoAdvance(step);
        return;
      }

      // Nothing fills until the person presses Autofill, once per page or step.
      const stepKey = `${location.pathname}|${step}`;
      if (armNext || AUTO) { armedFor = stepKey; armNext = false; }
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
        if (st?.duplicate) { banner(`JobWatch: you already applied to ${st.reason === "same role" ? "this role at this company" : "this job"} on ${fmtDay(st.submittedAt)}. Not filling it again. Add #jwforce to the URL and reload to fill anyway.`); stopped = true; autoReport("skipped", "already applied"); return; }
        if (!st?.ok) warn("ledger(start) failed:", st?.error);
        started = true;
      }
      lastStep = step;
      if (AUTO && isWorkday) await sendMsg({ type: "WORKDAY_FOCUS" });
      banner(`JobWatch is reading the form${step ? `: ${step}` : ""}…`);
      // Read options of the fresh pick lists (opens each dropdown once).
      fields = await gen("scan", { readOptions: true }).catch(() => fields);
      const ids = new Set(fields.filter((f) => !done.has(f.id) && (!f.filled || refill.has(f.id) || stale(f))).map((f) => f.id));
      ids.forEach((id) => done.add(id));
      const fills = (await fillPage(fields, { onlyIds: ids })) || [];
      ids.forEach((id) => refill.delete(id));
      if (stopped) return;
      if (isWorkday && /experience/i.test(step) && pkgCache) {
        await workdayExperience(pkgCache);
        // Copies of the resume left by earlier attempts at this job: one kept.
        const dd = await gen("workdayDedupeFiles").catch(() => null);
        if (dd?.removed) log(`removed ${dd.removed} duplicate upload(s)`);
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
      if (AUTO && isWorkday) {
        const opts = (f) => (f.options || []).map((o) => (typeof o === "string" ? o : o.label)).slice(0, 120);
        trace("step", {
          step,
          fields: fields.map((f) => ({ id: f.id, label: f.label, description: f.description || "", type: f.type, widget: f.widget || "", required: !!f.required, filledBefore: !!f.filled, section: f.section || "", wd: f.wd || "", domId: f.domId || "", fkit: f.fkit || "", options: opts(f) })),
          fills: stepFills.splice(0),
          results: Object.fromEntries(Object.entries(fillResults)),
          review: stepReview.splice(0),
          attention: [...attention.entries()].map(([label, v]) => ({ label, note: v.note })),
          after: seenNow.map((f) => ({ id: f.id, label: f.label, type: f.type, required: !!f.required, filled: !!f.filled, wd: f.wd || "" })),
          errors: await gen("errors").catch(() => []),
          // The HTML of every field that went wrong: failed fills, required ones still empty.
          problems: await gen("fieldHtml", [...new Set([...Object.entries(fillResults).filter(([, v]) => !v.ok).map(([k]) => k), ...seenNow.filter((f) => f.required && !f.filled).map((f) => f.id)])]).catch(() => []),
        });
        for (const k of Object.keys(fillResults)) delete fillResults[k];
      }
      // Auto-apply: new questions that just appeared are filled first (next tick);
      // otherwise Save and Continue, or stop on Review.
      if (AUTO && !seenNow.some((f) => !f.filled && !done.has(f.id))) await autoAdvance(step);
    } catch (e) {
      warn("tick failed:", e.message);
    } finally {
      busy = false;
    }
  }

  /** An auto-apply tab that went quiet for a minute off the application (after
   *  signing in, Workday sometimes lands on the posting, Candidate Home or an
   *  error page and nothing happened until the 25-minute timeout, 2026-11-10):
   *  record what the page shows, then Continue Application / Apply, else open
   *  the job's Apply Manually link again (three times at most). */
  async function watchdog() {
    // A fill running for four minutes (Johnson Controls' My Experience went silent): say where it is.
    // A step that is a third party's assessment (Centene: "Take Assessment", a
    // tax-credit questionnaire behind inlineAssessmentButton): the person's.
    if (AUTO && isWorkday && !busy && document.querySelector("[data-automation-id=inlineAssessmentButton]")) {
      stopped = true;
      return autoReport("needs_attention", `${header.companyName || "This company"} asks for an assessment (${(document.querySelector("[data-automation-id=inlineAssessmentButton]").innerText || "Take Assessment").trim()}): complete it yourself, then Save and Continue and Submit`);
    }
    if (AUTO && isWorkday && busy && busySince && Date.now() - busySince > 240000 && !busyReported) {
      busyReported = true;
      trace("busy", { minutes: Math.round((Date.now() - busySince) / 60000), work: currentWork, step: lastStep, openLists: document.querySelectorAll("[data-automation-id=activeListContainer], [role=listbox]:not([data-automation-id=selectedItemList])").length,
        text: (document.querySelector("[data-automation-id=applyFlowPage]") || document.body).innerText.replace(/\s+/g, " ").slice(-1500) });
    }
    if (!AUTO || !isWorkday || busy || stopped || Date.now() - lastProgress < 60000) return;
    if (onApplyFlow() && await gen("workdayInApp").catch(() => false)) return;
    const mem = authMem();
    mem.nudges = (mem.nudges || 0) + 1;
    authSave(mem);
    trace("idle", {
      nudge: mem.nudges, url: location.href.slice(0, 300),
      text: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 1500),
      buttons: [...document.querySelectorAll("button, a[role=button], [data-automation-id=adventureButton], [data-automation-id=continueButton]")].filter((x) => x.offsetParent).map((x) => `${x.getAttribute("data-automation-id") || ""}|${(x.innerText || "").trim().slice(0, 40)}`).slice(0, 40),
    });
    if (mem.nudges > 3) { stopped = true; return autoReport("error", `Workday left the application at ${location.pathname.slice(0, 120)} and did not come back`); }
    if (await gen("workdayPress", "continueButton", "^continue application$").catch(() => false)) return;
    if (await gen("workdayPress", "adventureButton", "^apply$").catch(() => false)) return;
    // An empty page after signing in (Insulet: header only): the Apply Manually
    // link, then the posting (it offers "Continue Application"), then sign in again.
    const posting = String(AUTO.applyUrl || "").replace(/\/apply(\/.*)?$/, "");
    location.href = mem.nudges === 2 && posting ? posting : mem.nudges === 3 ? loginUrl() : AUTO.applyUrl;
  }

  // Start once the page settles, then follow steps and new questions.
  (async () => {
    await sleep(manual() ? 200 : 1500);
    if (isWorkday && window.top === window) {
      const r = await sendMsg({ type: "AUTO_JOB" });
      if (r?.job) {
        AUTO = r.job;
        forced = true; // the runner opened it: no "is this an application?" checks
        if (AUTO.title) header.jobTitle = AUTO.title;
        if (AUTO.companyName) header.companyName = AUTO.companyName;
        log("auto-apply job:", AUTO.companyName, "|", AUTO.title);
        // Each page an auto-apply tab loads (some went silent right after signing in).
        setTimeout(async () => {
          trace("load", { url: location.href.slice(0, 300), title: document.title.slice(0, 120), step: await gen("stepName").catch(() => ""), password: await gen("hasPassword").catch(() => null),
            inApp: await gen("workdayInApp").catch(() => null), text: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 400) });
        }, 4000);
      }
    }
    await tick();
    let lastUrl = location.href;
    let quietUntil = 0;
    const obs = new MutationObserver(() => { quietUntil = Date.now() + 1200; });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (stopped || Date.now() - t0 > 90 * 60 * 1000) { clearInterval(timer); obs.disconnect(); return; }
      if (location.href !== lastUrl) { lastUrl = location.href; quietUntil = Date.now() + 1500; }
      watchdog().catch(() => {}); // also while a fill runs: it reports a fill that runs too long
      if (Date.now() < quietUntil || busy) return;
      tick();
    }, 1500);
  })();
})();
