/**
 * background.js — Service Worker (Manifest V3)
 *
 * Responsibilities:
 * 1. Receive AUTO_APPLY message from jobwatch-bridge content script
 * 2. Store pending job + open job URL in a new tab
 * 3. Respond to GET_FILL_DATA from ashby content script:
 *    a. Refresh auth token if needed
 *    b. Fetch user profile from Firestore REST API
 *    c. Call mapFormFields Cloud Function for AI field mapping
 *    d. Return everything to content script
 * 4. Receive APPLICATION_DONE from ashby content script and log to Firestore
 *
 * NOTE: No ES module imports — config inlined to avoid "Unexpected token" errors
 * in some Chrome builds when "type":"module" service workers load sub-modules.
 */

// ─── Firebase config (inlined from config.js) ────────────────────────────────
// Edit these values to match your Firebase project.
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyA-JxL9ApR6q2XMTH_BDHk-liMHC2Zqe6k",
  authDomain: "greenhouse-jobs-scrapper.firebaseapp.com",
  projectId: "greenhouse-jobs-scrapper",
  storageBucket: "greenhouse-jobs-scrapper.firebasestorage.app",
  messagingSenderId: "778274987006",
  appId: "1:778274987006:web:a463f8c51edab30ba43eaf",
};
const FUNCTIONS_BASE = `https://us-central1-${FIREBASE_CONFIG.projectId}.cloudfunctions.net`;

const { apiKey, projectId } = FIREBASE_CONFIG;

// ─── Auth helpers ─────────────────────────────────────────────────────────────

async function getStoredAuth() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["jwIdToken", "jwRefreshToken", "jwUid", "jwTokenExpiry"], resolve);
  });
}

async function saveAuth({ idToken, refreshToken, uid, expiresIn }) {
  const expiry = Date.now() + (parseInt(expiresIn, 10) - 60) * 1000;
  await chrome.storage.local.set({
    jwIdToken: idToken,
    jwRefreshToken: refreshToken,
    jwUid: uid,
    jwTokenExpiry: expiry,
  });
}

async function clearAuth() {
  await chrome.storage.local.remove(["jwIdToken", "jwRefreshToken", "jwUid", "jwTokenExpiry"]);
}

/**
 * Returns a fresh (not-expired) ID token.
 * Pass forceRefresh=true to always hit the token endpoint regardless of expiry.
 */
async function getFreshToken(forceRefresh = false) {
  const { jwIdToken, jwRefreshToken, jwUid, jwTokenExpiry } = await getStoredAuth();

  if (!jwRefreshToken) throw new Error("Not logged in. Open Job Watch and log in first.");

  if (!forceRefresh && jwIdToken && jwTokenExpiry && Date.now() < jwTokenExpiry) {
    return { idToken: jwIdToken, uid: jwUid };
  }

  // Refresh the token via Firebase REST API
  const res = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: jwRefreshToken }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "Token refresh failed. Please log in again.");

  const idToken = data.id_token;
  const uid = data.user_id;
  await saveAuth({ idToken, refreshToken: data.refresh_token, uid, expiresIn: data.expires_in });
  return { idToken, uid };
}

// ─── Firestore REST helpers ───────────────────────────────────────────────────

function fsValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === "string") return { stringValue: val };
  if (typeof val === "number") return { integerValue: String(val) };
  if (typeof val === "boolean") return { booleanValue: val };
  if (val instanceof Date) return { timestampValue: val.toISOString() };
  if (val instanceof Array) return { arrayValue: { values: val.map(fsValue) } };
  if (typeof val === "object") {
    return { mapValue: { fields: Object.fromEntries(Object.entries(val).map(([k, v]) => [k, fsValue(v)])) } };
  }
  return { stringValue: String(val) };
}

function parseFs(fields = {}) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if ("stringValue" in v) out[k] = v.stringValue;
    else if ("integerValue" in v) out[k] = Number(v.integerValue);
    else if ("booleanValue" in v) out[k] = v.booleanValue;
    else if ("nullValue" in v) out[k] = null;
    else if ("arrayValue" in v) out[k] = (v.arrayValue.values || []).map((x) => parseFs(x.mapValue?.fields || { _: x })?._ ?? Object.values(x)[0]);
    else if ("mapValue" in v) out[k] = parseFs(v.mapValue.fields || {});
    else if ("timestampValue" in v) out[k] = v.timestampValue;
    else out[k] = null;
  }
  return out;
}

async function fsGet(path, idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  if (res.status === 404) return {};  // Document doesn't exist yet — treat as empty
  if (!res.ok) throw new Error(`Firestore GET ${path} failed: ${res.status}`);
  const doc = await res.json();
  return parseFs(doc.fields || {});
}

// PATCH a subset of fields on an existing document
async function fsPatch(path, data, idToken) {
  const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, fsValue(v)]));
  const mask = Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}?${mask}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  return res.ok;
}

// Run a Firestore structured query under a parent document path
// (empty filters = list the whole collection)
async function fsQuery(parentPath, collectionId, filters, idToken, limit = null) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${parentPath}:runQuery`;
  const structuredQuery = { from: [{ collectionId }] };
  if (filters && filters.length) {
    structuredQuery.where = filters.length === 1 ? filters[0] : {
      compositeFilter: { op: "AND", filters },
    };
  }
  if (limit) structuredQuery.limit = limit;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery }),
  });
  const results = await res.json();
  return (Array.isArray(results) ? results : [])
    .filter(r => r.document)
    .map(r => {
      const id = r.document.name.split("/").pop();
      return { id, ...parseFs(r.document.fields || {}) };
    });
}

async function fsSet(path, data, idToken) {
  const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, fsValue(v)]));
  // Use PATCH with updateMask for upsert behavior
  const patchUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`;
  const res = await fetch(patchUrl, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  return res.ok;
}

// ─── Cloud Function call ──────────────────────────────────────────────────────

// Send one ledger event to recordApplication. Fills in job metadata from the
// cached pendingJob when the content script did not have it.
async function recordApplicationEvent(message, sender) {
  const { idToken } = await getFreshToken();
  const { pendingJob } = await new Promise((r) => chrome.storage.session.get("pendingJob", r));
  const job = pendingJob && (!message.postingId || jobMatchesExternalId(pendingJob, message.postingId)) ? pendingJob : null;
  const event = message.event || (message.type === "APPLICATION_DONE" ? "submitted" : "start");
  const payload = {
    event,
    formKey: message.formKey || "",
    source: message.source || "",
    org: message.org || "",
    postingId: message.postingId || "",
    applyUrl: message.applyUrl || sender?.tab?.url || "",
    jobId: message.jobId || job?.id || "",
    jobTitle: message.jobTitle || job?.title || "",
    companyName: message.companyName || job?.companyName || "",
    extensionVersion: chrome.runtime.getManifest().version,
  };
  for (const k of ["answersLog", "needsAttention", "filledCount", "totalFields", "requiredTotal", "flow", "schemaSource", "reasons", "error", "force"]) {
    if (message[k] !== undefined) payload[k] = message[k];
  }
  const res = await fetch(`${FUNCTIONS_BASE}/recordApplication`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ data: payload }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error?.message || `recordApplication ${res.status}`);
  if (event === "submitted") await chrome.storage.session.remove("pendingJob");
  return json.result || {};
}

async function callMapFormFields(fields, jobTitle, companyName, jobLocationName, jobWorkplaceType, idToken, errorContext) {
  const res = await fetch(`${FUNCTIONS_BASE}/mapFormFields`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ data: { fields, jobTitle, companyName, jobLocationName, jobWorkplaceType, errorContext: errorContext || null } }),
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error?.message || "mapFormFields failed");
  return json.result?.mappings || {};
}

// Compute a full Greenhouse application (answers + resume + cover letter).
async function callPrepareGreenhouse(token, id, idToken) {
  const res = await fetch(`${FUNCTIONS_BASE}/prepareGreenhouseApplication`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ data: { token, id } }),
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error?.message || "prepareGreenhouseApplication failed");
  return json.result;
}
// A stored pendingJob belongs to the page being filled only if it references
// that page's Ashby job UUID (externalId, or inside its apply URL). A leftover
// job from a previous application must never leak into this one — its
// companyName/title would poison the AI's "Why <company>?" answers.
function jobMatchesExternalId(job, externalId) {
  if (!job || !externalId) return false;
  const id = externalId.toLowerCase();
  return [job.externalId, job.absolute_url, job.jobUrl, job.url]
    .some((v) => typeof v === "string" && v.toLowerCase().includes(id));
}

// Authoritative job info straight from Ashby's public GraphQL — the fallback
// when the job never entered Firestore (e.g. the apply page was opened from a
// LinkedIn/external link rather than the JobWatch queue).
async function fetchAshbyPostingInfo(org, jobPostingId) {
  const gql = (op, query, variables) =>
    fetch(`https://jobs.ashbyhq.com/api/non-user-graphql?op=${op}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationName: op, variables, query }),
    }).then((r) => r.json());
  const [posting, orgRes] = await Promise.all([
    gql(
      "ApiJobPosting",
      "query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) { title locationName workplaceType } }",
      { organizationHostedJobsPageName: org, jobPostingId }
    ),
    gql(
      "ApiOrganizationFromHostedJobsPageName",
      "query ApiOrganizationFromHostedJobsPageName($organizationHostedJobsPageName: String!) { organization: organizationFromHostedJobsPageName(organizationHostedJobsPageName: $organizationHostedJobsPageName) { name } }",
      { organizationHostedJobsPageName: org }
    ),
  ]);
  const p = posting?.data?.jobPosting || {};
  return {
    externalId: jobPostingId,
    title: p.title || "",
    companyName: orgRes?.data?.organization?.name || "",
    locationName: p.locationName || "",
    workplaceType: p.workplaceType || "",
  };
}

// ─── Proactive Ashby job prefetch ────────────────────────────────────────────
// Fires as soon as any Ashby application page finishes loading.
// Looks up the job in Firestore by externalId and caches it as pendingJob so
// the content script always has the full job document (incl. locationName)
// ready the moment it sends GET_FILL_DATA — even if the service worker restarted.

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  const url = tab.url || "";
  // Match: https://jobs.ashbyhq.com/{org}/{uuid}/application[?...]
  //        https://jobs.lever.co/{site}/{uuid}/apply  (Lever postings carry the same UUID as externalId)
  const uuidMatch = url.match(
    /jobs\.ashbyhq\.com\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i
  ) || url.match(
    /jobs\.(?:eu\.)?lever\.co\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i
  );
  if (!uuidMatch) return;

  const externalId = uuidMatch[1];
  console.log("[JobWatch] application page detected — prefetching job:", externalId);

  (async () => {
    try {
      const { idToken, uid } = await getFreshToken();
      const jobs = await fsQuery(
        `users/${uid}`,
        "jobs",
        [{ fieldFilter: { field: { fieldPath: "externalId" }, op: "EQUAL", value: { stringValue: externalId } } }],
        idToken,
        1
      );
      if (jobs.length) {
        const job = jobs[0];
        await chrome.storage.session.set({ pendingJob: job });
        console.log("[JobWatch] pendingJob pre-loaded:", job.title, "| location:", job.locationName);
      } else {
        console.warn("[JobWatch] No Firestore job found for externalId:", externalId);
        // Don't leave a previous application's pendingJob lying around — it
        // would be used to fill THIS page with the wrong company's answers.
        const { pendingJob } = await new Promise((r) => chrome.storage.session.get("pendingJob", r));
        if (pendingJob && !jobMatchesExternalId(pendingJob, externalId)) {
          await chrome.storage.session.remove("pendingJob");
          console.warn("[JobWatch] Cleared stale pendingJob:", pendingJob.companyName, "|", pendingJob.title);
        }
      }
    } catch (err) {
      console.warn("[JobWatch] Prefetch failed:", err.message);
    }
  })();
});

// ─── Add feed (popup → Firestore) ────────────────────────────────────────────
// Feeds live under the admin user, same path the web app's Feeds page uses.

const ADMIN_UID = "7Tojjo8l5PZIYctPmdwncf7PC133";

function companyToSlug(name) {
  return (name || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function buildFeedUrl(source, slug) {
  if (source === "ashby") return `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
  return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
}

// POST to a collection → creates a document with an auto-generated ID
async function fsAdd(parentPath, collectionId, data, idToken) {
  const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, fsValue(v)]));
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${parentPath}/${collectionId}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`Firestore ADD ${parentPath}/${collectionId} failed: ${res.status}`);
  return res.json();
}

// ─── Auto-add feeds from the pages you open (admin) ──────────────────────────
// Opening any job page on a supported board adds that company's board as a
// feed, the same document the Feeds page writes, then pulls in its last three
// days of openings. Replaces the popup's manual Company / Job Board / Add Feed.


