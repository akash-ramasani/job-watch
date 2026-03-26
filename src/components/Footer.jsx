import React from "react";
import { Link } from "react-router-dom";

export default function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="border-t border-gray-100 bg-gray-50/50 mt-auto">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        <div className="py-10 grid grid-cols-1 gap-8 sm:grid-cols-3">
          {/* Brand */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="h-7 w-7 rounded-lg bg-indigo-600 flex items-center justify-center">
                <span className="text-white font-bold text-sm">J</span>
              </div>
              <span className="text-lg font-bold tracking-tight text-gray-900">JobWatch</span>
            </div>
            <p className="text-sm text-gray-500 leading-relaxed max-w-xs">
              Your intelligent job tracking dashboard. Never miss an opportunity again.
            </p>
          </div>

          {/* Navigation */}
          <div>
            <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-4">
              Navigation
            </h3>
            <ul className="space-y-2.5">
              <li>
                <Link to="/" className="text-sm text-gray-600 hover:text-indigo-600 transition-colors">
                  Dashboard
                </Link>
              </li>
              <li>
                <Link to="/jobs" className="text-sm text-gray-600 hover:text-indigo-600 transition-colors">
                  Jobs
                </Link>
              </li>
              <li>
                <Link to="/feeds" className="text-sm text-gray-600 hover:text-indigo-600 transition-colors">
                  Feeds
                </Link>
              </li>
              <li>
                <Link to="/history" className="text-sm text-gray-600 hover:text-indigo-600 transition-colors">
                  History
                </Link>
              </li>
              <li>
                <Link to="/profile" className="text-sm text-gray-600 hover:text-indigo-600 transition-colors">
                  Profile
                </Link>
              </li>
            </ul>
          </div>

          {/* Resources */}
          <div>
            <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-4">
              Resources
            </h3>
            <ul className="space-y-2.5">
              <li>
                <a
                  href="https://boards-api.greenhouse.io"
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-gray-600 hover:text-indigo-600 transition-colors"
                >
                  Greenhouse API
                </a>
              </li>
              <li>
                <a
                  href="https://developers.ashbyhq.com"
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-gray-600 hover:text-indigo-600 transition-colors"
                >
                  AshbyHQ Docs
                </a>
              </li>
              <li>
                <a
                  href="https://firebase.google.com"
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-gray-600 hover:text-indigo-600 transition-colors"
                >
                  Firebase
                </a>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="border-t border-gray-200 py-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-xs text-gray-400">
            &copy; {currentYear} JobWatch. All rights reserved.
          </p>
          <div className="flex items-center gap-4">
            <span className="text-xs text-gray-400">
              Built with React + Firebase
            </span>
            <span className="inline-flex h-2 w-2 rounded-full bg-emerald-400" title="All systems operational" />
          </div>
        </div>
      </div>
    </footer>
  );
}
