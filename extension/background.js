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
 * Refreshes automatically if the stored token is within 60s of expiry.
 */
async function getFreshToken() {
  const { jwIdToken, jwRefreshToken, jwUid, jwTokenExpiry } = await getStoredAuth();

  if (!jwRefreshToken) throw new Error("Not logged in.");

  if (jwIdToken && jwTokenExpiry && Date.now() < jwTokenExpiry) {
    return { idToken: jwIdToken, uid: jwUid };
  }

  // Refresh
  const res = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: jwRefreshToken }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "Token refresh failed.");

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
    else if ("arrayValue" in v) out[k] = (v.arrayValue.values || []).map((x) => parseFs(x.mapValue?.fields || { _: x })?._  ?? Object.values(x)[0]);
    else if ("mapValue" in v) out[k] = parseFs(v.mapValue.fields || {});
    else if ("timestampValue" in v) out[k] = v.timestampValue;
    else out[k] = null;
  }
  return out;
}

async function fsGet(path, idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
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
async function fsQuery(parentPath, collectionId, filters, idToken, limit = null) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${parentPath}:runQuery`;
  const where = filters.length === 1 ? filters[0] : {
    compositeFilter: { op: "AND", filters },
  };
  const structuredQuery = { from: [{ collectionId }], where };
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
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}?currentDocument.exists=false`;
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

async function callMapFormFields(fields, jobTitle, companyName, idToken) {
  const res = await fetch(`${FUNCTIONS_BASE}/mapFormFields`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ data: { fields, jobTitle, companyName } }),
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error?.message || "mapFormFields failed");
  return json.result?.mappings || {};
}

// Track the currently open single-fill tab so we can inject greenhouse.js
// into company-hosted career pages (e.g. careers.whop.com?gh_jid=...).
let fillTabId = null;

// Prefer the stored absolute_url if it's already a Greenhouse boards URL (boards or job-boards).
// Only reconstruct from companyKey+externalId when the absolute_url is a company-hosted page
// (e.g. careers.whop.com?gh_jid=...) — in that case companyKey must be a slug, not a token.
function buildGreenhouseFillUrl(job) {
  // Use the exact stored URL — do NOT strip query params, as company-hosted
  // pages like careers.whop.com/?gh_jid=... need them to load the right job.
  return (job.absolute_url || job.jobUrl || job.applyUrl || "").replace(/\/$/, "");
}