/** { source, slug, url, check? } for a page on a supported board, else null. */
function feedFromUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const slugOk = (x) => !!x && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(x);
  if (/^(job-)?boards(\.eu)?\.greenhouse\.io$/.test(host)) {
    const token = (u.searchParams.get("for") || (parts[0] !== "embed" ? parts[0] : "") || "").toLowerCase();
    if (!slugOk(token)) return null;
    return { source: "greenhouse", slug: token, url: buildFeedUrl("greenhouse", token), check: `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`, count: (j) => j?.jobs?.length || 0 };
  }
  if (host === "jobs.ashbyhq.com") {
    const org = (parts[0] || "").toLowerCase();
    if (!slugOk(org) || org === "api") return null;
    return { source: "ashby", slug: org, url: buildFeedUrl("ashby", org), check: buildFeedUrl("ashby", org), count: (j) => j?.jobs?.length || 0 };
  }
  let m = host.match(/^jobs\.(eu\.)?lever\.co$/);
  if (m) {
    const slug = parts[0];
    if (!slugOk(slug)) return null;
    return { source: "lever", slug, url: `https://jobs.${m[1] || ""}lever.co/${slug}` };
  }
  m = host.match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/);
  if (m) {
    if (parts.length && /^[a-z]{2}-[a-z]{2}$/i.test(parts[0])) parts.shift();
    const site = parts[0];
    if (!site || site === "wday") return null;
    return { source: "workday", slug: m[1], url: `https://${host}/${site}` };
  }
  if (/\.oraclecloud\.com$/.test(host)) {
    const o = u.pathname.match(/\/hcmUI\/CandidateExperience\/[a-z]{2}(?:-[A-Z]{2})?\/sites\/([^/?#]+)/i);
    return o ? { source: "oracle", slug: host.split(".")[0], url: `https://${host}/hcmUI/CandidateExperience/en/sites/${o[1]}` } : null;
  }
  if (host === "apply.workable.com") {
    const slug = (parts[0] || "").toLowerCase();
    if (!slugOk(slug) || ["j", "api"].includes(slug)) return null;
    return { source: "workable", slug, url: `https://apply.workable.com/${slug}` };
  }
  if (/^(jobs|careers)\.smartrecruiters\.com$/.test(host)) {
    const slug = parts[0] === "oneclick-ui" ? parts[2] : parts[0];
    if (!slugOk(slug)) return null;
    return { source: "smartrecruiters", slug, url: `https://jobs.smartrecruiters.com/${slug}` };
  }
  m = host.match(/^([a-z0-9-]+)\.bamboohr\.com$/);
  if (m && !["www", "api", "app"].includes(m[1])) return { source: "bamboohr", slug: m[1], url: `https://${m[1]}.bamboohr.com/careers` };
  return null;
}

/** A readable company name: from the tab title when it says, else the slug. */
function companyFromTab(title, slug) {
  const t = String(title || "").trim();
  const pick = t.match(/ at ([^|–—]+?)\s*$/) || t.match(/ @ ([^|–—]+?)\s*$/) || t.match(/^Jobs at ([^|–—]+)/i) || t.match(/^([^|–—-]+?) (?:Careers|Jobs)\b/i);
  const name = pick?.[1]?.trim();
  if (name && name.length <= 60 && !/^(job application|apply|careers?)$/i.test(name)) return name;
  return String(slug || "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

let feedCache = { at: 0, urls: new Set() };
const feedInFlight = new Set();

async function autoAddFeed(tabUrl, tabTitle) {
  const f = feedFromUrl(tabUrl);
  if (!f) return;
  const key = f.url.toLowerCase();
  if (feedInFlight.has(key)) return;
  const { jwUid } = await getStoredAuth();
  if (jwUid !== ADMIN_UID) return; // feeds are the admin's
  const { jwFeedSeen = [] } = await chrome.storage.local.get("jwFeedSeen");
  if (jwFeedSeen.includes(key)) return; // already checked on an earlier visit
  feedInFlight.add(key);
  try {
    const { idToken } = await getFreshToken();
    if (Date.now() - feedCache.at > 10 * 60 * 1000) {
      const existing = await fsQuery(`users/${ADMIN_UID}`, "feeds", [], idToken);
      feedCache = { at: Date.now(), urls: new Set(existing.map((x) => String(x.url || "").toLowerCase())) };
    }
    const remember = async () => chrome.storage.local.set({ jwFeedSeen: [key, ...jwFeedSeen].slice(0, 2000) });
    if (feedCache.urls.has(key)) { await remember(); return; } // present (or archived on purpose)
    // Slug boards: only a board that answers with jobs.
    if (f.check) {
      const r = await fetch(f.check).catch(() => null);
      const json = r?.ok ? await r.json().catch(() => null) : null;
      if (!json || f.count(json) === 0) { console.log("[JobWatch] auto feed: no jobs at", f.check); await remember(); return; }
    }
    const company = companyFromTab(tabTitle, f.slug);
    const added = await fsAdd(`users/${ADMIN_UID}`, "feeds", {
      company, url: f.url, source: f.source, createdAt: new Date(), archivedAt: null, lastCheckedAt: null, lastError: null, addedBy: "extension",
    }, idToken);
    feedCache.urls.add(key);
    await remember();
    const feedId = String(added?.name || "").split("/").pop();
    console.log("[JobWatch] auto feed added:", company, f.source, f.url);
    // Bring in the last three days' openings, as the Feeds page does.
    if (feedId) fetch(`${FUNCTIONS_BASE}/runSyncNow?feedIds=${encodeURIComponent(feedId)}&lookbackHours=72`, { headers: { Authorization: `Bearer ${idToken}` } }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: "#4f46e5" });
    chrome.action.setBadgeText({ text: "+1" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 8000);
  } catch (err) {
    console.warn("[JobWatch] auto feed failed:", err.message);
  } finally {
    feedInFlight.delete(key);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !/^https:/.test(tab.url || "")) return;
  autoAddFeed(tab.url, tab.title);
  autoLeverThanks(tabId, tab.url).catch(() => {});
  autoThanksPage(tabId, tab.url).catch(() => {});
  ghConfirmationPage(tabId, tab.url).catch(() => {});
  workdayCompletedPage(tabId, tab.url).catch(() => {});
});

/** Workday after Submit: Candidate Home at /jobTasks/completed/application
 *  (NVIDIA, HP, 2026-11-10). The content script that pressed Submit is gone by
 *  then, so the runner records it here: the job's own company only; a tab
 *  that reached another company's page is not this job's submission. */
async function workdayCompletedPage(tabId, url) {
  if (!/myworkday(jobs|site)\.com\/.*jobTasks\/completed\/application/i.test(url || "")) return;
  const job = await autoJobForTab(tabId);
  if (!job || job.source !== "workday") return;
  if (workdayTenantOf(url) !== workdayTenantOf(job.applyUrl || "")) {
    await autoFinish({ status: "needs_attention", note: `this tab reached another company's Workday page (${workdayTenantOf(url)}): check your applications there` }, tabId);
    return;
  }
  await callFunction("recordApplication", { event: "submitted", applyUrl: job.applyUrl, jobId: job.jobId, jobTitle: job.title, companyName: job.companyName }).catch((e) => console.warn("[JobWatch] ledger(submitted) failed:", e.message));
  try {
    const { idToken, uid } = await getFreshToken();
    await fsAdd(`users/${uid}`, "workdayTraces", { kind: "result", tenant: workdayTenantOf(url), jobId: job.jobId, companyName: job.companyName || "", title: job.title || "", test: !!job.test, url: String(url).slice(0, 500), at: new Date().toISOString(), version: chrome.runtime.getManifest().version, json: JSON.stringify({ status: "submitted", note: "Workday shows the application as completed", page: url }) }, idToken);
  } catch (_) { /* best effort */ }
  await autoFinish({ status: "submitted", note: "" }, tabId);
}

/** Greenhouse's confirmation page names the form it confirms
 *  (/embed/job_app/confirmation?for=<board>&token=<job>), so reaching it is a
 *  submission no matter who pressed Submit: the runner, or the person
 *  finishing a "needs you" tab by hand. Until 2026-11-02 only the runner's own
 *  submits were recorded; 20 real applications that day were logged as
 *  "the tab was closed" or "needs you", and the duplicate guard did not know
 *  about them. Recorded once per page load; the ledger ignores repeats. */
async function ghConfirmationPage(tabId, url) {
  if (!/greenhouse\.io\/embed\/job_app\/confirmation\?/i.test(url || "")) return;
  const params = new URL(url).searchParams;
  const board = params.get("for");
  const token = params.get("token");
  if (!board || !token) return;
  const applyUrl = `https://job-boards.greenhouse.io/embed/job_app?for=${board}&token=${token}`;
  const job = await autoJobForTab(tabId);
  await callFunction("recordApplication", {
    event: "submitted", applyUrl,
    ...(job ? { jobId: job.jobId, jobTitle: job.title, companyName: job.companyName } : {}),
  }).catch((e) => console.warn("[JobWatch] ledger(submitted) failed:", e.message));
  // The runner's own job: finish it as submitted (autoThanksPage may have already).
  if (job) { await autoFinish({ status: "submitted", note: "" }, tabId); return; }
  // A job the runner left for the person: the popup counts it as submitted
  // now, and its tab closes like the runner's own.
  const sameForm = (u) => { try { const q = new URL(u).searchParams; return q.get("for") === board && q.get("token") === token; } catch (_) { return false; } };
  await finishedByHand(tabId, sameForm);
}

/** After the form pressed Submit (AUTO_SUBMITTING), a new page in the job's
 *  tab that thanks the applicant is the submission. Greenhouse (and some
 *  Ashby boards) leave the form for a confirmation page, which ends the
 *  content script that was waiting for it, so the runner records it here. */
async function autoThanksPage(tabId, url) {
  const job = await autoJobForTab(tabId);
  if (!job?.submittingAt || Date.now() - job.submittingAt > 10 * 60 * 1000) return;
  // Every frame: a Greenhouse form embedded on a careers page confirms inside its iframe.
  const frames = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const text = (document.body?.innerText || "").slice(0, 6000);
      const form = !!document.querySelector("#application_form, form#application-form, input[id^='question_'], #first_name, .ashby-application-form-container");
      return { form, thanks: /confirmation|thank/i.test(location.href) || /thank you for (applying|your (application|interest))|thanks for applying|application (has been |was )?(successfully )?(submitted|received)|we('ve| have) received your application|successfully submitted/i.test(text) };
    },
  }).catch(() => []);
  const seen = frames.map((f) => f?.result).filter(Boolean);
  if (!seen.some((r) => r.thanks) || seen.some((r) => r.form)) return;
  await callFunction("recordApplication", { event: "submitted", applyUrl: job.applyUrl, jobId: job.jobId, jobTitle: job.title, companyName: job.companyName }).catch((e) => console.warn("[JobWatch] ledger(submitted) failed:", e.message));
  await autoFinish({ status: "submitted", note: "" }, tabId);
}

/** Lever leaves the form for a separate /thanks page after Submit: that is the submission. */
async function autoLeverThanks(tabId, url) {
  if (!/jobs\.(eu\.)?lever\.co\/[^/]+\/[0-9a-f-]{36}\/thanks/i.test(url)) return;
  const job = await autoJobForTab(tabId);
  if (!job) return;
  await callFunction("recordApplication", { event: "submitted", applyUrl: job.applyUrl, jobId: job.jobId, jobTitle: job.title, companyName: job.companyName }).catch((e) => console.warn("[JobWatch] ledger(submitted) failed:", e.message));
  await autoFinish({ status: "submitted", note: "" }, tabId);
}

// ─── Unattended auto-apply (Ashby, Greenhouse, Lever, Workday) ─────────────────────
// Works through getAutoApplyQueue one job at a time in a background tab: the
// tailored resume is made first (tailoredResumeFile), the page's content
// script fills the form, submits when nothing is left for the person, enters
// Greenhouse's emailed security code from Gmail, and reports back
// (AUTO_RESULT). Anything it cannot finish stays open in its tab and is
// listed in the popup. State lives in chrome.storage.local so a restarted
// service worker carries on; a one-minute alarm keeps the loop alive.
//
// Always on: when the queue runs dry the runner checks every minute whether
// the job list changed and starts on a new job at once, starts again when the browser opens,
// and keeps the computer awake while it is on (chrome.power). Failed jobs are
// retried on their own (30 minutes, then 2 hours; three tries in all; closed
// postings never). A job that needed the person is retried once they add a
// saved answer on the Profile page, if its tab was closed.
//
// Workday (2026-11-10): only with a Workday password saved in the popup. The
// page signs in, or makes the company's account and opens the verification
// link from Gmail, fills every step, presses Save and Continue, and stops on
// the Review page ("review": ready to submit, the tab stays open for the
// person to check and press Submit). At most WORKDAY_MAX_REVIEW wait at once.

const AUTO_KEY = "jwAuto";
const AUTO_JOB_TIMEOUT_MS = 15 * 60 * 1000;
const PERSON_ONLY = /assessment|reference #|references|transcript|refuses the saved workday password|cover letter|portfolio upload|writing sample/i;
const WORKDAY_DOWN = /workday is currently unavailable|workday[-_ ]maintenance|application system maintenance|down for (scheduled )?maintenance/i;
const WORKDAY_JOB_TIMEOUT_MS = 25 * 60 * 1000; // account, verification email and five or six steps
const WORKDAY_MAX_REVIEW = 5; // Workday applications waiting on Review before more start
const AUTO_GAP_MS = [1500, 3000]; // back to back: just long enough for the tab to close
const AUTO_IDLE_MS = 15 * 60 * 1000; // the queue is fetched again at least this often
const AUTO_POLL_MS = 60 * 1000; // nothing to do: check whether the job list changed this often
const AUTO_RETRY_MS = [30 * 60 * 1000, 2 * 60 * 60 * 1000]; // after the 1st and 2nd failure
const AUTO_MAX_TRIES = 3;
const AUTO_MAX_OPEN = 3; // "needs you" tabs left open at once
const AUTO_PARALLEL = 3; // jobs applied to at the same time, each in its own tab
const CLOSED_POSTING = /not found|no longer (accepting|available|open)|position (has been )?(filled|closed)|job (is )?closed|posting (was )?(removed|expired|closed)|\b404\b/i;
let autoBusy = false;
let autoQueue = { at: 0, list: [], answersUpdatedAt: 0 };

/** Keep the computer awake while auto-apply is on (the display may still sleep). */
function keepAwake(on) {
  try { if (on) chrome.power.requestKeepAwake("system"); else chrome.power.releaseKeepAwake(); } catch (_) { /* no power API */ }
}

/** Whether a job is due now: never tried, or a failure whose retry time came. */
async function autoDue(j, st) {
  const r = st.results[j.jobId];
  if (!r) return true;
  // A test run (filled to Review, never submitted) does not count for the real
  // job: it runs again, in a fresh tab (Workday, HP were test-filled first).
  if (r.test && !j.test) {
    if (r.tabId) await chrome.tabs.remove(r.tabId).catch(() => {});
    return true;
  }
  // Marked for another try (scripts/retry-stuck.mjs): a new mark starts it
  // fresh, even after its tries ran out; its old tab closes.
  if (j.retryToken && r.retryToken !== j.retryToken) {
    if (r.tabId) await chrome.tabs.remove(r.tabId).catch(() => {});
    return true;
  }
  // Left on Review before Submit was allowed for it: once more, to submit.
  if (j.submit && r.status === "review" && !r.submit) {
    if (r.tabId) await chrome.tabs.remove(r.tabId).catch(() => {});
    return true;
  }
  if ((r.tries || 1) >= AUTO_MAX_TRIES || r.closed) return false;
  if (r.status === "error") return Date.now() >= (r.retryAt || 0);
  if (r.status === "needs_attention") {
    // Tried again on its own (30 min, then 2 h; three tries in all), or at
    // once when the person saved a new answer. Its old tab is closed: the job
    // reopens fresh as an auto-apply job.
    const due = autoQueue.answersUpdatedAt > r.at || (!r.personOnly && Date.now() >= r.at + (AUTO_RETRY_MS[(r.tries || 1) - 1] || AUTO_RETRY_MS[AUTO_RETRY_MS.length - 1]));
    if (!due) return false;
    if (r.tabId) await chrome.tabs.remove(r.tabId).catch(() => {});
    return true;
  }
  return false;
}

async function autoState() {
  const { [AUTO_KEY]: st } = await chrome.storage.local.get(AUTO_KEY);
  // Always on: while the browser is open (and the person signed in), it applies.
  const out = st || { running: [], results: {}, startedAt: Date.now() };
  out.on = true;
  out.results = out.results || {};
  // Up to AUTO_PARALLEL jobs at once, each in its own tab (older state kept one in `current`).
  out.running = Array.isArray(out.running) ? out.running : out.current ? [out.current] : [];
  delete out.current;
  // Keep only what matters: a finished job (submitted, skipped) is forgotten
  // after a day; the server's applications record keeps it from a second
  // application. Jobs still waiting on a retry stay until they are done.
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, r] of Object.entries(out.results)) if (["submitted", "skipped"].includes(r.status) && (r.at || 0) < dayAgo) delete out.results[id];
  return out;
}
// The old "Feeds" list in the popup is gone: drop what it stored.
chrome.storage.local.remove("jwAutoFeeds").catch(() => {});
// One change to the runner's state at a time: jobs in parallel tabs finish
// whenever they finish, and two read-modify-writes must not cross.
let autoLock = Promise.resolve();
function withAutoLock(fn) {
  const run = autoLock.then(fn, fn);
  autoLock = run.catch(() => {});
  return run;
}
async function saveAuto(st) { await chrome.storage.local.set({ [AUTO_KEY]: st }); }

async function callFunction(name, data) {
  const { idToken } = await getFreshToken();
  const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ data: data || {} }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error?.message || `${name} ${res.status}`);
  return json.result;
}

function notify(title, message) {
  try { chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title, message: String(message).slice(0, 250) }); } catch (_) { /* notifications are a nicety */ }
}

/** The tailored resume PDF for a job ({ jobId } or { source, externalId }), cached for the session. */
async function tailoredResumeFor(ref) {
  const key = `tr:${ref.jobId || `${ref.source}|${ref.externalId}`}`;
  const { [key]: hit } = await chrome.storage.session.get(key);
  if (hit?.pdfBase64) return hit;
  if (hit?.failedAt && Date.now() - hit.failedAt < 10 * 60 * 1000) return { error: hit.error || "failed" };
  try {
    const r = await callFunction("tailoredResumeFile", ref);
    await chrome.storage.session.set({ [key]: { fileName: r.fileName, pdfBase64: r.pdfBase64, jobId: r.jobId } });
    return r;
  } catch (err) {
    console.warn("[JobWatch] tailored resume unavailable, using the saved resume:", err.message);
    await chrome.storage.session.set({ [key]: { failedAt: Date.now(), error: err.message } });
    return { error: err.message };
  }
}
// The AI account is out of credits: nothing tailored, no AI answers. Auto-apply
// waits instead of sending generic applications (2026-11-03: ran out at 9:30 AM).
const AI_DOWN = /out of credits|credit balance|billing|resource-exhausted/i;
const AI_DOWN_WAIT_MS = 15 * 60 * 1000;
// ─── Workday in a minimized window: focus emulation ───────────────────────────
// Workday only commits dates (and some other widgets) when the page has focus,
// which a tab in the minimized job window never has: Ohio State, Capital One,
// WellSky and Cadence refused dates they showed (2026-11-10; reproduced in an
// unfocused window, fixed only by focus emulation). For its own Workday
// auto-apply tabs, JobWatch attaches the debugger and turns on
// Emulation.setFocusEmulationEnabled, the switch test browsers use; it detaches
// when the job finishes. The browser shows a "debugging" bar meanwhile.
const focusTabs = new Set();
// Every debugger call is bounded: attaching while a tab navigates (right after a
// sign-in submit) can hang, and a page waiting on it never learned its job (the
// tabs that went silent after signing in, 2026-11-10).
const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`no answer in ${ms} ms`)), ms))]);
async function focusEmulate(tabId) {
  if (tabId == null || !chrome.debugger) return false;
  try { await within(chrome.debugger.attach({ tabId }, "1.3"), 3000); } catch (e) { if (!/already attached/i.test(e.message || "")) { console.warn("[JobWatch] focus emulation unavailable:", e.message); return false; } }
  focusTabs.add(tabId);
  try { await within(chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }), 3000); return true; }
  catch (e) { console.warn("[JobWatch] focus emulation failed:", e.message); return false; }
}
function focusRelease(tabId) {
  if (tabId == null || !focusTabs.has(tabId)) return;
  focusTabs.delete(tabId);
  chrome.debugger.detach({ tabId }).catch(() => {});
}
chrome.debugger?.onDetach.addListener((src) => focusTabs.delete(src.tabId));

/** The auto-apply job this tab is working on, or null. */
async function autoJobForTab(tabId) {
  const st = await autoState();
  return (st.on && st.running.find((j) => j.tabId != null && j.tabId === tabId)) || null;
}
/** Start making the job's tailored resume (runs alongside the answers). */
async function startTailored(sender, ref) {
  const job = await autoJobForTab(sender?.tab?.id);
  return tailoredResumeFor(job ? { jobId: job.jobId } : ref);
}
/** Swap the saved resume for the job's tailored one in a computed application. */
async function withTailoredResume(data, tailoredP) {
  if (!data || data.alreadyApplied) return data;
  const t = await tailoredP.catch(() => null);
  if (t?.pdfBase64) return { ...data, resumeB64: t.pdfBase64, resumeName: t.fileName, resumeTailored: true };
  return data;
}

/** When the job list or the match scores last changed (two one-field reads):
 *  a new value means new jobs, so the queue is fetched again at once. */
