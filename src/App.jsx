
import React, { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { AnimatePresence, motion } from "framer-motion";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { auth, db } from "./firebase";

import TopBar from "./components/TopBar.jsx";
import JobSyncNotification from "./components/JobSyncNotification.jsx";

import Login from "./pages/Login.jsx";
import Signup from "./pages/Signup.jsx";
import ForgotPassword from "./pages/ForgotPassword.jsx";
import Home from "./pages/Home.jsx"; 
import Jobs from "./pages/Jobs.jsx";
import Profile from "./pages/Profile.jsx";
import FetchHistory from "./pages/FetchHistory.jsx";

import { ToastProvider } from "./components/Toast/ToastProvider.jsx";

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
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      );
    }

    return (
      <Routes location={location} key={location.pathname}>
        <Route path="/" element={<Home user={user} />} />
        <Route path="/jobs" element={<Jobs user={user} userMeta={userMeta} />} />
        <Route path="/profile" element={<Profile user={user} userMeta={userMeta} />} />
        <Route path="/history" element={<FetchHistory user={user} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }, [loading, user, userMeta, location]);

  return (
    <ToastProvider>
      <div className="h-full bg-white">
        {user && (
          <>
            <JobSyncNotification user={user} />
            <TopBar 
              user={user} 
              userMeta={userMeta} 
              onLogout={() => signOut(auth)} 
            />
          </>
        )}

        {!user ? (
          <div className="h-full">
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
          <main className="py-10">
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
        )}
      </div>
    </ToastProvider>
  );
}