// Applications — the ledger of every application form the extension touched.
// One row per form: what was filled, what still needs you, and whether it
// was submitted. Rows come from users/{uid}/applications (written by the
// recordApplication function); the only writes here are the manual
// resolutions: mark submitted, dismiss, reopen.
//
// Layout follows the other signed-in pages (Jobs, History): page-wrapper +
// page-header, a segmented tab control, and one white ring panel with a caps
// header strip and hover rows.
import React, { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, doc, updateDoc, setDoc } from "firebase/firestore";
import { AnimatePresence, motion } from "framer-motion";
import { db } from "../firebase";
import { useToast } from "../components/Toast/ToastProvider.jsx";
import {
  ExclamationTriangleIcon, CheckCircleIcon, PaperAirplaneIcon, XCircleIcon, ArrowTopRightOnSquareIcon, ArrowPathIcon,
} from "@heroicons/react/24/outline";

const STATUS = {
  needs_attention: { label: "Needs attention", cls: "bg-amber-50 text-amber-700 ring-amber-200", icon: "text-amber-500", Icon: ExclamationTriangleIcon },
  error: { label: "Fill failed", cls: "bg-red-50 text-red-700 ring-red-200", icon: "text-red-500", Icon: XCircleIcon },
  in_progress: { label: "In progress", cls: "bg-sky-50 text-sky-700 ring-sky-200", icon: "text-sky-500", Icon: ArrowPathIcon },
  ready: { label: "Ready to submit", cls: "bg-indigo-50 text-indigo-700 ring-indigo-200", icon: "text-indigo-500", Icon: CheckCircleIcon },
  submitted: { label: "Submitted", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200", icon: "text-emerald-500", Icon: PaperAirplaneIcon },
  dismissed: { label: "Dismissed", cls: "bg-gray-100 text-gray-500 ring-gray-200", icon: "text-gray-300", Icon: XCircleIcon },
};
// What the company wrote back (read from Gmail by the extension; functions/lib/apply/emailTracker.cjs).
const OUTCOME = {
  confirmation: { label: "Received", cls: "bg-gray-50 text-gray-600 ring-gray-200" },
  assessment: { label: "Assessment", cls: "bg-sky-50 text-sky-700 ring-sky-200" },
  interview: { label: "Interview", cls: "bg-indigo-50 text-indigo-700 ring-indigo-200" },
  rejection: { label: "Rejected", cls: "bg-red-50 text-red-700 ring-red-200" },
  offer: { label: "Offer", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
};
// Marked for auto-apply to try again (scripts/clear-needs-attention.mjs) and
// not started since: waiting in the queue, not waiting on the person. A retry
// that stops again is back under Needs attention.
const awaitingRetry = (a) => {
  if (!a.retryRequested || a.status === "submitted" || a.status === "dismissed") return false;
  const asked = Date.parse(a.retryRequested) || 0;
  const started = Date.parse(toDate(a.lastStartedAt)?.toISOString?.() || a.lastStartedAt || "") || 0;
  return asked > started;
};
const TABS = [
  { key: "attention", label: "Needs attention", match: (a) => ["needs_attention", "error", "in_progress"].includes(a.status) && !awaitingRetry(a) },
  { key: "retrying", label: "Retrying", match: awaitingRetry },
  { key: "ready", label: "Ready", match: (a) => a.status === "ready" },
  { key: "submitted", label: "Submitted", match: (a) => a.status === "submitted" },
  { key: "replies", label: "Replies", match: (a) => ["interview", "assessment", "offer"].includes(a.outcome) },
  { key: "all", label: "All", match: () => true },
];

const toDate = (v) => (v?.toDate ? v.toDate() : v ? new Date(v) : null);
// The daily count starts here (local midnight, the day tracking began).
const DAILY_FROM = "2026-11-03T00:00:00";
const BOARD_NAME = { ashby: "Ashby", greenhouse: "Greenhouse", lever: "Lever" };
const when = (a) => toDate(a.updatedAt) || toDate(a.submittedAt) || toDate(a.appliedAt) || toDate(a.startedAt) || new Date(0);
function fmt(v) {
  const d = toDate(v);
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function fmtAgo(v) {
  const d = toDate(v);
  if (!d || Number.isNaN(d.getTime())) return "N/A";
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "just now";
}

const Chevron = ({ open }) => (
  <div className={`p-1.5 rounded-lg transition-all ${open ? "bg-indigo-50 text-indigo-600 rotate-180" : "text-gray-300"}`}>
    <svg className="size-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
    </svg>
  </div>
);

export default function Applications({ user }) {
  const [rows, setRows] = useState(null);
  const [tab, setTab] = useState("attention");
  const [open, setOpen] = useState(null);
  const [q, setQ] = useState("");
  const { showToast } = useToast();

  useEffect(() => {
    if (!user?.uid) return undefined;
    const unsub = onSnapshot(collection(db, "users", user.uid, "applications"), (snap) => {
      setRows(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }, (err) => { console.error(err); showToast("Could not load applications", "error"); });
    return unsub;
  }, [user?.uid, showToast]);

  // users/{uid}.applicationsSince: the page lists only activity from then on.
  // Older records stay in the database (they are what stops a second
  // application to the same job), just not on this page.
  const [since, setSince] = useState(0);
  useEffect(() => {
    if (!user?.uid) return undefined;
    return onSnapshot(doc(db, "users", user.uid), (snap) => setSince(toDate(snap.data()?.applicationsSince)?.getTime() || 0), () => setSince(0));
  }, [user?.uid]);
  const shown = useMemo(() => (rows || []).filter((a) => when(a).getTime() >= since), [rows, since]);
  async function startFresh() {
    if (!window.confirm("Start this page fresh? Applications so far are hidden here (they still stop JobWatch from applying to the same job twice).")) return;
    try { await setDoc(doc(db, "users", user.uid), { applicationsSince: new Date().toISOString() }, { merge: true }); showToast("Starting fresh from now", "success"); }
    catch (e) { console.error(e); showToast("Could not start fresh", "error"); }
  }

  // Submitted per day (this browser's time zone), from DAILY_FROM on, newest
  // first, each split by board.
  const daily = useMemo(() => {
    const from = new Date(DAILY_FROM).getTime();
    const byDay = new Map();
    for (const a of rows || []) {
      if (a.status !== "submitted") continue;
      const t = toDate(a.submittedAt) || toDate(a.appliedAt) || toDate(a.updatedAt);
      if (!t || t.getTime() < from) continue;
      const key = t.toLocaleDateString("en-CA");
      const d = byDay.get(key) || { key, total: 0, boards: {} };
      d.total++;
      const b = String(a.source || "other").toLowerCase().replace("ashbyhq", "ashby");
      d.boards[b] = (d.boards[b] || 0) + 1;
      byDay.set(key, d);
    }
    return [...byDay.values()].sort((x, y) => y.key.localeCompare(x.key));
  }, [rows]);

  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.key, shown.filter(t.match).length])), [shown]);
  const list = useMemo(() => {
    const t = TABS.find((x) => x.key === tab) || TABS[0];
    const needle = q.trim().toLowerCase();
    return shown.filter(t.match)
      .filter((a) => !needle || `${a.companyName} ${a.jobTitle} ${a.org}`.toLowerCase().includes(needle))
      .sort((a, b) => when(b) - when(a));
  }, [shown, tab, q]);

  async function setStatus(a, status) {
    const now = new Date().toISOString();
    const patch = { status, updatedAt: now };
    if (status === "submitted") { patch.submittedAt = a.submittedAt || now; patch.appliedAt = a.appliedAt || now; if (a.needsAttention?.length) patch.attentionResolvedAt = now; }
    if (status === "dismissed") patch.dismissedAt = now;
    try { await updateDoc(doc(db, "users", user.uid, "applications", a.id), patch); showToast(`Marked ${STATUS[status]?.label.toLowerCase() || status}`, "success"); }
    catch (e) { console.error(e); showToast("Update failed", "error"); }
  }

  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  const tabLabel = TABS.find((t) => t.key === tab)?.label || "All";

  const renderRow = (a) => {
    const st = STATUS[a.status] || STATUS.in_progress;
    const isOpen = open === a.id;
    const attention = Array.isArray(a.needsAttention) ? a.needsAttention : [];
    const answers = a.answersLog && typeof a.answersLog === "object" ? Object.values(a.answersLog) : [];
    const stamp = a.status === "submitted" ? (a.submittedAt || a.appliedAt) : a.updatedAt;
    const canResolve = a.status !== "submitted" && a.status !== "dismissed";

    return (
      <li
        key={a.id}
        className="group relative px-6 py-5 hover:bg-gray-50/80 transition-all border-l-4 border-transparent hover:border-indigo-500 cursor-pointer"
        onClick={() => setOpen(isOpen ? null : a.id)}
      >
        <div className="absolute top-0 left-0 right-0 h-[1px] bg-indigo-500 opacity-0 group-hover:opacity-100 transition-opacity" />

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 mb-1.5">
              <span className="text-xs font-bold text-indigo-600 uppercase tracking-tight">{a.companyName || a.org || "Unknown company"}</span>
              {a.source && (
                <>
                  <span className="text-gray-300">|</span>
                  <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">{a.source}</span>
                </>
              )}
            </div>

            <h3 className="text-base font-semibold text-gray-900 group-hover:text-indigo-600 transition-colors truncate">
              {a.jobTitle || "Untitled role"}
            </h3>

            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-widest ring-1 ring-inset ${st.cls}`}>
                <st.Icon className={`h-3 w-3 ${st.icon}`} />
                {st.label}
              </span>
              {OUTCOME[a.outcome] && (
                <span title={a.lastEmail?.subject || ""} className={`inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-widest ring-1 ring-inset ${OUTCOME[a.outcome].cls}`}>
                  {OUTCOME[a.outcome].label}
                </span>
              )}
              {Number.isFinite(a.filledCount) && (
                <span className="text-xs text-gray-400">
                  <span className="font-semibold text-gray-600">{a.filledCount}{a.totalFields ? ` / ${a.totalFields}` : ""}</span> filled
                </span>
              )}
              {attention.length > 0 && a.status !== "submitted" && (
                <span className="text-xs font-bold text-amber-600">{attention.length} to do</span>
              )}
              {a.attempts > 1 && <span className="text-xs text-gray-400">{a.attempts} attempts</span>}
              <span className="text-xs text-gray-400">{a.status === "submitted" ? "Submitted" : "Updated"} {fmtAgo(stamp)}</span>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0 z-10">
            {a.jobUrl && (
              <a
                href={a.jobUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest text-white bg-indigo-600 hover:bg-indigo-700 shadow-sm transition-colors"
              >
                Open form <ArrowTopRightOnSquareIcon className="h-3 w-3" />
              </a>
            )}
            {canResolve && (
              <>
                <button
                  onClick={stop(() => setStatus(a, "submitted"))}
                  className="hidden sm:inline-flex px-2.5 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest text-emerald-700 bg-emerald-50 hover:bg-emerald-100 ring-1 ring-inset ring-emerald-200/60 transition-colors"
                >
                  Mark submitted
                </button>
                <button
                  onClick={stop(() => setStatus(a, "dismissed"))}
                  className="hidden sm:inline-flex px-2.5 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest text-gray-500 bg-white hover:bg-gray-50 ring-1 ring-inset ring-gray-200 transition-colors"
                >
                  Dismiss
                </button>
              </>
            )}
            {a.status === "dismissed" && (
              <button
                onClick={stop(() => setStatus(a, attention.length ? "needs_attention" : "ready"))}
                className="hidden sm:inline-flex px-2.5 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest text-gray-500 bg-white hover:bg-gray-50 ring-1 ring-inset ring-gray-200 transition-colors"
              >
                Reopen
              </button>
            )}
            <Chevron open={isOpen} />
          </div>
        </div>

        <AnimatePresence>
          {isOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="overflow-hidden cursor-default"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mt-5 pt-5 border-t border-gray-100 space-y-5">

                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-700 bg-gray-50/50 p-4 rounded-xl ring-1 ring-inset ring-gray-100">
                  {[
                    ["Started", a.startedAt && fmt(a.startedAt)],
                    ["Filled", a.filledAt && fmt(a.filledAt)],
                    ["Submitted", a.submittedAt && fmt(a.submittedAt)],
                    ["Extension", a.extensionVersion],
                  ].filter(([, v]) => v).map(([k, v], i) => (
                    <React.Fragment key={k}>
                      {i > 0 && <span className="text-gray-300">•</span>}
                      <div>
                        <span className="text-gray-400 font-black uppercase text-[9px] tracking-widest mr-1.5">{k}</span>
                        <span className="font-bold">{v}</span>
                      </div>
                    </React.Fragment>
                  ))}
                  {!a.startedAt && !a.filledAt && !a.submittedAt && !a.extensionVersion && (
                    <span className="text-gray-400">No timing recorded.</span>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="bg-white p-4 rounded-xl ring-1 ring-inset ring-gray-200 shadow-sm">
                    <div className="text-[10px] font-black text-amber-600 uppercase tracking-widest mb-3">
                      Needs you{attention.length ? ` (${attention.length})` : ""}
                    </div>
                    {attention.length === 0 && (
                      <p className="text-sm text-gray-500">Nothing left. {a.status === "submitted" ? "Submitted." : "Review the form and click Submit."}</p>
                    )}
                    <ul className="space-y-2">
                      {attention.map((n, i) => (
                        <li key={`${n.path}-${i}`} className="rounded-lg bg-amber-50 ring-1 ring-inset ring-amber-100 px-3 py-2 text-sm">
                          <div className="font-semibold text-gray-900">{n.label}</div>
                          {n.note && <div className="mt-0.5 text-xs text-amber-800">{n.note}</div>}
                        </li>
                      ))}
                    </ul>
                    {a.lastError && (
                      <div className="mt-3 p-3 rounded-lg bg-red-50 border border-red-100">
                        <span className="text-[9px] font-black uppercase text-red-700 tracking-widest block mb-1">Last error</span>
                        <p className="text-[11px] font-mono text-red-800 leading-relaxed break-all whitespace-pre-wrap">{a.lastError}</p>
                      </div>
                    )}
                    {Array.isArray(a.gateReasons) && a.gateReasons.length > 0 && (
                      <p className="mt-3 text-xs text-gray-500">Gate: {a.gateReasons.join("; ")}</p>
                    )}
                  </div>

                  <div className="bg-white p-4 rounded-xl ring-1 ring-inset ring-gray-200 shadow-sm">
                    <div className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-3">Filled ({answers.length})</div>
                    <ul className="max-h-80 space-y-1.5 overflow-y-auto pr-1 custom-scrollbar">
                      {answers.map((v, i) => (
                        <li key={i} className="text-sm">
                          <span className="text-gray-500">{v.label}: </span>
                          <span className="text-gray-900 break-words">{String(v.answer ?? "").slice(0, 300)}</span>
                          {v.source && <span className="ml-1 text-[9px] font-black uppercase tracking-widest text-gray-300">{v.source}</span>}
                        </li>
                      ))}
                      {answers.length === 0 && <li className="text-sm text-gray-500">No answers recorded.</li>}
                    </ul>
                  </div>
                </div>

                {(canResolve || a.status === "dismissed") && (
                  <div className="flex flex-wrap gap-2 sm:hidden">
                    {canResolve && (
                      <>
                        <button onClick={() => setStatus(a, "submitted")} className="btn-primary !py-2 text-xs">Mark submitted</button>
                        <button onClick={() => setStatus(a, "dismissed")} className="btn-secondary text-xs">Dismiss</button>
                      </>
                    )}
                    {a.status === "dismissed" && (
                      <button onClick={() => setStatus(a, attention.length ? "needs_attention" : "ready")} className="btn-secondary text-xs">Reopen</button>
                    )}
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

      <div className="page-header flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1>Applications</h1>
          <p>Every form the extension touched. Rows that need you list exactly what is left to do.</p>
          <p className="mt-1 text-xs text-gray-500">
            {since ? `Showing activity since ${new Date(since).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}. ` : ""}
            <button type="button" onClick={startFresh} className="font-semibold text-indigo-600 hover:text-indigo-800">Start fresh</button>
          </p>
        </div>

        <div className="flex justify-center w-full md:w-auto overflow-hidden">
          <div className="inline-flex p-1 bg-gray-100 rounded-xl overflow-x-auto no-scrollbar scroll-smooth gap-0.5">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`inline-flex items-center gap-1.5 px-4 py-1.5 text-[11px] font-bold rounded-lg transition-all whitespace-nowrap min-w-fit ${tab === t.key ? "bg-white text-indigo-600 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
              >
                {t.label}
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${tab === t.key ? "bg-indigo-50 text-indigo-600" : "bg-gray-200/70 text-gray-500"}`}>
                  {counts[t.key] ?? 0}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Submitted per day, from Nov 3 on. */}
      <div className="mb-6 bg-white shadow-sm ring-1 ring-gray-200 rounded-2xl p-5">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm font-bold text-gray-900">Submitted per day</h2>
          <span className="text-xs text-gray-500">{daily.reduce((n, d) => n + d.total, 0)} since Nov 3</span>
        </div>
        {daily.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing submitted since Nov 3 yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {daily.map((d) => (
              <li key={d.key} className="flex items-center justify-between py-2 text-sm">
                <span className="font-medium text-gray-800">{new Date(`${d.key}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</span>
                <span className="flex items-center gap-3">
                  <span className="text-xs text-gray-500">{Object.entries(d.boards).map(([b, n]) => `${BOARD_NAME[b] || b} ${n}`).join(" · ")}</span>
                  <span className="min-w-[2.5rem] text-right font-bold text-indigo-600">{d.total}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="p-4 mb-6 bg-white rounded-xl ring-1 ring-gray-200 shadow-sm">
        <label className="caps-label mb-2 block px-1 text-gray-400 uppercase tracking-widest text-[10px] font-black">
          Search
        </label>
        <input
          placeholder="e.g. Stripe or Software Engineer"
          className="input-standard !bg-gray-50 border-transparent focus:!bg-white h-11 w-full"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="bg-white shadow-sm ring-1 ring-gray-200 rounded-2xl overflow-hidden flex flex-col min-h-[500px] transition-all">
        <div className="px-6 py-4 border-b bg-gray-50/50 border-gray-100 flex items-center justify-between">
          <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-600">
            {tabLabel}
            {rows !== null && <span className="ml-1 text-gray-400">({list.length})</span>}
          </h3>
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></div>
            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Live Ledger</span>
          </div>
        </div>

        {rows === null ? (
          <div className="flex-grow divide-y divide-gray-100">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="px-6 py-5 animate-pulse">
                <div className="h-3 w-24 bg-gray-100 rounded mb-2.5" />
                <div className="h-4 w-2/3 bg-gray-100 rounded mb-2.5" />
                <div className="h-3 w-40 bg-gray-100 rounded" />
              </div>
            ))}
          </div>
        ) : list.length === 0 ? (
          <div className="flex-grow flex flex-col items-center justify-center py-32 text-center bg-gray-50/10">
            <p className="text-sm font-semibold text-gray-900 tracking-tight">Nothing here</p>
            <p className="text-xs text-gray-400 mt-1 max-w-[240px] leading-relaxed">
              {q.trim() ? "No applications match your search." : "Open a job form with the extension and it will show up here."}
            </p>
          </div>
        ) : (
          <div className="flex-grow">
            <ul className="divide-y divide-gray-100">{list.map(renderRow)}</ul>
          </div>
        )}

        <div className="h-12 flex items-center justify-center border-t border-gray-50">
          {rows !== null && list.length > 0 && (
            <span className="text-[10px] font-black text-gray-200 uppercase tracking-widest">End of Ledger</span>
          )}
        </div>
      </div>
    </div>
  );
}
