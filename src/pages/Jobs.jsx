
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  where,
  Timestamp,
  doc,
  getDoc
} from "firebase/firestore";
import { AnimatePresence, motion } from "framer-motion";
import { jsPDF } from "jspdf";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";
import { useToast } from "../components/Toast/ToastProvider.jsx";
import { ADMIN_UID } from "../App.jsx";

const PAGE_SIZE = 50;


const US_STATES = [
  { code: "AL", name: "Alabama" }, { code: "AK", name: "Alaska" }, { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" }, { code: "CA", name: "California" }, { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" }, { code: "DE", name: "Delaware" }, { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" }, { code: "HI", name: "Hawaii" }, { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" }, { code: "IN", name: "Indiana" }, { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" }, { code: "KY", name: "Kentucky" }, { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" }, { code: "MD", name: "Maryland" }, { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Michigan" }, { code: "MN", name: "Minnesota" }, { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" }, { code: "MT", name: "Montana" }, { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" }, { code: "NH", name: "New Hampshire" }, { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" }, { code: "NY", name: "New York" }, { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" }, { code: "OH", name: "Ohio" }, { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" }, { code: "PA", name: "Pennsylvania" }, { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" }, { code: "SD", name: "South Dakota" }, { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" }, { code: "UT", name: "Utah" }, { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" }, { code: "WA", name: "Washington" }, { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" }, { code: "WY", name: "Wyoming" }, { code: "DC", name: "DC" },
];

function timeAgoFromFirestore(ts) {
  if (!ts?.toDate) return "—";
  const d = ts.toDate();
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / (1000 * 60));
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "just now";
}

function shortAgoFromDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "—";
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / (1000 * 60));
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (mins > 0) return `${mins}m`;
  return "Now";
}

function timeframeToThresholdTs(timeframe) {
  if (timeframe === "all") return null;
  const hoursMap = { "24h": 24, "12h": 12, "6h": 6, "1h": 1 };
  const hours = hoursMap[timeframe];
  if (!hours) return null;
  const ms = hours * 60 * 60 * 1000;
  return Timestamp.fromDate(new Date(Date.now() - ms));
}

function extractStateCodesFromLocationTokens(tokensOrString) {
  const tokens = Array.isArray(tokensOrString) ? tokensOrString : [tokensOrString].filter(Boolean);
  const found = new Set();
  for (const t of tokens) {
    const upper = String(t || "").toUpperCase();
    const matches = upper.match(/\b[A-Z]{2}\b/g) || [];
    for (const m of matches) {
      if (US_STATES.some((s) => s.code === m)) found.add(m);
    }
  }
  return Array.from(found);
}