// ─── Inject greenhouse.js into any career page domain ────────────────────────
// content_scripts only matches known Greenhouse domains; for company career pages
// (e.g. careers.whop.com?gh_jid=...) we inject programmatically on tab load.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  const url = tab.url || "";
  const alreadyInjected =
    /boards\.greenhouse\.io\/[^/]+\/jobs\//.test(url) ||
    /job-boards\.greenhouse\.io\/[^/]+\/jobs\//.test(url);

  // ── Fill mode: inject into company-hosted career pages ──────────────────
  if (tabId === fillTabId && !alreadyInjected) {
    fillTabId = null; // one-shot
    chrome.scripting.executeScript({ target: { tabId }, files: ["content/greenhouse.js"] })
      .catch((err) => console.warn("[JobWatch Fill] Script injection failed:", err.message, url));
    return;
  }

});

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      // ── 1. JobWatch bridge triggers auto apply ──────────────────────────
      if (message.type === "AUTO_APPLY") {
        const job = message.job;
        await chrome.storage.session.set({ pendingJob: job });
        let applyUrl;
        if (job.source === "greenhouse") {
          applyUrl = buildGreenhouseFillUrl(job);
        } else {
          applyUrl = (job.absolute_url || "").replace(/\/$/, "");
          if (!applyUrl.includes("/application")) applyUrl += "/application";
        }
        console.log("[JobWatch] AUTO_APPLY → opening:", applyUrl, "| absolute_url was:", job.absolute_url);
        const newTab = await chrome.tabs.create({ url: applyUrl });
        if (job.source === "greenhouse") fillTabId = newTab.id;
        sendResponse({ ok: true });
        return;
      }

      // ── 2. Ashby content script asks for fill data ──────────────────────
      if (message.type === "GET_FILL_DATA") {
        const { pendingJob } = await new Promise((r) =>
          chrome.storage.session.get("pendingJob", r)
        );

        const { idToken, uid } = await getFreshToken();

        // Fetch user profile and resume profile in parallel
        const [userDoc, resumeDoc] = await Promise.all([
          fsGet(`users/${uid}`, idToken),
          fsGet(`users/${uid}/resume/profile`, idToken),
        ]);

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

        const mappings = await callMapFormFields(formFields, jobTitle, companyName, idToken);

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

      // ── 3. Ashby content script reports done ────────────────────────────
      if (message.type === "APPLICATION_DONE") {
        const { idToken, uid } = await getFreshToken();
        const { jobId, jobTitle, companyName, status } = message;

        // Log to applications sub-collection
        const docPath = `users/${uid}/applications/${jobId || Date.now()}`;
        await fsSet(docPath, {
          status: status || "submitted",
          jobTitle: jobTitle || "",
          companyName: companyName || "",
          appliedAt: new Date().toISOString(),
        }, idToken);

        // Mark the job document itself as auto-applied so it won't be queued again
        if (jobId) {
          await fsPatch(`users/${uid}/jobs/${jobId}`, { autoApplied: true }, idToken).catch(() => {});
        }

        await chrome.storage.session.remove("pendingJob");

        // ── Advance auto-apply queue ──────────────────────────────────────
        const q = await new Promise(r =>
          chrome.storage.session.get(
            ["autoApplyActive", "autoApplyQueue", "autoApplyIndex", "autoApplyDone", "autoApplyTotal"],
            r
          )
        );

        if (q.autoApplyActive) {
          const newDone = (q.autoApplyDone || 0) + 1;
          const newIndex = (q.autoApplyIndex || 0) + 1;
          await chrome.storage.session.set({ autoApplyDone: newDone, autoApplyIndex: newIndex });

          // Close the current application tab after a short display delay
          const tabId = sender.tab?.id;
          setTimeout(async () => {
            if (tabId) chrome.tabs.remove(tabId).catch(() => {});

            if (newIndex < (q.autoApplyQueue || []).length) {
              const next = q.autoApplyQueue[newIndex];
              let applyUrl;
              if ((next.source || "") === "greenhouse") {
                applyUrl = buildGreenhouseFillUrl({ absolute_url: next.jobUrl || next.applyUrl || "", companyKey: next.companyKey, externalId: next.externalId });
              } else {
                applyUrl = (next.jobUrl || next.applyUrl || "").replace(/\/$/, "");
                if (!applyUrl.includes("/application")) applyUrl += "/application";
              }
              await chrome.storage.session.set({
                pendingJob: {
                  id: next.id,
                  title: next.title || next.jobTitle || "",
                  companyName: next.companyName || "",
                  absolute_url: next.jobUrl || next.applyUrl || "",
                  source: next.source || "",
                  companyKey: next.companyKey || "",
                  externalId: next.externalId || "",
                },
              });
              const nextTab = await chrome.tabs.create({ url: applyUrl });
              if ((next.source || "") === "greenhouse") fillTabId = nextTab.id;
            } else {
              // Queue exhausted
              await chrome.storage.session.set({ autoApplyActive: false });
            }
          }, 3000);
        }

        sendResponse({ ok: true });
        return;
      }

      // ── 4. Popup: start auto-apply queue ────────────────────────────────
      if (message.type === "START_AUTO_APPLY") {
        const { idToken, uid } = await getFreshToken();

        // Query jobs with relevanceScore > 60
        const jobs = await fsQuery(`users/${uid}`, "jobs", [{
          fieldFilter: {
            field: { fieldPath: "relevanceScore" },
            op: "GREATER_THAN",
            value: { integerValue: "60" },
          },
        }], idToken);

        // Filter: Ashby + Greenhouse jobs not already auto-applied
        const eligible = jobs.filter(j => {
          const source = j.source || "";
          return (source === "ashby" || source === "ashbyhq" || source === "greenhouse") && !j.autoApplied;
        });

        if (!eligible.length) {
          sendResponse({ ok: true, total: 0 });
          return;
        }

        await chrome.storage.session.set({
          autoApplyQueue: eligible,
          autoApplyIndex: 0,
          autoApplyTotal: eligible.length,
          autoApplyDone: 0,
          autoApplyActive: true,
        });

        // Open first job
        const first = eligible[0];
        let firstApplyUrl;
        if ((first.source || "") === "greenhouse") {
          firstApplyUrl = buildGreenhouseFillUrl({ absolute_url: first.jobUrl || first.applyUrl || "", companyKey: first.companyKey, externalId: first.externalId });
        } else {
          firstApplyUrl = (first.jobUrl || first.applyUrl || "").replace(/\/$/, "");
          if (!firstApplyUrl.includes("/application")) firstApplyUrl += "/application";
        }
        await chrome.storage.session.set({
          pendingJob: {
            id: first.id,
            title: first.title || first.jobTitle || "",
            companyName: first.companyName || "",
            absolute_url: first.jobUrl || first.applyUrl || "",
            source: first.source || "",
            companyKey: first.companyKey || "",
            externalId: first.externalId || "",
          },
        });
        const firstTab = await chrome.tabs.create({ url: firstApplyUrl });
        if ((first.source || "") === "greenhouse") fillTabId = firstTab.id;
        sendResponse({ ok: true, total: eligible.length });
        return;
      }

      // ── 8. Popup: get auto-apply progress ───────────────────────────────
      if (message.type === "GET_AUTO_APPLY_STATUS") {
        const s = await new Promise(r =>
          chrome.storage.session.get(["autoApplyActive", "autoApplyDone", "autoApplyTotal"], r)
        );
        sendResponse({ ok: true, active: !!s.autoApplyActive, done: s.autoApplyDone || 0, total: s.autoApplyTotal || 0 });
        return;
      }

      // ── 9. Popup: stop auto-apply ────────────────────────────────────────
      if (message.type === "STOP_AUTO_APPLY") {
        await chrome.storage.session.remove(["autoApplyActive", "autoApplyQueue", "autoApplyIndex", "autoApplyDone", "autoApplyTotal"]);
        await chrome.storage.session.remove("pendingJob");
        sendResponse({ ok: true });
        return;
      }

      // ── 10. Popup: sign in ────────────────────────────────────────────────
      if (message.type === "SIGN_IN") {
        const { email, password } = message;
        const res = await fetch(
          `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password, returnSecureToken: true }),
          }
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || "Login failed.");
        await saveAuth({
          idToken: data.idToken,
          refreshToken: data.refreshToken,
          uid: data.localId,
          expiresIn: data.expiresIn,
        });
        sendResponse({ ok: true, uid: data.localId, email: data.email });
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

      // ── Fill mode: content script found an iframe — navigate to embed URL ───
      if (message.type === "GREENHOUSE_FILL_REDIRECT") {
        const tabId = sender.tab?.id;
        if (tabId && message.newUrl) {
          fillTabId = tabId; // re-arm so tabs.onUpdated injects script on embed URL
          try { await chrome.tabs.update(tabId, { url: message.newUrl }); } catch (e) {
            console.warn("[JobWatch Fill] tabs.update failed:", e.message);
          }
        }
        sendResponse({ ok: true });
        return;
      }

    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // keep message channel open for async response
});
