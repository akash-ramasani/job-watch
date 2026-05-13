
import React, { useEffect, useMemo, useState, useRef } from "react";
import { useSearchParams } from "react-router-dom";
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
import { ADMIN_UID } from "../App.jsx";

const ScrollReveal = ({ children, delay = 0 }) => {
  const [isVisible, setIsVisible] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setTimeout(() => {
            setIsVisible(true);
          }, delay);
          observer.unobserve(entry.target);
        }
      },
      { threshold: 0.1, rootMargin: "0px 0px -50px 0px" }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [delay]);

  return (
    <div
      ref={ref}
      className={`h-full transition-all duration-1000 ease-out ${
        isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-12"
      }`}
    >
      {children}
    </div>
  );
};

const URL_RULES = {
  greenhouse: {
    label: "Greenhouse API Endpoint",
    placeholder: "https://boards-api.greenhouse.io/v1/boards/<company>/jobs",
    isValid: (u) =>
      /^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/[^/]+\/jobs(?:\?.*)?$/i.test(u),
    normalize: (u) => u.trim().toLowerCase(),
  },
  ashby: {
    label: "AshbyHQ Job Board Endpoint",
    placeholder: "https://api.ashbyhq.com/posting-api/job-board/<company>",
    isValid: (u) =>
      /^https:\/\/api\.ashbyhq\.com\/posting-api\/job-board\/[^/?#]+(?:\?.*)?$/i.test(u),
    normalize: (u) => u.trim(),
  },
  eightfold: {
    label: "Eightfold.ai / Microsoft Careers API",
    placeholder: "https://<company>.eightfold.ai/api/pcsx/search?domain=<company>.com&...",
    isValid: (u) => /\/api\/pcsx\/search/i.test(u),
    normalize: (u) => u.trim(),
  },
  netflix: {
    label: "Netflix Careers API",
    placeholder: "https://explore.jobs.netflix.net/api/apply/v2/jobs?domain=netflix.com&...",
    isValid: (u) => u.includes("explore.jobs.netflix.net/api/apply/v2/jobs"),
    normalize: (u) => u.trim(),
  },
};

function detectSourceFromUrl(raw) {
  const u = (raw || "").trim().toLowerCase();
  if (u.includes("boards-api.greenhouse.io/v1/boards/")) return "greenhouse";
  if (u.includes("api.ashbyhq.com/posting-api/job-board/")) return "ashby";
  if (u.includes("explore.jobs.netflix.net/api/apply/v2/jobs")) return "netflix";
  if (u.includes("/api/pcsx/search")) return "eightfold";
  return "greenhouse";
}

function prettySourceLabel(source) {
  if (source === "ashby" || source === "ashbyhq") return "AshbyHQ";
  if (source === "eightfold") return "Eightfold.ai";
  if (source === "netflix") return "Netflix";
  return "Greenhouse";
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
        : source === "eightfold"
          ? "Eightfold/Microsoft URL should look like: https://<domain>/api/pcsx/search?domain=<domain>&..."
          : source === "netflix"
            ? "Netflix URL should look like: https://explore.jobs.netflix.net/api/apply/v2/jobs?domain=netflix.com&..."
            : "Greenhouse URL should look like: https://boards-api.greenhouse.io/v1/boards/<company>/jobs",
    };
  }
  return { ok: true, normalizedUrl: rules.normalize(cleanUrl) };
}

function getDomainFromFeed(feed) {
  try {
    const url = feed.url || "";
    // Eightfold often has domain in params or subdomain
    if (feed.source === "eightfold" || url.includes("eightfold.ai")) {
      const match = url.match(/domain=([^&]+)/);
      if (match) return match[1];
      const host = new URL(url).hostname;
      return host.replace(".eightfold.ai", ".com");
    }
    // Netflix
    if (feed.source === "netflix") return "netflix.com";
    // Greenhouse
    if (url.includes("greenhouse.io")) {
      const parts = url.split("/");
      const boardIdx = parts.indexOf("boards");
      if (boardIdx !== -1 && parts[boardIdx + 1]) return `${parts[boardIdx + 1]}.com`;
    }
    // Ashby
    if (url.includes("ashbyhq.com")) {
      const parts = url.split("/");
      return `${parts[parts.length - 1]}.com`;
    }
    // Fallback to company name
    return `${(feed.company || "company").toLowerCase().replace(/\s+/g, "")}.com`;
  } catch (e) {
    return "google.com";
  }
}

// Global cache to track which logos have already finished loading in this session
const LOADED_LOGOS_CACHE = new Set();

