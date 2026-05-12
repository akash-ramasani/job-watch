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
      }
    } catch (err) {
      console.warn("[JobWatch] Prefetch failed:", err.message);
    }
  })();
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
        let { pendingJob } = await new Promise((r) =>
          chrome.storage.session.get("pendingJob", r)
        );

        // ── Fallback: service worker may have restarted, clearing session ──
        // Extract the Ashby job UUID from the tab URL and query Firestore.
        if (!pendingJob?.locationName) {
          try {
            const tabUrl = sender?.tab?.url || "";
            // Ashby URL pattern: /jobs.ashbyhq.com/{org}/{uuid}/application
            const uuidMatch = tabUrl.match(
              /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i
            );
            if (uuidMatch) {
              const externalId = uuidMatch[1];
              const { idToken: tok, uid: u } = await getFreshToken();
              // Query jobs collection by externalId
              const jobs = await fsQuery(
                `users/${u}`,
                "jobs",
                [{ fieldFilter: { field: { fieldPath: "externalId" }, op: "EQUAL", value: { stringValue: externalId } } }],
                tok,
                1
              );
              if (jobs.length) {
                pendingJob = { ...jobs[0], ...(pendingJob || {}) };
                console.log("[JobWatch] Recovered pendingJob from Firestore:", pendingJob.locationName);
              }
            }
          } catch (lookupErr) {
            console.warn("[JobWatch] Job lookup from URL failed:", lookupErr.message);
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

        let funcToRun = setReactFile;
        let argsToRun = [id, b64Data, fileName];
        if (action === "setInput") { funcToRun = setReactValue; argsToRun = [id, value]; }
        if (action === "typeCharByChar") { funcToRun = typeCharByChar; argsToRun = [id, value]; }

        chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
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
            if (tabId) chrome.tabs.remove(tabId).catch(() => { });

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

        // Query jobs with relevanceScore > 40
        const jobs = await fsQuery(`users/${uid}`, "jobs", [{
          fieldFilter: {
            field: { fieldPath: "relevanceScore" },
            op: "GREATER_THAN",
            value: { integerValue: "40" },
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

      // ── 9b. Popup: get live eligible + applied counts from Firestore ──────
      if (message.type === "GET_ELIGIBLE_COUNT") {
        const { idToken, uid } = await getFreshToken();

        // All jobs with relevanceScore > 40
        const allEligible = await fsQuery(`users/${uid}`, "jobs", [{
          fieldFilter: {
            field: { fieldPath: "relevanceScore" },
            op: "GREATER_THAN",
            value: { integerValue: "40" },
          },
        }], idToken);

        const ashbyEligible = allEligible.filter(j => {
          const src = (j.source || "").toLowerCase();
          return src === "ashby" || src === "ashbyhq";
        });

        const applied = ashbyEligible.filter(j => j.autoApplied).length;
        const remaining = ashbyEligible.filter(j => !j.autoApplied).length;

        sendResponse({ ok: true, total: ashbyEligible.length, applied, remaining });
        return;
      }

      // ── 10b. Popup: audit Ashby forms → download txt ─────────────────────
      if (message.type === "AUDIT_ASHBY_FORMS") {
        const HOURS = message.hours || 24;
        const TIMEOUT_MS = message.timeout || 12_000;  // skip after 12s
        const cutoffMs = Date.now() - HOURS * 60 * 60 * 1000;

        const { idToken, uid } = await getFreshToken();

        // 1. Query Firestore for recent Ashby jobs
        const rows = await fsQuery(`users/${uid}`, "jobs", [
          {
            fieldFilter: {
              field: { fieldPath: "source" },
              op: "EQUAL",
              value: { stringValue: "ashbyhq" },
            },
          },
        ], idToken, 500);

        const jobs = rows.filter(j => {
          // parseFs returns timestampValue as ISO string e.g. "2026-05-11T23:00:00Z"
          const raw = j.createdAt || j.sourceUpdatedTs || j.sourceUpdatedIso;
          if (!raw) return true; // include if no date field at all
          const ms = new Date(raw).getTime();
          return !isNaN(ms) && ms >= cutoffMs;
        });

        // Report back job count immediately
        await chrome.storage.session.set({
          auditState: { phase: "fetching", total: jobs.length, done: 0, errors: 0 }
        });
        sendResponse({ ok: true, total: jobs.length });

        // 2. Fetch each form page and build the combined text
        const lines = [
          `ASHBY FORM AUDIT — ${new Date().toISOString()}`,
          `Jobs scraped : ${jobs.length}  (total ashbyhq in db: ${rows.length})`,
          `Look-back   : last ${HOURS}h`,
          `Generated by: JobWatch Extension`,
          `${"=".repeat(80)}`,
          "",
        ];

        let done = 0;
        let errors = 0;

        for (const j of jobs) {
          const applyUrl = j.jobUrl ? `${j.jobUrl.replace(/\/$/, "")}/application` : null;

          lines.push(`${"=".repeat(80)}`);
          lines.push(`JOB:     ${j.title || "Unknown Title"}`);
          lines.push(`COMPANY: ${j.companyKey || "unknown"}`);
          lines.push(`URL:     ${applyUrl || "—"}`);
          lines.push(`DOC_ID:  ${j._docId || ""}`);
          lines.push(`CREATED: ${j.createdAt?.seconds ? new Date(j.createdAt.seconds * 1000).toISOString() : ""}`);
          lines.push(`${"=".repeat(80)}`);

          if (!applyUrl) {
            lines.push("[SKIPPED: no jobUrl]");
            lines.push("");
            errors++;
          } else {
            try {
              const ctrl = new AbortController();
              const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

              const res = await fetch(applyUrl, {
                signal: ctrl.signal,
                headers: {
                  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
                  "Accept": "text/html,application/xhtml+xml,*/*;q=0.9",
                  "Accept-Language": "en-US,en;q=0.9",
                },
              });
              clearTimeout(timer);

              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const html = await res.text();
              lines.push(html);
              lines.push("");
              done++;
            } catch (err) {
              lines.push(`[ERROR: ${err.message}]`);
              lines.push("");
              errors++;
            }
          }

          await chrome.storage.session.set({
            auditState: { phase: "fetching", total: jobs.length, done, errors }
          });
        }

        // 3. Build file and trigger download
        const content = lines.join("\n");
        const bytes = new TextEncoder().encode(content);
        const b64 = (() => {
          let binary = "";
          const chunkSize = 8192;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
          }
          return btoa(binary);
        })();

        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const filename = `ashby_forms_${ts}.txt`;

        await chrome.downloads.download({
          url: `data:text/plain;charset=utf-8;base64,${b64}`,
          filename,
          saveAs: false,
        });

        await chrome.storage.session.set({
          auditState: { phase: "done", total: jobs.length, done, errors, filename }
        });

        return; // sendResponse already called above
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

    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // keep message channel open for async response
});
