// sweep.cjs — nothing waits on the person by accident.
//
// Every application that stopped (needs_attention, error, ready = filled but
// not submitted, or in_progress for over two hours) is looked at on a
// schedule (sweepApplications in index.js) and ends in exactly one place:
//
//   submitted elsewhere   the same form, job or role was submitted        -> dismissed
//   posting closed        the board says it is gone (404/410 only)        -> dismissed
//   not eligible          the posting or its form requires US citizenship,
//                         a clearance, or says it won't sponsor           -> dismissed
//   not a match           its score (stored, else the rule score worked
//                         out from the posting) is below minScore (60)    -> dismissed
//   only you can answer   references, a transcript, an ID number, a video,
//                         an assessment                                   -> stays in Needs attention
//   tried enough          swept MAX_SWEEPS times and still stopping        -> stays in Needs attention
//   otherwise             marked for auto-apply again (retryPriority), so
//                         it goes ahead of new jobs on today's code       -> "Retrying"
//
// A record the board could not answer for is left for the next sweep.
// Dismissed records keep their reason and can be reopened on the
// Applications page. (Replaces scripts/clear-needs-attention.mjs,
// apply-top-matches.mjs and retry-stuck.mjs, 2026-11-13.)

const { workdayPostingApi } = require("./generic.cjs");
const { eligibilityOf, formEligibility, blockedReason, needsSponsorship } = require("../eligibility.cjs");
const { ruleAssessJob, profileSkills } = require("../ruleScore.cjs");
const ledger = require("./ledger.cjs");

const MAX_SWEEPS = 3;
const STALE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_FETCH = (...a) => fetch(...a);

