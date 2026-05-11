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
        const { pendingJob } = await new Promise((r) =>
          chrome.storage.session.get("pendingJob", r)
        );

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

      // ── 3. Execute script in MAIN world (bypasses CSP) ─────────────────
      if (message.type === "EXEC_MAIN_WORLD") {
        const { action, id, value, b64Data, fileName } = message;
        
        const setReactValue = async (fieldId, val) => {
          const entry = document.querySelector(`[data-field-path="${CSS.escape(fieldId)}"]`);
          const node = entry?.querySelector("input:not([type=file]):not([type=radio]):not([type=checkbox]), textarea");

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

        const setReactFile = async (fieldId, b64, name) => {
          const entry = document.querySelector(`[data-field-path="${CSS.escape(fieldId)}"]`);
          const node = entry ? entry.querySelector("input[type=file]") : null;
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

        chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: "MAIN",
          func: action === "setInput" ? setReactValue : setReactFile,
          args: action === "setInput" ? [id, value] : [id, b64Data, fileName]
        })
        .then((results) => sendResponse({ ok: true, result: results?.[0]?.result }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
        
        return true;
      }

      // ── 4. Ashby content script reports done ────────────────────────────
      if (message.type === "APPLICATION_DONE") {
        const { idToken, uid } = await getFreshToken();
        const { jobId, jobTitle, companyName, status, answersLog } = message;

        // Log to applications sub-collection with full answer record
        const docPath = `users/${uid}/applications/${jobId || Date.now()}`;
        await fsSet(docPath, {
          status: status || "submitted",
          jobTitle: jobTitle || "",
          companyName: companyName || "",
          appliedAt: new Date().toISOString(),
          answersLog: answersLog || {},   // every question label + answer submitted
          source: "ashby",
        }, idToken);

        // Mark the job document itself as auto-applied so it won't be queued again
        if (jobId) {
          await fsPatch(`users/${uid}/jobs/${jobId}`, { autoApplied: true, appliedAt: new Date().toISOString() }, idToken).catch(() => {});
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
              const applyUrl = (next.jobUrl || next.applyUrl || "").replace(/\/$/, "") + (!(next.jobUrl || next.applyUrl || "").includes("/application") ? "/application" : "");
              await chrome.storage.session.set({
                pendingJob: {
                  id: next.id,
                  title: next.title || next.jobTitle || "",
                  companyName: next.companyName || "",
                  absolute_url: next.jobUrl || next.applyUrl || "",
                  source: next.source || "",
                  companyKey: next.companyKey || "",
                  externalId: next.externalId || "",
                  locationName: next.locationName || "",
                  workplaceType: next.workplaceType || null,
                },
              });
              await chrome.tabs.create({ url: applyUrl });
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

        // Filter: Ashby jobs not already auto-applied
        const eligible = jobs.filter(j => {
          const source = j.source || "";
          return (source === "ashby" || source === "ashbyhq") && !j.autoApplied;
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
        let firstApplyUrl = (first.jobUrl || first.applyUrl || "").replace(/\/$/, "");
        if (!firstApplyUrl.includes("/application")) firstApplyUrl += "/application";
        await chrome.storage.session.set({
          pendingJob: {
            id: first.id,
            title: first.title || first.jobTitle || "",
            companyName: first.companyName || "",
            absolute_url: first.jobUrl || first.applyUrl || "",
            source: first.source || "",
            companyKey: first.companyKey || "",
            externalId: first.externalId || "",
            locationName: first.locationName || "",
            workplaceType: first.workplaceType || null,
          },
        });
        await chrome.tabs.create({ url: firstApplyUrl });
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

    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // keep message channel open for async response
});
