// src/pages/Jobs.jsx
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  limit,
  startAfter,
  getDocs,
} from "firebase/firestore";
import { db } from "../firebase";

const PAGE_SIZE = 100;

// US states: code + name (for searchable picker inside dropdown)
const US_STATES = [
  { code: "AL", name: "Alabama" },
  { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" },
  { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" },
  { code: "DE", name: "Delaware" },
  { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" },
  { code: "HI", name: "Hawaii" },
  { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" },
  { code: "IN", name: "Indiana" },
  { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" },
  { code: "KY", name: "Kentucky" },
  { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" },
  { code: "MD", name: "Maryland" },
  { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Michigan" },
  { code: "MN", name: "Minnesota" },
  { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" },
  { code: "MT", name: "Montana" },
  { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" },
  { code: "NH", name: "New Hampshire" },
  { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" },
  { code: "NY", name: "New York" },
  { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" },
  { code: "OH", name: "Ohio" },
  { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" },
  { code: "PA", name: "Pennsylvania" },
  { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" },
  { code: "SD", name: "South Dakota" },
  { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" },
  { code: "UT", name: "Utah" },
  { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" },
  { code: "WA", name: "Washington" },
  { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" },
  { code: "WY", name: "Wyoming" },
  { code: "DC", name: "District of Columbia" },
];

// If you have older jobs without normalized country/states, keep a fallback US detector
function looksLikeUnitedStates(locationName) {
  const loc = String(locationName || "");
  if (/\b(united states|u\.s\.|usa)\b/i.test(loc)) return true;

  const stateCodeRegex =
    /(?:^|[\s,•|/()\-])(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)(?=$|[\s,•|/()\-])/i;
  return stateCodeRegex.test(loc);
}

function normalizeStateInputToCode(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const upper = raw.toUpperCase();

  const byCode = US_STATES.find((s) => s.code === upper);
  if (byCode) return byCode.code;

  const lower = raw.toLowerCase();
  const byName = US_STATES.find((s) => s.name.toLowerCase() === lower);
  if (byName) return byName.code;

  // Accept "CA - California" or "California (CA)" etc
  for (const st of US_STATES) {
    const a = `${st.code.toLowerCase()} - ${st.name.toLowerCase()}`;
    if (lower === a) return st.code;
    if (lower.includes(st.name.toLowerCase()) && lower.includes(st.code.toLowerCase())) return st.code;
  }

  return "";
}

function stateCodeToLabel(code) {
  const st = US_STATES.find((s) => s.code === code);
  if (!st) return code || "";
  return `${st.code} - ${st.name}`;
}

function formatUpdatedAt(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  // concise, readable
  return d.toLocaleString(undefined, { month: "short", day: "2-digit", year: "numeric" });
}

function UpdatedAtRight({ iso }) {
  return (
    <div className="flex flex-col items-end">
      <span className="text-[10px] font-black text-gray-300 group-hover:text-indigo-200 uppercase tracking-tighter transition-colors">
        Updated
      </span>
      <span className="text-sm font-bold text-gray-900" title={String(iso || "")}>
        {formatUpdatedAt(iso)}
      </span>
    </div>
  );
}

// Tailwind dropdown (React implementation) styled to match your snippet
function OptionsDropdown({ buttonLabel = "Options", children }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    function onDocClick(e) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target)) setOpen(false);
    }
    function onEsc(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, []);

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex w-full justify-center gap-x-1.5 rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-xs inset-ring-1 inset-ring-gray-300 hover:bg-gray-50"
      >
        {buttonLabel}
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
          className="-mr-1 size-5 text-gray-400"
        >
          <path
            d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
            clipRule="evenodd"
            fillRule="evenodd"
          />
        </svg>
      </button>

      {open ? (
        <div
          className="absolute right-0 z-50 mt-2 w-80 origin-top-right rounded-md bg-white shadow-lg outline-1 outline-black/5"
          role="menu"
          aria-orientation="vertical"
        >
          <div className="py-2">{children}</div>
        </div>
      ) : null}
    </div>
  );
}

export default function Jobs({ user, userMeta }) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [lastDoc, setLastDoc] = useState(null);
  const [hasMore, setHasMore] = useState(true);

  const [locationSearch, setLocationSearch] = useState("");
  const [selectedCompany, setSelectedCompany] = useState(null);
  const [companySearch, setCompanySearch] = useState("");

  // State filter stored as canonical code (e.g. "CA")
  const [stateFilter, setStateFilter] = useState("");
  const [stateInput, setStateInput] = useState("");

  const observer = useRef(null);

  const profileCountry = userMeta?.country || "United States";
  const profileRegion = userMeta?.region || "";

  // ✅ Default sort by updated_at (from Greenhouse JSON), newest first
  useEffect(() => {
    setLoading(true);
    const jobsRef = collection(db, "users", user.uid, "jobs");
    const q = query(jobsRef, orderBy("raw.updated_at", "desc"), limit(PAGE_SIZE));

    const unsub = onSnapshot(
      q,
      (snap) => {
        const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setJobs(docs);
        setLastDoc(snap.docs[snap.docs.length - 1] || null);
        setHasMore(snap.docs.length === PAGE_SIZE);
        setLoading(false);
      },
      (err) => {
        console.error("Jobs snapshot error:", err);
        setLoading(false);
      }
    );

    return () => unsub();
  }, [user.uid]);

  // keep stateInput in sync if stateFilter is programmatically cleared
  useEffect(() => {
    if (!stateFilter) setStateInput("");
    else setStateInput(stateCodeToLabel(stateFilter));
  }, [stateFilter]);

  const companies = useMemo(() => {
    const set = new Set();
    jobs.forEach((j) => {
      const c = (j.companyName || j.raw?.company_name || "").trim();
      if (c) set.add(c);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [jobs]);

  const filteredJobs = useMemo(() => {
    const locTerms = locationSearch.trim().toLowerCase();
    const companyTerms = companySearch.trim().toLowerCase();

    return jobs.filter((j) => {
      const company = (j.companyName || j.raw?.company_name || "").trim();
      const location = (j.locationName || j.raw?.location?.name || "").trim();

      // 1) Country enforcement (high recall for US)
      const jobCountry = j.country || null;
      const matchesCountry =
        (jobCountry && jobCountry === profileCountry) ||
        (!jobCountry &&
          profileCountry === "United States" &&
          (Array.isArray(j.states) ? j.states.length > 0 : false)) ||
        (!jobCountry && profileCountry === "United States" && looksLikeUnitedStates(location));

      if (!matchesCountry) return false;

      // 2) State filter (US only)
      if (profileCountry === "United States" && stateFilter) {
        const states = Array.isArray(j.states) ? j.states : [];
        const stateMatches =
          states.includes(stateFilter) ||
          // fallback for older docs:
          location.includes(`, ${stateFilter}`) ||
          new RegExp(`(?:^|[\\s,•|/()\\-])${stateFilter}(?=$|[\\s,•|/()\\-])`).test(location);

        if (!stateMatches) return false;
      }

      // 3) Company pill
      if (selectedCompany && company !== selectedCompany) return false;

      // 4) Company search
      if (companyTerms) {
        if (!company.toLowerCase().includes(companyTerms)) return false;
      }

      // 5) Location search
      if (locTerms) {
        if (!location.toLowerCase().includes(locTerms)) return false;
      }

      return true;
    });
  }, [jobs, locationSearch, companySearch, selectedCompany, stateFilter, profileCountry]);

  const fetchMore = async () => {
    if (!lastDoc || loading) return;
    setLoading(true);
    try {
      const jobsRef = collection(db, "users", user.uid, "jobs");
      const nextQ = query(
        jobsRef,
        orderBy("raw.updated_at", "desc"),
        startAfter(lastDoc),
        limit(PAGE_SIZE)
      );
      const snap = await getDocs(nextQ);
      const nextJobs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setJobs((prev) => [...prev, ...nextJobs]);
      setLastDoc(snap.docs[snap.docs.length - 1] || null);
      setHasMore(snap.docs.length === PAGE_SIZE);
    } catch (err) {
      console.error("Fetch more error:", err);
    } finally {
      setLoading(false);
    }
  };

  const lastElementRef = useCallback(
    (node) => {
      if (loading) return;
      if (observer.current) observer.current.disconnect();
      observer.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasMore) fetchMore();
      });
      if (node) observer.current.observe(node);
    },
    [loading, hasMore, lastDoc]
  );

  const statePickerDisabled = profileCountry !== "United States";

  const onStateInputChange = (val) => {
    setStateInput(val);
    const code = normalizeStateInputToCode(val);
    if (code) setStateFilter(code);
    if (!val.trim()) setStateFilter("");
  };

  const onStateInputBlur = () => {
    const code = normalizeStateInputToCode(stateInput);
    if (!stateInput.trim()) {
      setStateFilter("");
      return;
    }
    if (code) {
      setStateFilter(code);
      setStateInput(stateCodeToLabel(code));
    } else {
      setStateFilter("");
      setStateInput("");
    }
  };

  return (
    <div className="py-8" style={{ fontFamily: "Ubuntu, sans-serif" }}>
      <div className="mb-2">
        <h1 className="text-2xl font-bold text-gray-900">Opportunities</h1>
        <p className="text-sm text-gray-500 mt-1">
          Showing jobs for: <span className="font-semibold">{profileCountry}</span>
          {profileRegion ? <span className="text-gray-400"> • Profile region: {profileRegion}</span> : null}
        </p>
      </div>

      <div className="mb-6">
        <p className="text-sm text-gray-500">{filteredJobs.length} roles found</p>
      </div>

      {/* Filters row */}
      <div className="space-y-4 mb-8">
        <div className="flex flex-wrap items-center gap-4 p-4 bg-white rounded-xl ring-1 ring-gray-200 shadow-sm">
          <div className="flex-1 min-w-[260px]">
            <input
              placeholder="Search company..."
              className="input-standard !bg-gray-50 border-transparent focus:!bg-white"
              value={companySearch}
              onChange={(e) => setCompanySearch(e.target.value)}
            />
          </div>

          <div className="flex-1 min-w-[260px]">
            <input
              placeholder="Location contains..."
              className="input-standard !bg-gray-50 border-transparent focus:!bg-white"
              value={locationSearch}
              onChange={(e) => setLocationSearch(e.target.value)}
            />
          </div>

          {/* ✅ Use the dropdown snippet (React version) for state filter */}
          <OptionsDropdown buttonLabel="Options">
            <div className="px-4 py-2">
              <div className="text-xs font-bold uppercase tracking-widest text-gray-400">
                Filters
              </div>

              <div className="mt-3">
                <div className="text-sm font-semibold text-gray-900">State (US only)</div>
                <div className="mt-2">
                  <input
                    list="us-states"
                    value={stateInput}
                    onChange={(e) => onStateInputChange(e.target.value)}
                    onBlur={onStateInputBlur}
                    disabled={statePickerDisabled}
                    placeholder={statePickerDisabled ? "Disabled (non-US profile)" : "Type CA or California"}
                    className="input-standard !bg-gray-50 border-transparent focus:!bg-white"
                    title={statePickerDisabled ? "State filtering is only for United States jobs" : ""}
                  />
                  <datalist id="us-states">
                    {US_STATES.map((s) => (
                      <option key={s.code} value={`${s.code} - ${s.name}`} />
                    ))}
                  </datalist>
                </div>

                <div className="mt-2 flex items-center justify-between">
                  <div className="text-xs text-gray-500">
                    {stateFilter ? (
                      <>
                        Active: <span className="font-semibold text-gray-800">{stateFilter}</span>
                      </>
                    ) : (
                      "No state filter"
                    )}
                  </div>

                  {stateFilter ? (
                    <button
                      type="button"
                      onClick={() => setStateFilter("")}
                      className="text-sm font-semibold text-gray-700 hover:text-gray-900"
                    >
                      Clear
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="mt-4 border-t border-gray-100 pt-3 flex items-center justify-between">
                <div className="text-xs text-gray-500">
                  Sorting: <span className="font-semibold text-gray-800">updated_at</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setCompanySearch("");
                    setLocationSearch("");
                    setSelectedCompany(null);
                    setStateFilter("");
                  }}
                  className="text-sm font-semibold text-indigo-600 hover:text-indigo-700"
                >
                  Clear all
                </button>
              </div>
            </div>
          </OptionsDropdown>
        </div>

        {/* Active filter chips */}
        <div className="flex flex-wrap items-center gap-2">
          {profileCountry === "United States" && stateFilter ? (
            <span className="inline-flex items-center gap-2 rounded-full bg-indigo-50 text-indigo-700 px-3 py-1 text-xs font-semibold ring-1 ring-inset ring-indigo-100">
              State: {stateFilter}
              <button
                type="button"
                onClick={() => setStateFilter("")}
                className="text-indigo-700/70 hover:text-indigo-900"
                aria-label="Remove state filter"
              >
                ✕
              </button>
            </span>
          ) : null}

          {selectedCompany ? (
            <span className="inline-flex items-center gap-2 rounded-full bg-gray-100 text-gray-700 px-3 py-1 text-xs font-semibold ring-1 ring-inset ring-gray-200">
              Company: {selectedCompany}
              <button
                type="button"
                onClick={() => setSelectedCompany(null)}
                className="text-gray-600 hover:text-gray-900"
                aria-label="Remove company filter"
              >
                ✕
              </button>
            </span>
          ) : null}
        </div>

        {/* Company pills */}
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-2">
          {companies.map((c) => {
            const isSelected = selectedCompany === c;
            return (
              <button
                key={c}
                onClick={() => setSelectedCompany(isSelected ? null : c)}
                className={`flex items-center gap-2 px-4 py-1.5 rounded-full border text-xs font-medium whitespace-nowrap transition-all ${
                  isSelected
                    ? "bg-indigo-600 border-indigo-600 text-white shadow-sm"
                    : "bg-white border-gray-200 text-gray-600 hover:border-indigo-400"
                }`}
              >
                {c}
                {isSelected && <span className="text-[10px] opacity-80">✕</span>}
              </button>
            );
          })}
          {!companies.length ? <div className="text-xs text-gray-400 px-2">No companies yet.</div> : null}
        </div>
      </div>

      {/* Job List */}
      <div className="bg-white shadow-sm ring-1 ring-gray-200 rounded-2xl overflow-hidden">
        <ul className="divide-y divide-gray-100">
          {filteredJobs.map((job, index) => {
            const company = job.companyName || job.raw?.company_name || "Company";
            const title = job.title || job.raw?.title || "Untitled role";
            const location = job.locationName || job.raw?.location?.name || "Remote";
            const href = job.absolute_url || job.raw?.absolute_url || "#";
            const updatedAt = job.raw?.updated_at || null;

            return (
              <li
                key={job.id}
                ref={index === filteredJobs.length - 1 ? lastElementRef : null}
                className="group px-6 py-5 hover:bg-gray-50/80 transition-all"
              >
                <a href={href} target="_blank" rel="noreferrer" className="flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-xs font-bold text-indigo-600 uppercase tracking-tight">
                        {company}
                      </span>
                      <span className="text-gray-300">|</span>
                      <span className="text-xs text-gray-500 font-medium truncate">
                        {location}
                      </span>
                    </div>

                    <h3 className="text-base font-semibold text-gray-900 group-hover:text-indigo-600 transition-colors truncate">
                      {title}
                    </h3>
                  </div>

                  <div className="flex items-center gap-4 ml-4">
                    {/* ✅ Right side shows updated_at now */}
                    <UpdatedAtRight iso={updatedAt} />

                    <div className="h-8 w-8 rounded-full bg-gray-50 flex items-center justify-center text-gray-400 group-hover:bg-indigo-50 group-hover:text-indigo-600 transition-all">
                      →
                    </div>
                  </div>
                </a>
              </li>
            );
          })}
        </ul>

        {loading ? (
          <div className="p-8 text-center text-xs text-gray-400 animate-pulse uppercase tracking-widest">
            Loading...
          </div>
        ) : null}

        {!loading && !filteredJobs.length ? (
          <div className="p-10 text-center text-sm text-gray-500">
            No jobs match your filters.
          </div>
        ) : null}
      </div>
    </div>
  );
}