const PERSON_ONLY = [
  [/references?\b.{0,40}(name|email|phone|contact)|three (professional )?references|reference #\d/i, "references"],
  [/transcript/i, "a transcript"],
  [/type, number, issue date|driver'?s license number|id number|passport number|social security|\bssn\b/i, "an ID number"],
  [/work sample|writing sample|portfolio (link|upload)/i, "a work sample"],
  [/\bvideo\b|voice recording/i, "a video"],
  [/assessment|coding challenge|take.?home|captcha/i, "an assessment"],
  // Workday sent the tab to the company's own careers site (PayPal:
  // careers.pypl.com, 2026-11-13); auto-apply fills Workday forms only.
  [/tab left workday for https?:\/\/(?![^\s]*(myworkday|workday\.com))/i, "the company's own careers site"],
];

const ms = (v) => (v?.toDate ? v.toDate().getTime() : Date.parse(v || "") || 0);
const unhtml = (h) => String(h || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/<\/(p|li|div|h\d)>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
const notesOf = (a) => [...(a.needsAttention || []).map((n) => (typeof n === "object" ? `${n.label}: ${n.note}` : String(n))), a.lastError || "", ...(a.gateReasons || [])].join(" | ");
const keyOf = (a) => `${String(a.companyName || "").toLowerCase().trim()}|${String(a.jobTitle || "").toLowerCase().replace(/\s+/g, " ").trim()}`;

/** The link auto-apply opens for a ledger record. */
function applyUrlOf(a, id) {
  const [source, org, post] = String(a.formKey || id || "").split("|");
  if (source === "greenhouse" && org && post) return `https://job-boards.greenhouse.io/embed/job_app?for=${org}&token=${post}`;
  if (source === "ashby" && org && post) return `https://jobs.ashbyhq.com/${org}/${post}/application`;
  if (source === "lever" && org && post) return `https://jobs.lever.co/${org}/${post}/apply`;
  if (source === "workday") {
    const m = String(a.jobUrl || "").match(/^(https:\/\/[^?#]*?_[A-Za-z0-9-]+)(?:\/apply(?:\/[^?#]*)?)?\/?(?:[?#].*)?$/);
    return m ? `${m[1]}/apply/applyManually` : "";
  }
  return "";
}

/** Is the posting still open (true / false / null = could not tell), its
 *  text, and whether its form rules out a visa holder. */
async function postingStatus(a, id, fetchFn = DEFAULT_FETCH, cache = new Map()) {
  const [source, org, post] = String(a.formKey || id || "").split("|");
  const gone = (r) => r.status === 404 || r.status === 410;
  try {
    if (source === "greenhouse") {
      const r = await fetchFn(`https://boards-api.greenhouse.io/v1/boards/${org}/jobs/${post}?questions=true`);
      if (gone(r)) return { open: false };
      if (!r.ok) return { open: null };
      const j = await r.json();
      return { open: true, title: j.title || "", desc: unhtml(j.content), formCitizen: formEligibility(j.questions).length > 0 };
    }
    if (source === "lever") {
      const r = await fetchFn(`https://api.lever.co/v0/postings/${org}/${post}`);
      if (gone(r)) return { open: false };
      if (!r.ok) return { open: null };
      const j = await r.json();
      return { open: true, title: j.text || "", desc: [j.descriptionPlain, ...(j.lists || []).map((l) => `${l.text}\n${unhtml(l.content)}`), j.additionalPlain].filter(Boolean).join("\n") };
    }
    if (source === "ashby") {
      const key = `ashby|${org}`;
      if (!cache.has(key)) {
        const r = await fetchFn(`https://api.ashbyhq.com/posting-api/job-board/${org}`);
        cache.set(key, r.ok ? new Map(((await r.json()).jobs || []).map((j) => [String(j.id), j])) : gone(r) ? new Map() : null);
      }
      const jobs = cache.get(key);
      if (!jobs) return { open: null };
      const j = jobs.get(String(post));
      return j ? { open: true, title: j.title || "", desc: j.descriptionPlain || unhtml(j.descriptionHtml) } : { open: false };
    }
    if (source === "workday") {
      const api = workdayPostingApi(a.jobUrl);
      if (!api) return { open: null };
      const r = await fetchFn(api.url, { headers: { accept: "application/json" } });
      if (gone(r)) return { open: false };
      if (!r.ok) return { open: null };
      const j = await r.json().catch(() => null);
      if (!j?.jobPostingInfo) return { open: null };
      return { open: j.jobPostingInfo.canApply !== false, title: j.jobPostingInfo.title || "", desc: unhtml(j.jobPostingInfo.jobDescription) };
    }
  } catch { return { open: null }; }
  return { open: null };
}

/** Stopped records, as the Applications page shows them: needs_attention,
 *  error, ready, and in_progress for over two hours; not those already
 *  waiting on their retry. */
function stoppedRecords(apps, now = Date.now()) {
  const waiting = (a) => a.retryRequested && Date.parse(a.retryRequested) > ms(a.lastStartedAt);
  return apps.filter((a) => !waiting(a) && (["needs_attention", "error", "ready"].includes(a.status)
    || (a.status === "in_progress" && now - ms(a.lastStartedAt || a.startedAt || a.updatedAt) > STALE_MS)));
}

/**
 * deps = { db, uid, adminUid, fetch?, now?, minScore? }
 * Returns { checked, outcomes: {…counts}, writes } and applies the writes
 * unless deps.dryRun.
 */
async function sweepApplications(deps) {
  const { db, uid, adminUid } = deps;
  const fetchFn = deps.fetch || DEFAULT_FETCH;
  const now = deps.now || Date.now();
  const U = db.collection("users").doc(uid);
  const [appsSnap, userSnap, resumeSnap, prefsSnap] = await Promise.all([
    U.collection("applications").get(),
    U.get(),
    U.collection("resume").doc("profile").get(),
    U.collection("settings").doc("preferences").get(),
  ]);
  const apps = appsSnap.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));
  const prefs = prefsSnap.exists ? prefsSnap.data() : {};
  const minScore = Number.isFinite(Number(deps.minScore ?? prefs.autoApplyRetryMinScore)) ? Number(deps.minScore ?? prefs.autoApplyRetryMinScore) : 60;
  const sponsorship = needsSponsorship(userSnap.exists ? userSnap.data() : {});
  const profile = resumeSnap.exists ? resumeSnap.data() : {};
  const mine = profileSkills(profile);
  const jobTypes = Array.isArray(prefs.jobTypes) && prefs.jobTypes.length ? prefs.jobTypes : null;

  const submitted = apps.filter((a) => a.status === "submitted");
  const subForms = new Set(submitted.map((a) => a.formKey).filter(Boolean));
  const subJobs = new Set(submitted.map((a) => a.jobId).filter(Boolean));
  const subKeys = new Set(submitted.map(keyOf));
  const subRoles = new Set(submitted.map((a) => a.roleKey || ledger.roleKeyOf(a.companyName, a.jobTitle)).filter(Boolean));

  const jobsCol = db.collection("users").doc(adminUid).collection("jobs");
  async function storedScore(a) {
    let jd = null;
    if (a.jobId) { const d = await jobsCol.doc(String(a.jobId)).get(); if (d.exists) jd = d; }
    if (!jd) {
      const ext = String(a.formKey || a.id).split("|")[2];
      if (ext) { const s = await jobsCol.where("externalId", "==", ext).limit(2).get(); jd = s.docs[0] || null; }
    }
    if (!jd) return null;
    const sc = await U.collection("jobScores").doc(jd.id).get();
    return sc.exists && typeof sc.data().score === "number" ? sc.data().score : null;
  }

  const iso = new Date(now).toISOString();
  const outcomes = { submittedElsewhere: 0, closed: 0, notEligible: 0, notAMatch: 0, needsYou: 0, triedEnough: 0, retry: 0, unknown: 0 };
  const writes = [];
  const dismiss = (a, reason, k) => { outcomes[k]++; writes.push([a.ref, { status: "dismissed", dismissedAt: iso, dismissReason: reason, updatedAt: iso }]); };
  const cache = new Map();
  const rows = stoppedRecords(apps, now);
  for (const a of rows) {
    const rk = a.roleKey || ledger.roleKeyOf(a.companyName, a.jobTitle);
    if ((a.formKey && subForms.has(a.formKey)) || (a.jobId && subJobs.has(a.jobId)) || subKeys.has(keyOf(a)) || (rk && subRoles.has(rk))) { dismiss(a, "submitted in another record", "submittedElsewhere"); continue; }
    const url = applyUrlOf(a, a.id);
    if (!url) { dismiss(a, `auto-apply does not take ${String(a.formKey || a.id).split("|")[0]} forms: apply by hand`, "closed"); continue; }
    const p = await postingStatus(a, a.id, fetchFn, cache);
    if (p.open === false) { dismiss(a, "posting closed", "closed"); continue; }
    if (p.open === null) { outcomes.unknown++; continue; } // the board did not answer: next sweep
    const blocked = blockedReason([...eligibilityOf(`${a.jobTitle || ""}. ${p.desc || ""}`).flags, ...(p.formCitizen ? ["citizen"] : [])], sponsorship);
    if (blocked) { dismiss(a, `not eligible: ${blocked}`, "notEligible"); continue; }
    let score = await storedScore(a);
    if (score == null && p.desc) {
      const rule = ruleAssessJob({ profile, jobTitle: a.jobTitle || p.title || "", description: p.desc, targets: jobTypes, mine });
      score = rule.screened ? 0 : rule.score;
    }
    if (score == null || score < minScore) { dismiss(a, `match score ${score ?? "unknown"} is below ${minScore}`, "notAMatch"); continue; }
    const who = PERSON_ONLY.find(([re]) => re.test(notesOf(a)));
    if (who) {
      outcomes.needsYou++;
      if (a.needsYouFor !== who[1]) writes.push([a.ref, { needsYouFor: who[1], updatedAt: iso }]);
      continue;
    }
    if ((a.retrySweeps || 0) >= MAX_SWEEPS) { outcomes.triedEnough++; continue; }
    outcomes.retry++;
    writes.push([a.ref, { retryRequested: iso, retryApplyUrl: url, retryPriority: true, retryScore: score, retrySweeps: (a.retrySweeps || 0) + 1, updatedAt: iso }]);
  }
  if (!deps.dryRun) {
    for (let i = 0; i < writes.length; i += 400) {
      const batch = db.batch();
      for (const [ref, patch] of writes.slice(i, i + 400)) batch.update(ref, patch);
      await batch.commit();
    }
  }
  return { checked: rows.length, outcomes, writes: writes.length, minScore };
}

/** The Applications page's tab counts, for the extension's popup. */
function tabCounts(apps, now = Date.now()) {
  const waiting = (a) => a.retryRequested && !["submitted", "dismissed"].includes(a.status) && Date.parse(a.retryRequested) > ms(a.lastStartedAt);
  const dayAgo = now - 24 * 60 * 60 * 1000;
  return {
    needsYou: apps.filter((a) => ["needs_attention", "in_progress"].includes(a.status) && !waiting(a)).length,
    errors: apps.filter((a) => a.status === "error" && !waiting(a)).length,
    ready: apps.filter((a) => a.status === "ready" && !waiting(a)).length,
    retrying: apps.filter(waiting).length,
    submitted24h: apps.filter((a) => a.status === "submitted" && ms(a.submittedAt || a.updatedAt) >= dayAgo).length,
  };
}

module.exports = { sweepApplications, stoppedRecords, postingStatus, applyUrlOf, tabCounts, MAX_SWEEPS };
