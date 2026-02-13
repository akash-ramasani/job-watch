import React, { useEffect, useState } from "react";
import { db } from "../firebase";
import { collection, query, orderBy, limit, onSnapshot } from "firebase/firestore";
import { AnimatePresence, motion } from "framer-motion";

/**
 * Precise timing format: Feb 12, 2026, 01:03:05 PM
 */
function fmtDateTimeFull(tsOrDate) {
  const d = tsOrDate?.toDate ? tsOrDate.toDate() : tsOrDate instanceof Date ? tsOrDate : null;
  if (!d || Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Relative time for the title: 7m ago
 */
function fmtSince(tsOrDate) {
  const d = tsOrDate?.toDate ? tsOrDate.toDate() : tsOrDate instanceof Date ? tsOrDate : null;
  if (!d || Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / (1000 * 60));
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "just now";
}

export default function FetchHistory({ user }) {
  const [runs, setRuns] = useState([]);
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    if (!user?.uid) return;
    const ref = collection(db, "users", user.uid, "syncRuns");
    const q = query(ref, orderBy("ranAt", "desc"), limit(60));
    return onSnapshot(q, (snap) => {
      setRuns(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
  }, [user?.uid]);

  const renderRunItem = (r) => {
    const isOpen = openId === r.id;
    const isManual = String(r.source || "").toLowerCase().match(/manual|runsyncnow|http/);
    const hasError = r.ok === false || Boolean(r.error);
    const scanned = r.scanned || 0;
    const updated = r.updated || 0;
    const written = r.jobsWritten || updated;

    return (
      <li
        key={r.id}
        className="group relative px-6 py-5 hover:bg-gray-50/80 transition-all border-l-4 border-transparent hover:border-indigo-500 cursor-pointer"
        onClick={() => setOpenId(isOpen ? null : r.id)}
      >
        {/* Hover accent line */}
        <div className="absolute top-0 left-0 right-0 h-[1px] bg-indigo-500 opacity-0 group-hover:opacity-100 transition-opacity" />
        
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1.5">
              <span className={`text-[10px] font-black uppercase tracking-tight ${isManual ? 'text-indigo-600' : 'text-gray-400'}`}>
                {isManual ? "Manual Run" : "Scheduled Sync"}
              </span>
              <span className="text-gray-300">|</span>
              <span className={`text-[10px] font-black uppercase ${hasError ? 'text-red-500' : 'text-emerald-500'}`}>
                {hasError ? "Failed" : "OK"}
              </span>
            </div>

            <h3 className="text-base font-bold text-gray-900 group-hover:text-indigo-600 transition-colors">
              Executed {fmtSince(r.ranAt)}
            </h3>

            <div className="mt-1 text-[11px] text-gray-400 font-medium">
              Ran At: <span className="text-gray-600 font-semibold">{fmtDateTimeFull(r.ranAt)}</span>
            </div>
          </div>

          <div className="flex items-center gap-6 flex-shrink-0">
            <div className="hidden sm:flex flex-col items-end min-w-[80px]">
              <span className="text-[10px] font-black text-gray-300 group-hover:text-indigo-200 uppercase tracking-tighter transition-colors">
                New Jobs
              </span>
              <span className="text-sm font-bold text-gray-900">{written}</span>
            </div>
            
            <div className={`p-1.5 rounded-lg transition-all ${isOpen ? 'bg-indigo-50 text-indigo-600 rotate-180' : 'text-gray-300'}`}>
              <svg className="size-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            </div>
          </div>
        </div>

        <AnimatePresence>
          {isOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="overflow-hidden"
            >
              <div className="mt-5 pt-5 border-t border-gray-100 space-y-5">
                
                {/* Metrics Summary Row */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-700 bg-gray-50/50 p-4 rounded-xl ring-1 ring-inset ring-gray-100">
                   <div>
                     <span className="text-gray-400 font-black uppercase text-[9px] tracking-widest mr-1.5">Scanned</span>
                     <span className="font-bold">{scanned.toLocaleString()}</span>
                   </div>
                   <span className="text-gray-300">•</span>
                   <div>
                     <span className="text-gray-400 font-black uppercase text-[9px] tracking-widest mr-1.5">Updated</span>
                     <span className="font-bold">{updated.toLocaleString()}</span>
                   </div>
                   <span className="text-gray-300">•</span>
                   <div>
                     <span className="text-gray-400 font-black uppercase text-[9px] tracking-widest mr-1.5">Jobs Written</span>
                     <span className="font-bold text-indigo-600">{written.toLocaleString()}</span>
                   </div>
                </div>

                {/* Detail Information */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="bg-white p-4 rounded-xl ring-1 ring-inset ring-gray-200 shadow-sm">
                    <div className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2">Ran At (Precise)</div>
                    <div className="text-sm font-bold text-gray-800">{fmtDateTimeFull(r.ranAt)}</div>
                  </div>
                  <div className="bg-white p-4 rounded-xl ring-1 ring-inset ring-gray-200 shadow-sm">
                    <div className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2">Recent Cutoff</div>
                    <div className="text-sm font-bold text-gray-800">
                      {r.recentCutoffIso ? fmtDateTimeFull(new Date(r.recentCutoffIso)) : "—"}
                    </div>
                  </div>
                </div>

                {/* Error Box */}
                {hasError && (
                  <div className="p-4 rounded-xl bg-red-50 border border-red-100">
                    <span className="text-[10px] font-black uppercase text-red-700 tracking-widest block mb-2">Technical Error log</span>
                    <p className="text-[11px] font-mono text-red-800 leading-relaxed break-all whitespace-pre-wrap">
                      {r.error || "Critical failure recorded. Check ingestion function logs for more info."}
                    </p>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </li>
    );
  };

  return (
    <div className="py-10 px-4 md:px-0 min-h-screen" style={{ fontFamily: "Ubuntu, sans-serif" }}>
      {/* HEADER SECTION */}
      <div className="mb-10">
        <h1 className="text-3xl font-black text-gray-900 tracking-tight">Sync History</h1>
        <p className="text-sm text-gray-500 mt-2 font-medium">
          Detailed activity logs for your background ingestion tasks.
        </p>
      </div>

      {/* MAIN CONTAINER */}
      <div className="bg-white shadow-sm ring-1 ring-gray-200 rounded-2xl overflow-hidden flex flex-col min-h-[500px]">
        {/* Sub-header */}
        <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/30 flex items-center justify-between">
          <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-400">Activity Log</h3>
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></div>
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Live Listening</span>
            </div>
          </div>

        {runs.length === 0 ? (
          <div className="flex-grow flex flex-col items-center justify-center py-32 text-center">
            <p className="text-sm font-bold text-gray-400 uppercase tracking-widest">No sync records found</p>
            <p className="text-xs text-gray-300 mt-2">Waiting for first execution...</p>
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {runs.map((r) => renderRunItem(r))}
          </ul>
        )}

        {/* Footer info */}
        <div className="bg-gray-50/50 py-8 border-t border-gray-100 flex items-center justify-center">
          <div className="flex flex-col items-center gap-1">
            <span className="text-[10px] font-black text-gray-300 uppercase tracking-[0.3em]">
              End of History
            </span>
            <span className="text-[9px] font-bold text-gray-300 uppercase tracking-widest">
              Showing last 60 events
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}