let jobsStampSeen = "";
async function jobsStamp() {
  try {
    const { idToken, uid } = await getFreshToken();
    const one = async (path) => {
      const r = await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}?mask.fieldPaths=updatedAt`, { headers: { Authorization: `Bearer ${idToken}` } });
      return r.ok ? (await r.json())?.fields?.updatedAt?.timestampValue || "" : "";
    };
    const [jobs, scores] = await Promise.all([one(`users/${ADMIN_UID}/aggregations/recentJobs`), one(`users/${uid || ADMIN_UID}/aggregations/myJobScores`)]);
    return `${jobs}|${scores}`;
  } catch (_) { return ""; }
}

async function autoNextJob(st, busy = new Set()) {
  const stamp = await jobsStamp();
  const changed = stamp && stamp !== jobsStampSeen;
  if (Date.now() - autoQueue.at > AUTO_IDLE_MS || !autoQueue.at || changed) {
    const r = await callFunction("getAutoApplyQueue", {});
    autoQueue = { at: Date.now(), list: r.queue || [], answersUpdatedAt: Number(r.answersUpdatedAt) || 0 };
    if (stamp) jobsStampSeen = stamp;
  }
  // Workday: only with its password saved, and while few wait on Review.
  const { jwWorkday } = await chrome.storage.local.get("jwWorkday");
  const reviewOpen = Object.values(st.results).filter((r) => r.status === "review" && r.tabId && !r.test).length;
  const workdayOk = !!jwWorkday?.password && reviewOpen < WORKDAY_MAX_REVIEW;
  // One job at a time per Workday site: two tabs on one site share its sign-in
  // and one of them stalls (two Micron jobs 20 s apart, 2026-11-10). A site
  // that showed a maintenance page waits out its pause.
  const wdBusy = new Set(st.running.filter((r) => r.source === "workday").map((r) => workdayTenantOf(r.applyUrl || "")));
  for (const j of autoQueue.list) {
    if (j.source === "workday" && !workdayOk) continue;
    if (j.source === "workday") {
      const t = workdayTenantOf(j.applyUrl || "");
      if (wdBusy.has(t) || (st.wdDown?.[t] || 0) > Date.now()) continue;
    }
    if (!busy.has(j.jobId) && await autoDue(j, st)) return j;
  }
  return null;
}

// A submitted application's tab stays up this long (the confirmation shows), then closes.
const SUBMITTED_CLOSE_MS = 5000;
/** Close a submitted application's tab after SUBMITTED_CLOSE_MS, unless the
 *  person has since taken that tab to another site. */
async function closeSubmittedTab(tabId) {
  if (tabId == null) return;
  const host = (u) => { try { return new URL(u).hostname; } catch (_) { return ""; } };
  const was = host((await chrome.tabs.get(tabId).catch(() => null))?.url);
  setTimeout(async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && host(tab.url) === was) chrome.tabs.remove(tabId).catch(() => {});
  }, SUBMITTED_CLOSE_MS);
}

/** A "needs you" tab the person finished by hand: count it submitted and close
 *  the tab like the runner's own. Returns whether the tab was one of those. */
async function finishedByHand(tabId, isSameForm = null) {
  const st = await autoState();
  let hit = false;
  for (const r of Object.values(st.results || {})) {
    if (r.status === "submitted" || !(r.tabId === tabId || (isSameForm && isSameForm(r.url)))) continue;
    if (r.tabId === tabId) hit = true;
    r.status = "submitted"; r.note = "finished by hand"; r.at = Date.now(); r.tabId = null;
  }
  if (hit || isSameForm) await saveAuto(st);
  if (hit) await closeSubmittedTab(tabId);
  return hit;
}

async function autoFinish(result, tabId, jobId = null) {
  return withAutoLock(() => autoFinishNow(result, tabId, jobId));
}
async function autoFinishNow(result, tabId, jobId) {
  const st = await autoState();
  const cur = st.running.find((j) => (jobId ? j.jobId === jobId : j.tabId === tabId));
  if (!cur) return;
  const prev = st.results[cur.jobId];
  const tries = (prev?.tries || 0) + 1;
  const note = String(result.note || "").slice(0, 300);
  focusRelease(cur.tabId);
  // A test run (autoApplyTest): traced, tab closed, never retried or submitted.
  if (cur.test) {
    st.results[cur.jobId] = { status: result.status, note, title: cur.title, companyName: cur.companyName, url: cur.applyUrl, at: Date.now(), tries: AUTO_MAX_TRIES, test: true };
    st.running = st.running.filter((j) => j !== cur);
    st.nextAt = Date.now() + AUTO_GAP_MS[0];
    await saveAuto(st);
    if (cur.tabId) chrome.tabs.remove(cur.tabId).catch(() => {});
    console.log(`[JobWatch] Workday test ${result.status}: ${cur.companyName} | ${cur.title} ${note}`);
    setTimeout(autoTick, 1500);
    chrome.alarms.create("jwAutoKick", { when: Date.now() + 30000 });
    return;
  }
  // Only the person can finish these (Centene's assessment ran three times):
  // no automatic retries; a newly saved answer still brings it back.
  const personOnly = result.status === "needs_attention" && PERSON_ONLY.test(note);
  st.results[cur.jobId] = {
    status: result.status, note, title: cur.title, companyName: cur.companyName, url: cur.applyUrl, at: Date.now(), tries: cur.retryToken && prev?.retryToken !== cur.retryToken ? 1 : tries, submit: !!cur.submit, ...(cur.retryToken ? { retryToken: cur.retryToken } : {}), ...(personOnly ? { personOnly: true } : {}),
    ...(result.status === "error" ? { retryAt: Date.now() + (AUTO_RETRY_MS[tries - 1] || AUTO_RETRY_MS[AUTO_RETRY_MS.length - 1]), closed: CLOSED_POSTING.test(note) } : {}),
    ...(["needs_attention", "review"].includes(result.status) ? { tabId: cur.tabId || null } : {}),
  };
  st.running = st.running.filter((j) => j !== cur);
  st.nextAt = Date.now() + AUTO_GAP_MS[0] + Math.random() * (AUTO_GAP_MS[1] - AUTO_GAP_MS[0]);
  await saveAuto(st);
  // Submitted: close the tab a few seconds later (the confirmation shows).
  // Skipped or failed: close it now. Needs you: leave it open to finish, but
  // only the newest AUTO_MAX_OPEN; older ones close (the popup lists them with
  // their links, and they retry once a missing answer is saved).
  if (result.status === "submitted") await closeSubmittedTab(cur.tabId);
  else if (!["needs_attention", "review"].includes(result.status) && cur.tabId) chrome.tabs.remove(cur.tabId).catch(() => {});
  if (result.status === "review") {
    // Workday, filled to Review: the tab stays open for the person to check and submit.
    const ready = Object.values(st.results).filter((r) => r.status === "review" && r.tabId).length;
    try {
      chrome.notifications.create("jwReview", { type: "basic", iconUrl: "icons/icon128.png", title: `JobWatch: ${ready} Workday application${ready === 1 ? "" : "s"} ready to submit`, message: `Latest: ${cur.companyName}, ${cur.title}. Check the Review page and press Submit.`.slice(0, 250), priority: 0 });
    } catch (_) { /* a nicety */ }
  }
  if (result.status === "needs_attention") {
    const open = Object.entries(st.results).filter(([, r]) => r.status === "needs_attention" && r.tabId).sort((a, b) => b[1].at - a[1].at);
    for (const [id, r] of open.slice(AUTO_MAX_OPEN)) {
      chrome.tabs.remove(r.tabId).catch(() => {});
      st.results[id].tabId = null;
    }
    await saveAuto(st);
    // One notification that updates, not one per job.
    const waiting = Object.values(st.results).filter((r) => r.status === "needs_attention").length;
    try {
      chrome.notifications.create("jwNeeds", { type: "basic", iconUrl: "icons/icon128.png", title: `JobWatch: ${waiting} application${waiting === 1 ? "" : "s"} need${waiting === 1 ? "s" : ""} you`, message: `Latest: ${cur.companyName}, ${cur.title}. ${result.note || ""}`.slice(0, 250), priority: 0 });
    } catch (_) { /* a nicety */ }
  }
  console.log(`[JobWatch] auto-apply ${result.status}: ${cur.companyName} | ${cur.title} ${result.note || ""}`);
  // Chrome won't fire an alarm sooner than 30 s: start the next job directly,
  // with the alarm as the backstop if the service worker sleeps first.
  setTimeout(autoTick, Math.max(0, st.nextAt - Date.now()) + 50);
  chrome.alarms.create("jwAutoKick", { when: Math.max(st.nextAt, Date.now() + 30000) });
}

/** Auto-apply's own minimized window: the jobs stay out of the person's tab
 *  strip, and a person's browser does not grow three hidden tabs at a time.
 *  Falls back to a background tab where a window cannot be made. */
let jobWindowLock = Promise.resolve();
/** One at a time: three jobs start together, and each used to find no job
 *  window yet and make its own (three windows of one tab each). */
function openJobTab(url) {
  const run = jobWindowLock.then(() => openJobTabNow(url));
  jobWindowLock = run.catch(() => {});
  return run;
}
async function openJobTabNow(url) {
  try {
    // Session storage, not local: window ids restart at 1 when the browser
    // restarts, so a remembered id could name the person's own window and jobs
    // would open (and switch tabs) right in front of them.
    chrome.storage.local.remove("jwJobWindow").catch(() => {});
    const { jwJobWindow } = await chrome.storage.session.get("jwJobWindow");
    let win = jwJobWindow ? await chrome.windows.get(jwJobWindow).catch(() => null) : null;
    if (win && win.type !== "normal") win = null;
    if (!win) {
      // The window starts with a blank pinned tab that stays: when the last job
      // tab closed, the window closed with it, and making a new one for the
      // next job pulled the person to it on macOS (watching YouTube, 2026-11-11).
      // Made once per browser session; jobs only add tabs to it after that.
      win = await chrome.windows.create({ url: "about:blank", state: "minimized", focused: false });
      await chrome.storage.session.set({ jwJobWindow: win.id, jwKeeperTab: win.tabs?.[0]?.id ?? null });
      if (win.tabs?.[0]?.id != null) chrome.tabs.update(win.tabs[0].id, { pinned: true }).catch(() => {});
      return await chrome.tabs.create({ windowId: win.id, url, active: true });
    }
    // The person is looking at the job window (finishing a "needs you"): the
    // new job opens as a background tab there, so their tab does not switch.
    if (win.focused) return await chrome.tabs.create({ windowId: win.id, url, active: false });
    // Restored but in the background: tuck it away again before adding a job.
    // Only a normal window is tucked away: one the person made full screen
    // or maximized is theirs to leave as it is (minimizing a full-screen
    // window flashed Edge's "To exit full screen" banner).
    if (win.state === "normal") await chrome.windows.update(win.id, { state: "minimized" }).catch(() => {});
    return await chrome.tabs.create({ windowId: win.id, url, active: true });
  } catch (err) {
    console.warn("[JobWatch] job window unavailable, using a tab:", err.message);
    return chrome.tabs.create({ url, active: false });
  }
}

async function autoTick() {
  if (autoBusy) return;
  autoBusy = true;
  try {
    // 1. Jobs whose tab is gone or that ran too long end as errors.
    const st0 = await autoState();
    keepAwake(true);
    for (const j of st0.running) {
      const alive = j.tabId ? await chrome.tabs.get(j.tabId).then(() => true).catch(() => false) : true;
      if (j.tabId && !alive) await autoFinish({ status: "error", note: "the tab was closed" }, j.tabId, j.jobId);
      // Workday down for maintenance ("Workday is currently unavailable", or the
      // company's own page: Target's /careers/workday-maintenance, 2026-11-10):
      // end the job now and pause that company's site for 30 minutes, instead of a
      // 25-minute wait per job with no page script to say why.
      // Off Workday on the company's own site (Labcorp's closed posting went to
      // careers.labcorp.com/.../404 and sat 25 minutes, 2026-11-10): no page
      // script runs there. Give the page a minute (sign-in pages can bounce).
      else if (j.source === "workday" && j.tabId && Date.now() - j.startedAt > 60000 && await chrome.tabs.get(j.tabId).then((t) => /^https?:/.test(t.url || "") && !/myworkday(jobs|site)?\.com|myworkday\.com/i.test(t.url || "") && !/mail\.google\.com/.test(t.url || "")).catch(() => false)) {
        const tab = await chrome.tabs.get(j.tabId).catch(() => ({}));
        const gone = /\b404\b|not found|no longer (available|accepting)|page (you|cannot)|doesn.t exist|expired|closed/i.test(`${tab.title || ""} ${tab.url || ""}`);
        const note = gone ? `job closed: Workday sent the tab to ${String(tab.url || "").slice(0, 100)}` : `the tab left Workday for ${String(tab.url || "").slice(0, 100)} (${String(tab.title || "").slice(0, 60)})`;
        try {
          const { idToken, uid } = await getFreshToken();
          await fsAdd(`users/${uid}`, "workdayTraces", { kind: "result", tenant: workdayTenantOf(j.applyUrl), jobId: j.jobId, companyName: j.companyName || "", title: j.title || "", test: !!j.test, url: String(tab.url || "").slice(0, 500), at: new Date().toISOString(), version: chrome.runtime.getManifest().version, json: JSON.stringify({ status: gone ? "error" : "needs_attention", note }) }, idToken);
        } catch (_) { /* best effort */ }
        await autoFinish({ status: gone ? "error" : "needs_attention", note }, j.tabId, j.jobId);
      }
      else if (j.source === "workday" && j.tabId && await chrome.tabs.get(j.tabId).then((t) => WORKDAY_DOWN.test(`${t.title || ""} ${t.url || ""}`)).catch(() => false)) {
        const tab = await chrome.tabs.get(j.tabId).catch(() => ({}));
        // Once per job, open the application again first: right after a password
        // reset Workday showed this page while the sign-in had worked (Fox, Target).
        if (!j.downRetried && j.applyUrl) {
          await withAutoLock(async () => { const st = await autoState(); const r = st.running.find((x) => x.jobId === j.jobId); if (r) r.downRetried = true; await saveAuto(st); });
          await chrome.tabs.update(j.tabId, { url: j.applyUrl }).catch(() => {});
          continue;
        }
        const note = `Workday is down for maintenance (${String(tab.title || tab.url || "").slice(0, 80)}): will try again later`;
        try {
          const { idToken, uid } = await getFreshToken();
          await fsAdd(`users/${uid}`, "workdayTraces", { kind: "result", tenant: workdayTenantOf(j.applyUrl), jobId: j.jobId, companyName: j.companyName || "", title: j.title || "", test: !!j.test, url: String(tab.url || "").slice(0, 500), at: new Date().toISOString(), version: chrome.runtime.getManifest().version,
            json: JSON.stringify({ status: "error", note, step: "", tabTitle: tab.title }) }, idToken);
        } catch (_) { /* best effort */ }
        await autoFinish({ status: "error", note }, j.tabId, j.jobId);
        // Only this company's site waits (U.S. Bank's outage was its own).
        await withAutoLock(async () => { const st = await autoState(); st.wdDown = { ...(st.wdDown || {}), [workdayTenantOf(j.applyUrl || "")]: Date.now() + 30 * 60 * 1000 }; await saveAuto(st); });
      }
      else if (Date.now() - j.startedAt > (j.source === "workday" ? WORKDAY_JOB_TIMEOUT_MS : AUTO_JOB_TIMEOUT_MS)) {
        // Where a Workday job ended up when it timed out (some went silent right
        // after signing in, with no page script left to say where).
        if (j.source === "workday" && j.tabId) {
          try {
            const tab = await chrome.tabs.get(j.tabId);
            const { idToken, uid } = await getFreshToken();
            await fsAdd(`users/${uid}`, "workdayTraces", { kind: "result", tenant: workdayTenantOf(tab.url || j.applyUrl), jobId: j.jobId, companyName: j.companyName || "", title: j.title || "", test: !!j.test, url: String(tab.url || "").slice(0, 500), at: new Date().toISOString(), version: chrome.runtime.getManifest().version,
              json: JSON.stringify({ status: "error", note: `timed out after 25 minutes on ${String(tab.url || "").slice(0, 200)} (${String(tab.title || "").slice(0, 100)})`, step: "", timedOutAt: tab.url, tabTitle: tab.title }) }, idToken);
          } catch (_) { /* best effort */ }
        }
        await autoFinish({ status: "error", note: `timed out after ${j.source === "workday" ? 25 : 15} minutes` }, j.tabId, j.jobId);
      }
    }
    // Workday applications waiting on Review whose tab the person closed
    // without submitting: no longer count toward WORKDAY_MAX_REVIEW.
    await withAutoLock(async () => {
      const st = await autoState();
      let changed = false;
      for (const r of Object.values(st.results)) {
        if (r.status !== "review" || r.tabId == null) continue;
        if (await chrome.tabs.get(r.tabId).then(() => true).catch(() => false)) continue;
        r.tabId = null; r.note = "closed on Review without submitting"; changed = true;
      }
      if (changed) await saveAuto(st);
    });
    // 2. Fill the free slots, one job at a time.
    for (let slot = 0; slot < AUTO_PARALLEL; slot++) {
      const job = await withAutoLock(async () => {
        const st = await autoState();
        if (st.running.length >= AUTO_PARALLEL) return null;
        if (st.nextAt && Date.now() < st.nextAt) return null;
        const busy = new Set(st.running.map((r) => r.jobId));
        const next = await autoNextJob(st, busy);
        if (!next) {
          if (st.running.length) return null; // the others are still working
          // Nothing due: wait for new jobs (or a retry's time) instead of stopping.
          const retryAts = Object.values(st.results).filter((r) => ["error", "needs_attention"].includes(r.status) && !r.closed && (r.tries || 1) < AUTO_MAX_TRIES)
            .map((r) => (r.status === "error" ? r.retryAt || 0 : r.at + (AUTO_RETRY_MS[(r.tries || 1) - 1] || AUTO_RETRY_MS[AUTO_RETRY_MS.length - 1])));
          // Look again in a minute: new jobs start the moment the list changes.
          st.nextAt = Math.min(Date.now() + AUTO_POLL_MS, ...retryAts.map((t) => Math.max(t, Date.now() + 60000)));
          if (!st.idle) {
            const n = Object.values(st.results).filter((r) => r.status === "submitted").length;
            notify("Auto-apply is waiting for new jobs", `Every job so far is done (${n} submitted). A new job starts within a minute of appearing on your Jobs page.`);
          }
          st.idle = true;
          await saveAuto(st);
          chrome.alarms.create("jwAutoKick", { when: st.nextAt });
          return null;
        }
        st.idle = false;
        st.running.push({ ...next, tabId: null, startedAt: Date.now() });
        await saveAuto(st);
        return next;
      });
      if (!job) break;
      try {
        const tailored = await tailoredResumeFor({ jobId: job.jobId }); // ready before the form asks for it
        if (tailored?.error && AI_DOWN.test(tailored.error)) {
          // Put the job back untouched (not a try) and look again in 15 minutes.
          await chrome.storage.session.remove(`tr:${job.jobId}`);
          const first = await withAutoLock(async () => {
            const st = await autoState();
            st.running = st.running.filter((x) => x.jobId !== job.jobId);
            const was = st.aiDownSince;
            st.aiDownSince = was || Date.now();
            st.nextAt = Date.now() + AI_DOWN_WAIT_MS;
            await saveAuto(st);
            chrome.alarms.create("jwAutoKick", { when: st.nextAt });
            return !was;
          });
          if (first) notify("Auto-apply paused: the AI is out of credits", "No tailored resumes or AI answers until credits are added (console.anthropic.com → Billing). JobWatch checks again every 15 minutes and carries on by itself.");
          break;
        }
        // Only with its tailored resume: no generic applications. The job
        // stops as an error and is tried again later (AUTO_RETRY_MS).
        if (!tailored?.pdfBase64) {
          await autoFinish({ status: "error", note: `no tailored resume: ${String(tailored?.error || "not made").slice(0, 200)}` }, null, job.jobId);
          continue;
        }
        await withAutoLock(async () => {
          const st = await autoState();
          if (st.aiDownSince) { delete st.aiDownSince; await saveAuto(st); notify("Auto-apply is back on", "The AI is answering again; applications carry on."); }
        });
        const tab = await openJobTab(job.source === "workday" ? workdayLoginUrl(job.applyUrl) : job.applyUrl);
        await withAutoLock(async () => {
          const st = await autoState();
          const r = st.running.find((x) => x.jobId === job.jobId);
          if (r) { r.tabId = tab.id; await saveAuto(st); }
        });
        // Make the next job's tailored resume while these fill, so it starts at once.
        const stNow = await autoState();
        const upcoming = autoQueue.list.find((j) => !stNow.results[j.jobId] && !stNow.running.some((r) => r.jobId === j.jobId));
        if (upcoming) tailoredResumeFor({ jobId: upcoming.jobId }).catch(() => {});
      } catch (err) {
        console.warn("[JobWatch] auto-apply could not open a job:", err.message);
        await withAutoLock(async () => {
          const st = await autoState();
          st.running = st.running.filter((x) => !(x.jobId === job.jobId && !x.tabId));
          st.nextAt = Date.now() + 60000;
          await saveAuto(st);
        });
        break;
      }
    }
  } catch (err) {
    console.warn("[JobWatch] auto-apply tick failed:", err.message);
  } finally {
    autoBusy = false;
  }
}

chrome.alarms.create("jwAutoTick", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "jwAutoTick") selfUpdate().catch(() => {});
  if (a.name === "jwAutoTick" || a.name === "jwAutoKick") autoTick();
});
// The browser opened: carry on where it left off (a job whose tab is gone is retried later).
chrome.runtime.onStartup.addListener(() => { requeueRefused().then(autoTick); });
// Reloaded with new code (selfUpdate, or the Reload button): carry on too.
chrome.runtime.onInstalled.addListener((d) => { if (d.reason === "update") requeueRefused().then(autoTick); });

/** After an update: every job that stopped (needs you, or an error) goes back
 *  in the queue so the new code gets its chance, with its stale tab closed
 *  so it reopens as an auto-apply job. A closed posting stays out. */
async function requeueRefused() {
  return withAutoLock(requeueRefusedNow);
}
async function requeueRefusedNow() {
  const st = await autoState();
  let n = 0;
  // Jobs that were mid-way lost their page script with the old code: restart them.
  for (const j of st.running) { if (j.tabId) chrome.tabs.remove(j.tabId).catch(() => {}); n++; }
  st.running = [];
  for (const [id, r] of Object.entries(st.results || {})) {
    if (!["needs_attention", "error"].includes(r.status) || r.closed) continue;
    if (r.tabId) chrome.tabs.remove(r.tabId).catch(() => {});
    delete st.results[id];
    n++;
  }
  if (n) { st.idle = false; st.nextAt = 0; autoQueue = { at: 0, list: [], answersUpdatedAt: 0 }; await saveAuto(st); console.log(`[JobWatch] re-queued ${n} refused job(s) after the update`); }
}

/** The extension is loaded unpacked, and Edge keeps running the old code when
 *  the files on disk change (until Reload on edge://extensions). Once a
 *  minute: a newer version on disk gets one notification per version, which
 *  opens the extensions page. (chrome.runtime.reload() would do it unseen, but
 *  in testing it unloaded a command-line-loaded extension instead; a stopped
 *  runner is worse than a prompt.) */
async function selfUpdate() {
  const disk = (await (await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" })).json())?.version;
  const running = chrome.runtime.getManifest().version;
  if (!disk || disk === running) return;
  const [d, r] = [disk, running].map((v) => v.split(".").map(Number));
  const i = d.findIndex((n, k) => n !== (r[k] || 0));
  if (i < 0 || d[i] < (r[i] || 0)) return; // same or older on disk
  const { jwUpdateSeen } = await chrome.storage.local.get("jwUpdateSeen");
  if (jwUpdateSeen === disk) return;
  await chrome.storage.local.set({ jwUpdateSeen: disk, jwUpdateReady: { disk, running } });
  try {
    chrome.notifications.create("jwUpdate", { type: "basic", iconUrl: "icons/icon128.png", requireInteraction: true, title: `JobWatch ${disk} is ready (running ${running})`, message: "Click here, then press Reload on JobWatch. Auto-apply keeps its place." });
  } catch (_) { /* a nicety */ }
}
chrome.notifications?.onClicked.addListener((id) => {
  if (id !== "jwUpdate") return;
  const url = /Edg\//.test(navigator.userAgent) ? `edge://extensions/?id=${chrome.runtime.id}` : `chrome://extensions/?id=${chrome.runtime.id}`;
  chrome.tabs.create({ url }).catch(() => {});
  chrome.notifications.clear(id);
});

