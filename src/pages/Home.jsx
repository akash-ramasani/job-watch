
import React, { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { db } from "../firebase";
import { useToast } from "../components/Toast/ToastProvider.jsx";
import { motion } from "framer-motion";

const URL_RULES = {
  greenhouse: {
    label: "Greenhouse API Endpoint",
    placeholder: "https://boards-api.greenhouse.io/v1/boards/<company>/jobs",
    isValid: (u) =>
      /^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/[^/]+\/jobs(?:\?.*)?$/i.test(
        u
      ),
    normalize: (u) => u.trim().toLowerCase(),
  },
  ashby: {
    label: "AshbyHQ Job Board Endpoint",
    placeholder: "https://api.ashbyhq.com/posting-api/job-board/<company>",
    isValid: (u) =>
      /^https:\/\/api\.ashbyhq\.com\/posting-api\/job-board\/[^/?#]+(?:\?.*)?$/i.test(
        u
      ),
    normalize: (u) => u.trim(),
  },
};

function detectSourceFromUrl(raw) {
  const u = (raw || "").trim().toLowerCase();
  if (u.includes("boards-api.greenhouse.io/v1/boards/")) return "greenhouse";
  if (u.includes("api.ashbyhq.com/posting-api/job-board/")) return "ashby";
  return "greenhouse";
}

function prettySourceLabel(source) {
  return source === "ashby" ? "AshbyHQ" : "Greenhouse";
}

function validateUrlForSource(source, rawUrl) {
  const cleanUrl = (rawUrl || "").trim();
  if (!cleanUrl) return { ok: false, error: "Please enter a URL." };
  if (!/^https:\/\//i.test(cleanUrl)) {
    return { ok: false, error: "Please use a valid https:// URL." };
  }

  const rules = URL_RULES[source] || URL_RULES.greenhouse;
  if (!rules.isValid(cleanUrl)) {
    return {
      ok: false,
      error:
        source === "ashby"
          ? "Ashby URL should look like: https://api.ashbyhq.com/posting-api/job-board/<company>"
          : "Greenhouse URL should look like: https://boards-api.greenhouse.io/v1/boards/<company>/jobs",
    };
  }
  return { ok: true, normalizedUrl: rules.normalize(cleanUrl) };
}

/* ── Feature & testimonial data ────────────────────────────── */

const FEATURES = [
  {
    icon: (
      <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
      </svg>
    ),
    title: "Smart Tracking",
    description: "Automatically sync job listings from Greenhouse & AshbyHQ boards. Never miss a new posting again.",
    color: "text-indigo-600",
    bg: "bg-indigo-50",
  },
  {
    icon: (
      <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
      </svg>
    ),
    title: "Real-Time Alerts",
    description: "Get instant push notifications on desktop & mobile the moment new jobs match your tracked companies.",
    color: "text-amber-600",
    bg: "bg-amber-50",
  },
  {
    icon: (
      <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
      </svg>
    ),
    title: "Powerful Filters",
    description: "Filter and sort by company, title keywords, and location. Find exactly the role you're looking for.",
    color: "text-emerald-600",
    bg: "bg-emerald-50",
  },
];

const TESTIMONIALS = [
  {
    name: "Priya Sharma",
    role: "CS Graduate, Stanford",
    quote: "JobWatch completely changed my job search. I saved hours every week by not having to check individual career pages.",
    avatar: "PS",
  },
  {
    name: "Alex Chen",
    role: "SWE Intern, UC Berkeley",
    quote: "The real-time notifications are a game-changer. I was one of the first to apply when Stripe opened new grad positions.",
    avatar: "AC",
  },
  {
    name: "Jordan Williams",
    role: "Data Science, Georgia Tech",
    quote: "Love how clean and fast the interface is. The filtering makes it so easy to find relevant roles across multiple companies.",
    avatar: "JW",
  },
];

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  visible: (i = 0) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.1, duration: 0.5, ease: "easeOut" },
  }),
};

/* ── Component ─────────────────────────────────────────────── */