export default function Jobs({ user, userMeta, preferences }) {
  const { showToast } = useToast();

  const [companies, setCompanies] = useState([]);
  const [selectedKeys, setSelectedKeys] = useState([]);

  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);

  const [titleSearch, setTitleSearch] = useState("");
  const [companySearch, setCompanySearch] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [timeframe, setTimeframe] = useState("1h");
  const [isFilterExpanded, setIsFilterExpanded] = useState(false);

  // Cover Letter State
  const [clState, setClState] = useState({ isOpen: false, job: null, loading: false, text: "", error: "" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const companiesRef = collection(db, "users", ADMIN_UID, "companies");
        const qCompanies = query(companiesRef, orderBy("companyName", "asc"), limit(1000));
        const snap = await getDocs(qCompanies);
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        if (!cancelled) setCompanies(list);
      } catch (e) {
        console.error("Load companies error:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [user.uid]);

  const fetchAllJobs = useCallback(
    async () => {
      setLoading(true);
      setJobs([]);

      try {
        const jobsCol = collection(db, "users", ADMIN_UID, "jobs");
        const allDocs = [];
        let cursor = null;

        // Loop through all pages until exhausted
        while (true) {
          const constraints = [];

          if (selectedKeys.length > 0) {
            constraints.push(where("companyKey", "in", selectedKeys.slice(0, 10)));
          }

          constraints.push(orderBy("sourceUpdatedTs", "desc"));

          if (timeframe !== "all") {
            const thresholdTs = timeframeToThresholdTs(timeframe);
            if (thresholdTs) constraints.push(where("sourceUpdatedTs", ">=", thresholdTs));
          }

          constraints.push(limit(PAGE_SIZE));
          if (cursor) constraints.push(startAfter(cursor));

          const snap = await getDocs(query(jobsCol, ...constraints));

          snap.docs.forEach((d) => {
            const data = d.data();

            const locationNameToken = Array.isArray(data.locationTokens) 
              ? data.locationTokens.map(t => typeof t === "string" ? t : (t?.name || t?.city || "")).filter(Boolean).join("; ")
              : "";

            const locationName =
              data.locationName || locationNameToken || "Remote";

            const companyName = data.companyName || "Unknown";

            const stateCodes =
              Array.isArray(data.stateCodes) && data.stateCodes.length > 0
                ? data.stateCodes
                : extractStateCodesFromLocationTokens(data.locationTokens || locationName);

            const updatedShort =
              data.sourceUpdatedTs?.toDate ? shortAgoFromDate(data.sourceUpdatedTs.toDate()) : "—";

            allDocs.push({
              id: d.id,
              ...data,
              companyName,
              locationName,
              stateCodes,
              absolute_url: data.jobUrl || data.applyUrl || "#",
              firstSeenAt: data.firstSeenAt || data.fetchedAt || null,
              _updatedShort: updatedShort,
              _path: d.ref.path,
            });
          });

          if (snap.docs.length < PAGE_SIZE) break; // no more pages
          cursor = snap.docs[snap.docs.length - 1];
        }

        setJobs(allDocs);
      } catch (err) {
        console.error("Fetch jobs error:", err);
        showToast("Error loading jobs. Check Firestore indexes.", "error");
      } finally {
        setLoading(false);
      }
    },
    [selectedKeys, timeframe, showToast]
  );

  useEffect(() => {
    fetchAllJobs();
  }, [selectedKeys, timeframe]);

  // Live polling: automatically fetch relevance scores for unscored jobs every 15s
  useEffect(() => {
    const unscoredJobs = jobs.filter((j) => typeof j.relevanceScore !== "number");
    if (unscoredJobs.length === 0) return;

    const intervalId = setInterval(async () => {
      try {
        const jobsCol = collection(db, "users", ADMIN_UID, "jobs");
        const updates = [];

        // Check up to 10 unscored jobs per tick
        for (const job of unscoredJobs.slice(0, 10)) {
          const snap = await getDoc(doc(jobsCol, job.id));
          if (snap.exists()) {
            const data = snap.data();
            if (typeof data.relevanceScore === "number") {
              updates.push({ id: job.id, relevanceScore: data.relevanceScore, scoreReason: data.scoreReason });
            }
          }
        }

        if (updates.length > 0) {
          setJobs((prev) =>
            prev.map((j) => {
              const matched = updates.find((u) => u.id === j.id);
              return matched ? { ...j, ...matched } : j;
            })
          );
        }
      } catch (err) {
        console.error("Polling error:", err);
      }
    }, 15000);

    return () => clearInterval(intervalId);
  }, [jobs]);

  const handleGenerateCoverLetter = async (e, job) => {
    e.preventDefault();
    e.stopPropagation();
    setClState({ isOpen: true, job, loading: true, text: "", error: "" });
    try {
      const coverLetterFn = httpsCallable(functions, "generateCoverLetter", { headers: { "X-Session-Token": localStorage.getItem("jw_session_token") || "" } });
      const res = await coverLetterFn({ jobId: job.id });
      if (res.data?.text) {
        setClState({ isOpen: true, job, loading: false, text: res.data.text, error: "" });
      } else {
        throw new Error("No text returned");
      }
    } catch (err) {
      console.error("Cover Letter gen error:", err);
      // Clean up firebase error msg
      const cleanMsg = err.message ? err.message.replace(/\[.*\]\s*/, "") : "Failed to generate";
      setClState({ isOpen: true, job, loading: false, text: "", error: cleanMsg });
    }
  };

  const handleAutoApply = (job) => {
    if (!job.absolute_url || job.absolute_url === "#") {
      alert("No application URL available for this job.");
      return;
    }
    // Send message to the JobWatch Auto Apply extension via postMessage.
    // The extension's content script (jobwatch-bridge.js) relays this to the background.
    window.postMessage(
      {
        type: "JOBWATCH_AUTO_APPLY",
        job: {
          id: job.id,
          title: job.title,
          companyName: job.companyName,
          absolute_url: job.absolute_url,
          source: job.source,
          companyKey: job.companyKey,
          externalId: job.externalId,
          locationName: job.locationName || "",
          workplaceType: job.workplaceType || null,
        },
      },
      window.location.origin
    );

    // Listen for acknowledgement from the extension
    const handler = (event) => {
      if (event.data?.type !== "JOBWATCH_AUTO_APPLY_ACK") return;
      window.removeEventListener("message", handler);
      if (!event.data.ok) {
        alert("JobWatch extension not detected. Install it from the Chrome Web Store.");
      }
    };
    window.addEventListener("message", handler);

    // If no ack in 1.5s, extension is probably not installed
    setTimeout(() => {
      window.removeEventListener("message", handler);
    }, 1500);
  };

  const handleDownloadPdf = () => {
    if (!clState.text) return;
    const doc = new jsPDF();
    
    doc.setFont("times", "normal");
    doc.setFontSize(12);
    
    const marginLeft = 20;
    const marginTop = 30;
    const maxWidth = 170;
    const lineHeight = 6.5; 

    const paragraphs = clState.text.split(/\n\s*\n/);
    let cursorY = marginTop;

    paragraphs.forEach((paragraph) => {
      const lines = doc.splitTextToSize(paragraph.trim(), maxWidth);
      
      lines.forEach((line) => {
        if (cursorY > 275) {
          doc.addPage();
          cursorY = marginTop;
        }
        doc.text(line, marginLeft, cursorY);
        cursorY += lineHeight; 
      });
      
      cursorY += 5; // Extra gap between paragraphs
    });

    const company = clState.job?.companyName || "Company";
    const role = clState.job?.title || "Role";
    const fullName = userMeta?.fullName || user?.displayName || "User";
    
    // Sanitize filename by removing invalid characters
    const fileName = `${company} - ${role} - ${fullName} - Cover Letter.pdf`
      .replace(/[<>:"/\\|?*]/g, "_")
      .trim();

    doc.save(fileName);
  };

  const toggleCompany = (key) => {
    setSelectedKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const filteredCompanies = useMemo(() => {
    const term = companySearch.trim().toLowerCase();
    if (!term) return companies;
    return companies.filter((c) => (c.companyName || "").toLowerCase().includes(term));
  }, [companies, companySearch]);
  const filteredJobs = useMemo(() => {
    const titleTerm = titleSearch.trim().toLowerCase();

    const filtered = jobs.filter((j) => {
      if (titleTerm && !j.title?.toLowerCase().includes(titleTerm)) return false;

      if (stateFilter) {
        if (Array.isArray(j.stateCodes)) {
          if (!j.stateCodes.includes(stateFilter)) return false;
        } else {
          const location = (j.locationName || "").trim().toUpperCase();
          const stateRegex = new RegExp(`(?:^|[^A-Z])${stateFilter}(?:$|[^A-Z])`);
          if (!stateRegex.test(location)) return false;
        }
      }

      return true;
    });

    return [...filtered].sort((a, b) => (b.relevanceScore ?? -1) - (a.relevanceScore ?? -1));
  }, [jobs, titleSearch, stateFilter]);

  const renderJobItem = (job) => {
    const updatedShort = job._updatedShort || "—";
    const score = job.relevanceScore;
    const hasScore = typeof score === "number";

    // Tier determines the score chip color only — no background floods
    const tier =
      score >= 80 ? { dot: "bg-indigo-500", label: "Strong Match", textCls: "text-indigo-600" }
        : score >= 60 ? { dot: "bg-indigo-400", label: "Good Match", textCls: "text-indigo-500" }
          : score >= 40 ? { dot: "bg-gray-400", label: "Partial Match", textCls: "text-gray-500" }
            : { dot: "bg-gray-300", label: "Weak Match", textCls: "text-gray-400" };

    const scoreBadge = (hasScore && preferences?.aiScoringEnabled && userMeta?.aiAccess !== false) ? (
      <span className="relative group/score inline-flex items-center gap-1.5 cursor-help">
        {/* Score chip */}
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-gray-100 ring-1 ring-gray-200 text-[10px] font-bold font-mono text-gray-700 transition-colors group-hover/score:bg-indigo-50 group-hover/score:ring-indigo-200 group-hover/score:text-indigo-700">
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${tier.dot}`} />
          {score}
        </span>
        {/* Label */}
        <span className={`text-[10px] font-bold uppercase tracking-widest ${tier.textCls}`}>
          {tier.label}
        </span>

        {/* AI reason tooltip — shows on hover */}
        {job.scoreReason && (
          <span className="pointer-events-none absolute bottom-full left-0 mb-2 z-50 w-56 opacity-0 group-hover/score:opacity-100 transition-opacity duration-150">
            <span className="block rounded-lg bg-gray-900 px-3 py-2 text-[11px] leading-relaxed text-white shadow-xl ring-1 ring-white/10">
              <span className="block text-[9px] font-black uppercase tracking-widest text-gray-400 mb-1">AI Analysis</span>
              {job.scoreReason}
            </span>
            {/* Arrow */}
            <span className="block w-2 h-2 bg-gray-900 rotate-45 ml-3 -mt-1" />
          </span>
        )}
      </span>
    ) : null;

    return (
      <li
        key={job.id}
        className="group relative px-6 py-5 hover:bg-gray-50/80 transition-all border-l-4 border-transparent hover:border-indigo-500"
      >
        <div className="absolute top-0 left-0 right-0 h-[1px] bg-indigo-500 opacity-0 group-hover:opacity-100 transition-opacity" />

        <div className="flex items-center justify-between gap-4">
          <a href={job.absolute_url || "#"} target="_blank" rel="noreferrer" className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-xs font-bold text-indigo-600 uppercase tracking-tight">
                {job.companyName || "Unknown"}
              </span>
              <span className="text-gray-300">|</span>
              <span className="text-xs text-gray-500 font-medium truncate">
                {job.locationName || "Remote"}
                {job.isRemote && <span className="ml-1 text-indigo-400 font-bold">(Remote)</span>}
              </span>
            </div>

            <h3 className="text-base font-semibold text-gray-900 group-hover:text-indigo-600 transition-colors truncate">
              {job.title}
            </h3>

            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 overflow-visible">
              <span className="text-xs text-gray-400">Discovered {timeAgoFromFirestore(job.firstSeenAt)}</span>
              {scoreBadge}
            </div>
          </a>

          <div className="flex items-center gap-4 flex-shrink-0 z-10">
            {preferences?.aiScoringEnabled && userMeta?.aiAccess !== false && (
              <button
                onClick={(e) => handleGenerateCoverLetter(e, job)}
                className="px-2.5 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest text-indigo-600 bg-indigo-50 hover:bg-indigo-100 ring-1 ring-inset ring-indigo-200/50 transition-colors"
              >
                Cover Letter
              </button>
            )}
            {job.absolute_url && userMeta?.aiAccess !== false && (job.source?.toLowerCase() === "ashby" || job.source?.toLowerCase() === "ashbyhq") && (
              <button
                onClick={(e) => { e.preventDefault(); handleAutoApply(job); }}
                className="px-3 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest text-white bg-emerald-500 hover:bg-emerald-600 active:scale-95 transition-all shadow-sm shadow-emerald-200 flex items-center gap-1.5"
              >
                <span>⚡</span> Auto Apply
              </button>
            )}
            <div className="hidden sm:flex flex-col items-end min-w-[70px]">
              <span className="text-[10px] font-black text-gray-300 group-hover:text-indigo-200 uppercase tracking-tighter transition-colors">
                Updated
              </span>
              <span className="text-sm font-bold text-gray-900">{updatedShort}</span>
            </div>
          </div>
        </div>
      </li>
    );
  };

  const renderSkeleton = () => (
    <div className="px-6 py-8 border-b border-gray-100 animate-pulse">
      <div className="h-3 w-24 bg-gray-200 rounded mb-3" />
      <div className="h-6 w-3/4 bg-gray-200 rounded mb-3" />
      <div className="h-3 w-40 bg-gray-100 rounded" />
    </div>
  );

  return (
    <div className="page-wrapper">

      <div className="page-header flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1>Opportunities</h1>
          <p>
            {selectedKeys.length === 0 ? "Viewing all companies" : `Filtering ${selectedKeys.length} company(ies)`}
          </p>
        </div>

        <div className="flex justify-center w-full md:w-auto overflow-hidden">
          <div className="inline-flex p-1 bg-gray-100 rounded-xl overflow-x-auto no-scrollbar scroll-smooth gap-0.5">
            {["all", "24h", "12h", "6h", "1h"].map((id) => (
              <button
                key={id}
                onClick={() => setTimeframe(id)}
                className={`px-4 py-1.5 text-[11px] font-bold rounded-lg transition-all whitespace-nowrap min-w-fit ${timeframe === id ? "bg-white text-indigo-600 shadow-sm" : "text-gray-500 hover:text-gray-700"
                  }`}
              >
                {id === "all" ? "All Jobs" : `Last ${id}`}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="p-4 mb-6 bg-white rounded-xl ring-1 ring-gray-200 shadow-sm flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-3">
          <div className="flex-1 w-full">
            <label className="caps-label mb-2 block px-1 text-gray-400 uppercase tracking-widest text-[10px] font-black">
              Job Title
            </label>
            <input
              placeholder="e.g. Software Engineer"
              className="input-standard !bg-gray-50 border-transparent focus:!bg-white h-11 w-full"
              value={titleSearch}
              onChange={(e) => setTitleSearch(e.target.value)}
            />
          </div>

          <div className="flex-1 w-full">
            <label className="caps-label mb-2 block px-1 text-gray-400 uppercase tracking-widest text-[10px] font-black">
              Company
            </label>
            <input
              placeholder="e.g. NVIDIA — Tab to complete"
              className="input-standard !bg-gray-50 border-transparent focus:!bg-white h-11 w-full"
              value={companySearch}
              onChange={(e) => setCompanySearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Tab" && companySearch.trim() && filteredCompanies.length > 0) {
                  e.preventDefault();
                  setCompanySearch(filteredCompanies[0].companyName || "");
                } else if (e.key === "Enter" && companySearch.trim() && filteredCompanies.length > 0) {
                  e.preventDefault();
                  toggleCompany(filteredCompanies[0].id);
                  setCompanySearch("");
                }
              }}
            />
          </div>

          <div className="flex items-center gap-2 mt-2 sm:mt-0 w-full sm:w-auto">
            <button
              onClick={() => setIsFilterExpanded(!isFilterExpanded)}
              className={`h-11 w-11 flex-shrink-0 flex items-center justify-center rounded-xl border transition-all ${isFilterExpanded
                ? "bg-indigo-50 border-indigo-200 text-indigo-600 shadow-inner"
                : "bg-white border-gray-200 text-gray-400 hover:bg-gray-50"
                }`}
              aria-label={isFilterExpanded ? "Hide filters" : "Show filters"}
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="size-5 transition-transform duration-300">
                <path d="M2.628 1.601C5.028 1.206 7.49 1 10 1s4.973.206 7.372.601a.75.75 0 0 1 .628.74v2.288a2.25 2.25 0 0 1-.659 1.59l-4.682 4.683a2.25 2.25 0 0 0-.659 1.59v3.037c0 .684-.31 1.33-.844 1.757l-1.937 1.55A.75.75 0 0 1 8 18.25v-5.757a2.25 2.25 0 0 0-.659-1.591L2.659 6.22A2.25 2.25 0 0 1 2 4.629V2.34a.75.75 0 0 1 .628-.74Z" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex justify-start sm:justify-end border-t border-gray-100 sm:border-0 pt-3 sm:pt-0">
          <button
            onClick={() => {
              setTitleSearch("");
              setCompanySearch("");
              setStateFilter("");
              setTimeframe("1h");
              setOnlyHighRelevant(false);
              setOnlyAutoApply(false);
              setSelectedKeys([]);
            }}
            className="text-xs font-bold text-gray-400 hover:text-indigo-600 py-1"
          >
            Reset All Filters
          </button>
        </div>
      </div>

      <AnimatePresence>
        {isFilterExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            className="overflow-hidden mb-8"
          >
            <div className="space-y-8 py-4 px-1">

              <div className="space-y-4">
                <div className="flex items-center gap-2 px-1">
                  <label className="caps-label text-gray-400 uppercase tracking-widest text-[10px] font-black">
                    Filter by State
                  </label>
                  <span className="bg-gray-100 text-gray-500 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                    {US_STATES.length}
                  </span>
                </div>

                <div className="flex w-full overflow-hidden">
                  <div className="inline-flex p-1 bg-gray-50 rounded-xl overflow-x-auto no-scrollbar scroll-smooth gap-1">
                    <button
                      onClick={() => setStateFilter("")}
                      className={`px-5 py-2.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${stateFilter === ""
                        ? "bg-white text-indigo-600 shadow-sm ring-1 ring-gray-200"
                        : "text-gray-500 hover:text-gray-700"
                        }`}
                    >
                      All States
                    </button>

                    {US_STATES.map((s) => (
                      <button
                        key={s.code}
                        onClick={() => setStateFilter(s.code)}
                        className={`px-5 py-2.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${stateFilter === s.code
                          ? "bg-indigo-600 text-white shadow-md shadow-indigo-100"
                          : "bg-white text-gray-500 ring-1 ring-inset ring-gray-200 hover:bg-gray-50"
                          }`}
                      >
                        {s.code} - {s.name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <div className="flex items-center gap-2 px-1">
                  <label className="caps-label text-gray-400 uppercase tracking-widest text-[10px] font-black">
                    Filter by Company (A-Z)
                  </label>
                  <span className="bg-gray-100 text-gray-500 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                    {companies.length}
                  </span>
                  {companySearch && (
                    <span className="bg-indigo-100 text-indigo-600 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                      {filteredCompanies.length} matches
                    </span>
                  )}
                </div>

                {selectedKeys.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 px-1">
                    {selectedKeys.map((key) => {
                      const comp = companies.find((c) => c.id === key);
                      const label = comp?.companyName || key;
                      return (
                        <button
                          key={key}
                          onClick={() => toggleCompany(key)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
                        >
                          {label}
                          <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                          </svg>
                        </button>
                      );
                    })}
                    <button
                      onClick={() => setSelectedKeys([])}
                      className="px-2.5 py-1 rounded-full text-[11px] font-bold text-gray-400 hover:text-red-500 transition-colors"
                    >
                      Clear all
                    </button>
                  </div>
                )}

                <div className="flex w-full overflow-hidden">
                  <div className="inline-flex p-1 bg-gray-50 rounded-xl overflow-x-auto no-scrollbar scroll-smooth gap-1">
                    <button
                      onClick={() => { setSelectedKeys([]); setCompanySearch(""); }}
                      className={`px-5 py-2.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${selectedKeys.length === 0 && !companySearch
                        ? "bg-white text-indigo-600 shadow-sm ring-1 ring-gray-200"
                        : "text-gray-500 hover:text-gray-700"
                        }`}
                    >
                      All Companies
                    </button>

                    {filteredCompanies.map((c) => {
                      const label = c.companyName || "Unknown";
                      return (
                        <button
                          key={c.id}
                          onClick={() => toggleCompany(c.id)}
                          className={`px-5 py-2.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${selectedKeys.includes(c.id)
                            ? "bg-indigo-600 text-white shadow-md shadow-indigo-100"
                            : "bg-white text-gray-500 ring-1 ring-inset ring-gray-200 hover:bg-gray-50"
                            }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {selectedKeys.length > 10 && (
                  <div className="px-2 text-xs text-amber-600 font-semibold">
                    Firestore "in" filter supports max 10 companies at a time. Only first 10 are applied.
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="bg-white shadow-sm ring-1 ring-gray-200 rounded-2xl overflow-hidden flex flex-col min-h-[500px] transition-all">
        <div className="px-6 py-4 border-b bg-gray-50/50 border-gray-100 flex items-center justify-between">
          <div>
            <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-600">
              Matched Roles{" "}
              {loading ? (
                ""
              ) : (
                <span className="ml-1 text-gray-400">
                  ({filteredJobs.filter((j) => typeof j.relevanceScore === "number").length} scored / {filteredJobs.length} total)
                </span>
              )}
            </h3>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></div>
            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Live Feed</span>
          </div>
        </div>
        {loading ? (
          <div className="flex-grow divide-y divide-gray-100">
            {Array.from({ length: 6 }).map((_, i) => (
              <React.Fragment key={i}>{renderSkeleton()}</React.Fragment>
            ))}
          </div>
        ) : filteredJobs.length === 0 ? (
          <div className="flex-grow flex flex-col items-center justify-center py-32 text-center bg-gray-50/10">
            <p className="text-sm font-semibold text-gray-900 tracking-tight">No positions found</p>
            <p className="text-xs text-gray-400 mt-1 max-w-[200px] leading-relaxed">Adjust filters to see more roles.</p>
          </div>
        ) : (
          <div className="flex-grow">
            <ul className="divide-y divide-gray-100">{filteredJobs.map((job) => renderJobItem(job))}</ul>
          </div>
        )}

        <div className="h-12 flex items-center justify-center border-t border-gray-50">
          {!loading && jobs.length > 0 && (
            <span className="text-[10px] font-black text-gray-200 uppercase tracking-widest">End of Feed</span>
          )}
        </div>
      </div>

      <AnimatePresence>
        {clState.isOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/40 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[85vh]"
            >
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-gray-50/50">
                <div>
                  <h3 className="text-sm font-bold text-gray-900">AI Cover Letter</h3>
                  <p className="text-[11px] font-semibold text-indigo-600 uppercase tracking-widest mt-0.5">
                    {clState.job?.companyName} • {clState.job?.title}
                  </p>
                </div>
                <button
                  onClick={() => setClState({ ...clState, isOpen: false })}
                  className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="p-6 flex-1 overflow-y-auto">
                {clState.loading ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center text-gray-400">
                    <svg className="w-8 h-8 animate-spin text-indigo-500 mb-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
                      <path d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" fill="currentColor" className="opacity-75" />
                    </svg>
                    <p className="text-sm font-bold text-gray-700">Writing highly targeted letter...</p>
                    <p className="text-xs text-gray-500 mt-1">Analyzing your resume against the JD.</p>
                  </div>
                ) : clState.error ? (
                  <div className="p-4 bg-red-50 text-red-600 rounded-xl text-sm whitespace-pre-wrap font-mono ring-1 ring-inset ring-red-200">
                    {clState.error}
                  </div>
                ) : (
                  <div className="text-[13px] text-gray-800 leading-relaxed font-serif whitespace-pre-wrap space-y-4">
                    {clState.text}
                  </div>
                )}
              </div>

              <div className="px-6 py-4 border-t border-gray-100 bg-gray-50/50 flex justify-end gap-3">
                <button
                  onClick={() => setClState({ ...clState, isOpen: false })}
                  className="px-4 py-2 text-xs font-bold text-gray-600 hover:text-gray-800 transition-colors"
                >
                  Close
                </button>
                <button
                  onClick={handleDownloadPdf}
                  disabled={!clState.text || clState.loading}
                  className="inline-flex items-center gap-2 px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:hover:bg-indigo-600 text-white text-xs font-bold rounded-xl transition-colors shadow-sm"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Download PDF
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
