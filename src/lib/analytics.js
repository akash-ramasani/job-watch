// ── Analytics façade ──────────────────────────────────────────────────────────
// Single entry point for product analytics so call sites don't import three
// SDKs. Currently fans out to:
//   • Firebase Analytics (GA4)  — always on if measurementId is configured
//   • PostHog                    — if VITE_POSTHOG_KEY is set
//
// Design notes:
//   • Firebase Analytics initializes asynchronously. We queue events fired
//     before init completes and flush once it's ready, so early signals
//     (signup, first page_view) are never dropped.
//   • Every call is wrapped in a try/catch — analytics MUST NEVER break the
//     app. Failures are logged once and swallowed.
//   • PII (emails, names, raw resume text, job descriptions) must never be
//     passed as event parameters. Identifiers should be opaque UIDs.
// ─────────────────────────────────────────────────────────────────────────────

import { logEvent as fbLogEvent, setUserId as fbSetUserId, setUserProperties as fbSetUserProperties } from "firebase/analytics";
import posthog from "posthog-js";
import { analytics as firebaseAnalyticsPromiseSlot } from "../firebase";

let firebaseReady = false;
let posthogReady = false;
const pendingEvents = [];
const pendingIdentify = { uid: null, props: null };

// Firebase Analytics is initialized via a promise inside firebase.js that sets
// the exported `analytics` variable when ready. Poll for it on first use so
// we don't have to refactor firebase.js to expose the promise.
function tryFlushFirebase() {
  if (firebaseReady) return true;
  // Read the live binding from firebase.js — it updates from null to the
  // analytics instance once the async support check resolves.
  const fa = firebaseAnalyticsPromiseSlot;
  if (!fa) return false;
  firebaseReady = true;
  if (pendingIdentify.uid) {
    try { fbSetUserId(fa, pendingIdentify.uid); } catch { /* noop */ }
  }
  if (pendingIdentify.props) {
    try { fbSetUserProperties(fa, pendingIdentify.props); } catch { /* noop */ }
  }
  for (const { name, params } of pendingEvents.splice(0)) {
    try { fbLogEvent(fa, name, params); } catch { /* noop */ }
  }
  return true;
}

// Poll a few times on startup — Firebase Analytics support check usually
// resolves within a few hundred ms.
if (typeof window !== "undefined") {
  let attempts = 0;
  const id = setInterval(() => {
    attempts += 1;
    if (tryFlushFirebase() || attempts > 20) clearInterval(id);
  }, 250);
}

// ── PostHog init ──────────────────────────────────────────────────────────────
const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY;
const POSTHOG_HOST = import.meta.env.VITE_POSTHOG_HOST || "https://us.i.posthog.com";
if (POSTHOG_KEY && typeof window !== "undefined") {
  try {
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      // Capture pageviews manually via trackPageView() so SPA route changes
      // are recorded (PostHog's auto-capture only fires on hard nav).
      capture_pageview: false,
      capture_pageleave: true,
      person_profiles: "identified_only",
      // Mask all input fields in session recordings by default. We only need
      // the visual flow, not what users type.
      session_recording: {
        maskAllInputs: true,
      },
      loaded: () => { posthogReady = true; },
    });
  } catch (err) {
    console.warn("[analytics] PostHog init failed:", err?.message);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function track(eventName, params = {}) {
  if (!eventName) return;
  const safeParams = sanitize(params);
  // Firebase
  tryFlushFirebase();
  if (firebaseReady && firebaseAnalyticsPromiseSlot) {
    try { fbLogEvent(firebaseAnalyticsPromiseSlot, eventName, safeParams); }
    catch { /* noop */ }
  } else {
    pendingEvents.push({ name: eventName, params: safeParams });
  }
  // PostHog
  if (posthogReady) {
    try { posthog.capture(eventName, safeParams); } catch { /* noop */ }
  }
}

export function identify(uid, properties = {}) {
  if (!uid) return;
  const safeProps = sanitize(properties);
  // Firebase
  tryFlushFirebase();
  if (firebaseReady && firebaseAnalyticsPromiseSlot) {
    try {
      fbSetUserId(firebaseAnalyticsPromiseSlot, uid);
      if (Object.keys(safeProps).length) fbSetUserProperties(firebaseAnalyticsPromiseSlot, safeProps);
    } catch { /* noop */ }
  } else {
    pendingIdentify.uid = uid;
    pendingIdentify.props = safeProps;
  }
  // PostHog
  if (posthogReady) {
    try { posthog.identify(uid, safeProps); } catch { /* noop */ }
  }
}

export function reset() {
  if (posthogReady) {
    try { posthog.reset(); } catch { /* noop */ }
  }
  // Firebase Analytics has no real "reset" — clear the userId.
  tryFlushFirebase();
  if (firebaseReady && firebaseAnalyticsPromiseSlot) {
    try { fbSetUserId(firebaseAnalyticsPromiseSlot, null); } catch { /* noop */ }
  }
}

export function trackPageView(path, title) {
  track("page_view", {
    page_path: path,
    page_title: title || (typeof document !== "undefined" ? document.title : undefined),
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const PII_KEYS = new Set(["email", "password", "phone", "ssn", "address", "name", "firstName", "lastName", "fullName", "resume", "jobDescription", "coverLetter"]);
function sanitize(obj) {
  if (!obj || typeof obj !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (PII_KEYS.has(k)) continue;
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.length > 200) {
      out[k] = v.slice(0, 200);
    } else if (typeof v === "object") {
      // Don't try to deep-sanitize — analytics events should be flat.
      continue;
    } else {
      out[k] = v;
    }
  }
  return out;
}
