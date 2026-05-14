/**
 * useSessionGuard.js — Single-session enforcement hook.
 *
 * Key design decisions:
 *
 * 1. wasLoggedInRef — prevents the initial user=null render from clearing
 *    sessionStorage. On page refresh, React starts with user=null before
 *    Firebase restores the persisted auth. Without this guard, sessionStorage
 *    gets wiped on every refresh → registerSession fires every time → new
 *    token → all other tabs/devices get ejected just from a refresh.
 *
 * 2. registeringRef — suppresses snapshot ejection during the HTTP round-trip
 *    to registerSession. The server writes the new token to Firestore BEFORE
 *    the HTTP response arrives. Without this flag, the snapshot fires and sees
 *    serverToken ≠ localToken (null) → self-ejects the new device.
 *
 * 3. REGISTERING broadcast — when one tab starts re-registering (e.g. fresh
 *    login), it tells sibling tabs to temporarily suppress ejection, then
 *    SESSION_REGISTERED updates their token when done.
 *
 * Ejection layers:
 *   L1: Firestore onSnapshot  — sub-second, real-time
 *   L2: Heartbeat (30s)       — catches stale snapshot streams
 *   L3: Visibility API        — immediate check on tab focus
 *   L4: BroadcastChannel      — cross-tab instant sync
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { doc, onSnapshot, getDoc } from "firebase/firestore";
import { signOut } from "firebase/auth";
import { auth, db } from "../firebase";

const SESSION_KEY       = "jw_session_token";
const BROADCAST_CHANNEL = "jw_session";
const HEARTBEAT_MS      = 30_000;
const REGISTER_URL      =
  import.meta.env.VITE_REGISTER_SESSION_URL ||
  "https://us-central1-greenhouse-jobs-scrapper.cloudfunctions.net/registerSession";

export function useSessionGuard(user) {
  const [ejected, setEjected]                   = useState(false);
  const [ejectedDeviceInfo, setEjectedDeviceInfo] = useState(null);

  const tokenRef        = useRef(null);
  const registeredRef   = useRef(false);
  const registeringRef  = useRef(false);  // true while HTTP call is in-flight
  const ejectedRef      = useRef(false);
  const wasLoggedInRef  = useRef(false);  // ← KEY: was user non-null before?
  const channelRef      = useRef(null);
  const heartbeatRef    = useRef(null);

  // ── Eject ──────────────────────────────────────────────────────────────────
  const ejectSession = useCallback(async (deviceInfo = null) => {
    if (ejectedRef.current)   return;
    if (registeringRef.current) return; // Never self-eject during registration

    ejectedRef.current = true;
    console.warn("[SessionGuard] ⛔ EJECTED");

    if (deviceInfo) setEjectedDeviceInfo(deviceInfo);
    setEjected(true);

    sessionStorage.removeItem(SESSION_KEY);
    tokenRef.current = null;

    try { channelRef.current?.postMessage({ type: "EJECTED", deviceInfo }); } catch {}
    try { await signOut(auth); } catch {}
  }, []);

  // ── Register session with server ───────────────────────────────────────────
  const registerSession = useCallback(async (firebaseUser) => {
    if (!firebaseUser)          return;
    if (registeredRef.current)  return;
    if (registeringRef.current) return;

    registeringRef.current = true;

    // Tell sibling tabs not to eject while we're registering
    try { channelRef.current?.postMessage({ type: "REGISTERING" }); } catch {}

    try {
      const idToken = await firebaseUser.getIdToken(true);
      const resp = await fetch(REGISTER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
      });

      if (!resp.ok) {
        console.warn("[SessionGuard] registerSession failed:", resp.status);
        return;
      }

      const data = await resp.json();
      if (data.ok && data.sessionToken) {
        // Store BEFORE clearing registeringRef so snapshot can't race us
        tokenRef.current = data.sessionToken;
        sessionStorage.setItem(SESSION_KEY, data.sessionToken);
        registeredRef.current = true;

        // Update all sibling tabs with the new token
        try {
          channelRef.current?.postMessage({
            type:  "SESSION_REGISTERED",
            token: data.sessionToken,
          });
        } catch {}

        console.info("[SessionGuard] ✓ registered:",
          data.device?.deviceType, data.device?.browser);
      }
    } catch (err) {
      console.warn("[SessionGuard] registerSession error:", err.message);
    } finally {
      registeringRef.current = false;
    }
  }, []);

  // ── Heartbeat (Layer 2) ────────────────────────────────────────────────────
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
      console.warn("[SessionGuard] heartbeat failed:", err.message);
    }
  }, [user, ejectSession]);

  // ── BroadcastChannel — cross-tab coordination (Layer 4) ───────────────────
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;

    const channel = new BroadcastChannel(BROADCAST_CHANNEL);
    channelRef.current = channel;

    channel.onmessage = ({ data: msg }) => {
      if (!msg) return;

      if (msg.type === "REGISTERING") {
        // A sibling tab has started registering — suppress our ejection checks
        // until we hear SESSION_REGISTERED
        registeringRef.current = true;
      }

      if (msg.type === "SESSION_REGISTERED" && msg.token) {
        // Adopt the new token so our snapshot doesn't eject us
        tokenRef.current = msg.token;
        sessionStorage.setItem(SESSION_KEY, msg.token);
        registeredRef.current  = true;
        registeringRef.current = false; // clear the REGISTERING suppression
      }

      if (msg.type === "EJECTED") {
        ejectSession(msg.deviceInfo);
      }
    };

    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [ejectSession]);

  // ── User lifecycle: register or restore ───────────────────────────────────
  useEffect(() => {
    if (!user) {
      // ── IMPORTANT: Only reset when we were PREVIOUSLY logged in ──
      // On page refresh React starts with user=null before Firebase restores
      // the persisted session. If we clear sessionStorage here unconditionally,
      // the token is gone when the real user arrives → registerSession fires
      // on every refresh → new session → other tabs get ejected.
      if (!wasLoggedInRef.current) return; // Initial cold load — skip reset

      // Genuine sign-out — clean up everything
      wasLoggedInRef.current = false;
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

    wasLoggedInRef.current = true; // User is now active

    const storedToken = sessionStorage.getItem(SESSION_KEY);
    if (storedToken) {
      // Page refresh — token survived in sessionStorage, no re-registration needed
      tokenRef.current      = storedToken;
      registeredRef.current = true;
    } else {
      // Genuine fresh login — register with server
      registerSession(user);
    }
  }, [user, registerSession]);

  // ── Layer 1: Firestore realtime listener ──────────────────────────────────
  useEffect(() => {
    if (!user) return;

    const unsubscribe = onSnapshot(
      doc(db, "users", user.uid),
      (snap) => {
        if (!snap.exists() || ejectedRef.current || registeringRef.current) return;

        const serverToken = snap.data()?.activeSession?.token;
        const localToken  = tokenRef.current || sessionStorage.getItem(SESSION_KEY);

        if (!localToken) return; // Still initialising — skip

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
        console.warn("[SessionGuard] snapshot error:", error.code);
        if (error.code === "permission-denied" || error.code === "unauthenticated") {
          ejectSession(null);
        }
      }
    );

    return () => unsubscribe();
  }, [user, ejectSession]);

  // ── Layers 2 + 3: Heartbeat + Visibility API ─────────────────────────────
  useEffect(() => {
    if (!user) return;

    heartbeatRef.current = setInterval(runHeartbeat, HEARTBEAT_MS);

    const onVisibility = () => {
      if (document.visibilityState === "visible" && !ejectedRef.current) {
        runHeartbeat();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [user, runHeartbeat]);

  // ── Modal dismiss ─────────────────────────────────────────────────────────
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
