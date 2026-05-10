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



// ─── Audit state ─────────────────────────────────────────────────────────────

const audit = {
  active: false,
  queue:   [],   // [{ id, title, companyName, url }]
  index:   0,
  total:   0,
  done:    0,
  skipped: 0,
  results: [],
  tabId:   null,
  timer:   null,
};

function auditReset() {
  if (audit.timer) { clearTimeout(audit.timer); audit.timer = null; }
  audit.active  = false;
  audit.queue   = [];
  audit.index   = 0;
  audit.total   = 0;
  audit.done    = 0;
  audit.skipped = 0;
  audit.results = [];
  audit.tabId   = null;
}

async function auditOpenNext() {
  if (!audit.active || audit.index >= audit.queue.length) return;
  const next = audit.queue[audit.index];
  const tab = await chrome.tabs.create({ url: next.url });
  audit.tabId = tab.id;
  // Fallback timeout: skip this tab if no response within 35s
  audit.timer = setTimeout(() => {
    console.warn("[JobWatch Audit] Timeout — skipping:", next.url);
    auditAdvance([], "timeout");
  }, 35000);
}

function auditAdvance(fields, error) {
  if (!audit.active) return;
  if (audit.timer) { clearTimeout(audit.timer); audit.timer = null; }

  const current = audit.queue[audit.index];
  if (audit.tabId) {
    chrome.tabs.remove(audit.tabId).catch(() => {});
    audit.tabId = null;
  }

  if (!error && fields && fields.length) {
    audit.results.push({
      job: {
        id:          current.id,
        title:       current.title       || "",
        companyName: current.companyName || "",
        url:         current.url,
      },
      fields,
    });
    audit.done++;
  } else {
    audit.skipped++;
  }

  audit.index++;
  if (audit.index >= audit.queue.length) {
    auditFinish();
    return;
  }
  auditOpenNext();
}

function auditFinish() {
  audit.active = false;
  if (audit.timer) { clearTimeout(audit.timer); audit.timer = null; }

  const json    = JSON.stringify(audit.results, null, 2);
  const encoded = btoa(unescape(encodeURIComponent(json)));
  chrome.downloads.download({
    url:            `data:application/json;base64,${encoded}`,
    filename:       "jobwatch-audit.json",
    saveAs:         true,
    conflictAction: "overwrite",
  }).catch(err => console.error("[JobWatch Audit] Download failed:", err));
}

// ─── Inject audit script when audit tab finishes loading ─────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  if (!audit.active || tabId !== audit.tabId) return;

  chrome.scripting.executeScript({ target: { tabId }, files: ["content/ashby-audit.js"] })
    .catch((err) => {
      console.warn("[JobWatch Audit] Injection failed:", err.message);
      auditAdvance([], `inject_failed: ${err.message}`);
    });
});

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

      // ── Audit: content script sends scraped fields ────────────────────────
      if (message.type === "ASHBY_AUDIT_DATA") {
        const tabId = sender.tab?.id;
        if (audit.active && tabId === audit.tabId) {
          auditAdvance(message.fields || [], message.error || null);
        }
        sendResponse({ ok: true });
        return;
      }

      // ── Audit: popup starts an audit run ─────────────────────────────────
      if (message.type === "START_ASHBY_AUDIT") {
        if (audit.active) { sendResponse({ ok: false, error: "Audit already running." }); return; }
        auditReset();

        const { idToken, uid } = await getFreshToken();
        // Two single-field queries (no composite index needed); filter score in JS
        const [jobs1, jobs2] = await Promise.all([
          fsQuery(`users/${uid}`, "jobs", [{
            fieldFilter: { field: { fieldPath: "source" }, op: "EQUAL", value: { stringValue: "ashby" } },
          }], idToken, 500),
          fsQuery(`users/${uid}`, "jobs", [{
            fieldFilter: { field: { fieldPath: "source" }, op: "EQUAL", value: { stringValue: "ashbyhq" } },
          }], idToken, 500),
        ]);
        console.log("[JobWatch Audit] ashby:", jobs1.length, "ashbyhq:", jobs2.length);
        const sample = [...jobs1, ...jobs2][0];
        if (sample) console.log("[JobWatch Audit] Sample job keys:", JSON.stringify({ id: sample.id, source: sample.source, relevanceScore: sample.relevanceScore, score: sample.score, absolute_url: sample.absolute_url }));

        const seen = new Set();
        const queue = [];
        for (const j of [...jobs1, ...jobs2]) {
          if (seen.has(j.id)) continue;
          seen.add(j.id);
          const score = Number(j.relevanceScore ?? j.score ?? 0);
          if (score <= 60) continue;
          if (queue.length >= 150) break;
          let url = (j.jobUrl || j.absolute_url || j.applyUrl || "").replace(/\/$/, "");
          if (!url) continue;
          if (!url.includes("/application")) url += "/application";
          url += (url.includes("?") ? "&" : "?") + "jwaudit=1";
          if (!url.includes("ashbyhq.com")) continue;
          queue.push({ id: j.id, title: j.title || j.jobTitle || "", companyName: j.companyName || "", url });
        }
        console.log("[JobWatch Audit] Eligible queue:", queue.length);

        if (!queue.length) { sendResponse({ ok: true, total: 0 }); return; }

        audit.queue  = queue;
        audit.total  = queue.length;
        audit.active = true;
        await auditOpenNext();
        sendResponse({ ok: true, total: queue.length });
        return;
      }

      // ── Audit: popup polls progress ───────────────────────────────────────
      if (message.type === "GET_ASHBY_AUDIT_STATUS") {
        sendResponse({
          ok:      true,
          active:  audit.active,
          done:    audit.done,
          skipped: audit.skipped,
          total:   audit.total,
          index:   audit.index,
        });
        return;
      }

      // ── Audit: popup stops audit ──────────────────────────────────────────
      if (message.type === "STOP_ASHBY_AUDIT") {
        if (audit.tabId) chrome.tabs.remove(audit.tabId).catch(() => {});
        auditReset();
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

    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // keep message channel open for async response
});
