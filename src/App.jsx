
import React, { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { AnimatePresence, motion } from "framer-motion";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { auth, db } from "./firebase";

import TopBar from "./components/TopBar.jsx";

import Login from "./pages/Login.jsx";
import Signup from "./pages/Signup.jsx";
import ForgotPassword from "./pages/ForgotPassword.jsx";
import LandingPage from "./pages/LandingPage.jsx";
import Home from "./pages/Home.jsx";
import Jobs from "./pages/Jobs.jsx";
import Feeds from "./pages/Feeds.jsx";
import Profile from "./pages/Profile.jsx";
import FetchHistory from "./pages/FetchHistory.jsx";
import Footer from "./components/Footer.jsx";
import ScrollToTop from "./components/ScrollToTop.jsx";

import { ToastProvider } from "./components/Toast/ToastProvider.jsx";

export const ADMIN_UID = "7Tojjo8l5PZIYctPmdwncf7PC133";

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [userMeta, setUserMeta] = useState(null);

  const location = useLocation();

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!user) {
      setUserMeta(null);
      return;
    }
    const ref = doc(db, "users", user.uid);
    return onSnapshot(ref, (snap) => setUserMeta(snap.exists() ? snap.data() : null));
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

    if (!user) {
      return (
        <Routes location={location} key={location.pathname}>
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
        <Route path="/jobs" element={<Jobs user={user} userMeta={userMeta} />} />
        <Route path="/profile" element={<Profile user={user} userMeta={userMeta} />} />
        <Route path="/history" element={<FetchHistory user={user} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }, [loading, user, userMeta, location]);

  return (
    <ToastProvider>
      <div className="flex flex-col min-h-screen bg-white">
        {user && (
          <>
            <TopBar
              user={user}
              userMeta={userMeta}
              onLogout={() => signOut(auth)}
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
            <main className="flex-1 py-10">
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
            <ScrollToTop />
          </>
        )}
      </div>
    </ToastProvider>
  );
}