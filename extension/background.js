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

const FEED_LABEL = { greenhouse: "Greenhouse", ashby: "AshbyHQ", lever: "Lever", workday: "Workday", oracle: "Oracle Cloud", workable: "Workable", smartrecruiters: "SmartRecruiters", bamboohr: "BambooHR" };

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
    const { jwAutoFeeds = [] } = await chrome.storage.local.get("jwAutoFeeds");
    await chrome.storage.local.set({ jwAutoFeeds: [{ company, source: f.source, label: FEED_LABEL[f.source] || f.source, url: f.url, at: new Date().toISOString() }, ...jwAutoFeeds].slice(0, 30) });
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
});

/** Lever leaves the form for a separate /thanks page after Submit: that is the submission. */
async function autoLeverThanks(tabId, url) {
  if (!/jobs\.(eu\.)?lever\.co\/[^/]+\/[0-9a-f-]{36}\/thanks/i.test(url)) return;
  const job = await autoJobForTab(tabId);
  if (!job) return;
  await callFunction("recordApplication", { event: "submitted", applyUrl: job.applyUrl, jobId: job.jobId, jobTitle: job.title, companyName: job.companyName }).catch((e) => console.warn("[JobWatch] ledger(submitted) failed:", e.message));
  await autoFinish({ status: "submitted", note: "" });
}

// ─── Unattended auto-apply (Ashby, Greenhouse, Lever) ──────────────────────────────
// Works through getAutoApplyQueue one job at a time in a background tab: the
// tailored resume is made first (tailoredResumeFile), the page's content
// script fills the form, submits when nothing is left for the person, enters
// Greenhouse's emailed security code from Gmail, and reports back
// (AUTO_RESULT). Anything it cannot finish stays open in its tab and is
// listed in the popup. State lives in chrome.storage.local so a restarted
// service worker carries on; a one-minute alarm keeps the loop alive.
//
// Always on: when the queue runs dry the runner waits and checks for new jobs
// every 15 minutes instead of stopping, starts again when the browser opens,
// and keeps the computer awake while it is on (chrome.power). Failed jobs are
// retried on their own (30 minutes, then 2 hours; three tries in all; closed
// postings never). A job that needed the person is retried once they add a
// saved answer on the Profile page, if its tab was closed.

const AUTO_KEY = "jwAuto";
const AUTO_JOB_TIMEOUT_MS = 15 * 60 * 1000;
const AUTO_GAP_MS = [1500, 3000]; // back to back: just long enough for the tab to close
const AUTO_IDLE_MS = 15 * 60 * 1000; // queue empty: look for new jobs this often
const AUTO_RETRY_MS = [30 * 60 * 1000, 2 * 60 * 60 * 1000]; // after the 1st and 2nd failure
const AUTO_MAX_TRIES = 3;
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
  if ((r.tries || 1) >= AUTO_MAX_TRIES || r.closed) return false;
  if (r.status === "error") return Date.now() >= (r.retryAt || 0);
  if (r.status === "needs_attention") {
    // Waiting on the person: retried after they add an answer, once its tab is gone.
    if (!(autoQueue.answersUpdatedAt > r.at)) return false;
    if (r.tabId && await chrome.tabs.get(r.tabId).then(() => true).catch(() => false)) return false;
    return true;
  }
  return false;
}

