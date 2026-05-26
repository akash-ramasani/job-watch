import React, { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Link, useLocation } from "react-router-dom";
import {
  HomeIcon,
  BriefcaseIcon,
  ClockIcon,
  RssIcon,
  UsersIcon,
  ArrowRightOnRectangleIcon,
  Bars3Icon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { useToast } from "./Toast/ToastProvider.jsx";
import { ADMIN_UID } from "../App.jsx";
import UserAvatar from "./UserAvatar.jsx";

export default function TopBar({ user, userMeta, onLogout, extInstalled }) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const location = useLocation();
  const { showToast } = useToast();

  const handleLogoutClick = () => {
    onLogout();
    showToast("Signed out successfully", "success");
  };

  return (
    <nav className="sticky top-0 z-50 w-full bg-transparent backdrop-blur-md backdrop-saturate-150">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          <Link
            to="/"
            className="group flex items-center gap-2 transition-opacity hover:opacity-90"
          >
            <div className="h-8 w-8 rounded-lg bg-indigo-600 flex items-center justify-center shadow-md shadow-indigo-200 transition-all duration-300 ease-out group-hover:scale-110 group-hover:rotate-[-6deg] group-hover:shadow-lg group-hover:shadow-indigo-300">
              <span className="text-white font-bold text-lg">J</span>
            </div>
            <span className="text-xl font-bold tracking-tight text-gray-900 transition-colors group-hover:text-indigo-600">JobWatch</span>
          </Link>

          {user && (
            <div className="hidden md:flex items-center gap-2">
              <NavButton active={location.pathname === "/"} to="/" icon={HomeIcon}>Dashboard</NavButton>
              {user.uid === ADMIN_UID && (
                <>
                  <NavButton active={location.pathname === "/feeds"} to="/feeds" icon={RssIcon}>Feeds</NavButton>
                  <NavButton active={location.pathname === "/users"} to="/users" icon={UsersIcon}>Users</NavButton>
                </>
              )}
              <NavButton active={location.pathname === "/jobs"} to="/jobs" icon={BriefcaseIcon}>Jobs</NavButton>
              <NavButton active={location.pathname === "/history"} to="/history" icon={ClockIcon}>History</NavButton>
            </div>
          )}

          <div className="flex items-center gap-4">
            {user ? (
              <div className="flex items-center gap-6">
                {/* Extension status — iOS-style camera-access dot */}
                <div className="hidden md:flex items-center">
                  {extInstalled ? (
                    <span
                      title="JobWatch extension is connected"
                      className="relative inline-flex h-2.5 w-2.5"
                    >
                      <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.7)]" />
                    </span>
                  ) : (
                    <a
                      href="https://github.com/akash-ramasani/job-watch"
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Install the JobWatch extension to use Auto Apply"
                      className="relative inline-flex h-2.5 w-2.5"
                    >
                      <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75 animate-ping" />
                      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.7)]" />
                    </a>
                  )}
                </div>

                <Link
                  to="/profile"
                  title="Profile"
                  className="hidden md:inline-flex rounded-lg ring-1 ring-gray-200 hover:ring-indigo-300 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md"
                >
                  <UserAvatar
                    uid={user.uid}
                    avatarUrl={userMeta?.avatarUrl}
                    name={userMeta?.fullName}
                    email={user.email}
                    size="md"
                    className="rounded-lg"
                  />
                </Link>

                <button
                  onClick={handleLogoutClick}
                  className="group hidden md:inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-indigo-200 hover:bg-indigo-700 hover:shadow-lg hover:shadow-indigo-300 hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] transition-all duration-200 ease-out"
                >
                  <ArrowRightOnRectangleIcon className="h-4 w-4 transition-transform duration-200 ease-out group-hover:translate-x-0.5" />
                  Sign Out
                </button>

                <Link to="/profile" className="md:hidden transition-transform duration-200 ease-out active:scale-95">
                  <UserAvatar
                    uid={user.uid}
                    avatarUrl={userMeta?.avatarUrl}
                    name={userMeta?.fullName}
                    email={user.email}
                    size="sm"
                    className="rounded-lg"
                  />
                </Link>

                <button className="md:hidden p-2 text-gray-500 hover:text-gray-700 transition-all duration-200 ease-out active:scale-90" onClick={() => setIsMenuOpen(!isMenuOpen)} aria-label="Toggle menu">
                  {isMenuOpen ? <XMarkIcon className="h-6 w-6" /> : <Bars3Icon className="h-6 w-6" />}
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
              <MobileNavButton active={location.pathname === "/"} to="/" icon={HomeIcon} onClick={() => setIsMenuOpen(false)}>Dashboard</MobileNavButton>
              {user.uid === ADMIN_UID && (
                <>
                  <MobileNavButton active={location.pathname === "/feeds"} to="/feeds" icon={RssIcon} onClick={() => setIsMenuOpen(false)}>Feeds</MobileNavButton>
                  <MobileNavButton active={location.pathname === "/users"} to="/users" icon={UsersIcon} onClick={() => setIsMenuOpen(false)}>Users</MobileNavButton>
                </>
              )}
              <MobileNavButton active={location.pathname === "/jobs"} to="/jobs" icon={BriefcaseIcon} onClick={() => setIsMenuOpen(false)}>Jobs</MobileNavButton>
              <MobileNavButton active={location.pathname === "/history"} to="/history" icon={ClockIcon} onClick={() => setIsMenuOpen(false)}>History</MobileNavButton>
              <button
                onClick={() => {
                  handleLogoutClick();
                  setIsMenuOpen(false);
                }}
                className="group w-full mt-4 flex items-center gap-2 rounded-lg bg-gray-50 px-4 py-3 text-left text-sm font-semibold text-red-600 hover:bg-red-50 transition-all duration-200 ease-out active:scale-[0.98]"
              >
                <ArrowRightOnRectangleIcon className="h-5 w-5 transition-transform duration-200 ease-out group-hover:translate-x-0.5" />
                Sign Out
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  );
}

function NavButton({ active, children, to, icon: Icon }) {
  return (
    <Link
      to={to}
      className={`group relative inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all duration-200 ease-out hover:-translate-y-0.5 ${
        active
          ? "bg-indigo-50 text-indigo-600 shadow-sm shadow-indigo-100"
          : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
      }`}
    >
      {Icon && (
        <Icon
          className={`h-4 w-4 transition-transform duration-200 ease-out group-hover:scale-110 group-hover:rotate-[-4deg] ${
            active ? "text-indigo-600" : "text-gray-400 group-hover:text-gray-700"
          }`}
        />
      )}
      <span className="relative">
        {children}
        <span
          className={`absolute -bottom-0.5 left-0 h-0.5 rounded-full bg-indigo-500 transition-all duration-300 ease-out ${
            active ? "w-full opacity-0" : "w-0 group-hover:w-full opacity-70"
          }`}
        />
      </span>
    </Link>
  );
}

function MobileNavButton({ active, children, onClick, to, icon: Icon }) {
  return (
    <Link
      to={to}
      onClick={onClick}
      className={`group flex items-center gap-3 w-full rounded-lg px-4 py-3 text-left text-base font-medium transition-all duration-200 ease-out active:scale-[0.98] ${active ? "bg-indigo-50 text-indigo-700" : "text-gray-600 hover:bg-gray-50 hover:translate-x-1"
        }`}
    >
      {Icon && (
        <Icon className={`h-5 w-5 transition-transform duration-200 ease-out group-hover:scale-110 ${active ? "text-indigo-600" : "text-gray-400"}`} />
      )}
      {children}
    </Link>
  );
}