export default function Home({ user, userMeta }) {
  const { showToast } = useToast();
  const [company, setCompany] = useState("");
  const [url, setUrl] = useState("");
  const [feeds, setFeeds] = useState([]);
  const [busyArchiveId, setBusyArchiveId] = useState(null);

  const [busyRunNow, setBusyRunNow] = useState(false);
  const [lastRunSummary, setLastRunSummary] = useState(null);

  useEffect(() => {
    const feedsRef = collection(db, "users", user.uid, "feeds");
    const qFeeds = query(feedsRef, orderBy("createdAt", "desc"));
    return onSnapshot(qFeeds, (snap) =>
      setFeeds(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    );
  }, [user.uid]);

  const activeFeeds = useMemo(() => feeds.filter((f) => !f.archivedAt), [feeds]);
  const archivedFeeds = useMemo(() => feeds.filter((f) => !!f.archivedAt), [feeds]);
  const detectedSource = useMemo(() => detectSourceFromUrl(url), [url]);

  const firstName = userMeta?.firstName || user?.displayName?.split(" ")[0] || "there";

  async function addFeed(e) {
    e.preventDefault();
    const cleanCompany = company.trim();
    const rawUrl = url.trim();
    if (!cleanCompany || !rawUrl) return;

    const source = detectSourceFromUrl(rawUrl);
    const v = validateUrlForSource(source, rawUrl);
    if (!v.ok) {
      showToast(v.error, "error");
      return;
    }

    const candidate = (v.normalizedUrl || "").toLowerCase();
    const isDuplicate = feeds.some((f) => (f.url || "").toLowerCase() === candidate);
    if (isDuplicate) {
      showToast("This feed URL has already been added.", "error");
      return;
    }

    try {
      await addDoc(collection(db, "users", user.uid, "feeds"), {
        company: cleanCompany,
        url: v.normalizedUrl,
        source,
        createdAt: serverTimestamp(),
        archivedAt: null,
        lastCheckedAt: null,
        lastError: null,
      });

      showToast(
        `${cleanCompany} (${prettySourceLabel(source)}) feed added successfully`,
        "success"
      );
      setCompany("");
      setUrl("");
    } catch (err) {
      console.error(err);
      showToast("Failed to add feed. Please try again.", "error");
    }
  }

  async function runSyncNow() {
    setBusyRunNow(true);
    setLastRunSummary(null);

    try {
      const projectId =
        import.meta?.env?.VITE_FIREBASE_PROJECT_ID ||
        process.env?.REACT_APP_FIREBASE_PROJECT_ID;

      if (!projectId) {
        showToast(
          "Missing project id env. Add VITE_FIREBASE_PROJECT_ID (Vite) or REACT_APP_FIREBASE_PROJECT_ID (CRA).",
          "error"
        );
        return;
      }

      const endpoint = `https://us-central1-${projectId}.cloudfunctions.net/runSyncNow?userId=${encodeURIComponent(
        user.uid
      )}`;

      const resp = await fetch(endpoint, { method: "GET" });
      const data = await resp.json().catch(() => ({}));

      if (!resp.ok) {
        const msg = data?.error || "Manual run failed (HTTP error).";
        showToast(msg, "error");
        return;
      }

      setLastRunSummary(data);

      const scanned = Number(data?.scanned || 0);
      const updated = Number(data?.updated || 0);
      showToast(`Sync complete — scanned ${scanned}, wrote ${updated}`, "success");
    } catch (e) {
      console.error(e);
      showToast(e?.message || "Manual run failed.", "error");
    } finally {
      setBusyRunNow(false);
    }
  }

  async function archiveFeed(feedId) {
    setBusyArchiveId(feedId);
    try {
      await updateDoc(doc(db, "users", user.uid, "feeds", feedId), {
        archivedAt: serverTimestamp(),
      });
      showToast("Feed archived", "info");
    } catch (err) {
      console.error(err);
      showToast("Error archiving feed", "error");
    } finally {
      setBusyArchiveId(null);
    }
  }

  async function restoreFeed(feedId) {
    setBusyArchiveId(feedId);
    try {
      await updateDoc(doc(db, "users", user.uid, "feeds", feedId), {
        archivedAt: null,
      });
      showToast("Feed restored to active", "success");
    } catch (err) {
      console.error(err);
      showToast("Error restoring feed", "error");
    } finally {
      setBusyArchiveId(null);
    }
  }

  return (
    <div className="space-y-16 py-6" style={{ fontFamily: "Ubuntu, sans-serif" }}>

      {/* ═══ HERO SECTION ═══ */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="hero-gradient relative overflow-hidden rounded-3xl px-8 py-14 sm:px-12 sm:py-20 text-white"
      >
        {/* Decorative circles */}
        <div className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full bg-white/5" />
        <div className="pointer-events-none absolute -left-10 -bottom-10 h-48 w-48 rounded-full bg-white/5" />

        <div className="relative z-10 max-w-2xl">
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="text-[11px] font-black uppercase tracking-[0.25em] text-white/70 mb-3"
          >
            Dashboard
          </motion.p>
          <motion.h1
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.5 }}
            className="text-3xl sm:text-4xl font-bold tracking-tight"
          >
            Welcome back, {firstName}! 👋
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4, duration: 0.5 }}
            className="mt-3 text-base sm:text-lg text-white/80 leading-relaxed"
          >
            Your intelligent job tracking dashboard — stay ahead of every opportunity.
          </motion.p>

          {/* Stats badges */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.55, duration: 0.5 }}
            className="mt-8 flex flex-wrap gap-3"
          >
            <span className="inline-flex items-center gap-2 rounded-full bg-white/15 backdrop-blur-sm px-4 py-2 text-sm font-semibold">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/25 text-[10px] font-black">
                {activeFeeds.length}
              </span>
              Active Feeds
            </span>
            <span className="inline-flex items-center gap-2 rounded-full bg-white/15 backdrop-blur-sm px-4 py-2 text-sm font-semibold">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/25 text-[10px] font-black">
                {feeds.length}
              </span>
              Total Feeds
            </span>
            <span className="inline-flex items-center gap-2 rounded-full bg-white/15 backdrop-blur-sm px-4 py-2 text-sm font-semibold">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Auto-Sync Enabled
            </span>
          </motion.div>
        </div>
      </motion.div>

      {/* ═══ FEATURE HIGHLIGHTS ═══ */}
      <div>
        <div className="text-center mb-10">
          <h2 className="text-[10px] font-black uppercase tracking-[0.25em] text-gray-400">
            Why JobWatch?
          </h2>
          <p className="mt-2 text-2xl font-bold text-gray-900">
            Everything you need to land your next role
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          {FEATURES.map((f, i) => (
            <motion.div
              key={f.title}
              custom={i}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-40px" }}
              variants={fadeUp}
              className="feature-card"
            >
              <div className={`inline-flex items-center justify-center rounded-xl ${f.bg} p-3 mb-4`}>
                <span className={f.color}>{f.icon}</span>
              </div>
              <h3 className="text-base font-bold text-gray-900">{f.title}</h3>
              <p className="mt-2 text-sm text-gray-500 leading-relaxed">{f.description}</p>
            </motion.div>
          ))}
        </div>
      </div>

      {/* ═══ TESTIMONIALS ═══ */}
      <div>
        <div className="text-center mb-10">
          <h2 className="text-[10px] font-black uppercase tracking-[0.25em] text-gray-400">
            Trusted by students
          </h2>
          <p className="mt-2 text-2xl font-bold text-gray-900">
            What our users say
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          {TESTIMONIALS.map((t, i) => (
            <motion.div
              key={t.name}
              custom={i}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-40px" }}
              variants={fadeUp}
              className="testimonial-card"
            >
              <svg className="h-6 w-6 text-indigo-300 mb-3" viewBox="0 0 24 24" fill="currentColor">
                <path d="M11.3 2.1C6 3.2 2 7.7 2 13c0 3 1.3 5 3.5 5 1.8 0 3-1.2 3-3 0-1.7-1.2-3-2.8-3h-.3c.4-2.8 2.6-5.3 5.5-6.3L11.3 2.1zm10 0C16 3.2 12 7.7 12 13c0 3 1.3 5 3.5 5 1.8 0 3-1.2 3-3 0-1.7-1.2-3-2.8-3h-.3c.4-2.8 2.6-5.3 5.5-6.3L21.3 2.1z" />
              </svg>
              <p className="text-sm text-gray-600 leading-relaxed italic">
                "{t.quote}"
              </p>
              <div className="mt-5 flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-100 text-xs font-black text-indigo-600">
                  {t.avatar}
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-900">{t.name}</p>
                  <p className="text-xs text-gray-400">{t.role}</p>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>

      {/* ═══ DIVIDER ═══ */}
      <div className="relative">
        <div className="absolute inset-0 flex items-center" aria-hidden="true">
          <div className="w-full border-t border-gray-200" />
        </div>
        <div className="relative flex justify-center">
          <span className="bg-white px-4 text-[10px] font-black uppercase tracking-[0.25em] text-gray-400">
            Feed Management
          </span>
        </div>
      </div>

      {/* ═══ EXISTING DASHBOARD ═══ */}
      <div className="section-grid">
        <div>
          <h2 className="text-[10px] font-black uppercase tracking-widest text-gray-400">
            Job Board Sources
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            Connect <span className="font-semibold">Greenhouse</span> and{" "}
            <span className="font-semibold">AshbyHQ</span> job boards.
          </p>

          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
            <button
              onClick={runSyncNow}
              disabled={busyRunNow}
              className="btn-secondary w-full sm:w-auto uppercase tracking-widest text-[11px] font-black"
            >
              {busyRunNow ? "Running..." : "Run sync now"}
            </button>
          </div>

          <p className="mt-3 text-[11px] text-gray-400">
            This triggers the backend ingestion immediately (no need to wait 1 hour).
            It also writes a summary into <span className="font-mono">users/{user.uid}/syncRuns</span>.
          </p>

          {lastRunSummary ? (
            <div className="mt-4 rounded-xl ring-1 ring-gray-200 bg-white p-4">
              <div className="text-[10px] font-black uppercase tracking-widest text-gray-500">
                Last manual run summary
              </div>
              <div className="mt-2 text-xs font-mono text-gray-800 whitespace-pre-wrap break-words">
                {JSON.stringify(lastRunSummary, null, 2)}
              </div>
            </div>
          ) : null}
        </div>

        <div className="md:col-span-2">
          <form onSubmit={addFeed} className="space-y-4">
            <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-6">
              <div className="sm:col-span-4">
                <label className="block text-xs font-black uppercase tracking-widest text-gray-400">
                  Company Name
                </label>
                <input
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  className="input-standard mt-2"
                  placeholder="e.g. OpenAI"
                />
              </div>

              <div className="col-span-full">
                <label className="block text-xs font-black uppercase tracking-widest text-gray-400">
                  Job Board API Endpoint{" "}
                  <span className="ml-2 text-[10px] font-black tracking-widest text-gray-300">
                    (Detected: {prettySourceLabel(detectedSource)})
                  </span>
                </label>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="input-standard mt-2"
                  placeholder={
                    detectedSource === "ashby"
                      ? URL_RULES.ashby.placeholder
                      : URL_RULES.greenhouse.placeholder
                  }
                />
                <p className="mt-2 text-[11px] text-gray-400">
                  Greenhouse:{" "}
                  <span className="font-mono">
                    https://boards-api.greenhouse.io/v1/boards/&lt;company&gt;/jobs
                  </span>
                  <br />
                  AshbyHQ:{" "}
                  <span className="font-mono">
                    https://api.ashbyhq.com/posting-api/job-board/&lt;company&gt;
                  </span>
                </p>
              </div>
            </div>

            <button
              type="submit"
              className="btn-primary uppercase tracking-widest text-[11px] font-black"
            >
              Add Feed
            </button>
          </form>
        </div>
      </div>

      <div className="mx-auto max-w-3xl space-y-10">
        <div className="bg-white shadow-sm ring-1 ring-gray-200 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b bg-indigo-50/60 border-indigo-100 flex items-center justify-between">
            <div>
              <h3 className="text-[10px] font-black uppercase tracking-widest text-indigo-900">
                Active Feeds{" "}
                <span className="ml-1 text-indigo-700">({activeFeeds.length})</span>
              </h3>
              <p className="text-[11px] text-indigo-700 mt-1">
                These feeds are enabled (archivedAt is null).
              </p>
            </div>
          </div>

          <ul className="divide-y divide-gray-100">
            {activeFeeds.map((feed) => (
              <li
                key={feed.id}
                className="flex items-center justify-between px-6 py-4 hover:bg-gray-50 transition-colors"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-gray-900">
                      {feed.company || "Company"}
                    </p>
                    <span className="rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-widest bg-gray-100 text-gray-600">
                      {prettySourceLabel(feed.source || detectSourceFromUrl(feed.url))}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-gray-500 font-mono">{feed.url}</p>
                </div>

                <button
                  onClick={() => archiveFeed(feed.id)}
                  disabled={busyArchiveId === feed.id}
                  className="text-[10px] font-black uppercase tracking-widest text-amber-600 hover:text-amber-800 disabled:opacity-50"
                >
                  Archive
                </button>
              </li>
            ))}

            {activeFeeds.length === 0 && (
              <li className="px-6 py-10 text-center text-sm text-gray-400 italic">
                No active feeds. Add one above to start monitoring.
              </li>
            )}
          </ul>
        </div>

        <div className="bg-white shadow-sm ring-1 ring-gray-200 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b bg-gray-50/80 border-gray-200 flex items-center justify-between">
            <div>
              <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-600">
                Archived Feeds{" "}
                <span className="ml-1 text-gray-400">({archivedFeeds.length})</span>
              </h3>
              <p className="text-[11px] text-gray-500 mt-1">
                Archived feeds are not used (archivedAt is set).
              </p>
            </div>
          </div>

          <ul className="divide-y divide-gray-100">
            {archivedFeeds.map((feed) => (
              <li
                key={feed.id}
                className="flex items-center justify-between px-6 py-4 hover:bg-gray-50 transition-colors"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-gray-900">
                      {feed.company || "Company"}
                    </p>
                    <span className="rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-widest bg-gray-100 text-gray-600">
                      {prettySourceLabel(feed.source || detectSourceFromUrl(feed.url))}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-gray-500 font-mono">{feed.url}</p>
                </div>

                <button
                  onClick={() => restoreFeed(feed.id)}
                  disabled={busyArchiveId === feed.id}
                  className="text-[10px] font-black uppercase tracking-widest text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
                >
                  Restore
                </button>
              </li>
            ))}

            {archivedFeeds.length === 0 && (
              <li className="px-6 py-10 text-center text-sm text-gray-400 italic">
                No archived feeds.
              </li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}
