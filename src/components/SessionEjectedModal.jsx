import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

/**
 * Premium session-ejection modal — shown AFTER Firebase signOut() has already
 * been called. This is purely informational; the user is already logged out.
 *
 * Features:
 *   - Non-dismissable (no close button, no clicking outside)
 *   - Auto-redirect countdown (10s → redirects to /login)
 *   - Displays the new session's device fingerprint (browser, device, IP)
 *   - Glassmorphism blur overlay blocks all interaction with the app behind
 *   - Live pulsing security badge for urgency
 */
export default function SessionEjectedModal({ open, deviceInfo, onSignInAgain }) {
  const [countdown, setCountdown] = useState(10);

  // Auto-redirect countdown
  useEffect(() => {
    if (!open) {
      setCountdown(10);
      return;
    }

    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          onSignInAgain?.();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [open, onSignInAgain]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="fixed inset-0 z-[9999] flex items-center justify-center"
          style={{ backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}
        >
          {/* Overlay — blocks all interaction */}
          <div className="absolute inset-0 bg-gray-900/70" />

          {/* Modal Card */}
          <motion.div
            initial={{ opacity: 0, scale: 0.88, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.88, y: 24 }}
            transition={{ type: "spring", damping: 26, stiffness: 320 }}
            className="relative z-10 w-full max-w-md mx-4"
          >
            <div className="rounded-2xl bg-white shadow-2xl ring-1 ring-gray-200/60 overflow-hidden">


              <div className="px-8 pt-8 pb-6 text-center">
                {/* Pulsing security shield */}
                <div className="mx-auto mb-5 relative">
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="h-20 w-20 rounded-full bg-red-100/50 animate-ping" style={{ animationDuration: "2s" }} />
                  </div>
                  <div className="relative flex h-16 w-16 mx-auto items-center justify-center rounded-2xl bg-red-50 ring-1 ring-red-200/60">
                    <svg
                      className="h-8 w-8 text-red-600"
                      fill="none"
                      viewBox="0 0 24 24"
                      strokeWidth={1.5}
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M12 9v3.75m0-10.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285zm0 13.036h.008v.008H12v-.008z"
                      />
                    </svg>
                  </div>
                </div>

                {/* Status badge */}
                <div className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-3 py-1 mb-4 ring-1 ring-red-100">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                  </span>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-red-700">
                    Session terminated
                  </span>
                </div>

                <h2 className="text-xl font-bold text-gray-900 tracking-tight">
                  You've been signed out
                </h2>
                <p className="mt-2 text-sm text-gray-500 leading-relaxed max-w-xs mx-auto">
                  A new login was detected on another device. For security, only one active session is allowed at a time. You have been signed out of this device.
                </p>

                {/* Device info card */}
                {deviceInfo && (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.15 }}
                    className="mt-5 rounded-xl bg-gray-50 ring-1 ring-gray-100 px-5 py-4 text-left"
                  >
                    <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-gray-400 mb-2.5">
                      New session fingerprint
                    </p>
                    <div className="space-y-1.5">
                      {deviceInfo.browser && (
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white ring-1 ring-gray-200/80">
                            <svg className="h-3.5 w-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25A2.25 2.25 0 015.25 3h13.5A2.25 2.25 0 0121 5.25z" />
                            </svg>
                          </span>
                          <span className="text-sm text-gray-700 font-medium">Browser: {deviceInfo.browser}</span>
                        </div>
                      )}
                      {deviceInfo.deviceType && (
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white ring-1 ring-gray-200/80">
                            <svg className="h-3.5 w-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3" />
                            </svg>
                          </span>
                          <span className="text-sm text-gray-700 font-medium">Device: {deviceInfo.deviceType}</span>
                        </div>
                      )}
                      {deviceInfo.ip && (
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white ring-1 ring-gray-200/80">
                            <svg className="h-3.5 w-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
                            </svg>
                          </span>
                          <span className="text-sm text-gray-700 font-medium">IP: {deviceInfo.ip}</span>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </div>

              {/* Footer action */}
              <div className="border-t border-gray-100 bg-gray-50/50 px-8 py-5">
                <button
                  onClick={onSignInAgain}
                  id="session-ejected-sign-in"
                  className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-md shadow-indigo-200 transition-all hover:bg-indigo-700 hover:shadow-lg active:scale-[0.98] focus:outline-none focus:ring-4 focus:ring-indigo-500/20"
                >
                  Sign in again
                </button>
                <p className="mt-3 text-center text-[11px] text-gray-400">
                  Redirecting to sign-in in <span className="font-bold text-gray-600 tabular-nums">{countdown}s</span>
                </p>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
