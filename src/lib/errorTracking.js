// ── Sentry error tracking (gated on VITE_SENTRY_DSN) ─────────────────────────
// Initializes Sentry only when a DSN is provided so dev / preview builds
// without the env var stay quiet. Captures unhandled errors, promise
// rejections, console errors, and (optionally) tracing for slow operations.
//
// To enable in production:
//   1. Sign up at https://sentry.io (free tier: 5k errors/mo).
//   2. Create a React project, copy its DSN.
//   3. Add VITE_SENTRY_DSN=https://...@sentry.io/... in Vercel env vars.
//   4. Redeploy. That's it — no further code changes needed.
// ─────────────────────────────────────────────────────────────────────────────

import * as Sentry from "@sentry/react";

let initialized = false;

export function initErrorTracking() {
  if (initialized) return;
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;
  try {
    Sentry.init({
      dsn,
      environment: import.meta.env.MODE || "production",
      // Capture 10% of transactions for performance monitoring in prod,
      // 100% in dev so you can see traces locally.
      tracesSampleRate: import.meta.env.MODE === "production" ? 0.1 : 1.0,
      // Capture 10% of sessions for replay, 100% of sessions with errors.
      replaysSessionSampleRate: 0.1,
      replaysOnErrorSampleRate: 1.0,
      integrations: [
        Sentry.browserTracingIntegration(),
        Sentry.replayIntegration({
          maskAllText: false,
          maskAllInputs: true,
          blockAllMedia: false,
        }),
      ],
      // Don't ship local-only noise.
      ignoreErrors: [
        "ResizeObserver loop limit exceeded",
        "ResizeObserver loop completed with undelivered notifications",
        /^Non-Error promise rejection captured/,
      ],
    });
    initialized = true;
  } catch (err) {
    console.warn("[errorTracking] Sentry init failed:", err?.message);
  }
}

export function identifyUserForErrors(uid, props = {}) {
  if (!initialized || !uid) return;
  try {
    Sentry.setUser({ id: uid, ...props });
  } catch { /* noop */ }
}

export function clearUserForErrors() {
  if (!initialized) return;
  try { Sentry.setUser(null); } catch { /* noop */ }
}

export function reportError(error, context = {}) {
  if (initialized) {
    try { Sentry.captureException(error, { extra: context }); } catch { /* noop */ }
  }
  // Always log to console too so dev sees it.
  console.error("[reportError]", error, context);
}

export { Sentry };
