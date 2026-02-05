// src/pages/Jobs.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  startAfter,
} from "firebase/firestore";
import { db } from "../firebase";

const PAGE_SIZE = 100;

// --- US states list for dropdown search ---
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

function normalizeStateInputToCode(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const upper = raw.toUpperCase();

  const byCode = US_STATES.find((s) => s.code === upper);
  if (byCode) return byCode.code;

  const lower = raw.toLowerCase();
  const byName = US_STATES.find((s) => s.name.toLowerCase() === lower);
  if (byName) return byName.code;

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

function timeAgoFromFirestore(ts) {
  if (!ts?.toDate) return "";
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

function shortAgoFromISO(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return "Now";

  const mins = Math.floor(diffMs / (1000 * 60));
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (mins > 0) return `${mins}m`;
  return "Now";
}

// Tailwind dropdown (React) styled like your snippet
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
        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="-mr-1 size-5 text-gray-400">
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
  const profileCountry = userMeta?.country || "United States";

  const [companies, setCompanies] = useState([]);
  const [selectedCompanyKey, setSelectedCompanyKey] = useState(null);

  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [lastDoc, setLastDoc] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const observer = useRef(null);

  const [locationSearch, setLocationSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [stateInput, setStateInput] = useState("");

  // 1) Load companies; default select the most recently seen company
  useEffect(() => {
    const companiesRef = collection(db, "users", user.uid, "companies");
    const qCompanies = query(companiesRef, orderBy("lastSeenAt", "desc"), limit(50));

    return onSnapshot(qCompanies, (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setCompanies(list);

      if (!selectedCompanyKey && list.length) {
        setSelectedCompanyKey(list[0].id);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.uid]);

  // keep stateInput synced
  useEffect(() => {
    if (!stateFilter) setStateInput("");
    else setStateInput(stateCodeToLabel(stateFilter));
  }, [stateFilter]);

  // 2) Subscribe to jobs for selected company
  useEffect(() => {
    if (!selectedCompanyKey) return;

    setLoading(true);
    setJobs([]);
    setLastDoc(null);
    setHasMore(true);

    const jobsRef = collection(db, "users", user.uid, "companies", selectedCompanyKey, "jobs");
    const qJobs = query(jobsRef, orderBy("updatedAtIso", "desc"), limit(PAGE_SIZE));

    const unsub = onSnapshot(
      qJobs,
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
  }, [user.uid, selectedCompanyKey]);

  // infinite scroll fetchMore (same company)
  const fetchMore = async () => {
    if (!selectedCompanyKey || !lastDoc || loading) return;
    setLoading(true);
    try {
      const jobsRef = collection(db, "users", user.uid, "companies", selectedCompanyKey, "jobs");
      const nextQ = query(
        jobsRef,
        orderBy("updatedAtIso", "desc"),
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
    [loading, hasMore, lastDoc, selectedCompanyKey]
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

  const filteredJobs = useMemo(() => {
    const locTerms = locationSearch.trim().toLowerCase();

    return jobs.filter((j) => {
      const location = (j.locationName || j.raw?.location?.name || "").trim();

      // Location contains
      if (locTerms && !location.toLowerCase().includes(locTerms)) return false;

      // State filter (US profiles only)
      if (profileCountry === "United States" && stateFilter) {
        // robust match: accepts "San Francisco, CA" and also "CA • United States"
        const re = new RegExp(`(?:^|[\\s,•|/()\\-])${stateFilter}(?=$|[\\s,•|/()\\-])`);
        if (!re.test(location)) return false;
      }

      return true;
    });
  }, [jobs, locationSearch, stateFilter, profileCountry]);

  const selectedCompany = useMemo(() => {
    if (!selectedCompanyKey) return null;
    return companies.find((c) => c.id === selectedCompanyKey) || null;
  }, [companies, selectedCompanyKey]);

  return (
    <div className="py-8" style={{ fontFamily: "Ubuntu, sans-serif" }}>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Opportunities</h1>
        <p className="text-sm text-gray-500 mt-1">
          {selectedCompany?.companyName ? (
            <>
              Company: <span className="font-semibold">{selectedCompany.companyName}</span>
            </>
          ) : (
            "Select a company to view jobs"
          )}
          <span className="text-gray-300"> • </span>
          {filteredJobs.length} roles found
        </p>
      </div>

      {/* Top controls */}
      <div className="space-y-4 mb-8">
        <div className="flex flex-wrap items-center gap-4 p-4 bg-white rounded-xl ring-1 ring-gray-200 shadow-sm">
          {/* Company selector */}
          <div className="min-w-[260px] flex-1">
            <label className="block text-xs font-bold uppercase tracking-widest text-gray-400 mb-2">
              Company
            </label>
            <select
              value={selectedCompanyKey || ""}
              onChange={(e) => setSelectedCompanyKey(e.target.value)}
              className="input-standard !bg-gray-50 border-transparent focus:!bg-white"
            >
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.companyName || c.id}
                </option>
              ))}
              {!companies.length ? <option value="">No companies yet</option> : null}
            </select>
          </div>

          {/* Location contains */}
          <div className="min-w-[260px] flex-1">
            <label className="block text-xs font-bold uppercase tracking-widest text-gray-400 mb-2">
              Location contains
            </label>
            <input
              placeholder="e.g. San Francisco"
              className="input-standard !bg-gray-50 border-transparent focus:!bg-white"
              value={locationSearch}
              onChange={(e) => setLocationSearch(e.target.value)}
            />
          </div>

          {/* Options dropdown */}
          <div className="pt-6">
            <OptionsDropdown buttonLabel="Options">
              <div className="px-4 py-2">
                <div className="text-xs font-bold uppercase tracking-widest text-gray-400">Filters</div>

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
                      setLocationSearch("");
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
        </div>

        {/* Chips */}
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
        </div>
      </div>

      {/* Job list */}
      <div className="bg-white shadow-sm ring-1 ring-gray-200 rounded-2xl overflow-hidden">
        <ul className="divide-y divide-gray-100">
          {filteredJobs.map((job, index) => {
            const title = job.title || job.raw?.title || "Untitled role";
            const location = job.locationName || job.raw?.location?.name || "Remote";
            const href = job.absolute_url || job.raw?.absolute_url || "#";

            const updatedAtISO = job.updatedAtIso || job.raw?.updated_at || null;
            const fetchedTs = job.firstSeenAt || null;

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
                        {selectedCompany?.companyName || job.companyName || "Company"}
                      </span>
                      <span className="text-gray-300">|</span>
                      <span className="text-xs text-gray-500 font-medium truncate">{location}</span>
                    </div>

                    <h3 className="text-base font-semibold text-gray-900 group-hover:text-indigo-600 transition-colors truncate">
                      {title}
                    </h3>

                    {/* fetched time under title */}
                    <div className="mt-1 text-xs text-gray-400">
                      Fetched {timeAgoFromFirestore(fetchedTs)}
                    </div>
                  </div>

                  <div className="flex items-center gap-4 ml-4">
                    {/* right side updated _h */}
                    <div className="flex flex-col items-end">
                      <span className="text-[10px] font-black text-gray-300 group-hover:text-indigo-200 uppercase tracking-tighter transition-colors">
                        Updated
                      </span>
                      <span className="text-sm font-bold text-gray-900" title={String(updatedAtISO || "")}>
                        {shortAgoFromISO(updatedAtISO)}
                      </span>
                    </div>

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
