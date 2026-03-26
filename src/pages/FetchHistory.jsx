import React, { useEffect, useMemo, useState } from "react";
import { db } from "../firebase";
import { collection, query, orderBy, limit, onSnapshot } from "firebase/firestore";
import { AnimatePresence, motion } from "framer-motion";
import { ADMIN_UID } from "../App.jsx";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
} from "recharts";

function fmtDateTimeFull(tsOrDate) {
  const d = tsOrDate?.toDate ? tsOrDate.toDate() : tsOrDate instanceof Date ? tsOrDate : null;
  if (!d || Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }) + " PT";
}

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

function fmtDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1000) return `${Math.round(n)}ms`;
  const s = n / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${String(rem).padStart(2, "0")}s`;
}


function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg bg-gray-900 px-3 py-2 shadow-lg">
      <p className="text-[10px] font-bold text-gray-400 mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="text-xs font-semibold text-white">
          {p.name}: <span style={{ color: p.color }}>{p.value}</span>
        </p>
      ))}
    </div>
  );
}

export default function FetchHistory({ user }) {
  const [runs, setRuns] = useState([]);
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    if (!user?.uid) return;
    const ref = collection(db, "users", ADMIN_UID, "syncRuns");
    const q = query(ref, orderBy("ranAt", "desc"), limit(60));
    return onSnapshot(q, (snap) => {
      setRuns(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
  }, [user?.uid]);

  /* ── Chart data ──────────────────────────────────────── */
  const chartData = useMemo(() => {
    return [...runs]
      .reverse()
      .filter((r) => r.ranAt?.toDate)
      .map((r) => {
        const d = r.ranAt.toDate();
        const label = d.toLocaleString("en-US", {
          timeZone: "America/Los_Angeles",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        return {
          label,
          written: Number(r.jobsWritten ?? r.updated ?? 0),
          scanned: Number(r.scanned ?? 0),
          fetched: Number(r.jobsFetched ?? 0),
        };
      });
  }, [runs]);

  const totalJobsWritten = useMemo(
    () => chartData.reduce((sum, d) => sum + d.written, 0),
    [chartData]
  );

  const totalScanned = useMemo(
    () => chartData.reduce((sum, d) => sum + d.scanned, 0),
    [chartData]
  );

  const renderRunItem = (r) => {
    const isOpen = openId === r.id;

    const isManual = String(r.source || "").toLowerCase().match(/manual|runsyncnow|http/);
    const hasError = r.ok === false || Boolean(r.error);

    const scanned = Number(r.scanned ?? 0);
    const fetched = Number(r.jobsFetched ?? 0);
    const written = Number(r.jobsWritten ?? r.updated ?? 0);
    const keptRecent = Number(r.jobsKeptRecent ?? 0);
    const durationMs = Number(r.durationMs ?? 0);
    const recentCutoffIso = r.recentCutoffIso ? new Date(r.recentCutoffIso) : null;

    return (
      <li
        key={r.id}
        className="group relative px-6 py-5 hover:bg-gray-50/80 transition-all border-l-4 border-transparent hover:border-indigo-500 cursor-pointer"
        onClick={() => setOpenId(isOpen ? null : r.id)}
      >

        <div className="absolute top-0 left-0 right-0 h-[1px] bg-indigo-500 opacity-0 group-hover:opacity-100 transition-opacity" />

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1.5">
              <span
                className={`text-[10px] font-black uppercase tracking-tight ${isManual ? "text-indigo-600" : "text-gray-400"
                  }`}
              >
                {isManual ? "Manual Run" : "Scheduled Sync"}
              </span>
              <span className="text-gray-300">|</span>
              <span className={`text-[10px] font-black uppercase ${hasError ? "text-red-500" : "text-emerald-500"}`}>
                {hasError ? "Failed" : "OK"}
              </span>

              <span className="text-gray-300">|</span>
              <span className="text-[10px] font-black uppercase text-gray-400 tracking-tight">
                Jobs Added{" "}
                <span className="text-gray-900">{written.toLocaleString()}</span>
              </span>
            </div>

            <h3 className="text-base font-bold text-gray-900 group-hover:text-indigo-600 transition-colors">
              Executed {fmtSince(r.ranAt)}
            </h3>

            <div className="mt-1 text-[11px] text-gray-400 font-medium">
              Ran At: <span className="text-gray-600 font-semibold">{fmtDateTimeFull(r.ranAt)}</span>
            </div>
          </div>

          <div className="flex items-center flex-shrink-0">
            <div
              className={`p-1.5 rounded-lg transition-all ${isOpen ? "bg-indigo-50 text-indigo-600 rotate-180" : "text-gray-300"
                }`}
            >
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

                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-700 bg-gray-50/50 p-4 rounded-xl ring-1 ring-inset ring-gray-100">

                  <div>
                    <span className="text-gray-400 font-black uppercase text-[9px] tracking-widest mr-1.5">
                      Duration
                    </span>
                    <span className="font-bold">{fmtDuration(durationMs)}</span>
                  </div>

                  <span className="text-gray-300">•</span>

                  <div>
                    <span className="text-gray-400 font-black uppercase text-[9px] tracking-widest mr-1.5">
                      Scanned
                    </span>
                    <span className="font-bold">{scanned.toLocaleString()}</span>
                  </div>

                  <span className="text-gray-300">•</span>

                  <div>
                    <span className="text-gray-400 font-black uppercase text-[9px] tracking-widest mr-1.5">
                      Fetched
                    </span>
                    <span className="font-bold">{fetched.toLocaleString()}</span>
                  </div>

                  <span className="text-gray-300">•</span>

                  <div>
                    <span className="text-gray-400 font-black uppercase text-[9px] tracking-widest mr-1.5">
                      Kept Recent
                    </span>
                    <span className="font-bold">{keptRecent.toLocaleString()}</span>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="bg-white p-4 rounded-xl ring-1 ring-inset ring-gray-200 shadow-sm">
                    <div className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2">
                      Ran At (Precise)
                    </div>
                    <div className="text-sm font-bold text-gray-800">{fmtDateTimeFull(r.ranAt)}</div>
                  </div>

                  <div className="bg-white p-4 rounded-xl ring-1 ring-inset ring-gray-200 shadow-sm">
                    <div className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2">
                      Recent Cutoff
                    </div>
                    <div className="text-sm font-bold text-gray-800">
                      {recentCutoffIso ? fmtDateTimeFull(recentCutoffIso) : "—"}
                    </div>
                  </div>
                </div>

                {hasError && (
                  <div className="p-4 rounded-xl bg-red-50 border border-red-100">
                    <span className="text-[10px] font-black uppercase text-red-700 tracking-widest block mb-2">
                      Error
                    </span>
                    <p className="text-[11px] font-mono text-red-800 leading-relaxed break-all whitespace-pre-wrap">
                      {r.error || "Failure recorded. Check ingestion function logs for details."}
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
    <div className="page-wrapper">

      <div className="page-header">
        <h1>Sync History</h1>
        <p>Detailed activity logs for your background ingestion tasks.</p>
      </div>

      {/* ═══ ANALYTICS CHART ═══ */}
      {chartData.length > 1 && (
        <div className="bg-white rounded-2xl ring-1 ring-gray-200 shadow-sm p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400">Jobs Added per Sync</h3>
              <p className="text-2xl font-bold text-gray-900 mt-1">{totalJobsWritten.toLocaleString()}</p>
              <p className="text-xs text-gray-400">total jobs written</p>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50">
              <svg className="h-5 w-5 text-indigo-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
              </svg>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
              <defs>
                <linearGradient id="colorJobs" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#6366f1" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="written" stroke="#6366f1" strokeWidth={2} fill="url(#colorJobs)" name="Jobs Written" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="bg-white shadow-sm ring-1 ring-gray-200 rounded-2xl overflow-hidden flex flex-col min-h-[500px]">

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
          <ul className="divide-y divide-gray-100">{runs.map((r) => renderRunItem(r))}</ul>
        )}

        <div className="bg-gray-50/50 py-8 border-t border-gray-100 flex items-center justify-center">
          <div className="flex flex-col items-center gap-1">
            <span className="text-[10px] font-black text-gray-300 uppercase tracking-[0.3em]">End of History</span>
            <span className="text-[9px] font-bold text-gray-300 uppercase tracking-widest">Showing last 60 events</span>
          </div>
        </div>
      </div>
    </div>
  );
}
