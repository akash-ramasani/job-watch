/**
 * useSessionGuard.js — Hardened single-session enforcement hook.
 *
 * Defense-in-depth layers (client side):
 *
 *   Layer 1: Firestore onSnapshot listener
 *     - Watches users/{uid}.activeSession.token in real-time
 *     - If the token changes and doesn't match ours → IMMEDIATE signOut()
 *     - Sub-second ejection latency over a healthy connection
 *
 *   Layer 2: Heartbeat polling (every 30s)
 *     - Reads the user doc directly via getDoc() to catch cases where
 *       the onSnapshot listener might be stale (network reconnect, etc.)
 *     - Acts as a safety net if the realtime stream is temporarily broken
 *
 *   Layer 3: Visibility API integration
 *     - When the tab becomes visible after being backgrounded, immediately
 *       runs a heartbeat check (don't wait for the next interval)
 *     - Catches the case where the user switches back to a stale tab
 *
 *   Layer 4: BroadcastChannel multi-tab coordination
 *     - All tabs in the same origin share a channel ("jw_session")
 *     - When one tab detects ejection, it broadcasts to ALL tabs instantly
 *     - Prevents the "one tab ejected, other tab still works" loophole
 *
 *   On ejection:
 *     - Firebase signOut() is called IMMEDIATELY (no waiting for user interaction)
 *     - SessionEjectedModal is shown as informational only
 *     - User can only click "Sign in again" → goes to /login
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { doc, onSnapshot, getDoc } from "firebase/firestore";
import { signOut } from "firebase/auth";
import { auth, db } from "../firebase";

const SESSION_KEY = "jw_session_token";
const BROADCAST_CHANNEL = "jw_session";
const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
const REGISTER_URL =
  import.meta.env.VITE_REGISTER_SESSION_URL ||
  "https://us-central1-greenhouse-jobs-scrapper.cloudfunctions.net/registerSession";

export function useSessionGuard(user) {
  const [ejected, setEjected] = useState(false);
  const [ejectedDeviceInfo, setEjectedDeviceInfo] = useState(null);
  const tokenRef = useRef(null);
  const registeredRef = useRef(false);
  const isFirstSnapshotRef = useRef(true);
  const ejectedRef = useRef(false); // Prevents double-ejection
  const channelRef = useRef(null);
  const heartbeatRef = useRef(null);

  // ── Core ejection handler — called from any layer ──
  const ejectSession = useCallback(async (deviceInfo = null) => {
    if (ejectedRef.current) return; // Already ejecting
    ejectedRef.current = true;

    console.warn("[SessionGuard] ⛔ EJECTED — signing out immediately.");

    // Set state for the informational modal
    if (deviceInfo) setEjectedDeviceInfo(deviceInfo);
    setEjected(true);

    // Clean up local session
    sessionStorage.removeItem(SESSION_KEY);
    tokenRef.current = null;

    // Broadcast ejection to all other tabs
    try {
      channelRef.current?.postMessage({ type: "EJECTED", deviceInfo });
    } catch { /* channel might be closed */ }

    // ── IMMEDIATE Firebase sign-out ──
    try {
      await signOut(auth);
    } catch {
      // Already signed out
    }
  }, []);

  // ── Register a new session after login ──
  const registerSession = useCallback(async (firebaseUser) => {
    if (!firebaseUser || registeredRef.current) return;
    registeredRef.current = true;

    try {
      const idToken = await firebaseUser.getIdToken(true); // Force fresh token
      const resp = await fetch(REGISTER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
      });

      if (!resp.ok) {
        console.warn("[SessionGuard] registerSession failed:", resp.status);
        registeredRef.current = false;
        return;
      }

      const data = await resp.json();
      if (data.ok && data.sessionToken) {
        tokenRef.current = data.sessionToken;
        sessionStorage.setItem(SESSION_KEY, data.sessionToken);

        // Notify other tabs of new session token
        try {
          channelRef.current?.postMessage({
            type: "SESSION_REGISTERED",
            token: data.sessionToken,
          });
        } catch { /* channel might be closed */ }

        console.info(
          "[SessionGuard] ✓ Session registered:",
          data.device?.deviceType,
          data.device?.browser
        );
      }
    } catch (err) {
      console.warn("[SessionGuard] registerSession error:", err.message);
      registeredRef.current = false;
    }
  }, []);

  // ── Heartbeat: verify session is still valid (Layer 2) ──
  const runHeartbeat = useCallback(async () => {
    if (!user || ejectedRef.current) return;

    const localToken = tokenRef.current || sessionStorage.getItem(SESSION_KEY);
    if (!localToken) return;

    try {
      const userRef = doc(db, "users", user.uid);
      const snap = await getDoc(userRef);
      if (!snap.exists()) return;

      const serverToken = snap.data()?.activeSession?.token;
      if (serverToken && serverToken !== localToken) {
        const data = snap.data();
        ejectSession({
          browser: data.activeSession?.browser || null,
          deviceType: data.activeSession?.deviceType || null,
          ip: data.activeSession?.ip
            ? data.activeSession.ip.slice(0, 6) + "***"
            : null,
        });
      }
    } catch (err) {
      // Network error — don't eject, just log. Next heartbeat will retry.
      console.warn("[SessionGuard] Heartbeat check failed:", err.message);
    }
  }, [user, ejectSession]);

  // ── Setup BroadcastChannel for multi-tab coordination (Layer 4) ──
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;

    const channel = new BroadcastChannel(BROADCAST_CHANNEL);
    channelRef.current = channel;

    channel.onmessage = (event) => {
      const { type, deviceInfo, token } = event.data || {};

      if (type === "EJECTED") {
        // Another tab detected ejection — eject this tab too
        ejectSession(deviceInfo);
      }

      if (type === "SESSION_REGISTERED" && token) {
        // Another tab registered a new session — update our local token
        tokenRef.current = token;
        sessionStorage.setItem(SESSION_KEY, token);
        registeredRef.current = true;
      }
    };

    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [ejectSession]);

  // ── Reset state on logout ──
  useEffect(() => {
    if (!user) {
      registeredRef.current = false;
      isFirstSnapshotRef.current = true;
      tokenRef.current = null;
      ejectedRef.current = false;
      sessionStorage.removeItem(SESSION_KEY);
      setEjected(false);
      setEjectedDeviceInfo(null);

      // Clear heartbeat
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      return;
    }

    // Try to recover token from sessionStorage (e.g. page refresh)
    const storedToken = sessionStorage.getItem(SESSION_KEY);
    if (storedToken) {
      tokenRef.current = storedToken;
      registeredRef.current = true;
    } else {
      // Fresh login — register a new session
      registerSession(user);
    }
  }, [user, registerSession]);

  // ── Layer 1: Firestore realtime listener ──
  useEffect(() => {
    if (!user) return;

    const userRef = doc(db, "users", user.uid);

    const unsubscribe = onSnapshot(
      userRef,
      (snap) => {
        if (!snap.exists() || ejectedRef.current) return;
        const data = snap.data();
        const serverToken = data?.activeSession?.token;

        // Skip the very first snapshot — it fires immediately with current data
        // and we might not have our token yet (registerSession is async)
        if (isFirstSnapshotRef.current) {
          isFirstSnapshotRef.current = false;

          if (!tokenRef.current || serverToken === tokenRef.current) return;

          // Token exists but doesn't match — page refresh with cleared sessionStorage
          if (!sessionStorage.getItem(SESSION_KEY)) {
            registeredRef.current = false;
            registerSession(user);
            return;
          }
        }

        const localToken =
          tokenRef.current || sessionStorage.getItem(SESSION_KEY);

        // If we don't have a local token yet, skip (still registering)
        if (!localToken) return;

        // Server token doesn't match our local token → EJECTED
        if (serverToken && serverToken !== localToken) {
          ejectSession({
            browser: data.activeSession?.browser || null,
            deviceType: data.activeSession?.deviceType || null,
            ip: data.activeSession?.ip
              ? data.activeSession.ip.slice(0, 6) + "***"
              : null,
          });
        }
      },
      (error) => {
        // If the listener fails (e.g. permission denied after token revocation),
        // that itself is a signal the session is invalid
        console.warn("[SessionGuard] Firestore listener error:", error.message);
        if (
          error.code === "permission-denied" ||
          error.code === "unauthenticated"
        ) {
          ejectSession(null);
        }
      }
    );

    return () => unsubscribe();
  }, [user, registerSession, ejectSession]);

  // ── Layer 2 + 3: Heartbeat polling + Visibility API ──
  useEffect(() => {
    if (!user) return;

    // Start heartbeat interval
    heartbeatRef.current = setInterval(runHeartbeat, HEARTBEAT_INTERVAL_MS);

    // Layer 3: Run heartbeat immediately when tab becomes visible
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && !ejectedRef.current) {
        runHeartbeat();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [user, runHeartbeat]);

  // ── Dismiss handler — user acknowledges the modal ──
  const handleEjectedSignOut = useCallback(async () => {
    setEjected(false);
    setEjectedDeviceInfo(null);
    sessionStorage.removeItem(SESSION_KEY);
    tokenRef.current = null;
    registeredRef.current = false;
    ejectedRef.current = false;
    try {
      await signOut(auth);
    } catch {
      // Already signed out
    }
  }, []);

  return { ejected, ejectedDeviceInfo, handleEjectedSignOut, registerSession };
}