const LogoImage = ({ src, alt, company }) => {
  const [loaded, setLoaded] = useState(LOADED_LOGOS_CACHE.has(src));

  const handleLoad = () => {
    LOADED_LOGOS_CACHE.add(src);
    setLoaded(true);
  };

  return (
    <div className="relative h-12 w-full flex items-center justify-center">
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onLoad={handleLoad}
        className={`max-h-12 w-full object-contain filter grayscale group-hover:grayscale-0 transition-all duration-1000 ease-out ${
          loaded ? "opacity-100 scale-100" : "opacity-0 scale-95"
        }`}
        onError={(e) => {
          e.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(company)}&background=f3f4f6&color=6366f1&bold=true`;
          handleLoad();
        }}
      />
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-8 h-8 bg-gray-50 rounded-full animate-pulse" />
        </div>
      )}
    </div>
  );
};

export default function Feeds({ user }) {
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [company, setCompany] = useState(searchParams.get("company") || "");
  const [url, setUrl] = useState(searchParams.get("url") || "");
  const [feeds, setFeeds] = useState([]);
  const [busyArchiveId, setBusyArchiveId] = useState(null);
  const [busyRunNow, setBusyRunNow] = useState(false);
  const [lastRunSummary, setLastRunSummary] = useState(null);

  const LOGO_KEY = import.meta.env.VITE_LOGO_DEV_KEY || "";

  useEffect(() => {
    const feedsRef = collection(db, "users", ADMIN_UID, "feeds");
    const qFeeds = query(feedsRef, orderBy("createdAt", "desc"));
    return onSnapshot(qFeeds, (snap) =>
      setFeeds(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    );
  }, [user.uid]);

  const activeFeeds = useMemo(() => feeds.filter((f) => !f.archivedAt), [feeds]);
  const archivedFeeds = useMemo(() => feeds.filter((f) => !!f.archivedAt), [feeds]);

  const feedStats = useMemo(() => {
    const counts = { greenhouse: 0, ashby: 0, eightfold: 0 };
    for (const f of activeFeeds) {
      const src = f.source || detectSourceFromUrl(f.url);
      if (src === "greenhouse") counts.greenhouse++;
      else if (src === "ashby") counts.ashby++;
      else counts.eightfold++; // eightfold + netflix + anything else
    }
    return [
      { name: "Greenhouse", value: counts.greenhouse },
      { name: "AshbyHQ", value: counts.ashby },
      { name: "Eightfold.ai", value: counts.eightfold },
    ];
  }, [activeFeeds]);
  const detectedSource = useMemo(() => detectSourceFromUrl(url), [url]);

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
      await addDoc(collection(db, "users", ADMIN_UID, "feeds"), {
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
      const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID || db.app.options.projectId;
      if (!projectId) {
        showToast("Missing project id env.", "error");
        return;
      }
      const idToken = await user.getIdToken();
      const endpoint = `https://us-central1-${projectId}.cloudfunctions.net/runSyncNow?userId=${encodeURIComponent(ADMIN_UID)}`;
      const resp = await fetch(endpoint, { 
        method: "GET",
        headers: {
          "Authorization": `Bearer ${idToken}`
        }
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        showToast(data?.error || "Manual run failed.", "error");
        return;
      }
      setLastRunSummary(data);
      showToast(`Sync complete — scanned ${data?.scanned || 0}, wrote ${data?.updated || 0}`, "success");
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
      await updateDoc(doc(db, "users", ADMIN_UID, "feeds", feedId), { archivedAt: serverTimestamp() });
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
      await updateDoc(doc(db, "users", ADMIN_UID, "feeds", feedId), { archivedAt: null });
      showToast("Feed restored to active", "success");
    } catch (err) {
      console.error(err);
      showToast("Error restoring feed", "error");
    } finally {
      setBusyArchiveId(null);
    }
  }

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    showToast("URL copied to clipboard", "success");
  };

  return (
    <div className="page-wrapper">
      <div className="page-header">
        <h1>Feed Management</h1>
        <p>Connect Greenhouse and AshbyHQ job boards, manage your sources, and trigger syncs.</p>
      </div>

      <div className="section-grid">
        <div className="bg-indigo-50/30 p-6 rounded-2xl border border-indigo-100/50">
          <h2 className="text-[10px] font-black uppercase tracking-widest text-indigo-900/60">
            Job Board Sources
          </h2>
          <p className="mt-2 text-sm text-indigo-900/80 leading-relaxed">
            Connect <span className="font-semibold">Greenhouse</span>,{" "}
            <span className="font-semibold">AshbyHQ</span>, and{" "}
            <span className="font-semibold">Eightfold.ai</span> (Microsoft, PayPal, Nvidia, etc.) job boards.
          </p>

          <div className="mt-6">
            <button
              onClick={runSyncNow}
              disabled={busyRunNow}
              className="btn-primary w-full shadow-lg shadow-indigo-200/50 uppercase tracking-widest text-[11px] font-black py-3"
            >
              {busyRunNow ? "Syncing..." : "Run sync now"}
            </button>
          </div>

          <p className="mt-4 text-[11px] text-indigo-900/50 leading-relaxed italic">
            This triggers the backend ingestion immediately. Check results in the sync history.
          </p>
        </div>

        <div className="md:col-span-2">
          <form onSubmit={addFeed} className="space-y-4 bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
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
                  <span className="ml-2 text-[10px] font-black tracking-widest text-indigo-400">
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
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                className="btn-primary uppercase tracking-widest text-[11px] font-black px-8"
              >
                Add Feed
              </button>
            </div>
          </form>
        </div>
      </div>

      <div className="mt-16">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-10 text-center sm:grid-cols-3">
          {feedStats.map((stat) => (
            <div key={stat.name} className="mx-auto flex max-w-xs flex-col gap-y-2">
              <dt className="text-sm text-gray-500">{stat.name}</dt>
              <dd className="order-first text-4xl font-bold tracking-tight text-gray-900">
                {stat.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="mt-16">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h3 className="text-xl font-bold text-gray-900">Active Monitoring</h3>
            <p className="text-sm text-gray-500 mt-1">Currently tracking {activeFeeds.length} job boards</p>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-0.5 overflow-hidden rounded-2xl ring-1 ring-gray-100 bg-gray-100">
          {activeFeeds.map((feed, idx) => {
            const domain = getDomainFromFeed(feed);
            const logoUrl = `https://img.logo.dev/${domain}?token=${LOGO_KEY}&retina=true`;
            
            return (
              <ScrollReveal key={feed.id} delay={(idx % 4) * 100}>
                <div className="group relative bg-white p-8 sm:p-10 flex flex-col items-center justify-center h-full min-h-[220px] hover:z-10 transition-all duration-300 hover:shadow-2xl hover:shadow-indigo-500/10">
                  <div className="absolute top-4 right-4 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => copyToClipboard(feed.url)}
                      className="p-1.5 rounded-md bg-gray-50 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                      title="Copy Feed URL"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                      </svg>
                    </button>
                    <button
                      onClick={() => archiveFeed(feed.id)}
                      disabled={busyArchiveId === feed.id}
                      className="p-1.5 rounded-md bg-gray-50 text-gray-400 hover:text-amber-600 hover:bg-amber-50 transition-colors"
                      title="Archive Feed"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M10 8v11m4-11v11M4 8l1-1h10l1 1M10 5a2 2 0 114 0" />
                      </svg>
                    </button>
                  </div>

                  <div className="w-full flex flex-col items-center">
                    <div className="mb-6 w-full">
                      <LogoImage
                         src={logoUrl}
                        alt={feed.company}
                        company={feed.company}
                      />
                    </div>
                    <h4 className="text-sm font-bold text-gray-900 text-center uppercase tracking-tight">{feed.company}</h4>
                    <span className="mt-2 inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-indigo-600 ring-1 ring-inset ring-indigo-700/10">
                      {prettySourceLabel(feed.source || detectSourceFromUrl(feed.url))}
                    </span>
                  </div>
                </div>
              </ScrollReveal>
            );
          })}
          
          {activeFeeds.length === 0 && (
            <div className="col-span-full bg-white py-20 text-center">
              <p className="text-sm text-gray-400 italic">No active feeds. Add one above to start monitoring.</p>
            </div>
          )}
        </div>

        {archivedFeeds.length > 0 && (
          <div className="mt-16">
            <h3 className="text-xs font-black uppercase tracking-widest text-gray-400 mb-6">Archived History</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
               {archivedFeeds.map((feed) => (
                <div key={feed.id} className="group bg-gray-50/50 p-4 rounded-xl border border-gray-100 flex flex-col items-center opacity-60 hover:opacity-100 transition-opacity">
                  <span className="text-[10px] font-bold text-gray-900 truncate w-full text-center">{feed.company}</span>
                  <button
                    onClick={() => restoreFeed(feed.id)}
                    className="mt-2 text-[9px] font-black uppercase tracking-widest text-indigo-600 hover:text-indigo-800"
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