async function autoState() {
  const { [AUTO_KEY]: st } = await chrome.storage.local.get(AUTO_KEY);
  return st || { on: false, current: null, results: {}, startedAt: null };
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
  if (hit?.failedAt && Date.now() - hit.failedAt < 10 * 60 * 1000) return null;
  try {
    const r = await callFunction("tailoredResumeFile", ref);
    await chrome.storage.session.set({ [key]: { fileName: r.fileName, pdfBase64: r.pdfBase64, jobId: r.jobId } });
    return r;
  } catch (err) {
    console.warn("[JobWatch] tailored resume unavailable, using the saved resume:", err.message);
    await chrome.storage.session.set({ [key]: { failedAt: Date.now(), error: err.message } });
    return null;
  }
}
/** The auto-apply job this tab is working on, or null. */
async function autoJobForTab(tabId) {
  const st = await autoState();
  return st.on && st.current && st.current.tabId === tabId ? st.current : null;
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

async function autoNextJob(st) {
  if (Date.now() - autoQueue.at > AUTO_IDLE_MS || !autoQueue.list.length) {
    const r = await callFunction("getAutoApplyQueue", {});
    autoQueue = { at: Date.now(), list: r.queue || [], answersUpdatedAt: Number(r.answersUpdatedAt) || 0 };
  }
  for (const j of autoQueue.list) if (await autoDue(j, st)) return j;
  return null;
}

async function autoFinish(result) {
  const st = await autoState();
  const cur = st.current;
  if (!cur) return;
  const prev = st.results[cur.jobId];
  const tries = (prev?.tries || 0) + 1;
  const note = String(result.note || "").slice(0, 300);
  st.results[cur.jobId] = {
    status: result.status, note, title: cur.title, companyName: cur.companyName, url: cur.applyUrl, at: Date.now(), tries,
    ...(result.status === "error" ? { retryAt: Date.now() + (AUTO_RETRY_MS[tries - 1] || AUTO_RETRY_MS[AUTO_RETRY_MS.length - 1]), closed: CLOSED_POSTING.test(note) } : {}),
    ...(result.status === "needs_attention" ? { tabId: cur.tabId || null } : {}),
  };
  st.current = null;
  st.nextAt = Date.now() + AUTO_GAP_MS[0] + Math.random() * (AUTO_GAP_MS[1] - AUTO_GAP_MS[0]);
  await saveAuto(st);
  // Submitted, skipped or failed: close the tab. Needs you: leave it open to finish.
  if (result.status !== "needs_attention" && cur.tabId) chrome.tabs.remove(cur.tabId).catch(() => {});
  if (result.status === "needs_attention") notify(`Needs you: ${cur.companyName}`, `${cur.title}. ${result.note || ""} The tab is left open.`);
  console.log(`[JobWatch] auto-apply ${result.status}: ${cur.companyName} | ${cur.title} ${result.note || ""}`);
  // Chrome won't fire an alarm sooner than 30 s: start the next job directly,
  // with the alarm as the backstop if the service worker sleeps first.
  setTimeout(autoTick, Math.max(0, st.nextAt - Date.now()) + 50);
  chrome.alarms.create("jwAutoKick", { when: Math.max(st.nextAt, Date.now() + 30000) });
}

async function autoTick() {
  if (autoBusy) return;
  autoBusy = true;
  try {
    const st = await autoState();
    keepAwake(!!st.on);
    if (!st.on) return;
    if (st.current) {
      const alive = st.current.tabId ? await chrome.tabs.get(st.current.tabId).then(() => true).catch(() => false) : true;
      if (st.current.tabId && !alive) { autoBusy = false; return autoFinish({ status: "error", note: "the tab was closed" }); }
      if (Date.now() - st.current.startedAt > AUTO_JOB_TIMEOUT_MS) { autoBusy = false; return autoFinish({ status: "error", note: "timed out after 15 minutes" }); }
      return;
    }
    if (st.nextAt && Date.now() < st.nextAt) return;
    const job = await autoNextJob(st);
    if (!job) {
      // Nothing due: wait for new jobs (or a retry's time) instead of stopping.
      const retryAts = Object.values(st.results).filter((r) => r.status === "error" && !r.closed && (r.tries || 1) < AUTO_MAX_TRIES).map((r) => r.retryAt || 0);
      st.nextAt = Math.min(Date.now() + AUTO_IDLE_MS, ...retryAts.map((t) => Math.max(t, Date.now() + 60000)));
      if (!st.idle) {
        const n = Object.values(st.results).filter((r) => r.status === "submitted").length;
        notify("Auto-apply is waiting for new jobs", `Every job so far is done (${n} submitted). It checks for new ones every 15 minutes.`);
      }
      st.idle = true;
      autoQueue.at = 0; // fetch a fresh queue next time
      await saveAuto(st);
      chrome.alarms.create("jwAutoKick", { when: st.nextAt });
      return;
    }
    st.idle = false;
    st.current = { ...job, tabId: null, startedAt: Date.now() };
    await saveAuto(st);
    await tailoredResumeFor({ jobId: job.jobId }); // ready before the form asks for it
    const tab = await chrome.tabs.create({ url: job.applyUrl, active: false });
    // Make the next job's tailored resume while this one fills, so it starts at once.
    const upcoming = autoQueue.list.find((j) => !st.results[j.jobId] && j.jobId !== job.jobId);
    if (upcoming) tailoredResumeFor({ jobId: upcoming.jobId }).catch(() => {});
    const st2 = await autoState();
    if (st2.current?.jobId === job.jobId) { st2.current.tabId = tab.id; await saveAuto(st2); }
  } catch (err) {
    console.warn("[JobWatch] auto-apply tick failed:", err.message);
    const st = await autoState();
    if (st.current && !st.current.tabId) { st.current = null; st.nextAt = Date.now() + 60000; await saveAuto(st); }
  } finally {
    autoBusy = false;
  }
}

chrome.alarms.create("jwAutoTick", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "jwAutoTick" || a.name === "jwAutoKick") autoTick(); });
// The browser opened: carry on where it left off (a job whose tab is gone is retried later).
chrome.runtime.onStartup.addListener(() => { autoTick(); });