async function autoStatus() {
  const st = await autoState();
  const results = Object.entries(st.results || {}).map(([jobId, r]) => ({ jobId, ...r })).sort((a, b) => b.at - a.at);
  const count = (s) => results.filter((r) => r.status === s).length;
  const left = autoQueue.list.filter((j) => !st.results[j.jobId]).length;
  const retrying = results.filter((r) => ["error", "needs_attention"].includes(r.status) && !r.closed && (r.tries || 1) < AUTO_MAX_TRIES).length;
  const stopped = results.filter((r) => ["needs_attention", "error"].includes(r.status) && r.at >= Date.now() - 864e5);
  return { on: !!st.on, idle: !!st.idle, aiDownSince: st.aiDownSince || 0, nextAt: st.nextAt || 0, current: st.running[0] || null, running: st.running, reasons: stopReasons(stopped), submitted: count("submitted"), review: count("review"), needs: count("needs_attention"), errors: count("error"), skipped: count("skipped"), retrying, left: autoQueue.at ? left : null, recent: results.slice(0, 8) };
}

// ─── Gmail: Greenhouse's emailed security code ───────────────────────────────
// Read-only Gmail access through Google's OAuth (chrome.identity), used for one
// thing: the 8-character code Greenhouse emails after Submit. The OAuth client
// ID is the person's own (Google Cloud Console, Web application client whose
// redirect URI is chrome.identity.getRedirectURL("gmail")), saved from the popup.

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
async function gmailState() { const { jwGmail } = await chrome.storage.local.get("jwGmail"); return jwGmail || {}; }
async function gmailToken(interactive = false) {
  const g = await gmailState();
  if (g.token && g.exp > Date.now() + 60000) return g.token;
  if (!g.clientId) throw new Error("Gmail is not connected (no OAuth client ID).");
  const params = new URLSearchParams({ client_id: g.clientId, response_type: "token", redirect_uri: chrome.identity.getRedirectURL("gmail"), scope: GMAIL_SCOPE, include_granted_scopes: "true", prompt: interactive ? "select_account consent" : "none" });
  if (g.email) params.set("login_hint", g.email);
  const back = await chrome.identity.launchWebAuthFlow({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, interactive });
  const frag = new URLSearchParams(String(back || "").split("#")[1] || "");
  const token = frag.get("access_token");
  if (!token) throw new Error(frag.get("error") || "Google did not return a Gmail token.");
  const next = { ...g, token, exp: Date.now() + Number(frag.get("expires_in") || 3600) * 1000 };
  if (!next.email) {
    const prof = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()).catch(() => ({}));
    next.email = prof.emailAddress || "";
  }
  await chrome.storage.local.set({ jwGmail: next });
  return token;
}
function b64urlText(data) {
  try { return decodeURIComponent(escape(atob(String(data || "").replace(/-/g, "+").replace(/_/g, "/")))); } catch { return ""; }
}
function mailText(payload) {
  let out = "";
  const walk = (p) => { if (!p) return; if (p.body?.data && /text\/(plain|html)/.test(p.mimeType || "")) out += " " + b64urlText(p.body.data); (p.parts || []).forEach(walk); };
  walk(payload);
  return out.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
}
/** The code from the newest Greenhouse security-code email received after
 *  `sinceMs` that no tab was given before, or "". Two applications to the same
 *  company minutes apart (three run at once) each get their own email's code:
 *  a code is handed out once (a second ask from the same tab means the first
 *  was wrong), and an email naming the tab's company comes first (Smartsheet,
 *  2026-11-09: one form took the other's code twice). */
