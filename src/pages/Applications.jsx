// Applications — the ledger of every application form the extension touched.
// One row per form: what was filled, what still needs you, and whether it
// was submitted. Rows come from users/{uid}/applications (written by the
// recordApplication function); the only writes here are the manual
// resolutions: mark submitted, dismiss, reopen.
import React, { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, doc, updateDoc } from "firebase/firestore";
import { AnimatePresence, motion } from "framer-motion";
import { db } from "../firebase";
import Card from "../components/Card.jsx";
import { useToast } from "../components/Toast/ToastProvider.jsx";
import {
  ExclamationTriangleIcon, CheckCircleIcon, PaperAirplaneIcon, XCircleIcon, ArrowTopRightOnSquareIcon, ChevronDownIcon, ArrowPathIcon,
} from "@heroicons/react/24/outline";

const STATUS = {
  needs_attention: { label: "Needs attention", cls: "bg-amber-100 text-amber-800 ring-amber-200", Icon: ExclamationTriangleIcon },
  error: { label: "Fill failed", cls: "bg-red-100 text-red-800 ring-red-200", Icon: XCircleIcon },
  in_progress: { label: "In progress", cls: "bg-sky-100 text-sky-800 ring-sky-200", Icon: ArrowPathIcon },
  ready: { label: "Ready to submit", cls: "bg-indigo-100 text-indigo-800 ring-indigo-200", Icon: CheckCircleIcon },
  submitted: { label: "Submitted", cls: "bg-emerald-100 text-emerald-800 ring-emerald-200", Icon: PaperAirplaneIcon },
  dismissed: { label: "Dismissed", cls: "bg-gray-100 text-gray-700 ring-gray-200", Icon: XCircleIcon },
};
const TABS = [
  { key: "attention", label: "Needs attention", match: (a) => ["needs_attention", "error", "in_progress"].includes(a.status) },
  { key: "ready", label: "Ready", match: (a) => a.status === "ready" },
  { key: "submitted", label: "Submitted", match: (a) => a.status === "submitted" },
  { key: "all", label: "All", match: () => true },
];

