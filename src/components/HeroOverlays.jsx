import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { collection, query, orderBy, limit, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { ADMIN_UID } from "../App.jsx";

/* ── Utility helpers ──────────────────────────────────────── */

function greetingFor(hour) {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 21) return "Good evening";
  return "Working late";
}

function timeOfDayClass(hour) {
  // Returns a subtle backdrop gradient tint based on hour of day
  if (hour >= 5 && hour < 11) return "hero-tint-morning";
  if (hour >= 11 && hour < 17) return "hero-tint-day";
  if (hour >= 17 && hour < 21) return "hero-tint-sunset";
  return "hero-tint-night";
}

function relativeTime(ts) {
  if (!ts) return "—";
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  const diffMs = Date.now() - date.getTime();
  const sec = Math.max(1, Math.floor(diffMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function startOfTodayTs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/* ── Animated tickering number ────────────────────────────── */

function Ticker({ value, duration = 1200 }) {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    const to = value || 0;
    const start = performance.now();
    let raf;
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (t < 1) raf = requestAnimationFrame(step);
      else fromRef.current = to;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return <span>{display.toLocaleString()}</span>;
}

/* ── Hero Overlays — all floating glass cards over the map ── */

export default function HeroOverlays({ user, userMeta, bubblePositions = {} }) {
  const firstName =
    userMeta?.firstName || user?.displayName?.split(" ")[0] || "there";

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const hour = now.getHours();
  const greeting = greetingFor(hour);

  /* ── Live job feed (most recent 20) ─────────────────────── */
  const [recentJobs, setRecentJobs] = useState([]);
  const [flashKey, setFlashKey] = useState(0);
  const firstSnapshotRef = useRef(true);

  useEffect(() => {
    const jobsCol = collection(db, "users", ADMIN_UID, "jobs");
    const q = query(jobsCol, orderBy("sourceUpdatedTs", "desc"), limit(20));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setRecentJobs(list);
        // Pulse on new-job arrival (skip very first snapshot)
        if (!firstSnapshotRef.current) {
          const added = snap.docChanges().some((c) => c.type === "added");
          if (added) setFlashKey((k) => k + 1);
        }
        firstSnapshotRef.current = false;
      },
      (err) => console.warn("HeroOverlays: jobs subscription failed", err),
    );
    return () => unsub();
  }, []);

  /* ── Derived personal stats ─────────────────────────────── */
  const stats = useMemo(() => {
    const todayStart = startOfTodayTs();
    let today = 0;
    let lastTs = null;
    for (const j of recentJobs) {
      const ts = j.sourceUpdatedTs?.toDate
        ? j.sourceUpdatedTs.toDate().getTime()
        : 0;
      if (ts >= todayStart) today += 1;
      if (!lastTs || ts > lastTs) lastTs = ts;
    }
    return {
      today,
      lastTs: lastTs ? new Date(lastTs) : null,
      tracked: recentJobs.length,
    };
  }, [recentJobs]);

  /* ── Cycling ticker for "live" card ─────────────────────── */
  const [tickerIdx, setTickerIdx] = useState(0);
  useEffect(() => {
    if (recentJobs.length === 0) return;
    const id = setInterval(
      () => setTickerIdx((i) => (i + 1) % Math.min(5, recentJobs.length)),
      3500,
    );
    return () => clearInterval(id);
  }, [recentJobs.length]);

  const tickerJob = recentJobs[tickerIdx];
  const nextUp = recentJobs.slice(0, 3);

  /* ── Pin live ticker over the matching bubble on the map ── */
  // Match the ticker job's location text against known bubble cities (by longest
  // substring hit). Falls back to a fixed left position if no match is found.
  const tickerPin = useMemo(() => {
    if (!tickerJob) return null;
    const loc = (tickerJob.locationName || "").toLowerCase();
    if (!loc) return null;
    const keys = Object.keys(bubblePositions);
    if (keys.length === 0) return null;
    let best = null;
    for (const k of keys) {
      const pos = bubblePositions[k];
      const cityLower = pos.city.toLowerCase();
      if (loc.includes(cityLower)) {
        if (!best || cityLower.length > best.city.toLowerCase().length) {
          best = pos;
        }
      }
    }
    return best;
  }, [tickerJob, bubblePositions]);

  /* ── Alert health (TODO: wire to real preferences) ───────── */
  const alertHealth = {
    email: true,
    slack: true,
    sms: false,
  };

  const isEmpty = recentJobs.length === 0;

  return (
    <div className={`hero-overlays pointer-events-none absolute inset-0 z-20 ${timeOfDayClass(hour)}`}>
      {/* Flash on new job */}
      <AnimatePresence>
        <motion.div
          key={flashKey}
          initial={{ opacity: 0.35 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 1.2 }}
          className="absolute inset-0 bg-emerald-200/30 pointer-events-none"
        />
      </AnimatePresence>

      {/* ── LIVE TICKER CARD — pinned to the matching bubble on the map ── */}
      <AnimatePresence mode="wait">
        {tickerJob && (
          <motion.div
            key={tickerJob.id}
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ duration: 0.45, ease: [0.34, 1.56, 0.64, 1] }}
            className="hidden sm:block hero-live-card pointer-events-auto absolute z-30"
            style={
              tickerPin
                ? {
                    left: tickerPin.x,
                    top: tickerPin.y,
                    transform: `translate(-50%, calc(-100% - ${(tickerPin.r || 8) + 14}px))`,
                  }
                : { left: 24, bottom: 110 }
            }
          >
            <div className="rounded-2xl bg-white/85 backdrop-blur-xl border border-white/60 shadow-2xl shadow-indigo-500/15 p-4 w-[260px]">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                <p className="text-[10px] font-black uppercase tracking-[0.25em] text-emerald-700">
                  Live · Just in
                </p>
              </div>
              <p className="text-sm font-bold text-gray-900 line-clamp-1">
                {tickerJob.title || "New role"}
              </p>
              <p className="mt-0.5 text-xs text-gray-500 line-clamp-1">
                {tickerJob.companyName || "Company"} ·{" "}
                {tickerJob.locationName || "Remote"}
              </p>
              <p className="mt-1 text-[10px] font-semibold text-gray-400">
                {relativeTime(tickerJob.sourceUpdatedTs)}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="relative h-full w-full mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pt-20 pb-12 sm:pb-10 flex flex-col gap-4">

        {/* ── TOP ROW: greeting (L) + alert health (R) ─────── */}
        <div className="flex items-start justify-between gap-3 sm:gap-4">
          <motion.div
            initial={{ opacity: 0, x: -16 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5 }}
            className="pointer-events-auto rounded-2xl bg-white/70 backdrop-blur-xl border border-white/60 shadow-xl shadow-indigo-500/5 px-4 sm:px-5 py-2.5 sm:py-3 max-w-full sm:max-w-sm flex-1 sm:flex-initial"
          >
            <p className="text-[9px] sm:text-[10px] font-black uppercase tracking-[0.2em] sm:tracking-[0.25em] text-indigo-600">
              Dashboard · {now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </p>
            <h2 className="mt-0.5 text-base sm:text-xl font-bold tracking-tight text-gray-900">
              {greeting},{" "}
              <span className="bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent">
                {firstName}
              </span>{" "}
              <span className="inline-block animate-wave origin-[70%_70%]">👋</span>
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 sm:gap-2 text-[10px] sm:text-[11px] font-semibold">
              <span className="rounded-full bg-indigo-50 text-indigo-700 px-2 py-0.5">
                <Ticker value={stats.today} /> today
              </span>
              <span className="rounded-full bg-violet-50 text-violet-700 px-2 py-0.5">
                <Ticker value={stats.tracked} /> tracked
              </span>
              <span className="rounded-full bg-emerald-50 text-emerald-700 px-2 py-0.5">
                Last alert {stats.lastTs ? relativeTime(stats.lastTs) : "—"}
              </span>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="hidden md:block pointer-events-auto rounded-2xl bg-white/70 backdrop-blur-xl border border-white/60 shadow-xl shadow-indigo-500/5 px-4 py-3"
          >
            <p className="text-[10px] font-black uppercase tracking-[0.25em] text-gray-400 mb-1.5">
              Alert health
            </p>
            <div className="flex items-center gap-2 text-xs font-semibold">
              <HealthChip ok={alertHealth.email} label="Email" />
              <HealthChip ok={alertHealth.slack} label="Slack" />
              <HealthChip ok={alertHealth.sms} label="SMS" />
            </div>
            {!alertHealth.sms && (
              <Link
                to="/profile"
                className="mt-2 inline-flex items-center gap-1 text-[11px] font-bold text-indigo-600 hover:text-indigo-700"
              >
                Configure SMS →
              </Link>
            )}
          </motion.div>
        </div>

        {/* ── MIDDLE FLEX SPACE (kept for vertical layout) ───── */}
        <div className="flex-1" />

        {/* ── BOTTOM ROW ───────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 sm:gap-4">
          {/* LEFT cluster: Next-up card (or onboarding pill when empty) */}
          <div className="flex flex-col items-start gap-2 w-full sm:max-w-[300px] order-2 sm:order-1">
            {nextUp.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.2 }}
                className="pointer-events-auto rounded-2xl bg-white/80 backdrop-blur-xl border border-white/60 shadow-2xl shadow-indigo-500/10 p-4 w-full"
              >
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] font-black uppercase tracking-[0.25em] text-indigo-700">
                    Next up · For you
                  </p>
                  <Link to="/jobs" className="text-[10px] font-bold text-indigo-600 hover:text-indigo-700">
                    View all →
                  </Link>
                </div>
                <ul className="space-y-2">
                  {nextUp.map((j) => (
                    <li key={j.id} className="group flex items-center gap-2 text-xs">
                      <div className="h-7 w-7 flex-shrink-0 rounded-md bg-gradient-to-br from-indigo-100 to-violet-100 flex items-center justify-center text-[10px] font-bold text-indigo-700">
                        {(j.companyName || "?").slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-gray-900 truncate group-hover:text-indigo-600 transition-colors">
                          {j.title || "Role"}
                        </p>
                        <p className="text-[10px] text-gray-500 truncate">
                          {j.companyName} · {relativeTime(j.sourceUpdatedTs)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </motion.div>
            )}
            {isEmpty && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.3 }}
                className="pointer-events-auto rounded-full bg-white/80 backdrop-blur-xl border border-indigo-100 shadow-lg px-4 py-2 text-xs font-bold text-indigo-700 flex items-center gap-2"
              >
                <span>👋</span>
                <Link to="/feeds" className="hover:text-indigo-900">
                  Add your first company in 30 seconds →
                </Link>
              </motion.div>
            )}
          </div>

          {/* Right cluster: legend + FAB */}
          <div className="flex items-center sm:items-end justify-end gap-3 order-1 sm:order-2">
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.4 }}
              className="hidden sm:flex pointer-events-auto rounded-full bg-white/70 backdrop-blur-xl border border-white/60 shadow-md px-3 py-1.5 text-[10px] font-semibold text-gray-600 items-center gap-3"
            >
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" /> 25+
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-indigo-500" /> 50+
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2.5 w-2.5 rounded-full bg-indigo-500" /> 100+
              </span>
              <span className="flex items-center gap-1">
                <span className="h-3 w-3 rounded-full bg-indigo-500" /> 200+
              </span>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4, delay: 0.5, type: "spring" }}
              className="pointer-events-auto"
            >
              <Link
                to="/feeds"
                className="inline-flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-indigo-500/30 hover:bg-indigo-700 hover:shadow-xl hover:shadow-indigo-500/40"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                Add Company
              </Link>
            </motion.div>
          </div>
        </div>

        {/* ── Live counter strip (very bottom, subtle) ─────── */}
        <div className="absolute left-0 right-0 bottom-3 flex justify-center pointer-events-none">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.6 }}
            className="rounded-full bg-white/40 backdrop-blur-md border border-white/40 px-4 py-1 text-[10px] font-semibold text-gray-500 tracking-wide"
          >
            <span className="text-emerald-600">●</span> Right now monitoring{" "}
            <span className="text-gray-900 font-bold">
              <Ticker value={650} />
            </span>{" "}
            companies ·{" "}
            <span className="text-gray-900 font-bold">
              <Ticker value={33127} />
            </span>{" "}
            active jobs
          </motion.div>
        </div>
      </div>

      <style>{`
        @keyframes hero-wave {
          0%, 60%, 100% { transform: rotate(0deg); }
          10% { transform: rotate(14deg); }
          20% { transform: rotate(-8deg); }
          30% { transform: rotate(14deg); }
          40% { transform: rotate(-4deg); }
          50% { transform: rotate(10deg); }
        }
        .animate-wave { animation: hero-wave 2.4s ease-in-out infinite; display: inline-block; }

        /* Time-of-day tint overlays applied to the hero-overlays root */
        .hero-tint-morning::before {
          content: ""; position: absolute; inset: 0; pointer-events: none;
          background: linear-gradient(180deg, rgba(254,243,199,0.20) 0%, transparent 60%);
        }
        .hero-tint-day::before {
          content: ""; position: absolute; inset: 0; pointer-events: none;
          background: linear-gradient(180deg, rgba(219,234,254,0.18) 0%, transparent 60%);
        }
        .hero-tint-sunset::before {
          content: ""; position: absolute; inset: 0; pointer-events: none;
          background: linear-gradient(180deg, rgba(254,215,170,0.22) 0%, transparent 60%);
        }
        .hero-tint-night::before {
          content: ""; position: absolute; inset: 0; pointer-events: none;
          background: linear-gradient(180deg, rgba(199,210,254,0.18) 0%, transparent 60%);
        }

        @media (prefers-reduced-motion: reduce) {
          .animate-wave { animation: none; }
        }
      `}</style>
    </div>
  );
}

function HealthChip({ ok, label }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md ${
        ok ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
      }`}
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          ok ? "bg-emerald-500" : "bg-rose-400"
        }`}
      />
      {label}
    </span>
  );
}