async function greenhouseCode(sinceMs, retried = false, { tabId = null, company = "" } = {}) {
  const token = await gmailToken(false);
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const q = encodeURIComponent('from:greenhouse newer_than:1d (security code OR verification code)');
  const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=5`, auth).then((r) => r.json());
  // An expired or revoked sign-in is an answer, not "no email yet" for three minutes.
  if (list.error) {
    // A stale sign-in: drop it and get a fresh one without asking, once.
    if (list.error.code === 401 && !retried) { await chrome.storage.local.set({ jwGmail: { ...(await gmailState()), token: "", exp: 0 } }); return greenhouseCode(sinceMs, true, { tabId, company }); }
    throw new Error(`Gmail: ${list.error.message || list.error.code} (reconnect Gmail in the JobWatch popup)`);
  }
  const { jwGhCodes = {} } = await chrome.storage.local.get("jwGhCodes");
  const day = Date.now() - 864e5;
  for (const k of Object.keys(jwGhCodes)) if (jwGhCodes[k].at < day) delete jwGhCodes[k];
  const co = String(company || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const found = [];
  for (const m of list.messages || []) {
    const msg = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, auth).then((r) => r.json());
    if (Number(msg.internalDate) < sinceMs - 120000) continue;
    const text = `${msg.snippet || ""} ${mailText(msg.payload)}`;
    // "…into the security code field on your application: 92997866" (Stitch Fix:
    // digits only), "Your security code is: aB3dE9fG", "…code below: …".
    const hit = text.match(/(?:security|verification) code\b[^:.\n]{0,60}:\s*([A-Za-z0-9]{6,10})\b/i)
      || text.match(/(?:security|verification) code(?: field)?[^A-Za-z0-9]{0,80}?(?:application|below|is)?[:\s]+([A-Za-z0-9]{6,10})\b/i)
      || text.match(/\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])([A-Za-z0-9]{8})\b/);
    if (!hit || jwGhCodes[hit[1]]) continue; // handed out before: another form's, or this one's wrong one
    const subject = (msg.payload?.headers || []).find((h) => /^subject$/i.test(h.name))?.value || "";
    const names = co && ` ${`${subject} ${text}`.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `.includes(` ${co} `);
    found.push({ code: hit[1], at: Number(msg.internalDate), names });
  }
  // Newest first, the company's own email before any other.
  const pick = found.find((f) => f.names) || found[0];
  if (!pick) return "";
  jwGhCodes[pick.code] = { tabId, at: Date.now() };
  await chrome.storage.local.set({ jwGhCodes });
  return pick.code;
}

// ─── Workday accounts ────────────────────────────────────────────────────────
// One email and one password for every company's Workday account
// (chrome.storage.local jwWorkday, this computer only, set in the popup; the
// email falls back to the Profile's). An account that refuses the password is
// reset to it through "Forgot your password?" and the email's link.
// jwWorkday.tenants remembers the companies that already have an account, so
// those sign in instead of trying to make one.
async function workdayState() { const { jwWorkday } = await chrome.storage.local.get("jwWorkday"); return jwWorkday || {}; }
const workdayTenantOf = (url) => {
  try {
    const u = new URL(url);
    const m = u.hostname.match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/i);
    if (m) return m[1].toLowerCase();
    const p = u.pathname.split("/").filter(Boolean);
    return /myworkdaysite\.com$/i.test(u.hostname) && p[0] === "recruiting" ? String(p[1] || "").toLowerCase() : "";
  } catch { return ""; }
};
/** Workday's own Sign In page that returns to the application once signed in
 *  (2026-11-10): <origin>/[locale/]<site>/login?redirect=<apply path>. It opens
 *  on Sign In (not Create Account), and lands on the saved application where
 *  the Apply Manually link says "Something went wrong". */
function workdayLoginUrl(applyUrl) {
  try {
    const u = new URL(applyUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    const at = parts.findIndex((x) => x === "job" || x === "details");
    if (at < 1) return applyUrl;
    return `${u.origin}/${parts.slice(0, at).join("/")}/login?redirect=${encodeURIComponent(u.pathname)}`;
  } catch { return applyUrl; }
}
/** The newest Workday "verify your account" (kind "verify") or "reset your
 *  password" (kind "reset") link for this tenant received after `sinceMs`, or
 *  "". Each link is handed out once. */
async function workdayVerifyLink(sinceMs, tenant, kind = "verify", retried = false) {
  const token = await gmailToken(false);
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const q = encodeURIComponent(kind === "reset"
    ? "newer_than:1d (password OR reset) (workday OR myworkday OR myworkdayjobs)"
    : "newer_than:1d (verify OR verification OR activate OR confirm) (workday OR myworkday OR myworkdayjobs)");
  const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=8`, auth).then((r) => r.json());
  if (list.error) {
    if (list.error.code === 401 && !retried) { await chrome.storage.local.set({ jwGmail: { ...(await gmailState()), token: "", exp: 0 } }); return workdayVerifyLink(sinceMs, tenant, kind, true); }
    throw new Error(`Gmail: ${list.error.message || list.error.code} (reconnect Gmail in the JobWatch popup)`);
  }
  const { jwWdLinks = {} } = await chrome.storage.local.get("jwWdLinks");
  const day = Date.now() - 864e5;
  for (const k of Object.keys(jwWdLinks)) if (jwWdLinks[k] < day) delete jwWdLinks[k];
  for (const m of list.messages || []) {
    const msg = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, auth).then((r) => r.json());
    if (Number(msg.internalDate) < sinceMs - 120000) continue;
    let raw = "";
    const walk = (p) => { if (!p) return; if (p.body?.data && /text\/(plain|html)/.test(p.mimeType || "")) raw += " " + b64urlText(p.body.data); (p.parts || []).forEach(walk); };
    walk(msg.payload);
    const subject = (msg.payload?.headers || []).find((h) => /^subject$/i.test(h.name))?.value || "";
    const aboutReset = /password|reset/i.test(subject);
    if ((kind === "reset") !== aboutReset) continue; // a verify email is not a reset email
    const links = [...raw.matchAll(/https:\/\/[^\s"'<>]+/g)].map((x) => x[0].replace(/&amp;/g, "&").replace(/[).,]+$/, ""))
      .filter((u) => /myworkdayjobs\.com|myworkdaysite\.com|myworkday\.com/i.test(u) && /activat|verif|confirm|token|reset|password/i.test(u));
    // This company's link only, by its exact Workday name: "workday" is in every
    // Workday link, and the Workday job's reset opened NVIDIA's (2026-11-10).
    const link = tenant ? links.find((u) => workdayTenantOf(u) === tenant) || "" : "";
    if (!link || jwWdLinks[link]) continue;
    jwWdLinks[link] = Date.now();
    await chrome.storage.local.set({ jwWdLinks });
    return link;
  }
  return "";
}

// ─── Replies from companies (Gmail) ──────────────────────────────────────────
// Every 30 minutes while Gmail is connected: recent messages that look like
// application mail go to trackApplicationEmails, which matches them to
// submitted applications and records confirmations, rejections, interviews,
// assessments and offers. An interview, assessment or offer is a notification.

async function scanApplicationMail() {
  const g = await gmailState();
  if (!g.clientId || !g.email) return;
  let token;
  try { token = await gmailToken(false); } catch (err) { console.warn("[JobWatch] mail scan: no Gmail token:", err.message); return; }
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  // Every unseen message in the window, page by page: the newest 40 alone missed
  // most confirmations on busy days (about half of 200 a day unmatched,
  // 2026-11-11). The first scan after this change looks back 7 days.
  const { jwMailSeen = [], jwMailBackfilled2 } = await chrome.storage.local.get(["jwMailSeen", "jwMailBackfilled2"]);
  // The 7-day catch-up reads every message again: ones seen before were matched
  // with the older rules (HP by its address); the server skips ones already recorded.
  const seen = new Set(jwMailBackfilled2 ? jwMailSeen : []);
  const q = encodeURIComponent(`newer_than:${jwMailBackfilled2 ? 3 : 7}d -in:sent -category:promotions -category:social (application OR applying OR applied OR interview OR candidacy OR "next steps" OR unfortunately OR assessment OR offer OR position OR role)`);
  const fresh = [];
  let pageToken = "";
  for (let page = 0; page < (jwMailBackfilled2 ? 4 : 15); page++) {
    const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ""}`, auth).then((r) => r.json()).catch(() => ({}));
    for (const m of list.messages || []) if (!seen.has(m.id)) fresh.push(m);
    if (!list.nextPageToken || fresh.length >= (jwMailBackfilled2 ? 300 : 1500)) break;
    pageToken = list.nextPageToken;
  }
  if (!fresh.length) { if (!jwMailBackfilled2) await chrome.storage.local.set({ jwMailBackfilled2: true }); return; }
  let checked = 0, matched = 0;
  // Oldest first, 25 to a call, so a confirmation is matched before a later reply.
  for (const chunk of [...fresh].reverse().reduce((a, m, i) => { if (i % 25 === 0) a.push([]); a[a.length - 1].push(m); return a; }, [])) {
    const emails = [];
    for (const m of chunk) {
      const msg = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, auth).then((r) => r.json()).catch(() => null);
      if (!msg?.id) continue;
      const h = (n) => (msg.payload?.headers || []).find((x) => x.name.toLowerCase() === n)?.value || "";
      emails.push({ id: msg.id, from: h("from"), subject: h("subject"), snippet: msg.snippet || "", date: Number(msg.internalDate) || Date.now() });
    }
    let out;
    try { out = await callFunction("trackApplicationEmails", { emails }); } catch (err) { console.warn("[JobWatch] mail scan failed:", err.message); return; }
    const { jwMailSeen: seenNow = [] } = await chrome.storage.local.get("jwMailSeen");
    await chrome.storage.local.set({ jwMailSeen: [...seenNow, ...chunk.map((m) => m.id)].slice(-4000) });
    const { jwMailEvents = [] } = await chrome.storage.local.get("jwMailEvents");
    const events = [...jwMailEvents, ...(out.updates || []).map((u) => ({ ...u, at: Date.now() }))].filter((e) => Date.now() - e.at < 14 * 864e5).slice(-300);
    await chrome.storage.local.set({ jwMailEvents: events });
    for (const u of out.updates || []) {
      const what = { interview: "wants to interview you", assessment: "sent an assessment", offer: "sent an offer" }[u.kind];
      if (what) notify(`${u.companyName} ${what}`, `${u.jobTitle || "Your application"}. Check your email.`);
    }
    checked += emails.length; matched += (out.updates || []).length;
  }
  if (!jwMailBackfilled2) await chrome.storage.local.set({ jwMailBackfilled2: true });
  console.log("[JobWatch] mail scan:", checked, "checked,", matched, "matched");
}

// ─── Daily summary (8 PM) ─────────────────────────────────────────────────────
/** Stop notes grouped into a few plain reasons, most common first. */
function stopReasons(rows) {
  const KINDS = [
    [/captcha/i, "CAPTCHA"], [/no tailored resume/i, "tailored resume not made"], [/spam check|flagged as spam/i, "spam check"], [/resume would not attach|no resume/i, "resume upload"],
    [/security code/i, "security code"], [/salary|compensation|pay expectation/i, "salary number"], [/closed|no longer|not found|404/i, "posting closed"],
    [/timed out|the tab was closed/i, "timed out"],
    [/ flagged: /i, "fields the form marked after Submit"], [/no message shown|no confirmation/i, "no answer after Submit"],
    [/did not accept/i, "refused at Submit"], [/Submit button/i, "no Submit button"], [/needs you:|still empty|could not/i, "a question only you can answer"],
  ];
  const count = new Map();
  for (const r of rows) {
    const kind = (KINDS.find(([re]) => re.test(r.note || "")) || [null, "other"])[1];
    count.set(kind, (count.get(kind) || 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${n} × ${k}`).join(", ");
}
function next8pm() {
  const d = new Date();
  d.setHours(20, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}
async function dailySummary() {
  const st = await autoState();
  const day = Date.now() - 864e5;
  const recent = Object.values(st.results || {}).filter((r) => r.at >= day);
  const n = (s) => recent.filter((r) => r.status === s).length;
  const { jwMailEvents = [] } = await chrome.storage.local.get("jwMailEvents");
  const mail = jwMailEvents.filter((e) => e.at >= day);
  const m = (k) => mail.filter((e) => e.kind === k).length;
  const parts = [
    `${n("submitted")} submitted`, n("needs_attention") && `${n("needs_attention")} need you`, n("error") && `${n("error")} failed`,
    m("interview") && `${m("interview")} interview${m("interview") === 1 ? "" : "s"}`, m("assessment") && `${m("assessment")} assessment${m("assessment") === 1 ? "" : "s"}`,
    m("offer") && `${m("offer")} offer${m("offer") === 1 ? "" : "s"}`, m("rejection") && `${m("rejection")} rejection${m("rejection") === 1 ? "" : "s"}`,
  ].filter(Boolean);
  if (!recent.length && !mail.length) return;
  // Why the rest stopped, most common first ("3 × salary number, 2 × CAPTCHA").
  const reasons = stopReasons(recent.filter((r) => ["needs_attention", "error"].includes(r.status)));
  notify("JobWatch today", `${parts.join(", ")}.${reasons ? ` Stopped by: ${reasons}.` : ""}`);
  await chrome.storage.local.set({ jwDailyReport: { at: Date.now(), parts, reasons } });
}

chrome.alarms.get("jwMailScan", (a) => { if (!a) chrome.alarms.create("jwMailScan", { delayInMinutes: 2, periodInMinutes: 30 }); });
chrome.alarms.get("jwDaily", (a) => { if (!a) chrome.alarms.create("jwDaily", { when: next8pm(), periodInMinutes: 24 * 60 }); });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "jwMailScan") scanApplicationMail().catch((e) => console.warn("[JobWatch] mail scan:", e.message));
  if (a.name === "jwDaily") dailySummary().catch(() => {});
});

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      // ── Unattended auto-apply ───────────────────────────────────────────
      if (message.type === "AUTO_JOB") {
        const job = await autoJobForTab(sender?.tab?.id);
        // Not awaited: the page learns its job at once; emulation follows.
        if (job?.source === "workday" && sender?.frameId === 0) {
          focusEmulate(sender.tab.id).catch(() => {});
          // Each page of a Workday job that started and asked (USC went silent
          // after signing in on "Password has been reset": did a page start?).
          getFreshToken().then(({ idToken, uid }) => fsAdd(`users/${uid}`, "workdayTraces", { kind: "init", tenant: workdayTenantOf(sender.tab.url || ""), jobId: job.jobId, companyName: job.companyName || "", title: job.title || "", test: !!job.test,
            url: String(sender.tab.url || "").slice(0, 500), at: new Date().toISOString(), version: chrome.runtime.getManifest().version, json: JSON.stringify({ url: sender.tab.url, title: sender.tab.title }) }, idToken)).catch(() => {});
        }
        sendResponse({ ok: true, job });
        return;
      }
      // ── Workday account: the password only goes to an auto-apply tab on Workday.
      if (message.type === "WORKDAY_STATUS") {
        const w = await workdayState();
        const { jwCachedUserDoc } = await chrome.storage.local.get("jwCachedUserDoc");
        if (!w.email && !jwCachedUserDoc?.email) {
          try { const { idToken, uid } = await getFreshToken(); const e = String((await fsGet(`users/${uid}`, idToken))?.email || "").trim(); if (e) { w.email = e; await chrome.storage.local.set({ jwWorkday: { ...w } }); } } catch (_) { /* popup shows it empty */ }
        }
        sendResponse({ ok: true, set: !!w.password, email: w.email || "", profileEmail: jwCachedUserDoc?.email || "", gmailEmail: (await gmailState()).email || "", accounts: Object.keys(w.tenants || {}).length });
        return;
      }
      if (message.type === "WORKDAY_SET") {
        const password = String(message.password || "");
        const email = String(message.email ?? "").trim().toLowerCase();
        if (email && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) { sendResponse({ ok: false, error: "That email does not look right." }); return; }
        // 12 at least: Citi asks for 12 (2026-11-10); one password serves every company.
        // 16 at least: Comcast asks for 16, Citi for 12 (2026-11-10); one password serves every company.
        if (password && (password.length < 16 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password))) {
          sendResponse({ ok: false, error: "Use at least 16 characters (Comcast asks for 16) with an upper-case letter, a lower-case letter, a number and a symbol." });
          return;
        }
        const w = await workdayState();
        await chrome.storage.local.set({ jwWorkday: { ...w, ...(password ? { password } : {}), ...(email ? { email } : {}) } });
        if (password) { autoQueue = { at: 0, list: [], answersUpdatedAt: 0 }; autoTick(); }
        sendResponse({ ok: true });
        return;
      }
      if (message.type === "WORKDAY_CREDS") {
        const job = await autoJobForTab(sender?.tab?.id);
        const tenant = workdayTenantOf(sender?.tab?.url || "");
        if (!job || job.source !== "workday" || !tenant) { sendResponse({ ok: false, error: "not an auto-apply Workday tab" }); return; }
        const w = await workdayState();
        const { jwCachedUserDoc } = await chrome.storage.local.get("jwCachedUserDoc");
        let email = String(w.email || jwCachedUserDoc?.email || "").trim();
        if (!email) {
          // The cached profile can lack the email (2026-11-10): read it from the account, and keep it.
          try {
            const { idToken, uid } = await getFreshToken();
            email = String((await fsGet(`users/${uid}`, idToken))?.email || "").trim();
            if (email) await chrome.storage.local.set({ jwWorkday: { ...w, email } });
          } catch (_) { /* reported below */ }
        }
        if (!w.password || !email) { sendResponse({ ok: false, error: !w.password ? "no Workday password saved in the JobWatch popup" : "no Workday email saved in the JobWatch popup" }); return; }
        sendResponse({ ok: true, email, password: w.password, hasAccount: !!w.tenants?.[tenant] });
        return;
      }
      if (message.type === "WORKDAY_ACCOUNT") {
        const tenant = workdayTenantOf(sender?.tab?.url || "");
        if (tenant) {
          const w = await workdayState();
          await chrome.storage.local.set({ jwWorkday: { ...w, tenants: { ...(w.tenants || {}), [tenant]: Date.now() } } });
        }
        sendResponse({ ok: true });
        return;
      }
      // A Workday trace (account step, form step, result) into users/{uid}/workdayTraces.
      if (message.type === "WORKDAY_TRACE") {
        try {
          const { idToken, uid } = await getFreshToken();
          const job = await autoJobForTab(sender?.tab?.id);
          const tenant = workdayTenantOf(sender?.tab?.url || "") || workdayTenantOf(job?.applyUrl || "");
          await fsAdd(`users/${uid}`, "workdayTraces", {
            kind: String(message.kind || ""), tenant, jobId: job?.jobId || "", companyName: job?.companyName || "", title: job?.title || "",
            test: !!job?.test, url: String(sender?.tab?.url || "").slice(0, 500), at: new Date().toISOString(), version: chrome.runtime.getManifest().version,
            json: JSON.stringify(message.data || {}).slice(0, 900000),
          }, idToken);
          sendResponse({ ok: true });
        } catch (err) { sendResponse({ ok: false, error: err.message }); }
        return;
      }
      if (message.type === "WORKDAY_VERIFY_LINK") {
        try {
          const link = await workdayVerifyLink(Number(message.since) || Date.now() - 600000, workdayTenantOf(sender?.tab?.url || ""), message.kind === "reset" ? "reset" : "verify");
          if (link && message.open) {
            // Open it beside the application (the link may live on another Workday
            // host), give it time to verify, then close it; the application tab signs in.
            const t = await chrome.tabs.create({ url: link, active: false, ...(sender?.tab?.windowId != null ? { windowId: sender.tab.windowId } : {}) }).catch(() => null);
            await new Promise((r) => setTimeout(r, 12000));
            if (t?.id != null) chrome.tabs.remove(t.id).catch(() => {});
          }
          sendResponse({ ok: true, link });
        } catch (err) { sendResponse({ ok: false, error: err.message }); }
        return;
      }
      // Focus emulation again before a step is filled or saved (it is lost when
      // the "debugging" bar is cancelled or closed; CoStar's Self Identify date).
      if (message.type === "WORKDAY_FOCUS") {
        const job = await autoJobForTab(sender?.tab?.id);
        sendResponse({ ok: job?.source === "workday" ? await focusEmulate(sender.tab.id) : false });
        return;
      }
      if (message.type === "AUTO_SUBMITTING") {
        const st = await autoState();
        await withAutoLock(async () => {
          const st = await autoState();
          const job = st.running.find((j) => j.tabId === sender?.tab?.id);
          if (job) { job.submittingAt = Date.now(); await saveAuto(st); }
        });
        sendResponse({ ok: true });
        return;
      }
      if (message.type === "AUTO_RESULT") {
        const job = await autoJobForTab(sender?.tab?.id);
        // "Already applied" is the ledger saying this form WAS submitted
        // (often a retry of a job whose submit went unrecorded): count it so.
        const already = message.status === "skipped" && /already applied/i.test(message.note || "");
        if (job) await autoFinish({ status: already ? "submitted" : message.status, note: already ? "already applied" : message.note }, sender?.tab?.id);
        sendResponse({ ok: true });
        return;
      }
      if (message.type === "AUTO_START") {
        const st = await autoState();
        st.on = true; st.idle = false; st.nextAt = 0; st.startedAt = st.startedAt || Date.now();
        await saveAuto(st);
        keepAwake(true);
        autoQueue = { at: 0, list: [], answersUpdatedAt: 0 };
        autoTick();
        sendResponse({ ok: true });
        return;
      }
      if (message.type === "AUTO_RETRY") {
        // Jobs that needed the person or failed go back in the queue (after a fix).
        const st = await autoState();
        let n = 0;
        for (const [id, r] of Object.entries(st.results || {})) if (r.status === "needs_attention" || r.status === "error") {
          // Its old tab would sit in manual mode; the job reopens fresh instead.
          if (r.tabId) chrome.tabs.remove(r.tabId).catch(() => {});
          delete st.results[id]; n++;
        }
        st.idle = false; st.nextAt = 0;
        await saveAuto(st);
        autoQueue = { at: 0, list: [], answersUpdatedAt: 0 };
        if (st.on) autoTick();
        sendResponse({ ok: true, retried: n });
        return;
      }
      if (message.type === "AUTO_CLEAR") {
        // Wipe the popup's counts and recent list; auto-apply carries on.
        // Submitted jobs stay skipped (the server keeps them in applications).
        const st = await autoState();
        await withAutoLock(async () => { const cur = await autoState(); await saveAuto({ on: true, running: cur.running, results: {}, startedAt: Date.now() }); });
        autoQueue = { at: 0, list: [], answersUpdatedAt: 0 };
        try { chrome.notifications.clear("jwNeeds"); } catch (_) { /* none */ }
        autoTick();
        sendResponse({ ok: true, cleared: Object.keys(st.results || {}).length });
        return;
      }
      if (message.type === "JW_WAIT") {
        // A pause for a hidden tab (content/wake.js): the worker's timers are not throttled.
        await new Promise((r) => setTimeout(r, Math.min(Math.max(Number(message.ms) || 0, 0), 60000)));
        sendResponse({ ok: true });
        return;
      }
      if (message.type === "LEARN_ANSWERS") {
        // The answer bank (functions/lib/apply/savedAnswers.cjs).
        try { sendResponse({ ok: true, result: await callFunction("learnAnswers", { saved: message.saved || [], missing: message.missing || [] }) }); }
        catch (err) { sendResponse({ ok: false, error: err.message }); }
        return;
      }
      if (message.type === "AUTO_STATUS") {
        sendResponse({ ok: true, status: await autoStatus() });
        return;
      }
      if (message.type === "GMAIL_STATUS") {
        const g = await gmailState();
        // The address Greenhouse emails the code to is the one on the form: the profile's.
        const { jwCachedUserDoc } = await chrome.storage.local.get("jwCachedUserDoc");
        sendResponse({ ok: true, clientId: g.clientId || "", email: g.email || "", profileEmail: jwCachedUserDoc?.email || "", connected: !!(g.clientId && g.email), redirectUrl: chrome.identity.getRedirectURL("gmail") });
        return;
      }
      if (message.type === "GMAIL_CONNECT") {
        try {
          const g = await gmailState();
          const clientId = String(message.clientId || g.clientId || "").trim();
          if (!/\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error("Paste the OAuth client ID (it ends in .apps.googleusercontent.com).");
          await chrome.storage.local.set({ jwGmail: { clientId } });
          await gmailToken(true);
          sendResponse({ ok: true, email: (await gmailState()).email });
        } catch (err) { sendResponse({ ok: false, error: err.message }); }
        return;
      }
      if (message.type === "GET_GH_CODE") {
        // Poll Gmail for up to three minutes for the code Greenhouse just sent.
        try {
          const t0 = Date.now();
          let code = "";
          while (!code && Date.now() - t0 < 3 * 60 * 1000) {
            code = await greenhouseCode(Number(message.since) || t0, false, { tabId: sender?.tab?.id ?? null, company: (await autoJobForTab(sender?.tab?.id))?.companyName || message.company || "" });
            if (!code) await new Promise((r) => setTimeout(r, 10000));
          }
          sendResponse(code ? { ok: true, code } : { ok: false, error: "no security code email arrived in 3 minutes" });
        } catch (err) { sendResponse({ ok: false, error: err.message }); }
        return;
      }

      // ── 1. JobWatch bridge triggers auto apply ──────────────────────────
      if (message.type === "AUTO_APPLY") {
        const job = message.job;
        await chrome.storage.session.set({ pendingJob: job });
        let applyUrl = (job.absolute_url || "").replace(/\/$/, "");
        if (/jobs\.(eu\.)?lever\.co\//i.test(applyUrl)) { if (!/\/apply$/.test(applyUrl)) applyUrl += "/apply"; }
        else if (/greenhouse\.io\//i.test(applyUrl)) { /* the posting page carries the form */ }
        else if (/myworkdayjobs\.com\/|myworkdaysite\.com\//i.test(applyUrl)) { if (!/\/apply(\/|$)/.test(applyUrl)) applyUrl += "/apply"; }
        else if (/jobs\.ashbyhq\.com\//i.test(applyUrl) && !applyUrl.includes("/application")) applyUrl += "/application";
        // Every other board: the posting page itself; content/universal.js fills the form when it appears.
        console.log("[JobWatch] AUTO_APPLY → opening:", applyUrl, "| absolute_url was:", job.absolute_url);
        await chrome.tabs.create({ url: applyUrl });
        sendResponse({ ok: true });
        return;
      }

      // ── 2. Ashby content script asks for fill data ──────────────────────
      if (message.type === "GET_FILL_DATA") {
        let { pendingJob } = await new Promise((r) =>
          chrome.storage.session.get("pendingJob", r)
        );

        // The job actually being filled is defined by the TAB URL, never by
        // whatever happens to sit in session storage.
        // Ashby URL pattern: /jobs.ashbyhq.com/{org}/{uuid}/application
        const tabUrl = sender?.tab?.url || "";
        const tabMatch = tabUrl.match(
          /jobs\.ashbyhq\.com\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i
        );
        const tabOrg = tabMatch ? tabMatch[1] : null;
        const tabExternalId = tabMatch ? tabMatch[2] : null;

        // Discard a pendingJob left over from a PREVIOUS application.
        if (tabExternalId && pendingJob && !jobMatchesExternalId(pendingJob, tabExternalId)) {
          console.warn("[JobWatch] pendingJob is for a different job — discarding:",
            pendingJob.companyName, "|", pendingJob.title);
          pendingJob = null;
          chrome.storage.session.remove("pendingJob");
        }

        // ── Fallback: service worker may have restarted, clearing session ──
        // Query Firestore by the tab's job UUID.
        if (tabExternalId && !pendingJob?.locationName) {
          try {
            const { idToken: tok, uid: u } = await getFreshToken();
            const jobs = await fsQuery(
              `users/${u}`,
              "jobs",
              [{ fieldFilter: { field: { fieldPath: "externalId" }, op: "EQUAL", value: { stringValue: tabExternalId } } }],
              tok,
              1
            );
            if (jobs.length) {
              // Firestore is authoritative — it must win over session leftovers.
              pendingJob = { ...(pendingJob || {}), ...jobs[0] };
              console.log("[JobWatch] Recovered pendingJob from Firestore:", pendingJob.locationName);
            }
          } catch (lookupErr) {
            console.warn("[JobWatch] Job lookup from URL failed:", lookupErr.message);
          }
        }

        // ── Last resort: job never entered Firestore (opened from an external
        // link). Pull title/company/location straight from Ashby so the AI
        // never writes about the wrong company — or no company at all.
        if (tabOrg && tabExternalId && !pendingJob?.companyName) {
          try {
            const info = await fetchAshbyPostingInfo(tabOrg, tabExternalId);
            if (info.companyName || info.title) {
              pendingJob = { ...(pendingJob || {}), ...info };
              console.log("[JobWatch] pendingJob from Ashby API:", info.companyName, "|", info.title);
            }
          } catch (e) {
            console.warn("[JobWatch] Ashby posting lookup failed:", e.message);
          }
        }

        let { idToken, uid } = await getFreshToken();

        // Fetch user profile and resume profile.
        // On 401: force-refresh token and retry.
        // On continued failure: fall back to locally cached profile so AI
        // can still fill the form even if Firestore is temporarily unavailable.
        let userDoc, resumeDoc;
        try {
          [userDoc, resumeDoc] = await Promise.all([
            fsGet(`users/${uid}`, idToken),
            fsGet(`users/${uid}/resume/profile`, idToken),
          ]);
          // Cache the profile locally after every successful fetch
          await chrome.storage.local.set({
            jwCachedUserDoc: userDoc,
            jwCachedResumeDoc: resumeDoc,
          });
        } catch (err) {
          if (err.message.includes("401")) {
            console.warn("[JobWatch] 401 on Firestore fetch — force-refreshing token and retrying…");
            try {
              ({ idToken, uid } = await getFreshToken(true));
              [userDoc, resumeDoc] = await Promise.all([
                fsGet(`users/${uid}`, idToken),
                fsGet(`users/${uid}/resume/profile`, idToken),
              ]);
              await chrome.storage.local.set({
                jwCachedUserDoc: userDoc,
                jwCachedResumeDoc: resumeDoc,
              });
            } catch (retryErr) {
              // Auth still broken — fall back to cached profile so AI can still run
              console.warn("[JobWatch] Token refresh failed — using cached profile:", retryErr.message);
              const cached = await new Promise(r =>
                chrome.storage.local.get(["jwCachedUserDoc", "jwCachedResumeDoc"], r)
              );
              if (!cached.jwCachedUserDoc) throw retryErr; // no cache at all, give up
              userDoc = cached.jwCachedUserDoc;
              resumeDoc = cached.jwCachedResumeDoc || {};
            }
          } else {
            throw err;
          }
        }

        // Fetch resume PDF in background (no CORS restrictions here)
        let resumeBase64 = null;
        const resumeUrl = userDoc?.resumeUrl;
        if (resumeUrl) {
          try {
            const r = await fetch(resumeUrl);
            const buf = await r.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let bin = "";
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            resumeBase64 = btoa(bin);
          } catch (e) {
            console.warn("[JobWatch] Could not fetch resume PDF:", e.message);
          }
        }

        const formFields = message.fields || [];
        const jobTitle = pendingJob?.title || "";
        const companyName = pendingJob?.companyName || "";
        const jobLocationName = pendingJob?.locationName || "";
        const jobWorkplaceType = pendingJob?.workplaceType || "";
        const errorContext = message.errorContext || null; // validation errors from previous submit attempt

        // If auth is broken, AI may also fail — return empty mappings so at
        // least the profile fields (name, email) can still be filled from cache.
        let mappings = {};
        try {
          mappings = await callMapFormFields(formFields, jobTitle, companyName, jobLocationName, jobWorkplaceType, idToken, errorContext);
        } catch (aiErr) {
          console.warn("[JobWatch] mapFormFields failed (will fill from profile only):", aiErr.message);
        }

        sendResponse({
          ok: true,
          userDoc,
          resumeDoc,
          mappings,
          pendingJob,
          resumeBase64,
        });
        return;
      }

      // ── Ashby: the computed application (answer engine + AI + cover PDF) ──
      // Replaces GET_FILL_DATA for Ashby; that path stays as the fallback.
      if (message.type === "GET_ASHBY_FILL_DATA") {
        try {
          const tailoredP = startTailored(sender, { source: "ashby", externalId: message.id });
          const { idToken } = await getFreshToken();
          const { pendingJob } = await new Promise((r) => chrome.storage.session.get("pendingJob", r));
          const job = pendingJob && jobMatchesExternalId(pendingJob, message.id) ? pendingJob : null;
          const res = await fetch(`${FUNCTIONS_BASE}/prepareAshbyApplication`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({ data: {
              org: message.org, id: message.id, domFields: message.domFields || [],
              jobTitle: job?.title || "", companyName: job?.companyName || "", jobLocationName: job?.locationName || "",
            } }),
          });
          const json = await res.json();
          if (!res.ok || json.error) throw new Error(json.error?.message || `prepareAshbyApplication ${res.status}`);
          sendResponse({ ok: true, data: await withTailoredResume(json.result, tailoredP), pendingJob: job });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        return;
      }

      // ── Lever: the computed application from the scraped form ────────────
      if (message.type === "GET_LEVER_FILL_DATA") {
        try {
          const { idToken } = await getFreshToken();
          const { pendingJob } = await new Promise((r) => chrome.storage.session.get("pendingJob", r));
          const job = pendingJob && jobMatchesExternalId(pendingJob, message.id) ? pendingJob : null;
          const tailoredP = startTailored(sender, { source: "lever", externalId: message.id });
          const res = await fetch(`${FUNCTIONS_BASE}/prepareLeverApplication`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({ data: {
              site: message.site, id: message.id, eu: !!message.eu, domFields: message.domFields || [],
              jobTitle: message.jobTitle || job?.title || "", companyName: message.companyName || job?.companyName || "", jobLocationName: message.locationName || job?.locationName || "",
            } }),
          });
          const json = await res.json();
          if (!res.ok || json.error) throw new Error(json.error?.message || `prepareLeverApplication ${res.status}`);
          sendResponse({ ok: true, data: await withTailoredResume(json.result, tailoredP), pendingJob: job });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        return;
      }

      // ── Lever: run a lib/lever-dom.js helper in the page's MAIN world ─────
      if (message.type === "EXEC_LEVER") {
        const target = { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] };
        chrome.scripting.executeScript({ target, world: "MAIN", files: ["lib/wait-main.js", "lib/lever-dom.js"] })
          .then(() => chrome.scripting.executeScript({
            target, world: "MAIN",
            func: (action, args) => window.__jwLever[action](...(args || [])),
            args: [message.action, message.args || []],
          }))
          .then((results) => sendResponse({ ok: true, result: results?.[0]?.result }))
          .catch((err) => sendResponse({ ok: false, error: err.message }));
        return true;
      }

      // ── Any other board: the computed application from the scanned form ──
      if (message.type === "GET_GENERIC_FILL_DATA") {
        try {
          const { idToken } = await getFreshToken();
          const { pendingJob } = await new Promise((r) => chrome.storage.session.get("pendingJob", r));
          const job = pendingJob && message.externalId && jobMatchesExternalId(pendingJob, message.externalId) ? pendingJob : null;
          // An auto-apply tab (Workday) sends the job's tailored resume, like the other boards.
          const autoJob = await autoJobForTab(sender?.tab?.id);
          const tailoredP = autoJob ? tailoredResumeFor({ jobId: autoJob.jobId }) : null;
          const res = await fetch(`${FUNCTIONS_BASE}/prepareGenericApplication`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({ data: {
              source: message.source || "web", applyUrl: message.applyUrl || sender?.tab?.url || "", formKey: message.formKey || "",
              externalId: message.externalId || "", domFields: message.domFields || [],
              jobTitle: job?.title || autoJob?.title || message.jobTitle || "", companyName: job?.companyName || autoJob?.companyName || message.companyName || "",
              jobLocationName: job?.locationName || autoJob?.locationName || message.locationName || "", descriptionText: message.descriptionText || "",
            } }),
          });
          const json = await res.json();
          if (!res.ok || json.error) throw new Error(json.error?.message || `prepareGenericApplication ${res.status}`);
          sendResponse({ ok: true, data: tailoredP ? await withTailoredResume(json.result, tailoredP) : json.result, pendingJob: job });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        return;
      }

      // ── AI rescue of a stuck field: the page side, then Claude's plan ─────
      if (message.type === "EXEC_RESCUE") {
        const target = { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] };
        chrome.scripting.executeScript({ target, world: "MAIN", files: ["lib/wait-main.js", "lib/rescue-dom.js"] })
          .then(() => chrome.scripting.executeScript({
            target, world: "MAIN",
            func: (action, args) => window.__jwRescueDom[action](...(args || [])),
            args: [message.action, message.args || []],
          }))
          .then((results) => sendResponse({ ok: true, result: results?.[0]?.result }))
          .catch((err) => sendResponse({ ok: false, error: err.message }));
        return true;
      }
      if (message.type === "RESCUE_FIELD") {
        try {
          const job = await autoJobForTab(sender?.tab?.id);
          const plan = await callFunction("rescueField", {
            question: message.question, html: message.html, required: !!message.required, round: message.round || 1, history: message.history || [],
            jobTitle: message.jobTitle || job?.title || "", companyName: message.companyName || job?.companyName || "",
          });
          sendResponse({ ok: true, plan });
        } catch (err) { sendResponse({ ok: false, error: err.message }); }
        return;
      }

      // ── The whole filled form, checked before Submit (content/rescue.js) ──
      if (message.type === "REVIEW_FORM") {
        try {
          const job = await autoJobForTab(sender?.tab?.id);
          const r = await callFunction("reviewApplication", {
            items: message.items || [], jobTitle: message.jobTitle || job?.title || "", companyName: message.companyName || job?.companyName || "",
          });
          sendResponse({ ok: true, issues: r?.issues || [] });
        } catch (err) { sendResponse({ ok: false, error: err.message }); }
        return;
      }

      // ── Any other board: run a lib/generic-dom.js helper in the MAIN world ─
      if (message.type === "EXEC_GENERIC") {
        const target = { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] };
        // Bounded (see universal.js gen): a call into a page that is switching views may never return.
        within(chrome.scripting.executeScript({ target, world: "MAIN", files: ["lib/wait-main.js", "lib/generic-dom.js"] }), 15000)
          .then(() => chrome.scripting.executeScript({
            target, world: "MAIN",
            func: (action, args) => window.__jwGeneric[action](...(args || [])),
            args: [message.action, message.args || []],
          }))
          .then((results) => sendResponse({ ok: true, result: results?.[0]?.result }))
          .catch((err) => sendResponse({ ok: false, error: err.message }));
        return true;
      }

      // ── Popup: fill the form in the active tab, whatever the site ────────
      if (message.type === "FILL_THIS_PAGE") {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.id || !/^https?:/i.test(tab.url || "")) throw new Error("Open a job application page first.");
          const target = { tabId: tab.id, allFrames: true };
          await chrome.scripting.executeScript({ target, func: () => { window.__jwManualStart = true; } });
          await chrome.scripting.executeScript({ target, files: ["content/wake.js", "content/highlight.js", "content/notify.js", "lib/rescue-dom.js", "content/rescue.js", "content/universal.js"] });
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        return;
      }

      // ── Ashby: run a lib/ashby-dom.js helper in the page's MAIN world ─────
      if (message.type === "EXEC_ASHBY") {
        const target = { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] };
        chrome.scripting.executeScript({ target, world: "MAIN", files: ["lib/wait-main.js", "lib/ashby-dom.js"] })
          .then(() => chrome.scripting.executeScript({
            target, world: "MAIN",
            func: (action, args) => window.__jwAshby[action](...(args || [])),
            args: [message.action, message.args || []],
          }))
          .then((results) => sendResponse({ ok: true, result: results?.[0]?.result }))
          .catch((err) => sendResponse({ ok: false, error: err.message }));
        return true;
      }

      // ── Ashby: fetch the authoritative form schema via public GraphQL ────
      // The application page's __appData no longer embeds fieldEntries (form
      // audit 2026-08-26), so the schema must come from this endpoint.
      if (message.type === "GET_ASHBY_SCHEMA") {
        const { org, id } = message;
        const QUERY = "query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) { applicationForm { sections { fieldEntries { field isRequired } } } } }";
        const res = await fetch("https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operationName: "ApiJobPosting",
            variables: { organizationHostedJobsPageName: org, jobPostingId: id },
            query: QUERY,
          }),
        });
        const json = await res.json();
        const sections = json.data?.jobPosting?.applicationForm?.sections || [];
        const entries = [];
        for (const s of sections) {
          for (const e of s.fieldEntries || []) {
            const f = e.field || {};
            entries.push({
              path: f.path || "",
              type: f.type || "String",
              title: f.title || "",
              required: !!e.isRequired,
              options: (f.selectableValues || []).map(o => ({ label: o.label || o.value || "", id: o.value ?? o.label ?? "" })),
            });
          }
        }
        sendResponse({ ok: true, entries });
        return;
      }

      // ── Greenhouse: compute the full application for the content script ──
      if (message.type === "GET_GH_FILL_DATA") {
        try {
          const tailoredP = startTailored(sender, { source: "greenhouse", externalId: message.id });
          const { idToken } = await getFreshToken();
          const data = await callPrepareGreenhouse(message.token, message.id, idToken);
          sendResponse({ ok: true, data: await withTailoredResume(data, tailoredP) });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        return;
      }

      // ── 3. Execute script in MAIN world (bypasses CSP) ─────────────────
      if (message.type === "EXEC_MAIN_WORLD") {
        const { action, id, value, b64Data, fileName, match, which } = message;

        const setReactValue = async (fieldId, val) => {
          const entry = document.querySelector(`[data-field-path="${CSS.escape(fieldId)}"]`);
          let node = entry?.querySelector("input:not([type=file]):not([type=radio]):not([type=checkbox]), textarea");

          // Greenhouse: fieldId is the control's own DOM id (no data-field-path wrappers).
          if (!node) {
            const byId = document.getElementById(fieldId);
            if (byId && (byId.tagName === "INPUT" || byId.tagName === "TEXTAREA")) node = byId;
          }

          if (!node) return { ok: false, actual: "", error: "input not found" };

          const sleep = (ms) => window.__jwMainWait(ms);

          for (let attempt = 1; attempt <= 3; attempt++) {
            node.focus();
            if (node.select) node.select();

            // Method 1: closest to real user typing
            const worked = document.execCommand("insertText", false, val);

            // Fallback: React tracker hack
            if (!worked || node.value !== val) {
              const proto = node.tagName === "TEXTAREA"
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype;

              const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
              const oldValue = node.value;

              if (setter) setter.call(node, val);
              if (node._valueTracker) node._valueTracker.setValue(oldValue);

              node.dispatchEvent(new Event("input", { bubbles: true }));
              node.dispatchEvent(new Event("change", { bubbles: true }));
            }

            node.dispatchEvent(new Event("blur", { bubbles: true }));

            await sleep(300);

            // Masked inputs reformat what was typed ("5109356846" -> "(510) 935-6846").
            const alnum = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
            if (node.value === val || (alnum(val) && alnum(node.value) === alnum(val))) {
              return { ok: true, actual: node.value, attempt };
            }
          }

          return { ok: false, actual: node.value, error: "React reset value" };
        };

        // Type a whole value like a person: one character at a time through
        // React's value tracker, faster for long text so an answer lands in
        // about a second and a half. Works for inputs and textareas found by
        // data-field-path (Ashby) or by DOM id (Greenhouse).
        const typeHuman = async (fieldId, val) => {
          const entry = document.querySelector(`[data-field-path="${CSS.escape(fieldId)}"]`);
          let node = entry?.querySelector("input:not([type=file]):not([type=radio]):not([type=checkbox]), textarea");
          if (!node) {
            const byId = document.getElementById(fieldId);
            if (byId && (byId.tagName === "INPUT" || byId.tagName === "TEXTAREA")) node = byId;
          }
          if (!node) return { ok: false, error: "input not found" };
          const sleep = (ms) => window.__jwMainWait(ms);
          const text = String(val ?? "");
          const proto = node.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          const set = (v) => {
            const old = node.value;
            if (setter) setter.call(node, v); else node.value = v;
            if (node._valueTracker) node._valueTracker.setValue(old);
            node.dispatchEvent(new Event("input", { bubbles: true }));
          };
          node.focus();
          node.click();
          await sleep(120);
          set("");
          const perChar = Math.max(6, Math.min(35, Math.round(1400 / Math.max(1, text.length))));
          let typed = "";
          for (const ch of text) { typed += ch; set(typed); await sleep(perChar); }
          node.dispatchEvent(new Event("change", { bubbles: true }));
          await sleep(120);
          node.dispatchEvent(new Event("blur", { bubbles: true }));
          await sleep(120);
          const alnum = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
          return { ok: node.value === text || (!!alnum(text) && alnum(node.value) === alnum(text)), actual: node.value };
        };

        const typeCharByChar = async (fieldId, val) => {
          const entry = document.querySelector(`[data-field-path="${CSS.escape(fieldId)}"]`);
          const node = entry?.querySelector("input[role='combobox']") || entry?.querySelector("input");
          if (!node) return { ok: false, error: "input not found" };

          node.focus();
          node.click();
          await window.__jwMainWait(200);

          // Select-all + delete
          node.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }));
          node.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
          await window.__jwMainWait(100);

          const typeStr = val.slice(0, 10);
          for (const ch of typeStr) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
            if (setter) {
              const current = node.value || "";
              setter.call(node, current + ch);
            } else {
              node.value += ch;
            }
            node.dispatchEvent(new Event("input", { bubbles: true }));
            node.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
            await window.__jwMainWait(60);
          }
          return { ok: true, typed: typeStr };
        };

        // `which` is "resume" or "cover": the upload a file input must belong to.
        // Greenhouse removes a file input once a file is attached, so a lookup
        // that falls back to "whatever file input is left" would put the resume
        // into the cover letter slot on a retry. Every input is classified by
        // its own section (nearest ancestor that names Resume/CV or Cover
        // Letter) and only a matching one is used.
        const setReactFile = async (fieldId, b64, name, which) => {
          const want = which === "cover" ? "cover" : "resume";
          const isCover = (s) => /cover/i.test(s);
          const isResume = (s) => /resume|\bcv\b|curriculum/i.test(s);
          const sectionOf = (input) => {
            let p = input.parentElement;
            for (let k = 0; k < 6 && p && p.tagName !== "FORM" && p !== document.body; k++, p = p.parentElement) {
              const t = (p.textContent || "").replace(/\s+/g, " ");
              if (isResume(t) || isCover(t)) return t;
            }
            return "";
          };
          const kindOf = (input) => {
            const attrs = `${input.id} ${input.name} ${input.getAttribute("aria-label") || ""} ${input.getAttribute("data-qa") || ""}`;
            if (isCover(attrs)) return "cover";
            if (isResume(attrs)) return "resume";
            const sec = sectionOf(input);
            const cov = isCover(sec), res = isResume(sec);
            if (cov && !res) return "cover";
            if (res && !cov) return "resume";
            return "";
          };

          const entry = document.querySelector(`[data-field-path="${CSS.escape(fieldId)}"]`);
          let node = entry ? entry.querySelector("input[type=file]") : null;

          // Greenhouse: fieldId is a DOM id — either the file input itself or a wrapper.
          if (!node && fieldId) {
            const byId = document.getElementById(fieldId);
            if (byId) node = byId.matches("input[type=file]") ? byId : byId.querySelector("input[type=file]");
          }
          // The resume widget has no <label>: find the file input that belongs
          // to the wanted section. Never settle for an input of the other kind.
          if (!node) {
            const inputs = [...document.querySelectorAll("input[type=file]")];
            node = inputs.find((i) => kindOf(i) === want) || null;
            if (!node) {
              // Already attached? The section then shows the file name instead of an input.
              const group = [...document.querySelectorAll(".file-upload, [class*='file-upload'], [class*='attach']")]
                .find((g) => (want === "cover" ? isCover(g.textContent || "") : isResume(g.textContent || "")) && !g.querySelector("input[type=file]"));
              const shown = group?.querySelector("[class*='filename'], [class*='file-name'], [class*='fileName']")?.textContent?.trim()
                || ((group?.textContent || "").match(/\S+\.(pdf|docx?|txt|rtf)\b/i) || [])[0];
              if (shown && (!name || shown === name)) return { ok: true, already: true, actual: shown };
              if (shown) {
                // Another file is attached (Greenhouse's own autofill puts the saved
                // resume there): remove it so the tailored one goes in instead.
                const x = group.querySelector("button[aria-label*='remove' i], button[aria-label*='delete' i], button[class*='remove' i], [class*='remove' i] button, button[class*='close' i]")
                  || [...group.querySelectorAll("button")].find((bt) => !/attach|dropbox|google drive|enter manually/i.test(bt.textContent || ""));
                if (x) {
                  x.click();
                  for (let k = 0; k < 30 && !node; k++) {
                    await window.__jwMainWait(100);
                    node = [...document.querySelectorAll("input[type=file]")].find((i) => kindOf(i) === want) || null;
                  }
                }
                if (!node) return { ok: true, already: true, actual: shown, note: "could not replace the attached file" };
              } else return { ok: false, error: `${want} file input not found` };
            }
          } else if (!entry && kindOf(node) && kindOf(node) !== want) {
            return { ok: false, error: `file input #${node.id || "?"} belongs to the ${kindOf(node)} section, not ${want}` };
          }

          // A PDF saved under its LaTeX source's name ("Akash_Ramasani.tex") is
          // refused by the form's file types (Ashby, Nash, HappyRobot, 2026-11-10).
          if (b64 && atob(String(b64).slice(0, 8)).startsWith("%PDF") && !/\.pdf$/i.test(name || "")) name = String(name || "resume").replace(/\.[a-z0-9]+$/i, "") + ".pdf";
          const ext = (name || "resume.pdf").split(".").pop().toLowerCase();
          const mime = ext === "pdf" ? "application/pdf"
            : ext === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              : "application/octet-stream";
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const dt = new DataTransfer();
          dt.items.add(new File([bytes], name || "resume.pdf", { type: mime }));
          node.files = dt.files;
          node.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
          node.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
          return { ok: true, actual: node.files[0]?.name };
        };

        // Set a React-controlled Yes/No button
        const setReactYesNo = async (fieldId, answer) => {
          const entry = document.querySelector(`[data-field-path="${CSS.escape(fieldId)}"]`);
          if (!entry) return { ok: false, error: "yes/no entry not found" };

          const target = String(answer || "").toLowerCase().trim();
          const container = entry.querySelector("[class*='_yesno_']") || entry;
          const buttons = [...container.querySelectorAll("button")];

          const btn = buttons.find(b => b.textContent.trim().toLowerCase() === target);

          if (!btn) {
            return {
              ok: false,
              error: `yes/no button "${target}" not found`,
              buttons: buttons.map(b => b.textContent.trim())
            };
          }

          btn.click();
          await window.__jwMainWait(250);

          const input = entry.querySelector("input[type='checkbox']");
          return {
            ok: true,
            clicked: btn.textContent.trim(),
            checkboxChecked: input?.checked ?? null
          };
        };

        const setReactRadio = async (fieldId, index) => {
          const entry = document.querySelector(
            `[data-field-path="${CSS.escape(fieldId)}"]`
          );

          if (!entry) {
            return { ok: false, error: "radio entry not found" };
          }

          const radios = [...entry.querySelectorAll("input[type='radio']")];

          if (!radios[index]) {
            return {
              ok: false,
              error: "radio at index not found",
              radioCount: radios.length,
              requestedIndex: index
            };
          }

          const target = radios[index];

          // Ashby radio buttons are wired through the visible <label for="...">
          const label = target.id
            ? entry.querySelector(`label[for="${CSS.escape(target.id)}"]`)
            : null;

          if (label) {
            label.click();
          } else {
            target.click();
          }

          await window.__jwMainWait(250);

          // Fallback: if React did not accept the label click, try native input click
          if (!target.checked) {
            target.click();
            target.dispatchEvent(new Event("input", { bubbles: true }));
            target.dispatchEvent(new Event("change", { bubbles: true }));
            await window.__jwMainWait(200);
          }

          return {
            ok: target.checked,
            checked: target.checked,
            selectedLabel: label?.textContent?.trim() || ""
          };
        };

        const extractSchema = () => {
          const results = [];
          try {
            // Try __appData first (most Ashby pages)
            const appData = window.__appData;
            const formDef = appData?.applicationForm?.fieldEntries
              || appData?.jobPosting?.applicationForm?.fieldEntries
              || appData?.posting?.applicationForm?.fieldEntries
              || [];

            for (const entry of formDef) {
              const field = entry.field || entry;
              results.push({
                path: field.path || entry.path || entry.fieldPath || "",
                type: field.type || entry.type || "String",
                title: field.title || entry.title || "",
                required: field.isRequired ?? entry.isRequired ?? false,
                options: (field.selectableValues || entry.selectableValues || field.options || entry.options || [])
                  .map(o => typeof o === "string" ? { label: o, id: o } : { label: o.label || o.value || "", id: o.id || o.value || o.label || "" }),
              });
            }

            // Also try __NEXT_DATA__ as fallback
            if (!results.length) {
              const nextData = JSON.parse(document.getElementById("__NEXT_DATA__")?.textContent || "{}");
              const formFields = nextData?.props?.pageProps?.posting?.applicationForm?.fieldEntries
                || nextData?.props?.pageProps?.posting?.formDefinition?.fields
                || nextData?.props?.pageProps?.applicationForm?.fieldEntries
                || [];
              for (const entry of formFields) {
                const field = entry.field || entry;
                results.push({
                  path: field.path || entry.path || "",
                  type: field.type || entry.type || "String",
                  title: field.title || entry.title || "",
                  required: field.isRequired ?? entry.isRequired ?? false,
                  options: (field.selectableValues || entry.selectableValues || field.options || [])
                    .map(o => typeof o === "string" ? { label: o, id: o } : { label: o.label || o.value || "", id: o.id || o.value || o.label || "" }),
                });
              }
            }
          } catch (e) {
            console.warn("[JobWatch] Schema extraction error:", e.message);
          }
          return results;
        };

        // Greenhouse custom combobox: open it, then pick the option by text.
        // New job-boards forms use a react-select style widget: the menu opens
        // on mousedown on the styled CONTROL wrapper (or ArrowDown), not on a
        // plain click of the inner input.
        const ghSelectCombobox = async (fieldId, value) => {
          const wait = (ms) => window.__jwMainWait(ms);
          const nrm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
          let el = document.getElementById(fieldId);
          if (!el) return { ok: false, error: "combobox not found: " + fieldId };
          // If the label pointed at a wrapper, use the interactive control inside.
          if (!el.matches("input, button, select, [role=combobox]")) {
            el = el.querySelector("select, [role=combobox], input, button") || el;
          }
          const want = nrm(value);

          // Older Greenhouse boards render a real <select> (select2 UI on top):
          // set its value directly and fire change so the UI layer follows.
          if (el.tagName === "SELECT") {
            const options = [...el.options];
            const opt = options.find(o => nrm(o.textContent) === want)
              || options.find(o => nrm(o.textContent).startsWith(want))
              || options.find(o => nrm(o.textContent).includes(want));
            if (!opt) return { ok: false, error: "option not found (native select)", want, seen: options.slice(0, 12).map(o => o.textContent.trim()) };
            el.value = opt.value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true, picked: opt.textContent.trim() };
          }
          const control = el.closest("[class*='select__control'], [class*='control']") || el.parentElement || el;
          const collect = () => [...document.querySelectorAll('[role=option], ul[role=listbox] li, [id$="-listbox"] li, [class*="option"]')].filter(o => o.offsetParent !== null);

          // Auto-apply runs in a background tab, which never sends focus events
          // on its own; react-select only opens its menu once it hears them.
          el.focus();
          el.dispatchEvent(new FocusEvent("focus"));
          el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
          for (const target of [el, control]) {
            target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
            target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
            target.click();
            await wait(200);
            if (collect().length) break;
          }
          if (!collect().length) {
            el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
            await wait(300);
          }

          let opts = collect();
          let match = opts.find(o => nrm(o.textContent) === want);
          if (!match) {
            // Type the value so filter-as-you-type comboboxes narrow the list.
            // Poll up to ~2.5s: async lists (e.g. School) load from the network.
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
            try { setter.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) { /* not a text combobox */ }
            for (let i = 0; i < 7 && !match; i++) {
              await wait(350);
              opts = collect();
              match = opts.find(o => nrm(o.textContent) === want)
                || opts.find(o => nrm(o.textContent).startsWith(want))
                || opts.find(o => nrm(o.textContent).includes(want));
            }
          }
          if (!match) return { ok: false, error: "option not found", want, seen: opts.slice(0, 12).map(o => o.textContent.trim()) };
          match.scrollIntoView({ block: "nearest" });
          match.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
          match.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          match.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          match.click();
          await wait(200);
          return { ok: true, picked: match.textContent.trim() };
        };

        // Greenhouse location typeahead: type the city, wait for the geocoder's
        // suggestions, pick the one matching "City, FullStateName". Clicking the
        // suggestion also fills the hidden latitude/longitude fields.
        const ghLocationPick = async (fieldId, city, matchPrefix) => {
          const wait = (ms) => window.__jwMainWait(ms);
          const nrm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
          const el = document.getElementById(fieldId);
          if (!el) return { ok: false, error: "location input not found: " + fieldId };
          // "Cambridge, Massachusetts": the state is what tells Cambridge MA from
          // Cambridge, England. Picking the first "Cambridge" sent Lila Sciences
          // an English city (2026-11-02).
          const want = nrm(matchPrefix || city);
          const cityN = nrm(city);
          const state = want.includes(",") ? want.split(",").slice(1).join(",").trim().replace(/,?\s*(usa|us|united states)$/, "").trim() : "";
          // "NY" and "New York" are the same state: the list spells it out
          // ("New York, New York, United States"), the job may not (MongoDB).
          const US = { al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado", ct: "connecticut", de: "delaware", fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky", la: "louisiana", me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan", mn: "minnesota", ms: "mississippi", mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada", nh: "new hampshire", nj: "new jersey", nm: "new mexico", ny: "new york", nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma", or: "oregon", pa: "pennsylvania", ri: "rhode island", sc: "south carolina", sd: "south dakota", tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont", va: "virginia", wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming", dc: "district of columbia" };
          const abbr = Object.fromEntries(Object.entries(US).map(([k, v]) => [v, k]));
          const states = state ? [...new Set([state, US[state], abbr[state]].filter(Boolean))] : [];
          const inState = (text) => states.some((st) => new RegExp(`(^|,\\s*)${st.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s*,|$)`).test(text));
          const type = (text) => {
            el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            el.focus();
            el.dispatchEvent(new FocusEvent("focus"));
            el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
            el.click();
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
            if (setter) setter.call(el, ""); else el.value = "";
            el.dispatchEvent(new Event("input", { bubbles: true }));
            if (setter) setter.call(el, text); else el.value = text;
            el.dispatchEvent(new Event("input", { bubbles: true }));
          };
          // Only this picker's own list (the phone's country menu can be open too).
          const collect = () => {
            const lb = document.getElementById(el.getAttribute("aria-controls") || "") || document.getElementById(`react-select-${fieldId}-listbox`);
            return [...(lb || document).querySelectorAll("[role=option], ul[role=listbox] li, [class*='option']")]
              .filter((o) => o.offsetParent !== null && !/^(no (results|options)|loading)/i.test(o.textContent.trim()));
          };
          const choose = (opts) => {
            const t = (o) => nrm(o.textContent);
            if (state) {
              // The right city in the right state, nothing else: the city
              // first ("New York, ..." not "West New York, ..."), then the state.
              return opts.find((o) => t(o).startsWith(want))
                || opts.find((o) => t(o).startsWith(cityN + ",") && inState(t(o).slice(cityN.length + 1)))
                || opts.find((o) => t(o).startsWith(cityN) && inState(t(o)))
                || null;
            }
            return opts.find((o) => t(o).startsWith(want)) || opts.find((o) => t(o).includes(want)) || null;
          };
          // Search the specific "City, State" first, then the bare city. A
          // background tab runs the board's search on throttled timers, so the
          // list can take many seconds: keep asking (ArrowDown opens the menu,
          // retyping restarts a search that was dropped) for up to ~15 s each.
          const queries = [...new Set([matchPrefix, city].filter(Boolean))];
          let pick = null, opts = [];
          for (const q of queries) {
            type(q);
            for (let i = 0; i < 50 && !pick; i++) {
              await wait(300);
              if (el.getAttribute("aria-expanded") !== "true" && i % 3 === 2) {
                for (const t of ["keydown", "keyup"]) el.dispatchEvent(new KeyboardEvent(t, { key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40, bubbles: true, cancelable: true }));
              }
              opts = collect();
              pick = choose(opts);
              if (!pick && opts.length && i >= 6) break; // results came back, none of them is this place
              if (!opts.length && i > 0 && i % 12 === 0) type(q);
            }
            if (pick) break;
          }
          if (!pick) return { ok: false, error: "no matching location option", want, seen: opts.slice(0, 8).map((o) => o.textContent.trim()) };
          pick.scrollIntoView({ block: "nearest" });
          pick.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
          pick.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          pick.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          pick.click();
          await wait(300);
          return { ok: true, picked: pick.textContent.trim() };
        };


        // Paste the generated cover letter: Greenhouse's cover-letter widget
        // offers Attach / Dropbox / ... / "enter manually" — click the manual
        // toggle, then fill the revealed textarea.
        const ghCoverText = async (_id, text) => {
          const wait = (ms) => window.__jwMainWait(ms);
          const heads = [...document.querySelectorAll("label, legend, h1, h2, h3, h4, strong, span")]
            .filter(n => /cover letter/i.test(n.textContent || "") && (n.textContent || "").trim().length < 40);
          if (!heads.length) return { ok: false, error: "cover letter section not found" };
          // Walk up until the container holds the textarea or the manual toggle.
          let root = heads[0];
          for (let k = 0; k < 6 && root.parentElement; k++) {
            root = root.parentElement;
            if (root.querySelector("textarea") ||
              [...root.querySelectorAll("button, a")].some(b => /enter manually|paste|write/i.test(b.textContent || ""))) break;
          }
          let ta = root.querySelector("textarea");
          if (!ta) {
            const toggle = [...root.querySelectorAll("button, a")].find(b => /enter manually|paste|write/i.test(b.textContent || ""));
            if (toggle) { toggle.click(); await wait(400); ta = root.querySelector("textarea") || document.getElementById("cover_letter_text"); }
          }
          if (!ta) return { ok: false, error: "cover letter textarea not found" };
          ta.focus();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
          if (setter) setter.call(ta, text); else ta.value = text;
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          ta.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true };
        };

        // Check a consent/agreement checkbox.
        const ghCheck = async (fieldId) => {
          const el = document.getElementById(fieldId);
          if (!el) return { ok: false, error: "checkbox not found: " + fieldId };
          if (!el.checked) { el.click(); await window.__jwMainWait(150); }
          return { ok: el.checked === true };
        };

        // Greenhouse's emailed security code: one box per character, or one box.
        const ghCode = async (code) => {
          const vis = (el) => el && el.offsetParent !== null;
          const isCodeBox = (i) => {
            // The emailed code's own box ("security-input-0", autocomplete one-time-code,
            // "Security code"), never a question: a long agreement that mentions
            // "verifications" once took the code (CannonDesign, 2026-11-09).
            if (/^question_|^job_application_/.test(i.id || "") || /^question_|^job_application\[/.test(i.name || "")) return false;
            const aria = i.getAttribute("aria-label") || "";
            if (aria.length > 60) return false;
            const h = `${i.id} ${i.name} ${aria} ${i.getAttribute("autocomplete") || ""} ${i.getAttribute("placeholder") || ""}`;
            return /security[-_ ]?(code|input)|verification[-_ ]?code|one-time-code|\bcode\b/i.test(h) && !/zip|postal|phone|country|promo|referral|discount/i.test(h);
          };
          const boxes = [...document.querySelectorAll("input")].filter((i) => vis(i) && !["hidden", "checkbox", "radio", "file"].includes(i.type)
            && isCodeBox(i));
          if (!boxes.length) return { ok: false, error: "no security code input found" };
          const set = (node, v) => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            const old = node.value;
            node.focus();
            if (setter) setter.call(node, v); else node.value = v;
            if (node._valueTracker) node._valueTracker.setValue(old);
            node.dispatchEvent(new Event("input", { bubbles: true }));
            node.dispatchEvent(new Event("change", { bubbles: true }));
          };
          if (boxes.length > 1 && boxes.length >= code.length) code.split("").forEach((ch, i) => set(boxes[i], ch));
          else set(boxes[0], code);
          await window.__jwMainWait(300);
          return { ok: true, boxes: boxes.length };
        };

        // Diagnosis: log every write to the phone box with the code that made it
        // (stack), so a "+1" written by the page, an autofill or JobWatch shows its source.
        const ghPhoneTrap = () => {
          const el = document.getElementById("phone") || document.querySelector("input[type=tel]");
          if (!el || el.__jwTrap) return { ok: !!el };
          const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
          Object.defineProperty(el, "value", {
            configurable: true,
            get() { return d.get.call(this); },
            set(v) {
              const before = d.get.call(this);
              d.set.call(this, v);
              if (/\+\d\s*$/.test(String(v)) || (/\d/.test(String(v)) && String(v).replace(/\D/g, "").length > 10)) {
                console.warn(`[JobWatch/GH] phone written: "${before}" -> "${v}"`, new Error("who wrote the phone").stack);
              }
            },
          });
          el.__jwTrap = true;
          el.addEventListener("input", (e) => { if (/\+\d\s*$/.test(el.value)) console.warn(`[JobWatch/GH] phone input event (${e.isTrusted ? "real" : "script"}, ${e.inputType || "-"}): "${el.value}"`); }, true);
          return { ok: true };
        };

        let funcToRun = setReactFile;
        let argsToRun = [id, b64Data, fileName, which];
        if (action === "setInput") { funcToRun = setReactValue; argsToRun = [id, value]; }
        if (action === "typeCharByChar") { funcToRun = typeCharByChar; argsToRun = [id, value]; }
        if (action === "typeHuman") { funcToRun = typeHuman; argsToRun = [id, value]; }
        if (action === "clickYesNo") { funcToRun = setReactYesNo; argsToRun = [id, value]; }
        if (action === "clickRadio") { funcToRun = setReactRadio; argsToRun = [id, value]; }
        if (action === "ghSelectCombobox") { funcToRun = ghSelectCombobox; argsToRun = [id, value]; }
        if (action === "ghLocation") { funcToRun = ghLocationPick; argsToRun = [id, value, match]; }
        if (action === "ghCoverText") { funcToRun = ghCoverText; argsToRun = [id, value]; }
        if (action === "ghCheck") { funcToRun = ghCheck; argsToRun = [id]; }
        if (action === "ghCode") { funcToRun = ghCode; argsToRun = [value]; }
        if (action === "ghPhoneTrap") { funcToRun = ghPhoneTrap; argsToRun = []; }
        if (action === "extractSchema") { funcToRun = extractSchema; argsToRun = []; }

        chrome.scripting.executeScript({ target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] }, world: "MAIN", files: ["lib/wait-main.js"] }).then(() => chrome.scripting.executeScript({
          // Target the frame the request came from — Greenhouse forms are often
          // embedded in an iframe on the company's own careers page.
          target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
          world: "MAIN",
          func: funcToRun,
          args: argsToRun
        }))
          .then((results) => sendResponse({ ok: true, result: results?.[0]?.result }))
          .catch(err => sendResponse({ ok: false, error: err.message }));

        return true;
      }

      // ── 4. Application ledger: every form, every attempt ─────────────────
      // Content scripts report start / filled / submitted / error / dismiss.
      // recordApplication keeps one document per form; a "start" on a form
      // already submitted answers duplicate=true so the page is left alone.
      if (message.type === "APPLICATION_EVENT" || message.type === "APPLICATION_DONE") {
        try {
          const r = await recordApplicationEvent(message, sender);
          sendResponse({ ok: true, ...r });
          // A "needs you" tab (Ashby, Lever, Greenhouse) the person just submitted: close it too.
          const submitted = (message.event || (message.type === "APPLICATION_DONE" ? "submitted" : "")) === "submitted";
          if (submitted && sender?.tab?.id != null && !(await autoJobForTab(sender.tab.id))) await finishedByHand(sender.tab.id);
        } catch (err) {
          console.warn("[JobWatch] recordApplication failed:", err.message);
          sendResponse({ ok: false, error: err.message });
        }
        return;
      }

      // ── 4. Popup: add a job board feed ──────────────────────────────────
      if (message.type === "ADD_FEED") {
        const company = (message.company || "").trim();
        const source = ["ashby", "workday", "oracle"].includes(message.source) ? message.source : "greenhouse";
        const isUrlSource = source === "workday" || source === "oracle";
        const slug = companyToSlug(company);
        if (!company || (!isUrlSource && !slug)) {
          sendResponse({ ok: false, error: "Please enter a valid company name." });
          return;
        }

        // Workday / Oracle feeds carry the career-site URL from the popup, already
        // reduced to its canonical form by the popup's parser.
        let url;
        if (isUrlSource) {
          url = String(message.url || "").trim();
          const ok = source === "workday"
            ? /^https:\/\/[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com\/[^/?#]+$/i.test(url)
            : /^https:\/\/[a-z0-9.-]+\.oraclecloud\.com\/hcmUI\/CandidateExperience\/en\/sites\/[^/?#]+$/i.test(url);
          if (!ok) {
            sendResponse({ ok: false, error: `Please paste a valid ${source === "workday" ? "Workday" : "Oracle Cloud"} career site URL.` });
            return;
          }
        }

        const { jwUid } = await getStoredAuth();
        if (jwUid !== ADMIN_UID) {
          sendResponse({ ok: false, error: "Only the admin can add feeds." });
          return;
        }
        const { idToken } = await getFreshToken();
        if (!url) url = buildFeedUrl(source, slug);

        const existing = await fsQuery(`users/${ADMIN_UID}`, "feeds", [], idToken);
        if (existing.some((f) => (f.url || "").toLowerCase() === url.toLowerCase())) {
          sendResponse({ ok: false, error: "This feed has already been added." });
          return;
        }

        await fsAdd(`users/${ADMIN_UID}`, "feeds", {
          company,
          url,
          source,
          createdAt: new Date(),
          archivedAt: null,
          lastCheckedAt: null,
          lastError: null,
        }, idToken);

        sendResponse({ ok: true, url, source });
        return;
      }

      // ── 10. Popup: enterprise sign in via web app ─────────────────────────
      if (message.type === "SIGN_IN_WITH_WEB") {
        // Build the extension-auth URL with our chromiumapp.org redirect
        const extId = chrome.runtime.id;
        const redirectUri = `https://${extId}.chromiumapp.org/callback`;
        const authUrl =
          `https://jobwatch.akashramasani.com/extension-auth` +
          `?redirect_uri=${encodeURIComponent(redirectUri)}`;

        let callbackUrl;
        try {
          callbackUrl = await new Promise((resolve, reject) => {
            chrome.identity.launchWebAuthFlow(
              { url: authUrl, interactive: true },
              (redirectUrl) => {
                if (chrome.runtime.lastError) {
                  return reject(new Error(chrome.runtime.lastError.message));
                }
                resolve(redirectUrl);
              }
            );
          });
        } catch (err) {
          // User closed the window
          sendResponse({ ok: false, error: err.message });
          return;
        }

        // Extract one-time code from redirect URL
        const url = new URL(callbackUrl);
        const code = url.searchParams.get("code");
        if (!code) {
          sendResponse({ ok: false, error: "No code returned from auth flow." });
          return;
        }

        // Exchange code for Firebase Custom Token
        const exchangeRes = await fetch(
          `${FUNCTIONS_BASE}/exchangeExtensionCode`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code }),
          }
        );
        const exchangeData = await exchangeRes.json();
        if (!exchangeData.ok) {
          throw new Error(exchangeData.error || "Code exchange failed.");
        }

        // Sign in with Custom Token → Firebase REST API
        const signInRes = await fetch(
          `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              token: exchangeData.customToken,
              returnSecureToken: true,
            }),
          }
        );
        const signInData = await signInRes.json();
        if (!signInRes.ok) {
          throw new Error(signInData.error?.message || "Custom token sign-in failed.");
        }

        await saveAuth({
          idToken: signInData.idToken,
          refreshToken: signInData.refreshToken,
          uid: signInData.localId,
          expiresIn: signInData.expiresIn,
        });

        sendResponse({ ok: true, uid: signInData.localId });
        return;
      }


      // ── 11. Popup: get current user ───────────────────────────────────────
      if (message.type === "GET_USER") {
        const { jwUid } = await getStoredAuth();
        if (!jwUid) { sendResponse({ ok: false }); return; }
        try {
          const { idToken } = await getFreshToken();
          const userDoc = await fsGet(`users/${jwUid}`, idToken);
          sendResponse({ ok: true, uid: jwUid, userDoc });
        } catch {
          sendResponse({ ok: false });
        }
        return;
      }

      // ── 12. Popup: sign out ───────────────────────────────────────────────
      if (message.type === "SIGN_OUT") {
        await clearAuth();
        await chrome.storage.session.clear();
        sendResponse({ ok: true });
        return;
      }

      // ── 13. Web app → extension: sync auth on web app login ──────────────
      if (message.type === "JW_AUTH") {
        await saveAuth({
          idToken: message.idToken,
          refreshToken: message.refreshToken,
          uid: message.uid,
          expiresIn: message.expiresIn || 3600,
        });
        sendResponse({ ok: true });
        return;
      }

      // ── 14. Web app → extension: clear auth on web app logout ────────────
      if (message.type === "JW_LOGOUT") {
        await clearAuth();
        await chrome.storage.session.clear();
        sendResponse({ ok: true });
        return;
      }

      // ── 15. Web app pings extension to check login status ─────────────────
      if (message.type === "JW_PING") {
        const { jwUid, jwRefreshToken } = await getStoredAuth();
        sendResponse({ ok: true, loggedIn: !!(jwUid && jwRefreshToken) });
        return;
      }

      // Unknown message type (e.g. a newer popup talking to a stale service
      // worker) — always respond so the caller's UI never hangs.
      sendResponse({ ok: false, error: `Unknown message type: ${message.type}. Reload the extension.` });

    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // keep message channel open for async response
});
