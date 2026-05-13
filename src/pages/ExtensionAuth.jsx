/**
 * ExtensionAuth.jsx
 *
 * Handles the enterprise extension authentication flow.
 *
 * How it works:
 *  1. Extension opens this page via chrome.identity.launchWebAuthFlow.
 *  2. If the user is already logged in on the web app, this page automatically:
 *     a. Calls createExtensionCode Cloud Function to get a one-time code.
 *     b. Redirects to https://<ext-id>.chromiumapp.org/callback?code=<code>
 *  3. If not logged in, shows a sign-in prompt.
 *  4. chrome.identity intercepts the chromiumapp.org redirect — the popup closes
 *     and the extension background script receives the final redirect URL.
 */

import React, { useEffect, useState } from "react";
import { auth } from "../firebase";
import { onAuthStateChanged } from "firebase/auth";
import { Link } from "react-router-dom";

const FUNCTIONS_BASE = "https://us-central1-greenhouse-jobs-scrapper.cloudfunctions.net";

export default function ExtensionAuth() {
  const [status, setStatus] = useState("checking"); // checking | authorizing | done | no-session | error
  const [errorMsg, setErrorMsg] = useState("");

  // Get the redirect URI from the query string (sent by chrome.identity)
  const params = new URLSearchParams(window.location.search);
  const redirectUri = params.get("redirect_uri") || "";

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setStatus("no-session");
        return;
      }

      // User is already logged in — mint a one-time code and redirect
      setStatus("authorizing");
      try {
        const idToken = await user.getIdToken();
        const res = await fetch(`${FUNCTIONS_BASE}/createExtensionCode`, {
          method: "POST",
          headers: {
          "X-Session-Token": sessionStorage.getItem("jw_session_token") || "",
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`,
          },
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Failed to create code.");

        // Build the callback URL for the extension
        // redirectUri is: https://<ext-id>.chromiumapp.org/callback
        const callbackUrl = `${redirectUri}?code=${data.code}`;
        setStatus("done");

        // Small visual delay so user sees the "Authorizing…" state
        setTimeout(() => {
          window.location.href = callbackUrl;
        }, 400);
      } catch (err) {
        setErrorMsg(err.message);
        setStatus("error");
      }
    });
    return () => unsub();
  }, [redirectUri]);

  return (
    <div className="min-h-screen bg-white flex items-center justify-center px-4">
      <div className="w-full max-w-sm text-center">
        {/* Logo */}
        <div className="flex justify-center mb-6">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg"
            style={{ background: "linear-gradient(135deg, #4f46e5, #7c3aed)" }}
          >
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
              <text x="16" y="23" fontFamily="Ubuntu,Arial,sans-serif" fontSize="20" fontWeight="700" fill="white" textAnchor="middle">J</text>
            </svg>
          </div>
        </div>

        <h1 className="text-xl font-bold text-gray-900 mb-1">JobWatch Extension</h1>
        <p className="text-sm text-gray-500 mb-8">Connecting your account to the browser extension.</p>

        {status === "checking" && (
          <div className="flex flex-col items-center gap-3">
            <div className="w-6 h-6 rounded-full border-2 border-indigo-200 border-t-indigo-600 animate-spin" />
            <p className="text-sm text-gray-400">Checking session…</p>
          </div>
        )}

        {status === "authorizing" && (
          <div className="flex flex-col items-center gap-3">
            <div className="w-6 h-6 rounded-full border-2 border-indigo-200 border-t-indigo-600 animate-spin" />
            <p className="text-sm font-medium text-indigo-600">Authorizing extension…</p>
            <p className="text-xs text-gray-400">You'll be redirected in a moment.</p>
          </div>
        )}

        {status === "done" && (
          <div className="flex flex-col items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-green-50 flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2.5">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <p className="text-sm font-semibold text-green-700">Success! Redirecting…</p>
          </div>
        )}

        {status === "no-session" && (
          <div className="flex flex-col items-center gap-4">
            <div className="w-10 h-10 rounded-full bg-amber-50 flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2.5">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-800">Not signed in</p>
              <p className="text-xs text-gray-500 mt-1">Sign in to JobWatch first, then click the extension again.</p>
            </div>
            <Link
              to="/login"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white"
              style={{ background: "linear-gradient(135deg, #4f46e5, #7c3aed)" }}
            >
              Sign in to JobWatch →
            </Link>
          </div>
        )}

        {status === "error" && (
          <div className="flex flex-col items-center gap-3">
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-left w-full">
              <p className="text-sm font-semibold text-red-700 mb-1">Authorization failed</p>
              <p className="text-xs text-red-500">{errorMsg}</p>
            </div>
            <button
              onClick={() => window.location.reload()}
              className="text-sm text-indigo-600 hover:underline font-medium"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
