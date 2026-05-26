
import React, { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, onIdTokenChanged, signOut } from "firebase/auth";
import { doc, onSnapshot, updateDoc } from "firebase/firestore";
import { AnimatePresence, motion } from "framer-motion";
import { Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { auth, db } from "./firebase";

import TopBar from "./components/TopBar.jsx";
import SessionEjectedModal from "./components/SessionEjectedModal.jsx";

import Login from "./pages/Login.jsx";
import Signup from "./pages/Signup.jsx";
import ForgotPassword from "./pages/ForgotPassword.jsx";
import LandingPage from "./pages/LandingPage.jsx";
import Home from "./pages/Home.jsx";
import Jobs from "./pages/Jobs.jsx";
import Feeds from "./pages/Feeds.jsx";
import Profile from "./pages/Profile.jsx";
import FetchHistory from "./pages/FetchHistory.jsx";
import AdminUsers from "./pages/AdminUsers.jsx";
import ExtensionAuth from "./pages/ExtensionAuth.jsx";
import Footer from "./components/Footer.jsx";
import ChatAssistant from "./components/ChatAssistant/ChatAssistant.jsx";

import { ToastProvider } from "./components/Toast/ToastProvider.jsx";
import { DataCacheProvider } from "./contexts/DataCacheContext.jsx";
import { useSessionGuard } from "./hooks/useSessionGuard.js";

export const ADMIN_UID = "7Tojjo8l5PZIYctPmdwncf7PC133";

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [userMeta, setUserMeta] = useState(null);
  const [preferences, setPreferences] = useState({ aiScoringEnabled: true });
  const [extInstalled, setExtInstalled] = useState(false);

  const location = useLocation();
  const navigate = useNavigate();

  // ── Single-session enforcement ──
  const { ejected, ejectedDeviceInfo, handleEjectedSignOut } = useSessionGuard(user);

  // Detect extension — runs once on mount, retries briefly to handle timing
  useEffect(() => {
    const check = () => {
      if (window.__JW_EXTENSION_INSTALLED__) {
        setExtInstalled(true);
        return true;
      }
      return false;
    };
    if (!check()) {
      // Retry a few times in case the content script hasn't injected yet
      const t1 = setTimeout(check, 200);
      const t2 = setTimeout(check, 800);
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }
  }, []);

  const syncToExtension = async (u) => {
    if (!window.__JW_EXTENSION_INSTALLED__) return;
    if (u) {
      try {
        const result = await u.getIdTokenResult();
        const expiresIn = Math.max(300, Math.floor((new Date(result.expirationTime) - Date.now()) / 1000));
        window.postMessage({ type: "JW_AUTH", idToken: result.token, refreshToken: u.refreshToken, uid: u.uid, expiresIn }, "*");
      } catch (e) {
        console.warn("[JobWatch] Could not sync auth to extension:", e.message);
      }
    } else {
      window.postMessage({ type: "JW_LOGOUT" }, "*");
    }
  };

  // Sync auth state to extension.
  // onIdTokenChanged fires on login, logout, AND every ~1h when Firebase
  // silently refreshes the token — so the extension always has a fresh token.
  useEffect(() => {
    const unsub = onIdTokenChanged(auth, async (u) => {
      setUser(u);
      setLoading(false);
      syncToExtension(u);
    });
    return () => unsub();
  }, []);

  // If the extension injects AFTER Firebase restores the session (e.g., late
  // document_idle injection), re-sync the active user to it.
  useEffect(() => {
    if (extInstalled && !loading) {
      syncToExtension(user);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extInstalled]);

  useEffect(() => {
    if (!user) {
      setUserMeta(null);
      setPreferences({ aiScoringEnabled: true });
      return;
    }
    const ref = doc(db, "users", user.uid);
    const prefRef = doc(db, "users", user.uid, "settings", "preferences");
    
    const unsubMeta = onSnapshot(ref, (snap) => setUserMeta(snap.exists() ? snap.data() : null));
    const unsubPrefs = onSnapshot(prefRef, (snap) => {
      if (snap.exists()) setPreferences(snap.data());
    });

    return () => {
      unsubMeta();
      unsubPrefs();
    };
  }, [user]);

  const content = useMemo(() => {
    if (loading) {
      return (
        <div className="flex h-screen items-center justify-center bg-white">
          <div className="text-sm font-medium text-gray-400 animate-pulse tracking-widest uppercase">
            Loading JobWatch...
          </div>
        </div>
      );
    }

    // ── Account status gate (skip for admin) ──
    if (user && user.uid !== ADMIN_UID && userMeta) {
      const status = userMeta.accountStatus;

      // Auto-deactivate expired accounts (Trial or Paid)
      if (userMeta.trialEndsAt && (status === "trial" || status === "active" || status === "pending")) {
        const trialEnd = userMeta.trialEndsAt?.toDate
          ? userMeta.trialEndsAt.toDate()
          : new Date(userMeta.trialEndsAt);
        
        if (new Date() > trialEnd) {
          // Fire-and-forget: update Firestore and show deactivated screen
          updateDoc(doc(db, "users", user.uid), { accountStatus: "deactivated", aiAccess: false }).catch(() => {});
          
          const isTrial = userMeta.accountType === "trial";
          return (
            <div className="flex h-screen items-center justify-center bg-white px-4">
              <div className="text-center max-w-sm">
                <div className="mx-auto mb-6 h-16 w-16 rounded-2xl bg-red-50 flex items-center justify-center">
                  <svg className="h-8 w-8 text-red-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <h2 className="text-xl font-bold text-gray-900">
                  {isTrial ? "Trial Expired" : "Access Expired"}
                </h2>
                <p className="mt-2 text-sm text-gray-500">
                  {isTrial 
                    ? "Your free trial has ended. Please contact us to continue using JobWatch."
                    : "Your access period has ended. Please contact us to renew your account."}
                </p>
                <button onClick={() => signOut(auth)} className="mt-6 btn-secondary text-sm">Sign Out</button>
              </div>
            </div>
          );
        }
      }

      if (status === "pending") {
        return (
          <div className="flex h-screen items-center justify-center bg-white px-4">
            <div className="text-center max-w-sm">
              <div className="mx-auto mb-6 h-16 w-16 rounded-2xl bg-amber-50 flex items-center justify-center">
                <svg className="h-8 w-8 text-amber-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                </svg>
              </div>
              <h2 className="text-xl font-bold text-gray-900">Account Pending Activation</h2>
              <p className="mt-2 text-sm text-gray-500">Your account is being reviewed. You'll get access as soon as it's activated.</p>
              <button onClick={() => signOut(auth)} className="mt-6 btn-secondary text-sm">Sign Out</button>
            </div>
          </div>
        );
      }

      if (status === "deactivated") {
        return (
          <div className="flex h-screen items-center justify-center bg-white px-4">
            <div className="text-center max-w-sm">
              <div className="mx-auto mb-6 h-16 w-16 rounded-2xl bg-gray-100 flex items-center justify-center">
                <svg className="h-8 w-8 text-gray-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
              </div>
              <h2 className="text-xl font-bold text-gray-900">Account Deactivated</h2>
              <p className="mt-2 text-sm text-gray-500">Your account has been deactivated. Please contact us if you believe this is a mistake.</p>
              <button onClick={() => signOut(auth)} className="mt-6 btn-secondary text-sm">Sign Out</button>
            </div>
          </div>
        );
      }
    }

    if (!user) {
      return (
        <Routes location={location} key={location.pathname}>
          <Route path="/extension-auth" element={<ExtensionAuth />} />
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      );
    }

    return (
      <Routes location={location} key={location.pathname}>
        <Route path="/extension-auth" element={<ExtensionAuth />} />
        <Route path="/" element={<Home user={user} userMeta={userMeta} />} />
        <Route
          path="/feeds"
          element={
            user.uid === ADMIN_UID ? (
              <Feeds user={user} />
            ) : (
              <Navigate to="/" replace />
            )
          }
        />
        <Route
          path="/users"
          element={
            user.uid === ADMIN_UID ? (
              <AdminUsers user={user} />
            ) : (
              <Navigate to="/" replace />
            )
          }
        />
        <Route path="/jobs" element={<Jobs user={user} userMeta={userMeta} preferences={preferences} />} />
        <Route path="/profile" element={<Profile user={user} userMeta={userMeta} />} />
        <Route path="/history" element={<FetchHistory user={user} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }, [loading, user, userMeta, location]);

  return (
    <DataCacheProvider>
    <ToastProvider>
      <div className="flex flex-col min-h-screen bg-white">
        {user && (
          <>
            <TopBar
              user={user}
              userMeta={userMeta}
              onLogout={() => signOut(auth)}
              extInstalled={extInstalled}
            />
          </>
        )}

        {!user ? (
          <div className="flex-1">
            <AnimatePresence mode="wait">
              <motion.div
                key={location.pathname}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
                className="h-full"
              >
                {content}
              </motion.div>
            </AnimatePresence>
          </div>
        ) : (
          <>
            <main className="flex-1">
              <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={location.pathname}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                  >
                    {content}
                  </motion.div>
                </AnimatePresence>
              </div>
            </main>
            <Footer />
            {preferences.aiScoringEnabled && userMeta?.aiAccess !== false && <ChatAssistant user={user} />}
          </>
        )}

        {/* Single-session enforcement modal — shown when ejected by another login */}
        <SessionEjectedModal
          open={ejected}
          deviceInfo={ejectedDeviceInfo}
          onSignInAgain={() => {
            handleEjectedSignOut();
            navigate("/login");
          }}
        />
      </div>
    </ToastProvider>
    </DataCacheProvider>
  );
}