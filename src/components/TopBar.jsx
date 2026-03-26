
import React, { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Link, useLocation } from "react-router-dom";
import { useToast } from "./Toast/ToastProvider.jsx"; 

export default function TopBar({ user, userMeta, onLogout }) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const location = useLocation();
  const { showToast } = useToast(); 

  const handleLogoutClick = () => {
    onLogout();
    showToast("Signed out successfully", "success");
  };

  return (
    <nav className="sticky top-0 z-50 w-full border-b border-gray-200 bg-white/80 backdrop-blur-md">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          <div className="flex items-center gap-10">
            <Link
              to="/"
              className="flex items-center gap-2 transition-opacity hover:opacity-80"
            >
              <div className="h-8 w-8 rounded-lg bg-indigo-600 flex items-center justify-center">
                <span className="text-white font-bold text-lg">J</span>
              </div>
              <span className="text-xl font-bold tracking-tight text-gray-900">JobWatch</span>
            </Link>

            {user && (
              <div className="hidden md:flex items-center gap-1">
                <NavButton active={location.pathname === "/"} to="/">Dashboard</NavButton>
                <NavButton active={location.pathname === "/jobs"} to="/jobs">Jobs</NavButton>
                <NavButton active={location.pathname === "/history"} to="/history">History</NavButton>
                <NavButton active={location.pathname === "/profile"} to="/profile">Settings</NavButton>
              </div>
            )}
          </div>

          <div className="flex items-center gap-4">
            {user ? (
              <div className="flex items-center gap-6">
                <div className="hidden md:flex flex-col items-end">
                  <span className="text-sm font-semibold text-gray-900">
                    {userMeta?.fullName || "User"}
                  </span>
                  <button
                    onClick={handleLogoutClick} 
                    className="text-[11px] font-bold uppercase tracking-wider text-gray-400 hover:text-indigo-600 transition-colors"
                  >
                    Sign Out &rarr;
                  </button>
                </div>

                <button className="md:hidden p-2 text-gray-500" onClick={() => setIsMenuOpen(!isMenuOpen)}>
                  <span className="text-2xl">{isMenuOpen ? "✕" : "☰"}</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <AnimatePresence>
        {isMenuOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="md:hidden border-t border-gray-100 bg-white"
          >
            <div className="space-y-1 px-4 py-4">
              <MobileNavButton active={location.pathname === "/"} to="/" onClick={() => setIsMenuOpen(false)}>Dashboard</MobileNavButton>
              <MobileNavButton active={location.pathname === "/jobs"} to="/jobs" onClick={() => setIsMenuOpen(false)}>Jobs</MobileNavButton>
              <MobileNavButton active={location.pathname === "/history"} to="/history" onClick={() => setIsMenuOpen(false)}>History</MobileNavButton>
              <MobileNavButton active={location.pathname === "/profile"} to="/profile" onClick={() => setIsMenuOpen(false)}>Settings</MobileNavButton>
              <button 
                onClick={() => {
                  handleLogoutClick();
                  setIsMenuOpen(false);
                }} 
                className="w-full mt-4 rounded-lg bg-gray-50 px-4 py-3 text-left text-sm font-semibold text-red-600"
              >
                Sign Out
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  );
}

function NavButton({ active, children, to }) {
  return (
    <Link
      to={to}
      className={`relative px-4 py-2 text-sm font-medium transition-colors ${
        active ? "text-indigo-600" : "text-gray-500 hover:text-gray-900"
      }`}
    >
      {children}
      {active && (
        <motion.div 
          layoutId="activeNav" 
          className="absolute bottom-[-22px] left-0 right-0 h-[2px] bg-indigo-600" 
        />
      )}
    </Link>
  );
}

function MobileNavButton({ active, children, onClick, to }) {
  return (
    <Link
      to={to}
      onClick={onClick}
      className={`block w-full rounded-lg px-4 py-3 text-left text-base font-medium ${
        active ? "bg-indigo-50 text-indigo-700" : "text-gray-600 hover:bg-gray-50"
      }`}
    >
      {children}
    </Link>
  );
}