
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { doc, onSnapshot } from "firebase/firestore";
import { AnimatePresence, motion } from "framer-motion";
import { jsPDF } from "jspdf";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";
import { useToast } from "../components/Toast/ToastProvider.jsx";
import { ADMIN_UID } from "../App.jsx";
import { useDataCache } from "../contexts/DataCacheContext.jsx";
import { track } from "../lib/analytics.js";
import { buildResumeLatex, emphasisRuns } from "../lib/resumeLatex.js";


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
  if (!ts?.toDate) return "N/A";
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
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "N/A";
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / (1000 * 60));
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (mins > 0) return `${mins}m`;
  return "Now";
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
  const { getCompanyStats } = useDataCache();

  const [searchParams, setSearchParams] = useSearchParams();

  const [companies, setCompanies] = useState([]);
  const [selectedKeys, setSelectedKeys] = useState(
    () => (searchParams.get("companies") || "").split(",").map(s => s.trim()).filter(Boolean)
  );

  const [jobs, setJobs] = useState([]);
  const [myScores, setMyScores] = useState({}); // { [jobId]: { score, reason } }
  const [loading, setLoading] = useState(true);

  const [titleSearch, setTitleSearch] = useState(() => searchParams.get("title") || "");
  const [companySearch, setCompanySearch] = useState("");
  const [stateFilter, setStateFilter] = useState(() => searchParams.get("state") || "");
  const [timeframe, setTimeframe] = useState(() => searchParams.get("t") || "1h");
  const [isFilterExpanded, setIsFilterExpanded] = useState(false);

  // Keep the URL in sync with shareable filter state.
  useEffect(() => {
    const next = new URLSearchParams();
    if (selectedKeys.length) next.set("companies", selectedKeys.join(","));
    if (titleSearch.trim()) next.set("title", titleSearch.trim());
    if (stateFilter) next.set("state", stateFilter);
    if (timeframe && timeframe !== "1h") next.set("t", timeframe);
    setSearchParams(next, { replace: true });
  }, [selectedKeys, titleSearch, stateFilter, timeframe, setSearchParams]);

  // Cover Letter State
  const [clState, setClState] = useState({ isOpen: false, job: null, loading: false, text: "", error: "" });
  // Tailored Resume State
  const [trState, setTrState] = useState({ isOpen: false, job: null, loading: false, data: null, error: "" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stats = await getCompanyStats();
        const list = Object.entries(stats.companies || {})
          .map(([key, val]) => ({ id: key, companyKey: key, companyName: val.name, jobCount: val.count }))
          .sort((a, b) => a.companyName.localeCompare(b.companyName));
        if (!cancelled) setCompanies(list);
      } catch (e) {
        console.error("Load companies error:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [user.uid, getCompanyStats]);

  // ─── Job enrichment shared by both data sources ────────────────────────
  const enrichJob = useCallback((data, id) => {
    const locationNameToken = Array.isArray(data.locationTokens)
      ? data.locationTokens.map(t => typeof t === "string" ? t : (t?.name || t?.city || "")).filter(Boolean).join("; ")
      : "";
    const locationName = data.locationName || locationNameToken || "Remote";
    const companyName = data.companyName || "Unknown";
    const stateCodes =
      Array.isArray(data.stateCodes) && data.stateCodes.length > 0
        ? data.stateCodes
        : extractStateCodesFromLocationTokens(data.locationTokens || locationName);
    const updatedShort = data.sourceUpdatedTs?.toDate
      ? shortAgoFromDate(data.sourceUpdatedTs.toDate())
      : "N/A";
    return {
      id,
      ...data,
      companyName,
      locationName,
      stateCodes,
      absolute_url: data.jobUrl || data.applyUrl || "#",
      firstSeenAt: data.firstSeenAt || data.fetchedAt || null,
      _updatedShort: updatedShort,
    };
  }, []);

  // ─── Single data source for all timeframes: aggregation docs.
  //     Cost per session: 1 read for the initial load + 1 per backend rebuild.
  //     - timeframe === "all" → /users/{ADMIN_UID}/aggregations/allJobs
  //         (lean projection, up to ALL_JOBS_LIMIT ≈ 1500 jobs)
  //         Falls back to recentJobs if allJobs hasn't been built yet.
  //     - all other timeframes → /users/{ADMIN_UID}/aggregations/recentJobs
  //         (full projection, up to RECENT_JOBS_LIMIT = 500 jobs)
  //     Both docs are maintained by Cloud Functions: scoreNewJobsForUser,
  //     syncUserRecentJobs, and dailyAggregationReconciliation all rebuild them.
  useEffect(() => {
    setLoading(true);
    const primaryDocId = timeframe === "all" ? "allJobs" : "recentJobs";
    const fallbackDocId = timeframe === "all" ? "recentJobs" : null;

    let unsubFallback = null;

    const subscribeToFallback = () => {
      if (!fallbackDocId || unsubFallback) return;
      const fbRef = doc(db, "users", ADMIN_UID, "aggregations", fallbackDocId);
      unsubFallback = onSnapshot(
        fbRef,
        (snap) => {
          const data = snap.exists() ? snap.data() : null;
          const list = Array.isArray(data?.jobs) ? data.jobs : [];
          setJobs(list.map((j) => enrichJob(j, j.id)));
          setLoading(false);
        },
        (err) => {
          console.error(`${fallbackDocId} fallback snapshot error:`, err);
          setLoading(false);
        }
      );
    };

    const ref = doc(db, "users", ADMIN_UID, "aggregations", primaryDocId);
    const unsubPrimary = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          if (fallbackDocId) {
            subscribeToFallback();
          } else {
            setJobs([]);
            setLoading(false);
          }
          return;
        }
        const data = snap.data();
        const list = Array.isArray(data.jobs) ? data.jobs : [];
        setJobs(list.map((j) => enrichJob(j, j.id)));
        setLoading(false);
      },
      (err) => {
        console.error(`${primaryDocId} snapshot error:`, err);
        showToast("Error loading jobs.", "error");
        setLoading(false);
      }
    );
    return () => {
      unsubPrimary();
      if (unsubFallback) unsubFallback();
    };
  }, [timeframe, enrichJob, showToast]);

  // ─── Per-user AI scores ──────────────────────────────────────────────
  //  Subscribes to /users/{currentUser.uid}/aggregations/myJobScores, a single
  //  doc holding a map of jobId → { score, reason } for THIS user only.
  //  Cost: 1 read per session + 1 per backend rebuild (after scoring).
  //  Non-admin users with AI disabled simply get an empty doc.
  useEffect(() => {
    if (!user?.uid) return undefined;
    const ref = doc(db, "users", user.uid, "aggregations", "myJobScores");
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          setMyScores({});
          return;
        }
        const data = snap.data();
        setMyScores(data && typeof data.scores === "object" ? data.scores : {});
      },
      (err) => {
        console.warn("myJobScores snapshot error:", err);
        setMyScores({});
      }
    );
    return () => unsub();
  }, [user?.uid]);

  const handleGenerateCoverLetter = async (e, job) => {
    e.preventDefault();
    e.stopPropagation();
    setClState({ isOpen: true, job, loading: true, text: "", error: "" });
    const startedAt = Date.now();
    track("cover_letter_requested", { source: job.source, company: job.companyName });
    try {
      const coverLetterFn = httpsCallable(functions, "generateCoverLetter", { headers: { "X-Session-Token": localStorage.getItem("jw_session_token") || "" } });
      const res = await coverLetterFn({ jobId: job.id });
      if (res.data?.text) {
        track("cover_letter_generated", {
          source: job.source,
          duration_ms: Date.now() - startedAt,
          chars: res.data.text.length,
        });
        setClState({ isOpen: true, job, loading: false, text: res.data.text, error: "" });
      } else {
        throw new Error("No text returned");
      }
    } catch (err) {
      console.error("Cover Letter gen error:", err);
      // Clean up firebase error msg
      const cleanMsg = err.message ? err.message.replace(/\[.*\]\s*/, "") : "Failed to generate";
      track("cover_letter_failed", { reason: cleanMsg?.slice(0, 80) });
      setClState({ isOpen: true, job, loading: false, text: "", error: cleanMsg });
    }
  };

  const handleGenerateResume = async (e, job, force = false) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    setTrState({ isOpen: true, job, loading: true, data: null, error: "" });
    const startedAt = Date.now();
    track("tailored_resume_requested", { source: job.source, company: job.companyName, force });
    try {
      const fn = httpsCallable(functions, "generateTailoredResume", { headers: { "X-Session-Token": localStorage.getItem("jw_session_token") || "" } });
      const res = await fn({ jobId: job.id, force });
      if (!res.data?.resume) throw new Error("No resume returned");
      track("tailored_resume_generated", {
        source: job.source,
        duration_ms: Date.now() - startedAt,
        cached: !!res.data.cached,
        coverage: res.data.matchReport?.coveragePct ?? null,
      });
      setTrState({ isOpen: true, job, loading: false, data: res.data, error: "" });
    } catch (err) {
      console.error("Tailored resume error:", err);
      const cleanMsg = err.message ? err.message.replace(/\[.*\]\s*/, "") : "Failed to generate";
      track("tailored_resume_failed", { reason: cleanMsg?.slice(0, 80) });
      setTrState({ isOpen: true, job, loading: false, data: null, error: cleanMsg });
    }
  };

  // Single-column, text-only layout so applicant tracking systems parse it cleanly.
  // ── Tailored resume exports ──────────────────────────────────────────────
  // Both mirror the user's own LaTeX resume template: .tex is the template
  // itself (Overleaf-ready); the PDF approximates it with jsPDF for a quick copy.
  const resumeContact = () => ({
    name: userMeta?.fullName || user?.displayName || "",
    location: userMeta?.city || "",
    phone: userMeta?.phone || "",
    email: userMeta?.email || user?.email || "",
    github: userMeta?.github || "",
    linkedin: userMeta?.linkedin || "",
  });
  const resumeFileBase = () => {
    const company = trState.job?.companyName || "Company";
    const role = trState.job?.title || "Role";
    const fullName = trState.data?.resume?.header?.name || userMeta?.fullName || user?.displayName || "Resume";
    return `${company} - ${role} - ${fullName} - Resume`.replace(/[<>:"/\\|?*]/g, "_").trim();
  };

  const handleDownloadResumeTex = () => {
    const resume = trState.data?.resume;
    if (!resume) return;
    const tex = buildResumeLatex(resume, resumeContact());
    const blob = new Blob([tex], { type: "application/x-tex;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${resumeFileBase()}.tex`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    track("tailored_resume_downloaded", { company: trState.job?.companyName, format: "tex" });
  };

  const handleDownloadResumePdf = () => {
    const resume = trState.data?.resume;
    if (!resume) return;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 0.38 * 72; // matches geometry margin=0.38in
    const width = pageW - margin * 2;
    const FONT = "times";
    let y = margin + 4;

    const ensure = (h) => {
      if (y + h > pageH - margin) {
        doc.addPage();
        y = margin;
      }
    };
    const setStyle = (size, style = "normal") => {
      doc.setFont(FONT, style);
      doc.setFontSize(size);
    };
    // Word-wrap runs of {text, bold} and draw them; returns nothing, advances y.
    const drawRich = (input, x, maxWidth, size, baseStyle = "normal") => {
      const runs = typeof input === "string" ? emphasisRuns(input) : input;
      const words = [];
      for (const r of runs) {
        const style = r.bold ? "bold" : baseStyle;
        r.text.split(/(\s+)/).forEach((w) => { if (w) words.push({ w, style }); });
      }
      const lh = size * 1.22;
      let line = [];
      let lineW = 0;
      const flush = () => {
        ensure(lh);
        let cx = x;
        for (const t of line) {
          setStyle(size, t.style);
          doc.text(t.w, cx, y);
          cx += doc.getTextWidth(t.w);
        }
        y += lh;
        line = [];
        lineW = 0;
      };
      for (const t of words) {
        setStyle(size, t.style);
        const ww = doc.getTextWidth(t.w);
        if (lineW + ww > maxWidth && line.length && !/^\s+$/.test(t.w)) flush();
        if (line.length === 0 && /^\s+$/.test(t.w)) continue;
        line.push(t);
        lineW += ww;
      }
      if (line.length) flush();
    };
    const section = (title) => {
      y += 6;
      ensure(22);
      setStyle(12.5, "normal");
      doc.text(title.toUpperCase(), margin, y);
      y += 3;
      doc.setLineWidth(0.6);
      doc.line(margin, y, pageW - margin, y);
      y += 12;
    };
    const twoCol = (leftText, rightText, size, leftStyle, rightStyle) => {
      ensure(size * 1.3);
      setStyle(size, leftStyle);
      doc.text(leftText || "", margin, y);
      if (rightText) {
        setStyle(size, rightStyle);
        doc.text(rightText, pageW - margin, y, { align: "right" });
      }
      y += size * 1.3;
    };
    const bullets = (items) => {
      for (const b of items || []) {
        ensure(13);
        setStyle(9.5, "normal");
        doc.text("•", margin + 6, y);
        drawRich(b, margin + 18, width - 18, 9.5);
        y += 1;
      }
    };

    const h = { ...resumeContact(), ...(resume.header || {}) };
    setStyle(19, "bold");
    ensure(30);
    doc.text(String(h.name || "").toUpperCase(), pageW / 2, y, { align: "center" });
    y += 16;
    const strip = (u) => String(u || "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
    const contact = [h.location, h.phone, h.email, h.github ? strip(h.github) : null, h.linkedin ? strip(h.linkedin) : null].filter(Boolean).join("  |  ");
    if (contact) {
      setStyle(9.5, "normal");
      doc.text(contact, pageW / 2, y, { align: "center" });
      y += 10;
    }

    if (resume.summary) {
      section("Profile");
      drawRich(resume.summary, margin, width, 9.5);
    }
    const groups = resume.skillGroups?.length ? resume.skillGroups : (resume.skills?.length ? [{ label: "Skills", skills: resume.skills }] : []);
    if (groups.length) {
      section("Skills");
      for (const g of groups) {
        if (!g?.skills?.length) continue;
        drawRich([{ text: `${g.label}: `, bold: true }, { text: g.skills.join(", "), bold: false }], margin, width, 9.5);
      }
    }
    if (resume.roles?.length) {
      section("Professional Experience");
      for (const r of resume.roles) {
        const dates = [r.startDate, r.endDate].filter(Boolean).join(" – ");
        twoCol(r.company, dates, 10.5, "bold", "normal");
        twoCol(r.title, r.location, 9.5, "italic", "italic");
        y += 1;
        bullets(r.bullets);
        y += 3;
      }
    }
    if (resume.projects?.length) {
      section("Selected Projects");
      for (const p of resume.projects) {
        twoCol(p.name, p.link ? strip(p.link) : "", 10.5, "bold", "normal");
        bullets(p.bullets);
        y += 3;
      }
    }
    if (resume.education?.length) {
      section("Education");
      for (const e of resume.education) {
        const dates = [e.startDate, e.endDate].filter(Boolean).join(" – ");
        twoCol(e.institution, dates, 10.5, "bold", "normal");
        twoCol(e.degree, e.location, 9.5, "italic", "italic");
        y += 2;
      }
    }
    if (resume.certifications?.length) {
      section("Certifications");
      bullets(resume.certifications);
    }

    doc.save(`${resumeFileBase()}.pdf`);
    track("tailored_resume_downloaded", { company: trState.job?.companyName, format: "pdf" });
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
    const companyKeySet = selectedKeys.length > 0 ? new Set(selectedKeys) : null;
    const thresholdMs = (() => {
      if (timeframe === "all") return null;
      const hoursMap = { "24h": 24, "12h": 12, "6h": 6, "1h": 1 };
      const h = hoursMap[timeframe];
      return h ? Date.now() - h * 60 * 60 * 1000 : null;
    })();

    const filtered = jobs.filter((j) => {
      if (titleTerm && !j.title?.toLowerCase().includes(titleTerm)) return false;

      if (companyKeySet && !companyKeySet.has(j.companyKey)) return false;

      if (thresholdMs !== null) {
        const ts = j.sourceUpdatedTs?.toDate ? j.sourceUpdatedTs.toDate().getTime() : 0;
        if (!ts || ts < thresholdMs) return false;
      }

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

    // Merge in the current user's personal AI scores from myJobScores. Jobs
    // without a personal score render as "unscored" (which is correct for
    // any user who hasn't enabled AI / hasn't been backfilled).
    const merged = filtered.map((j) => {
      const s = myScores[j.id];
      if (!s) return j;
      return { ...j, relevanceScore: s.score, scoreReason: s.reason };
    });

    return merged.sort((a, b) => (b.relevanceScore ?? -1) - (a.relevanceScore ?? -1));
  }, [jobs, myScores, titleSearch, stateFilter, selectedKeys, timeframe]);

  const renderJobItem = (job) => {
    const updatedShort = job._updatedShort || "N/A";
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
          <a
            href={job.absolute_url || "#"}
            target="_blank"
            rel="noreferrer"
            onClick={() => track("job_opened", { source: job.source, company: job.companyName, has_score: job.relevanceScore != null })}
            className="min-w-0 flex-1"
          >
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
              <>
                <button
                  onClick={(e) => handleGenerateResume(e, job)}
                  className="px-2.5 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest text-white bg-indigo-600 hover:bg-indigo-700 shadow-sm transition-colors"
                  title="Tailor your real experience to this job"
                >
                  Resume
                </button>
                <button
                  onClick={(e) => handleGenerateCoverLetter(e, job)}
                  className="px-2.5 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest text-indigo-600 bg-indigo-50 hover:bg-indigo-100 ring-1 ring-inset ring-indigo-200/50 transition-colors"
                >
                  Cover Letter
                </button>
              </>
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
              placeholder="e.g. NVIDIA (Tab to complete)"
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

      {/* Tailored Resume Modal */}
      <AnimatePresence>
        {trState.isOpen && (
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
              className="bg-white rounded-2xl shadow-xl w-full max-w-4xl overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-gray-50/50">
                <div>
                  <h3 className="text-sm font-bold text-gray-900">Tailored Resume</h3>
                  <p className="text-[11px] font-semibold text-indigo-600 uppercase tracking-widest mt-0.5">
                    {trState.job?.companyName} • {trState.job?.title}
                  </p>
                </div>
                <button
                  onClick={() => setTrState({ ...trState, isOpen: false })}
                  className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="flex-1 overflow-y-auto">
                {trState.loading ? (
                  <div className="flex flex-col items-center justify-center py-16 text-center text-gray-400">
                    <svg className="w-8 h-8 animate-spin text-indigo-500 mb-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
                      <path d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" fill="currentColor" className="opacity-75" />
                    </svg>
                    <p className="text-sm font-bold text-gray-700">Tailoring your experience to this job…</p>
                    <p className="text-xs text-gray-500 mt-1">Rewriting your real bullets in the JD's language, then auditing every line against your profile.</p>
                  </div>
                ) : trState.error ? (
                  <div className="m-6 p-4 bg-red-50 text-red-600 rounded-xl text-sm whitespace-pre-wrap font-mono ring-1 ring-inset ring-red-200">
                    {trState.error}
                  </div>
                ) : trState.data ? (
                  <div className="grid grid-cols-1 md:grid-cols-5 gap-0 md:divide-x divide-gray-100">
                    {/* Match report */}
                    <aside className="md:col-span-2 p-6 bg-gray-50/60 space-y-5">
                      {(() => {
                        const r = trState.data.matchReport || {};
                        const pct = r.coveragePct;
                        // Full class strings so Tailwind's scanner keeps them.
                        const tone = pct == null
                          ? { text: "text-gray-500", bar: "bg-gray-400" }
                          : pct >= 80
                            ? { text: "text-emerald-600", bar: "bg-emerald-500" }
                            : pct >= 60
                              ? { text: "text-amber-600", bar: "bg-amber-500" }
                              : { text: "text-red-600", bar: "bg-red-500" };
                        return (
                          <>
                            <div>
                              <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Requirement coverage</p>
                              <div className="mt-2 flex items-end gap-3">
                                <span className={`text-3xl font-black ${tone.text}`}>{pct == null ? "—" : `${pct}%`}</span>
                                <span className="text-xs text-gray-500 pb-1">
                                  {r.requirements?.filter((q) => q.covered === "yes").length || 0} covered ·{" "}
                                  {r.requirements?.filter((q) => q.covered === "partial").length || 0} partial ·{" "}
                                  {r.gaps?.length || 0} gaps
                                </span>
                              </div>
                              <div className="mt-2 h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
                                <div className={`h-full ${tone.bar}`} style={{ width: `${pct || 0}%` }} />
                              </div>
                              <p className="mt-2 text-[11px] text-gray-500 leading-relaxed">
                                Built only from your profile. Nothing was added that you haven't written; gaps are real gaps.
                              </p>
                            </div>
                            <ul className="space-y-1.5">
                              {(r.requirements || []).map((q, i) => (
                                <li key={i} className="flex gap-2 text-xs leading-snug">
                                  <span className={`mt-0.5 flex-shrink-0 ${q.covered === "yes" ? "text-emerald-600" : q.covered === "partial" ? "text-amber-500" : "text-red-500"}`}>
                                    {q.covered === "yes" ? "✓" : q.covered === "partial" ? "◐" : "✗"}
                                  </span>
                                  <span>
                                    <span className="text-gray-800">{q.requirement}</span>
                                    {q.evidence && <span className="block text-[11px] text-gray-400">{q.evidence}</span>}
                                  </span>
                                </li>
                              ))}
                            </ul>
                            {(r.removedBullets?.length > 0 || r.trimmedBullets?.length > 0) && (
                              <div className="rounded-xl bg-amber-50 ring-1 ring-inset ring-amber-200 p-3">
                                <p className="text-[10px] font-black uppercase tracking-widest text-amber-700">Checked against your profile</p>
                                <p className="text-[11px] text-amber-800 mt-1 mb-2">
                                  The draft claimed things your profile doesn't state. Those parts were trimmed or cut. If they're true, add the detail on your Profile page and regenerate.
                                </p>
                                <ul className="space-y-1.5">
                                  {(r.trimmedBullets || []).map((b, i) => (
                                    <li key={`t${i}`} className="text-[11px] text-amber-900">
                                      <span className="font-semibold">Trimmed:</span> {b.reason}
                                    </li>
                                  ))}
                                  {(r.removedBullets || []).map((b, i) => (
                                    <li key={`r${i}`} className="text-[11px] text-amber-900">
                                      <span className="line-through opacity-70">{b.text}</span>
                                      <span className="block text-amber-700">{b.reason}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </aside>

                    {/* Resume preview */}
                    <div className="md:col-span-3 p-6 text-[12.5px] text-gray-800 leading-relaxed">
                      {(() => {
                        const res = trState.data.resume;
                        const hdr = { ...resumeContact(), ...(res.header || {}) };
                        const Rich = ({ text }) => emphasisRuns(text).map((r, i) => r.bold ? <strong key={i} className="font-semibold text-gray-900">{r.text}</strong> : <span key={i}>{r.text}</span>);
                        const H = ({ children }) => (
                          <h4 className="mt-5 mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-700 border-b border-gray-300 pb-0.5" style={{ fontVariant: "small-caps" }}>{children}</h4>
                        );
                        const groups = res.skillGroups?.length ? res.skillGroups : (res.skills?.length ? [{ label: "Skills", skills: res.skills }] : []);
                        const strip = (u) => String(u || "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
                        return (
                          <div className="font-serif">
                            <p className="text-center text-xl font-black tracking-wide text-gray-900" style={{ fontVariant: "small-caps" }}>{hdr.name}</p>
                            <p className="text-center text-[11px] text-gray-600">
                              {[hdr.location, hdr.phone, hdr.email, hdr.github ? strip(hdr.github) : null, hdr.linkedin ? strip(hdr.linkedin) : null].filter(Boolean).join("  |  ")}
                            </p>
                            {res.summary && (<><H>Profile</H><p><Rich text={res.summary} /></p></>)}
                            {groups.length > 0 && (
                              <>
                                <H>Skills</H>
                                {groups.map((g, i) => g?.skills?.length ? <p key={i}><strong className="font-semibold text-gray-900">{g.label}:</strong> {g.skills.join(", ")}</p> : null)}
                              </>
                            )}
                            {res.roles?.length > 0 && (
                              <>
                                <H>Professional Experience</H>
                                {res.roles.map((r, i) => (
                                  <div key={i} className="mb-3">
                                    <div className="flex items-baseline justify-between gap-3">
                                      <p className="font-bold text-gray-900">{r.company}</p>
                                      <p className="text-[11px] text-gray-600 whitespace-nowrap">{[r.startDate, r.endDate].filter(Boolean).join(" – ")}</p>
                                    </div>
                                    <div className="flex items-baseline justify-between gap-3">
                                      <p className="italic text-gray-700">{r.title}</p>
                                      {r.location && <p className="text-[11px] italic text-gray-600 whitespace-nowrap">{r.location}</p>}
                                    </div>
                                    <ul className="mt-1 list-disc pl-5 space-y-0.5">
                                      {r.bullets.map((b, j) => <li key={j}><Rich text={b} /></li>)}
                                    </ul>
                                  </div>
                                ))}
                              </>
                            )}
                            {res.projects?.length > 0 && (
                              <>
                                <H>Selected Projects</H>
                                {res.projects.map((p, i) => (
                                  <div key={i} className="mb-2">
                                    <div className="flex items-baseline justify-between gap-3">
                                      <p className="font-bold text-gray-900">{p.name}</p>
                                      {p.link && <p className="text-[11px] underline text-gray-600 whitespace-nowrap">{strip(p.link)}</p>}
                                    </div>
                                    <ul className="mt-1 list-disc pl-5 space-y-0.5">{p.bullets.map((b, j) => <li key={j}><Rich text={b} /></li>)}</ul>
                                  </div>
                                ))}
                              </>
                            )}
                            {res.education?.length > 0 && (
                              <>
                                <H>Education</H>
                                {res.education.map((e, i) => (
                                  <div key={i} className="mb-1.5">
                                    <div className="flex items-baseline justify-between gap-3">
                                      <p className="font-bold text-gray-900">{e.institution}</p>
                                      <p className="text-[11px] text-gray-600 whitespace-nowrap">{[e.startDate, e.endDate].filter(Boolean).join(" – ")}</p>
                                    </div>
                                    <div className="flex items-baseline justify-between gap-3">
                                      <p className="italic text-gray-700">{e.degree}</p>
                                      {e.location && <p className="text-[11px] italic text-gray-600 whitespace-nowrap">{e.location}</p>}
                                    </div>
                                  </div>
                                ))}
                              </>
                            )}
                            {res.certifications?.length > 0 && (<><H>Certifications</H><ul className="list-disc pl-5">{res.certifications.map((c, i) => <li key={i}>{c}</li>)}</ul></>)}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="px-6 py-4 border-t border-gray-100 bg-gray-50/50 flex items-center justify-between gap-3">
                <p className="text-[11px] text-gray-400">
                  {trState.data?.cached ? "Saved version — regenerate after editing your profile." : trState.data ? "Saved for this job." : ""}
                </p>
                <div className="flex gap-3">
                  <button
                    onClick={() => setTrState({ ...trState, isOpen: false })}
                    className="px-4 py-2 text-xs font-bold text-gray-600 hover:text-gray-800 transition-colors"
                  >
                    Close
                  </button>
                  <button
                    onClick={(e) => handleGenerateResume(e, trState.job, true)}
                    disabled={trState.loading || !trState.job}
                    className="px-4 py-2 text-xs font-bold text-indigo-600 hover:text-indigo-800 disabled:opacity-50 transition-colors"
                  >
                    Regenerate
                  </button>
                  <button
                    onClick={handleDownloadResumePdf}
                    disabled={!trState.data?.resume || trState.loading}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-white hover:bg-gray-50 disabled:opacity-50 text-indigo-700 text-xs font-bold rounded-xl ring-1 ring-inset ring-indigo-200 transition-colors"
                    title="Quick PDF that approximates your LaTeX template"
                  >
                    PDF
                  </button>
                  <button
                    onClick={handleDownloadResumeTex}
                    disabled={!trState.data?.resume || trState.loading}
                    className="inline-flex items-center gap-2 px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:hover:bg-indigo-600 text-white text-xs font-bold rounded-xl transition-colors shadow-sm"
                    title="Your resume template, ready for Overleaf"
                  >
                    Download .tex
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
