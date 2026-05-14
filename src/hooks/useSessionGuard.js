/**
 * useSessionGuard.js — Hardened single-session enforcement hook.
 *
 * ── How registration works ──
 *   1. App.jsx passes the Firebase user to this hook.
 *   2. On first user detection (fresh login), we call registerSession which:
 *      a. Sets registeringRef = true  (suppresses snapshot ejection)
 *      b. POSTs to the Cloud Function → gets back a unique sessionToken
 *      c. Stores the token in tokenRef + sessionStorage
 *      d. Sets registeringRef = false
 *   3. The Firestore onSnapshot watches activeSession.token.
 *      If the server token no longer matches ours → another device logged in → eject us.
 *
 * ── Why registeringRef matters ──
 *   The HTTP round-trip takes ~200–600ms. During that window the Firestore snapshot
 *   can fire (because the server just wrote the new token). Without registeringRef,
 *   the snapshot sees serverToken ≠ localToken (null) and ejects the NEW device —
 *   the exact bug we're fixing.
 *
 * ── Defense-in-depth layers ──
 *   Layer 1: Firestore onSnapshot  → sub-second ejection when token changes
 *   Layer 2: Heartbeat (30s)       → catches cases where snapshot stream is stale
 *   Layer 3: Visibility API        → re-checks immediately when tab is focused
 *   Layer 4: BroadcastChannel      → instant cross-tab coordination
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { doc, onSnapshot, getDoc } from "firebase/firestore";
import { signOut } from "firebase/auth";
import { auth, db } from "../firebase";

const SESSION_KEY        = "jw_session_token";
const BROADCAST_CHANNEL  = "jw_session";
const HEARTBEAT_MS       = 30_000;
const REGISTER_URL       =
  import.meta.env.VITE_REGISTER_SESSION_URL ||
  "https://us-central1-greenhouse-jobs-scrapper.cloudfunctions.net/registerSession";

export function useSessionGuard(user) {
  const [ejected, setEjected]               = useState(false);
  const [ejectedDeviceInfo, setEjectedDeviceInfo] = useState(null);

  // ── Refs (don't trigger re-renders) ──────────────────────────────────────────
  const tokenRef        = useRef(null);   // Our session token
  const registeredRef   = useRef(false);  // Have we completed registration?
  const registeringRef  = useRef(false);  // Are we mid-registration? Suppresses ejection.
  const ejectedRef      = useRef(false);  // Prevents double-ejection
  const channelRef      = useRef(null);
  const heartbeatRef    = useRef(null);

  // ── Eject this session ────────────────────────────────────────────────────────
  const ejectSession = useCallback(async (deviceInfo = null) => {
    if (ejectedRef.current) return;       // Already ejecting
    if (registeringRef.current) return;   // Mid-registration — don't self-eject

    ejectedRef.current = true;
    console.warn("[SessionGuard] ⛔ EJECTED — signing out.");

    if (deviceInfo) setEjectedDeviceInfo(deviceInfo);
    setEjected(true);

    sessionStorage.removeItem(SESSION_KEY);
    tokenRef.current   = null;

    // Tell all other tabs to eject too
    try { channelRef.current?.postMessage({ type: "EJECTED", deviceInfo }); } catch {}

    try { await signOut(auth); } catch {}
  }, []);

  // ── Register a brand-new session with the server ──────────────────────────────
  const registerSession = useCallback(async (firebaseUser) => {
    if (!firebaseUser)            return;
    if (registeredRef.current)    return;  // Already registered (e.g. page refresh)
    if (registeringRef.current)   return;  // Already in-flight

    registeringRef.current = true;         // ← suppress snapshot ejection during HTTP call

    try {
      const idToken = await firebaseUser.getIdToken(true);
      const resp = await fetch(REGISTER_URL, {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          Authorization:   `Bearer ${idToken}`,
        },
      });

      if (!resp.ok) {
        console.warn("[SessionGuard] registerSession HTTP error:", resp.status);
        registeringRef.current = false;
        return;
      }

      const data = await resp.json();
      if (data.ok && data.sessionToken) {
        // ── Store token BEFORE clearing registeringRef ──
        // The snapshot might fire immediately after this; having the token set
        // ensures we won't eject ourselves on our own token write.
        tokenRef.current = data.sessionToken;
        sessionStorage.setItem(SESSION_KEY, data.sessionToken);
        registeredRef.current = true;

        // Tell sibling tabs on the same browser about the new token
        try {
          channelRef.current?.postMessage({
            type:  "SESSION_REGISTERED",
            token: data.sessionToken,
          });
        } catch {}

        console.info("[SessionGuard] ✓ Session registered:",
          data.device?.deviceType, data.device?.browser);
      }
    } catch (err) {
      console.warn("[SessionGuard] registerSession error:", err.message);
    } finally {
      // Always clear the registering guard so future snapshots work normally
      registeringRef.current = false;
    }
  }, []);

  // ── Heartbeat check (Layer 2) ─────────────────────────────────────────────────
  const runHeartbeat = useCallback(async () => {
    if (!user || ejectedRef.current || registeringRef.current) return;

    const localToken = tokenRef.current || sessionStorage.getItem(SESSION_KEY);
    if (!localToken) return;

    try {
      const snap = await getDoc(doc(db, "users", user.uid));
      if (!snap.exists()) return;

      const serverToken = snap.data()?.activeSession?.token;
      if (serverToken && serverToken !== localToken) {
        const d = snap.data();
        ejectSession({
          browser:    d.activeSession?.browser    || null,
          deviceType: d.activeSession?.deviceType || null,
          ip:         d.activeSession?.ip ? d.activeSession.ip.slice(0, 6) + "***" : null,
        });
      }
    } catch (err) {
      // Network blip — don't eject. Retry on next heartbeat.
      console.warn("[SessionGuard] Heartbeat failed:", err.message);
    }
  }, [user, ejectSession]);

  // ── BroadcastChannel — multi-tab coordination (Layer 4) ──────────────────────
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;

    const channel = new BroadcastChannel(BROADCAST_CHANNEL);
    channelRef.current = channel;

    channel.onmessage = ({ data: msg }) => {
      if (!msg) return;
      if (msg.type === "EJECTED") {
        ejectSession(msg.deviceInfo);
      }
      if (msg.type === "SESSION_REGISTERED" && msg.token) {
        // Another tab on this device registered — adopt its token so we don't
        // get erroneously ejected when the snapshot fires here.
        tokenRef.current = msg.token;
        sessionStorage.setItem(SESSION_KEY, msg.token);
        registeredRef.current = true;
      }
    };

    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [ejectSession]);

  // ── User lifecycle — register or restore session ──────────────────────────────
  useEffect(() => {
    if (!user) {
      // User signed out — full reset
      registeredRef.current  = false;
      registeringRef.current = false;
      tokenRef.current       = null;
      ejectedRef.current     = false;
      sessionStorage.removeItem(SESSION_KEY);
      setEjected(false);
      setEjectedDeviceInfo(null);
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      return;
    }

    const storedToken = sessionStorage.getItem(SESSION_KEY);
    if (storedToken) {
      // Page refresh — token already in sessionStorage, no need to re-register
      tokenRef.current      = storedToken;
      registeredRef.current = true;
    } else {
      // Fresh login — register with the server
      registerSession(user);
    }
  }, [user, registerSession]);

  // ── Layer 1: Firestore realtime listener ──────────────────────────────────────
  useEffect(() => {
    if (!user) return;

    const unsubscribe = onSnapshot(
      doc(db, "users", user.uid),
      (snap) => {
        // Ignore if already ejected or if we're mid-registration
        if (!snap.exists() || ejectedRef.current || registeringRef.current) return;

        const serverToken = snap.data()?.activeSession?.token;
        const localToken  = tokenRef.current || sessionStorage.getItem(SESSION_KEY);

        // No local token yet → still registering or not yet started; skip
        if (!localToken) return;

        // Token mismatch → another device logged in → eject
        if (serverToken && serverToken !== localToken) {
          const d = snap.data();
          ejectSession({
            browser:    d.activeSession?.browser    || null,
            deviceType: d.activeSession?.deviceType || null,
            ip:         d.activeSession?.ip ? d.activeSession.ip.slice(0, 6) + "***" : null,
          });
        }
      },
      (error) => {
        console.warn("[SessionGuard] Firestore listener error:", error.code);
        // permission-denied after revocation is a signal the session is dead
        if (error.code === "permission-denied" || error.code === "unauthenticated") {
          ejectSession(null);
        }
      }
    );

    return () => unsubscribe();
  }, [user, ejectSession]);

  // ── Layer 2 + 3: Heartbeat + Visibility API ───────────────────────────────────
  useEffect(() => {
    if (!user) return;

    heartbeatRef.current = setInterval(runHeartbeat, HEARTBEAT_MS);

    const handleVisibility = () => {
      if (document.visibilityState === "visible" && !ejectedRef.current) {
        runHeartbeat();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [user, runHeartbeat]);

  // ── Modal dismiss ─────────────────────────────────────────────────────────────
  const handleEjectedSignOut = useCallback(async () => {
    setEjected(false);
    setEjectedDeviceInfo(null);
    sessionStorage.removeItem(SESSION_KEY);
    tokenRef.current      = null;
    registeredRef.current = false;
    ejectedRef.current    = false;
    try { await signOut(auth); } catch {}
  }, []);

  return { ejected, ejectedDeviceInfo, handleEjectedSignOut };
}