async function autoStatus() {
  const st = await autoState();
  const results = Object.entries(st.results || {}).map(([jobId, r]) => ({ jobId, ...r })).sort((a, b) => b.at - a.at);
  const count = (s) => results.filter((r) => r.status === s).length;
  const left = autoQueue.list.filter((j) => !st.results[j.jobId]).length;
  const retrying = results.filter((r) => r.status === "error" && !r.closed && (r.tries || 1) < AUTO_MAX_TRIES).length;
  return { on: !!st.on, idle: !!st.idle, nextAt: st.nextAt || 0, current: st.current, submitted: count("submitted"), needs: count("needs_attention"), errors: count("error"), skipped: count("skipped"), retrying, left: autoQueue.at ? left : null, recent: results.slice(0, 8) };
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
/** The code from the newest Greenhouse security-code email received after `sinceMs`, or "". */
async function greenhouseCode(sinceMs) {
  const token = await gmailToken(false);
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const q = encodeURIComponent('from:greenhouse newer_than:1d (security code OR verification code)');
  const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=5`, auth).then((r) => r.json());
  for (const m of list.messages || []) {
    const msg = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, auth).then((r) => r.json());
    if (Number(msg.internalDate) < sinceMs - 120000) continue;
    const text = `${msg.snippet || ""} ${mailText(msg.payload)}`;
    const hit = text.match(/(?:security|verification) code(?: field)?[^A-Za-z0-9]{0,80}?(?:application|below|is)?[:\s]+([A-Za-z0-9]{6,10})\b/i)
      || text.match(/\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])([A-Za-z0-9]{8})\b/);
    if (hit) return hit[1];
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
  const q = encodeURIComponent('newer_than:3d -in:sent -category:promotions -category:social (application OR applying OR applied OR interview OR candidacy OR "next steps" OR unfortunately OR assessment OR offer OR position OR role)');
  const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=40`, auth).then((r) => r.json()).catch(() => ({}));
  const { jwMailSeen = [] } = await chrome.storage.local.get("jwMailSeen");
  const seen = new Set(jwMailSeen);
  const fresh = (list.messages || []).filter((m) => !seen.has(m.id)).slice(0, 25);
  if (!fresh.length) return;
  const emails = [];
  for (const m of fresh) {
    const msg = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, auth).then((r) => r.json()).catch(() => null);
    if (!msg?.id) continue;
    const h = (n) => (msg.payload?.headers || []).find((x) => x.name.toLowerCase() === n)?.value || "";
    emails.push({ id: msg.id, from: h("from"), subject: h("subject"), snippet: msg.snippet || "", date: Number(msg.internalDate) || Date.now() });
  }
  let out;
  try { out = await callFunction("trackApplicationEmails", { emails }); } catch (err) { console.warn("[JobWatch] mail scan failed:", err.message); return; }
  await chrome.storage.local.set({ jwMailSeen: [...jwMailSeen, ...fresh.map((m) => m.id)].slice(-1000) });
  const { jwMailEvents = [] } = await chrome.storage.local.get("jwMailEvents");
  const events = [...jwMailEvents, ...(out.updates || []).map((u) => ({ ...u, at: Date.now() }))].filter((e) => Date.now() - e.at < 14 * 864e5).slice(-300);
  await chrome.storage.local.set({ jwMailEvents: events });
  for (const u of out.updates || []) {
    const what = { interview: "wants to interview you", assessment: "sent an assessment", offer: "sent an offer" }[u.kind];
    if (what) notify(`${u.companyName} ${what}`, `${u.jobTitle || "Your application"}. Check your email.`);
  }
  console.log("[JobWatch] mail scan:", emails.length, "checked,", (out.updates || []).length, "matched");
}