const toDate = (v) => (v?.toDate ? v.toDate() : v ? new Date(v) : null);
const when = (a) => toDate(a.updatedAt) || toDate(a.submittedAt) || toDate(a.appliedAt) || toDate(a.startedAt) || new Date(0);
function fmt(v) {
  const d = toDate(v);
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

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

  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.key, (rows || []).filter(t.match).length])), [rows]);
  const list = useMemo(() => {
    const t = TABS.find((x) => x.key === tab) || TABS[0];
    const needle = q.trim().toLowerCase();
    return (rows || []).filter(t.match)
      .filter((a) => !needle || `${a.companyName} ${a.jobTitle} ${a.org}`.toLowerCase().includes(needle))
      .sort((a, b) => when(b) - when(a));
  }, [rows, tab, q]);

  async function setStatus(a, status) {
    const now = new Date().toISOString();
    const patch = { status, updatedAt: now };
    if (status === "submitted") { patch.submittedAt = a.submittedAt || now; patch.appliedAt = a.appliedAt || now; if (a.needsAttention?.length) patch.attentionResolvedAt = now; }
    if (status === "dismissed") patch.dismissedAt = now;
    try { await updateDoc(doc(db, "users", user.uid, "applications", a.id), patch); showToast(`Marked ${STATUS[status]?.label.toLowerCase() || status}`, "success"); }
    catch (e) { console.error(e); showToast("Update failed", "error"); }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Applications</h1>
          <p className="mt-1 text-sm text-gray-600">Every form the extension touched. Rows that need you list exactly what is left to do.</p>
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search company or title" className="w-full sm:w-64 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200" />
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${tab === t.key ? "bg-indigo-600 text-white" : "bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50"}`}>
            {t.label} <span className={`ml-1 rounded-full px-1.5 text-xs ${tab === t.key ? "bg-indigo-500 text-white" : "bg-gray-100 text-gray-600"}`}>{counts[t.key] ?? 0}</span>
          </button>
        ))}
      </div>

      <Card className="divide-y divide-gray-100 overflow-hidden p-0">
        {rows === null && <div className="p-8 text-center text-sm text-gray-500">Loading…</div>}
        {rows !== null && list.length === 0 && <div className="p-8 text-center text-sm text-gray-500">Nothing here.</div>}
        {list.map((a) => {
          const st = STATUS[a.status] || STATUS.in_progress;
          const isOpen = open === a.id;
          const attention = Array.isArray(a.needsAttention) ? a.needsAttention : [];
          const answers = a.answersLog && typeof a.answersLog === "object" ? Object.values(a.answersLog) : [];
          return (
            <div key={a.id} className="px-4 py-4 sm:px-6">
              <div className="flex flex-wrap items-start gap-3">
                <button onClick={() => setOpen(isOpen ? null : a.id)} className="flex min-w-0 flex-1 items-start gap-3 text-left">
                  <st.Icon className={`mt-0.5 h-5 w-5 flex-none ${a.status === "submitted" ? "text-emerald-600" : a.status === "ready" ? "text-indigo-600" : a.status === "dismissed" ? "text-gray-400" : "text-amber-600"}`} />
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-gray-900">{a.companyName || a.org || "Unknown company"} <span className="font-normal text-gray-500">·</span> <span className="font-medium text-gray-700">{a.jobTitle || "Untitled role"}</span></div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                      <span className={`rounded-full px-2 py-0.5 font-medium ring-1 ${st.cls}`}>{st.label}</span>
                      {a.source && <span className="rounded-full bg-gray-100 px-2 py-0.5 capitalize">{a.source}</span>}
                      {Number.isFinite(a.filledCount) && <span>{a.filledCount}{a.totalFields ? ` / ${a.totalFields}` : ""} filled</span>}
                      {attention.length > 0 && a.status !== "submitted" && <span className="font-medium text-amber-700">{attention.length} to do</span>}
                      {a.attempts > 1 && <span>{a.attempts} attempts</span>}
                      <span>{fmt(a.status === "submitted" ? (a.submittedAt || a.appliedAt) : a.updatedAt)}</span>
                    </div>
                  </div>
                  <ChevronDownIcon className={`ml-auto mt-1 h-4 w-4 flex-none text-gray-400 transition ${isOpen ? "rotate-180" : ""}`} />
                </button>
                <div className="flex flex-none flex-wrap items-center gap-2">
                  {a.jobUrl && (
                    <a href={a.jobUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700">
                      Open form <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
                    </a>
                  )}
                  {a.status !== "submitted" && a.status !== "dismissed" && (
                    <>
                      <button onClick={() => setStatus(a, "submitted")} className="rounded-lg bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-100">Mark submitted</button>
                      <button onClick={() => setStatus(a, "dismissed")} className="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50">Dismiss</button>
                    </>
                  )}
                  {a.status === "dismissed" && (
                    <button onClick={() => setStatus(a, attention.length ? "needs_attention" : "ready")} className="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50">Reopen</button>
                  )}
                </div>
              </div>

              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                    <div className="mt-4 grid gap-4 md:grid-cols-2">
                      <div>
                        <h3 className="text-xs font-bold uppercase tracking-wide text-amber-700">Needs you{attention.length ? ` (${attention.length})` : ""}</h3>
                        {attention.length === 0 && <p className="mt-2 text-sm text-gray-500">Nothing left. {a.status === "submitted" ? "Submitted." : "Review the form and click Submit."}</p>}
                        <ul className="mt-2 space-y-2">
                          {attention.map((n, i) => (
                            <li key={`${n.path}-${i}`} className="rounded-lg bg-amber-50 px-3 py-2 text-sm">
                              <div className="font-medium text-gray-900">{n.label}</div>
                              {n.note && <div className="text-xs text-amber-800">{n.note}</div>}
                            </li>
                          ))}
                        </ul>
                        {a.lastError && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">Last error: {a.lastError}</p>}
                        {Array.isArray(a.gateReasons) && a.gateReasons.length > 0 && <p className="mt-3 text-xs text-gray-500">Gate: {a.gateReasons.join("; ")}</p>}
                      </div>
                      <div>
                        <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">Filled ({answers.length})</h3>
                        <ul className="mt-2 max-h-80 space-y-1.5 overflow-y-auto pr-1">
                          {answers.map((v, i) => (
                            <li key={i} className="text-sm">
                              <span className="text-gray-500">{v.label}: </span>
                              <span className="text-gray-900 break-words">{String(v.answer ?? "").slice(0, 300)}</span>
                              {v.source && <span className="ml-1 text-[10px] uppercase text-gray-400">{v.source}</span>}
                            </li>
                          ))}
                          {answers.length === 0 && <li className="text-sm text-gray-500">No answers recorded.</li>}
                        </ul>
                        <div className="mt-3 text-xs text-gray-400">
                          {a.startedAt && <span>Started {fmt(a.startedAt)}. </span>}
                          {a.filledAt && <span>Filled {fmt(a.filledAt)}. </span>}
                          {a.submittedAt && <span>Submitted {fmt(a.submittedAt)}. </span>}
                          {a.extensionVersion && <span>Extension {a.extensionVersion}.</span>}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </Card>
    </div>
  );
}
