/**
 * useSessionGuard.js — Single-session enforcement hook.
 *
 * DESIGN PRINCIPLES:
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. The session token lives in localStorage so it survives page refreshes and
 *    is shared across all tabs in the same browser profile.
 *
 * 2. We use a single onSnapshot listener (Layer 1) as the primary ejection
 *    mechanism. The heartbeat (Layer 2) is a safety net for stale WS streams.
 *
 * 3. All refs are used so closures never go stale. No function or effect
 *    depends on `user` directly — instead we access it via userRef.current.
 *    This means effects only run ONCE and are never torn down/rebuilt as
 *    Firebase refreshes the ID token, eliminating listener restart races.
 *
 * 4. ejectSession never calls signOut(). It only shows the modal. The user
 *    must acknowledge the modal and click the button, which calls signOut().
 *    This prevents the modal from vanishing faster than the eye can see.
 *
 * 5. The REGISTERING guard suppresses ejection while registerSession HTTP
 *    call is in-flight (server writes new token BEFORE HTTP response returns).
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { doc, onSnapshot, getDoc } from "firebase/firestore";
import { signOut } from "firebase/auth";
import { auth, db } from "../firebase";

const SESSION_KEY       = "jw_session_token";
const BROADCAST_CHANNEL = "jw_session";
const HEARTBEAT_MS      = 60_000; // check every 60s (was 30s — less aggressive)
const REGISTER_URL      =
  import.meta.env.VITE_REGISTER_SESSION_URL ||
  "https://us-central1-greenhouse-jobs-scrapper.cloudfunctions.net/registerSession";

export function useSessionGuard(user) {
  const [ejected, setEjected]                     = useState(false);
  const [ejectedDeviceInfo, setEjectedDeviceInfo] = useState(null);

  // All state kept in refs so closures never go stale ─────────────────────────
  const userRef         = useRef(user);
  const tokenRef        = useRef(null);
  const registeredRef   = useRef(false);
  const registeringRef  = useRef(false);  // true while HTTP call is in-flight
  const ejectedRef      = useRef(false);
  const wasLoggedInRef  = useRef(false);
  const channelRef      = useRef(null);
  const snapshotUnsub   = useRef(null);   // keep one stable listener

  // Keep userRef in sync without causing effect reruns
  useEffect(() => { userRef.current = user; }, [user]);

  // ── Eject (show modal only — do NOT call signOut) ─────────────────────────
  const ejectSession = useCallback((deviceInfo = null) => {
    if (ejectedRef.current)     return; // already ejected
    if (registeringRef.current) return; // mid-registration — ignore

    ejectedRef.current = true;
    console.warn("[SessionGuard] ⛔ EJECTED — deviceInfo:", JSON.stringify(deviceInfo));
    console.trace("[SessionGuard] ejection call stack"); // shows exactly which line called ejectSession

    localStorage.removeItem(SESSION_KEY);
    tokenRef.current = null;

    if (deviceInfo) setEjectedDeviceInfo(deviceInfo);
    setEjected(true);

    // We do NOT broadcast EJECTED anymore.
    // Broadcasting EJECTED causes a chain reaction where a stale background tab
    // waking up can accidentally kill the active tab's session.
    // Every tab independently monitors localStorage and Firestore, so they will
    // all naturally eject themselves when they see the token disappear.
    // NOTE: signOut is intentionally NOT called here.
    // The SessionEjectedModal stays visible until user clicks "Sign in again".
  }, []);

  // ── Check Firestore token against local token ─────────────────────────────
  const checkToken = useCallback(async (source = "unknown") => {
    const u = userRef.current;
    if (!u || ejectedRef.current || registeringRef.current) {
      console.log(`[SessionGuard] checkToken(${source}) skipped — user:${!!u} ejected:${ejectedRef.current} registering:${registeringRef.current}`);
      return;
    }

    // ALWAYS prefer localStorage over memory to catch updates from sibling tabs
    // while this tab was asleep/frozen by the browser.
    const localToken = localStorage.getItem(SESSION_KEY) || tokenRef.current;
    if (!localToken) {
      console.log(`[SessionGuard] checkToken(${source}) skipped — no local token yet`);
      return; // still initialising — never eject
    }

    console.log(`[SessionGuard] checkToken(${source}) — localToken: ${localToken.slice(0, 8)}…`);

    try {
      const snap = await getDoc(doc(db, "users", u.uid));
      if (!snap.exists()) return;
      const serverToken = snap.data()?.activeSession?.token;

      console.log(`[SessionGuard] checkToken(${source}) — serverToken: ${serverToken ? serverToken.slice(0, 8) + "…" : "none"} match:${serverToken === localToken}`);

      if (serverToken && serverToken === localToken) {
        // Quietly update memory in case a sibling tab updated localStorage while we slept
        tokenRef.current = localToken;
        registeredRef.current = true;
      }

      if (serverToken && serverToken !== localToken) {
        const d = snap.data();
        console.warn(`[SessionGuard] TOKEN MISMATCH via ${source}! Ejecting.`);
        ejectSession({
          browser:    d.activeSession?.browser    || null,
          os:         d.activeSession?.os         || null,
          deviceType: d.activeSession?.deviceType || null,
          ip:         d.activeSession?.ip
            ? d.activeSession.ip.slice(0, 6) + "***"
            : null,
        });
      }
    } catch (err) {
      // Network error — don't eject. Heartbeat will retry.
      console.warn(`[SessionGuard] checkToken(${source}) failed:`, err.message);
    }
  }, [ejectSession]); // ejectSession is stable (no deps)

  // ── Register session with server ──────────────────────────────────────────
  const registerSession = useCallback(async (firebaseUser) => {
    if (!firebaseUser)          return;
    if (registeredRef.current)  return;
    if (registeringRef.current) return;
    if (ejectedRef.current)     return;

    registeringRef.current = true;
    try { channelRef.current?.postMessage({ type: "REGISTERING" }); } catch {}

    try {
      const idToken = await firebaseUser.getIdToken(); // do NOT force refresh here — avoids extra network roundtrip
      const resp = await fetch(REGISTER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ screenWidth: window.innerWidth }),
      });

      if (!resp.ok) {
        console.warn("[SessionGuard] registerSession HTTP error:", resp.status);
        return;
      }

      const data = await resp.json();
      if (data.ok && data.sessionToken) {
        tokenRef.current      = data.sessionToken;
        registeredRef.current = true;
        localStorage.setItem(SESSION_KEY, data.sessionToken);

        try {
          channelRef.current?.postMessage({
            type:  "SESSION_REGISTERED",
            token: data.sessionToken,
          });
        } catch {}

        console.info("[SessionGuard] ✓ session registered",
          data.device?.deviceType, data.device?.browser);
      }
    } catch (err) {
      console.warn("[SessionGuard] registerSession error:", err.message);
    } finally {
      registeringRef.current = false;
    }
  }, []); // no deps — uses no state/props

  // ── BroadcastChannel — cross-tab sync (runs once on mount) ───────────────
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(BROADCAST_CHANNEL);
    channelRef.current = channel;

    channel.onmessage = ({ data: msg }) => {
      if (!msg) return;

      if (msg.type === "REGISTERING") {
        registeringRef.current = true;
      }
      if (msg.type === "SESSION_REGISTERED" && msg.token) {
        tokenRef.current      = msg.token;
        registeredRef.current = true;
        registeringRef.current = false;
        localStorage.setItem(SESSION_KEY, msg.token);
      }
      // We no longer listen for EJECTED broadcasts to prevent chain reactions.
      // If a sibling tab ejects, it clears localStorage, which this tab will
      // detect on its next checkToken or visibility change.
    };

    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [ejectSession]); // ejectSession is stable

  // ── Firestore realtime listener — runs ONCE, never rebuilt ───────────────
  // We keep one stable listener for the lifetime of the hook.
  // It reads userRef.current instead of closing over `user`.
  useEffect(() => {
    // We need uid to start listening. Wait until user is available.
    if (!user) return;
    if (snapshotUnsub.current) return; // already listening

    snapshotUnsub.current = onSnapshot(
      doc(db, "users", user.uid),
      (snap) => {
        if (!snap.exists() || ejectedRef.current || registeringRef.current) {
          console.log(`[SessionGuard] snapshot skipped — exists:${snap.exists()} ejected:${ejectedRef.current} registering:${registeringRef.current}`);
          return;
        }

        const serverToken = snap.data()?.activeSession?.token;
        // ALWAYS prefer localStorage over memory to catch sibling tab updates
        const localToken  = localStorage.getItem(SESSION_KEY) || tokenRef.current;

        console.log(`[SessionGuard] snapshot — localToken:${localToken ? localToken.slice(0,8)+"…" : "NONE"} serverToken:${serverToken ? serverToken.slice(0,8)+"…" : "NONE"} match:${serverToken === localToken}`);

        if (!localToken) return; // still initialising — skip

        if (serverToken && serverToken === localToken) {
           tokenRef.current = localToken;
           registeredRef.current = true;
        }

        if (serverToken && serverToken !== localToken) {
          console.warn("[SessionGuard] snapshot TOKEN MISMATCH — ejecting!");
          const d = snap.data();
          ejectSession({
            browser:    d.activeSession?.browser    || null,
            os:         d.activeSession?.os         || null,
            deviceType: d.activeSession?.deviceType || null,
            ip:         d.activeSession?.ip
              ? d.activeSession.ip.slice(0, 6) + "***"
              : null,
          });
        }
      },
      (error) => {
        // Transient errors (reconnecting after sleep/suspend) — ignore.
        // A genuine auth failure will be caught by Firebase's own signOut.
        console.warn("[SessionGuard] snapshot error, ignoring:", error.code);
      }
    );

    return () => {
      if (snapshotUnsub.current) {
        snapshotUnsub.current();
        snapshotUnsub.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!user]); // only re-run when user goes null → non-null (login/logout)

  // ── Visibility check (reads once when tab regains focus, NOT periodic) ──────────
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible" && !ejectedRef.current) {
        console.log("[SessionGuard] tab became visible — running checkToken");
        checkToken("visibility");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [checkToken]); // checkToken is stable

  // ── User lifecycle: register or restore ──────────────────────────────────
  useEffect(() => {
    if (!user) {
      if (!wasLoggedInRef.current) return; // Cold load — Firebase still initialising

      // Genuine sign-out (user clicked logout or was ejected + confirmed modal)
      wasLoggedInRef.current = false;
      registeredRef.current  = false;
      registeringRef.current = false;
      tokenRef.current       = null;
      ejectedRef.current     = false;
      localStorage.removeItem(SESSION_KEY);
      setEjected(false);
      setEjectedDeviceInfo(null);

      // Stop snapshot listener — will restart on next login
      if (snapshotUnsub.current) {
        snapshotUnsub.current();
        snapshotUnsub.current = null;
      }
      return;
    }

    wasLoggedInRef.current = true;

    const storedToken = localStorage.getItem(SESSION_KEY);
    if (storedToken) {
      // Token survived a page refresh — no need to re-register
      tokenRef.current      = storedToken;
      registeredRef.current = true;
      console.info("[SessionGuard] ✓ restored session from localStorage");
    } else if (!registeredRef.current && !registeringRef.current) {
      // Fresh login — register with server
      registerSession(user);
    }
  // Only re-run when the user UID changes (login/logout), not on every token refresh
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid]);

  // ── Modal dismiss ─────────────────────────────────────────────────────────
  const handleEjectedSignOut = useCallback(async () => {
    setEjected(false);
    setEjectedDeviceInfo(null);
    localStorage.removeItem(SESSION_KEY);
    tokenRef.current      = null;
    registeredRef.current = false;
    ejectedRef.current    = false;
    try { await signOut(auth); } catch {}
  }, []);

  return { ejected, ejectedDeviceInfo, handleEjectedSignOut };
}