// ─── Daily summary (8 PM) ─────────────────────────────────────────────────────
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
  notify("JobWatch today", `${parts.join(", ")}.${st.on ? "" : " Auto-apply is off."}`);
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
        sendResponse({ ok: true, job: await autoJobForTab(sender?.tab?.id) });
        return;
      }
      if (message.type === "AUTO_RESULT") {
        const job = await autoJobForTab(sender?.tab?.id);
        if (job) await autoFinish({ status: message.status, note: message.note });
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
      if (message.type === "AUTO_STOP") {
        const st = await autoState();
        st.on = false; st.idle = false; st.current = null;
        await saveAuto(st);
        keepAwake(false);
        sendResponse({ ok: true });
        return;
      }
      if (message.type === "AUTO_RETRY") {
        // Jobs that needed the person or failed go back in the queue (after a fix).
        const st = await autoState();
        let n = 0;
        for (const [id, r] of Object.entries(st.results || {})) if (r.status === "needs_attention" || r.status === "error") { delete st.results[id]; n++; }
        st.idle = false; st.nextAt = 0;
        await saveAuto(st);
        autoQueue = { at: 0, list: [], answersUpdatedAt: 0 };
        if (st.on) autoTick();
        sendResponse({ ok: true, retried: n });
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
            code = await greenhouseCode(Number(message.since) || t0);
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
        chrome.scripting.executeScript({ target, world: "MAIN", files: ["lib/lever-dom.js"] })
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
          const res = await fetch(`${FUNCTIONS_BASE}/prepareGenericApplication`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({ data: {
              source: message.source || "web", applyUrl: message.applyUrl || sender?.tab?.url || "", formKey: message.formKey || "",
              externalId: message.externalId || "", domFields: message.domFields || [],
              jobTitle: job?.title || message.jobTitle || "", companyName: job?.companyName || message.companyName || "",
              jobLocationName: job?.locationName || message.locationName || "", descriptionText: message.descriptionText || "",
            } }),
          });
          const json = await res.json();
          if (!res.ok || json.error) throw new Error(json.error?.message || `prepareGenericApplication ${res.status}`);
          sendResponse({ ok: true, data: json.result, pendingJob: job });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        return;
      }

      // ── AI rescue of a stuck field: the page side, then Claude's plan ─────
      if (message.type === "EXEC_RESCUE") {
        const target = { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] };
        chrome.scripting.executeScript({ target, world: "MAIN", files: ["lib/rescue-dom.js"] })
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

      // ── Any other board: run a lib/generic-dom.js helper in the MAIN world ─
      if (message.type === "EXEC_GENERIC") {
        const target = { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] };
        chrome.scripting.executeScript({ target, world: "MAIN", files: ["lib/generic-dom.js"] })
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
          await chrome.scripting.executeScript({ target, files: ["content/highlight.js", "content/notify.js", "content/rescue.js", "content/universal.js"] });
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        return;
      }

      // ── Ashby: run a lib/ashby-dom.js helper in the page's MAIN world ─────
      if (message.type === "EXEC_ASHBY") {
        const target = { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] };
        chrome.scripting.executeScript({ target, world: "MAIN", files: ["lib/ashby-dom.js"] })
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

          const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
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
          await new Promise(r => setTimeout(r, 200));

          // Select-all + delete
          node.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }));
          node.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
          await new Promise(r => setTimeout(r, 100));

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
            await new Promise(r => setTimeout(r, 60));
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
              if (shown) return { ok: true, already: true, actual: shown };
              return { ok: false, error: `${want} file input not found` };
            }
          } else if (!entry && kindOf(node) && kindOf(node) !== want) {
            return { ok: false, error: `file input #${node.id || "?"} belongs to the ${kindOf(node)} section, not ${want}` };
          }

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
          await new Promise(r => setTimeout(r, 250));

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

          await new Promise(r => setTimeout(r, 250));

          // Fallback: if React did not accept the label click, try native input click
          if (!target.checked) {
            target.click();
            target.dispatchEvent(new Event("input", { bubbles: true }));
            target.dispatchEvent(new Event("change", { bubbles: true }));
            await new Promise(r => setTimeout(r, 200));
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
          const wait = (ms) => new Promise(r => setTimeout(r, ms));
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
          const wait = (ms) => new Promise(r => setTimeout(r, ms));
          const nrm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
          const el = document.getElementById(fieldId);
          if (!el) return { ok: false, error: "location input not found: " + fieldId };
          // Background tabs send no focus events; the typeahead needs them to search.
          el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          el.focus();
          el.dispatchEvent(new FocusEvent("focus"));
          el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
          el.click();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (setter) setter.call(el, city); else el.value = city;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          const collect = () => [...document.querySelectorAll("[role=option], ul[role=listbox] li, [class*='option']")].filter(o => o.offsetParent !== null);
          const want = nrm(matchPrefix || city);
          let pick = null, opts = [];
          for (let i = 0; i < 12 && !pick; i++) {
            await wait(300);
            opts = collect();
            pick = opts.find(o => nrm(o.textContent).startsWith(want))
              || opts.find(o => nrm(o.textContent).includes(want));
          }
          // Fall back to the first suggestion for the right city (e.g. no state).
          if (!pick) pick = opts.find(o => nrm(o.textContent).startsWith(nrm(city)));
          if (!pick) return { ok: false, error: "no matching location option", want, seen: opts.slice(0, 8).map(o => o.textContent.trim()) };
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
          const wait = (ms) => new Promise(r => setTimeout(r, ms));
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
          if (!el.checked) { el.click(); await new Promise(r => setTimeout(r, 150)); }
          return { ok: el.checked === true };
        };

        // Greenhouse's emailed security code: one box per character, or one box.
        const ghCode = async (code) => {
          const vis = (el) => el && el.offsetParent !== null;
          const hint = (i) => `${i.id} ${i.name} ${i.getAttribute("aria-label") || ""} ${i.getAttribute("autocomplete") || ""} ${i.getAttribute("placeholder") || ""}`;
          const boxes = [...document.querySelectorAll("input")].filter((i) => vis(i) && !["hidden", "checkbox", "radio", "file"].includes(i.type)
            && /security|verification|one-time-code|\bcode\b/i.test(hint(i)) && !/zip|postal|phone|country|promo/i.test(hint(i)));
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
          await new Promise((r) => setTimeout(r, 300));
          return { ok: true, boxes: boxes.length };
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
        if (action === "extractSchema") { funcToRun = extractSchema; argsToRun = []; }

        chrome.scripting.executeScript({
          // Target the frame the request came from — Greenhouse forms are often
          // embedded in an iframe on the company's own careers page.
          target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
          world: "MAIN",
          func: funcToRun,
          args: argsToRun
        })
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
