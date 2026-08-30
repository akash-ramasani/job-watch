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
  const uuidMatch = url.match(
    /jobs\.ashbyhq\.com\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i
  );
  if (!uuidMatch) return;

  const externalId = uuidMatch[1];
  console.log("[JobWatch] Ashby page detected — prefetching job:", externalId);

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

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      // ── 1. JobWatch bridge triggers auto apply ──────────────────────────
      if (message.type === "AUTO_APPLY") {
        const job = message.job;
        await chrome.storage.session.set({ pendingJob: job });
        let applyUrl = (job.absolute_url || "").replace(/\/$/, "");
        if (!applyUrl.includes("/application")) applyUrl += "/application";
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
          const { idToken } = await getFreshToken();
          const data = await callPrepareGreenhouse(message.token, message.id, idToken);
          sendResponse({ ok: true, data });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        return;
      }

      // ── 3. Execute script in MAIN world (bypasses CSP) ─────────────────
      if (message.type === "EXEC_MAIN_WORLD") {
        const { action, id, value, b64Data, fileName, match } = message;

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

            if (node.value === val) {
              return { ok: true, actual: node.value, attempt };
            }
          }

          return { ok: false, actual: node.value, error: "React reset value" };
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

        const setReactFile = async (fieldId, b64, name) => {
          const entry = document.querySelector(`[data-field-path="${CSS.escape(fieldId)}"]`);
          let node = entry ? entry.querySelector("input[type=file]") : null;

          // Greenhouse: fieldId is a DOM id — either the file input itself or a wrapper.
          if (!node && fieldId) {
            const byId = document.getElementById(fieldId);
            if (byId) node = byId.matches("input[type=file]") ? byId : byId.querySelector("input[type=file]");
          }
          // Last resort on Greenhouse: the resume widget has no <label>, so
          // find its file input directly — by attributes, then by nearby text.
          if (!node) {
            const inputs = [...document.querySelectorAll("input[type=file]")];
            node = inputs.find(i => /resume|\bcv\b/i.test(`${i.id} ${i.name} ${i.getAttribute("aria-label") || ""} ${i.getAttribute("data-qa") || ""}`))
              || inputs.find(i => {
                let p = i.parentElement;
                for (let k = 0; k < 4 && p; k++, p = p.parentElement) {
                  const t = p.textContent || "";
                  if (t.length < 300 && /resume|\bcv\b/i.test(t)) return true;
                }
                return false;
              })
              || (inputs.length === 1 ? inputs[0] : null);
          }

          if (!node) return { ok: false, error: "file input not found" };

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

          el.focus();
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
          el.focus();
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

        let funcToRun = setReactFile;
        let argsToRun = [id, b64Data, fileName];
        if (action === "setInput") { funcToRun = setReactValue; argsToRun = [id, value]; }
        if (action === "typeCharByChar") { funcToRun = typeCharByChar; argsToRun = [id, value]; }
        if (action === "clickYesNo") { funcToRun = setReactYesNo; argsToRun = [id, value]; }
        if (action === "clickRadio") { funcToRun = setReactRadio; argsToRun = [id, value]; }
        if (action === "ghSelectCombobox") { funcToRun = ghSelectCombobox; argsToRun = [id, value]; }
        if (action === "ghLocation") { funcToRun = ghLocationPick; argsToRun = [id, value, match]; }
        if (action === "ghCoverText") { funcToRun = ghCoverText; argsToRun = [id, value]; }
        if (action === "ghCheck") { funcToRun = ghCheck; argsToRun = [id]; }
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

      // ── 4. Ashby content script reports done ────────────────────────────
      if (message.type === "APPLICATION_DONE") {
        const { idToken, uid } = await getFreshToken();
        const { jobId, jobTitle, companyName, status, answersLog } = message;

        // Recover the cached job so we can record its URL. Without this load,
        // `pendingJob` is undefined in this scope and reading .absolute_url
        // throws a ReferenceError, aborting the whole handler.
        const { pendingJob } = await new Promise((r) =>
          chrome.storage.session.get("pendingJob", r)
        );

        // Log to applications sub-collection with full answer record
        const docPath = `users/${uid}/applications/${jobId || Date.now()}`;
        await fsSet(docPath, {
          status: status || "submitted",
          jobTitle: jobTitle || "",
          companyName: companyName || "",
          jobUrl: pendingJob?.absolute_url || pendingJob?.jobUrl || "",
          appliedAt: new Date().toISOString(),
          answersLog: answersLog || {},   // every question label + answer submitted
          source: "ashby",
        }, idToken);

        // Mark the job document itself as auto-applied so it won't be queued again
        if (jobId) {
          await fsPatch(`users/${uid}/jobs/${jobId}`, { autoApplied: true, appliedAt: new Date().toISOString() }, idToken).catch(() => { });
        }

        await chrome.storage.session.remove("pendingJob");

        sendResponse({ ok: true });
        return;
      }

      // ── 4. Popup: add a job board feed ──────────────────────────────────
      if (message.type === "ADD_FEED") {
        const company = (message.company || "").trim();
        const source = message.source === "ashby" ? "ashby" : "greenhouse";
        const slug = companyToSlug(company);
        if (!company || !slug) {
          sendResponse({ ok: false, error: "Please enter a valid company name." });
          return;
        }

        const { idToken } = await getFreshToken();
        const url = buildFeedUrl(source, slug);

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
