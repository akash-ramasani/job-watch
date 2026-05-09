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

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      // ── 1. JobWatch bridge triggers auto apply ──────────────────────────
      if (message.type === "AUTO_APPLY") {
        const job = message.job;
        await chrome.storage.session.set({ pendingJob: job });
        // Ashby application form is always at {job_url}/application
        let applyUrl = (job.absolute_url || "").replace(/\/$/, "");
        if (!applyUrl.includes("/application")) applyUrl += "/application";
        await chrome.tabs.create({ url: applyUrl });
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
        });
        return;
      }

      // ── 3. Ashby content script reports done ────────────────────────────
      if (message.type === "APPLICATION_DONE") {
        const { idToken, uid } = await getFreshToken();
        const { jobId, jobTitle, companyName, status } = message;
        const docPath = `users/${uid}/applications/${jobId || Date.now()}`;
        await fsSet(docPath, {
          status: status || "submitted",
          jobTitle: jobTitle || "",
          companyName: companyName || "",
          appliedAt: new Date().toISOString(),
        }, idToken);
        await chrome.storage.session.remove("pendingJob");
        sendResponse({ ok: true });
        return;
      }

      // ── 4. Popup: sign in ────────────────────────────────────────────────
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

      // ── 5. Popup: get current user ───────────────────────────────────────
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

      // ── 6. Popup: sign out ───────────────────────────────────────────────
      if (message.type === "SIGN_OUT") {
        await clearAuth();
        await chrome.storage.session.clear();
        sendResponse({ ok: true });
        return;
      }

    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // keep message channel open for async response
});
