// src/pages/FetchHistory.jsx
import React, { useEffect, useState } from "react";
import { db } from "../firebase";
import { collection, query, orderBy, limit, onSnapshot } from "firebase/firestore";

function fmtDateTime(ts) {
  if (!ts?.toDate) return "—";
  const d = ts.toDate();
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtSince(ts) {
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

function fmtDuration(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function pickRunTime(r) {
  return r.startedAt || r.enqueuedAt || r.createdAt || r.updatedAt || null;
}

function statusLabel(statusRaw) {
  const s = String(statusRaw || "done").toUpperCase();
  return s;
}

function statusClass(status) {
  if (status === "DONE") return "text-green-700";
  if (status === "RUNNING" || status === "ENQUEUED") return "text-amber-700";
  if (status === "DONE_WITH_ERRORS") return "text-red-700";
  if (status === "FAILED" || status === "ENQUEUE_FAILED") return "text-red-700";
  return "text-gray-500";
}

function runTypeLabel(rt) {
  return rt === "scheduled" ? "Scheduled" : "Manual";
}

function runTypeBadgeClass(rt) {
  return rt === "scheduled"
    ? "bg-gray-100 text-gray-700 ring-gray-200"
    : "bg-indigo-50 text-indigo-700 ring-indigo-100";
}

export default function FetchHistory({ user }) {
  const [runs, setRuns] = useState([]);
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    if (!user?.uid) return;
    const ref = collection(db, "users", user.uid, "fetchRuns");
    const q = query(ref, orderBy("createdAt", "desc"), limit(50));

    return onSnapshot(q, (snap) => {
      setRuns(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
  }, [user?.uid]);

  return (
    <div className="space-y-8 py-10" style={{ fontFamily: "Ubuntu, sans-serif" }}>
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Fetch History</h1>
        <p className="mt-1 text-sm text-gray-600">
          Every scheduled poll (every 30 minutes) and every manual fetch is logged here.
        </p>
      </div>

      <div className="overflow-hidden bg-white shadow-sm ring-1 ring-gray-200 sm:rounded-xl">
        <div className="px-4 py-4 sm:px-6 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900">Recent Runs</h3>
          <p className="text-xs text-gray-500 mt-1">
            “Added” = new docs created • “Updated” = existing docs merged
          </p>
        </div>

        <ul className="divide-y divide-gray-100">
          {runs.map((r) => {
            const isOpen = openId === r.id;

            const runType = runTypeLabel(r.runType);
            const badgeCls = runTypeBadgeClass(r.runType);

            const status = statusLabel(r.status);
            const statusCls = statusClass(status);

            const runTime = pickRunTime(r);

            const feedsCount = r.feedsCount ?? 0;
            const processedCount = r.processed ?? 0;

            // NEW COUNTERS (from updated index.js)
            const added = r.createdCount ?? 0;
            const updated = r.updatedCount ?? 0;

            const errorsCount = r.errorsCount ?? 0;
            const samples = Array.isArray(r.errorSamples) ? r.errorSamples : [];

            return (
              <li key={r.id} className="px-4 py-5 sm:px-6 hover:bg-gray-50 transition-colors">
                <div className="flex items-start justify-between gap-x-6">
                  <div className="min-w-0 flex-1">
                    {/* Top line */}
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${badgeCls}`}
                      >
                        {runType}
                      </span>

                      <span className="text-sm font-semibold text-gray-900">
                        Ran {fmtSince(runTime)}
                      </span>

                      <span className="text-gray-300">|</span>

                      <span className="text-sm text-gray-600">{fmtDateTime(runTime)}</span>

                      <span className="text-gray-300">|</span>

                      <span className={`text-xs font-black uppercase tracking-widest ${statusCls}`}>
                        {status}
                      </span>
                    </div>

                    {/* Summary line */}
                    <div className="mt-2 text-sm text-gray-700">
                      Feeds <span className="font-semibold">{feedsCount}</span> • Processed{" "}
                      <span className="font-semibold">{processedCount}</span> • Added{" "}
                      <span className="font-semibold">{added}</span> • Updated{" "}
                      <span className="font-semibold">{updated}</span> • Duration{" "}
                      <span className="font-semibold">{fmtDuration(r.durationMs)}</span>
                    </div>

                    {/* Expanded */}
                    {isOpen && (
                      <div className="mt-5 space-y-4">
                        {/* status panel */}
                        {status === "RUNNING" || status === "ENQUEUED" ? (
                          <div className="rounded-lg bg-amber-50 ring-1 ring-inset ring-amber-100 p-4">
                            <div className="text-xs font-bold uppercase tracking-widest text-amber-700">
                              In progress
                            </div>
                            <div className="mt-2 text-sm text-amber-800">
                              This run is still updating.
                            </div>
                          </div>
                        ) : errorsCount === 0 && status !== "FAILED" && status !== "ENQUEUE_FAILED" ? (
                          <div className="rounded-lg bg-green-50 ring-1 ring-inset ring-green-100 p-4">
                            <div className="text-xs font-bold uppercase tracking-widest text-green-700">
                              No errors in this run
                            </div>
                            <div className="mt-2 text-sm text-green-800">
                              All feeds completed successfully.
                            </div>
                          </div>
                        ) : (
                          <div className="rounded-lg bg-red-50 ring-1 ring-inset ring-red-100 p-4">
                            <div className="text-xs font-bold uppercase tracking-widest text-red-700">
                              Errors detected
                            </div>
                            <div className="mt-2 text-sm text-red-800">
                              {status === "ENQUEUE_FAILED"
                                ? "The run could not be enqueued."
                                : status === "FAILED"
                                ? "The task failed."
                                : "Some feeds failed during the run."}
                            </div>

                            <div className="mt-2 text-sm text-gray-700">
                              Errors count: <span className="font-semibold">{errorsCount}</span>
                            </div>

                            {/* show enqueueError / error */}
                            {r.enqueueError ? (
                              <div className="mt-3 text-xs text-red-800 font-mono whitespace-pre-wrap break-words">
                                {r.enqueueError}
                              </div>
                            ) : null}

                            {r.error ? (
                              <div className="mt-3 text-xs text-red-800 font-mono whitespace-pre-wrap break-words">
                                {r.error}
                              </div>
                            ) : null}

                            {/* NEW: error samples list */}
                            {samples.length > 0 ? (
                              <div className="mt-4">
                                <div className="text-[11px] font-black uppercase tracking-widest text-red-700">
                                  Error samples
                                </div>
                                <ul className="mt-2 space-y-2">
                                  {samples.map((s, idx) => (
                                    <li
                                      key={`${idx}-${s?.url || "x"}`}
                                      className="rounded-md bg-white/60 ring-1 ring-inset ring-red-100 p-2"
                                    >
                                      <div className="text-[11px] text-gray-700 font-mono break-words">
                                        {s?.url || "—"}
                                      </div>
                                      <div className="mt-1 text-[11px] text-red-800 font-mono whitespace-pre-wrap break-words">
                                        {s?.error || "—"}
                                      </div>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ) : null}
                          </div>
                        )}

                        {/* run details */}
                        <div className="rounded-lg bg-gray-50 ring-1 ring-inset ring-gray-200 p-4">
                          <div className="text-xs font-bold uppercase tracking-widest text-gray-600">
                            Run details
                          </div>
                          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm text-gray-700">
                            <div>
                              <span className="text-gray-500">Created:</span>{" "}
                              <span className="font-medium">{fmtDateTime(r.createdAt)}</span>
                            </div>
                            <div>
                              <span className="text-gray-500">Enqueued:</span>{" "}
                              <span className="font-medium">{fmtDateTime(r.enqueuedAt)}</span>
                            </div>
                            <div>
                              <span className="text-gray-500">Started:</span>{" "}
                              <span className="font-medium">{fmtDateTime(r.startedAt)}</span>
                            </div>
                            <div>
                              <span className="text-gray-500">Finished:</span>{" "}
                              <span className="font-medium">{fmtDateTime(r.finishedAt)}</span>
                            </div>
                          </div>
                        </div>

                        {/* counters detail */}
                        <div className="rounded-lg bg-white ring-1 ring-inset ring-gray-200 p-4">
                          <div className="text-xs font-bold uppercase tracking-widest text-gray-600">
                            Counters
                          </div>
                          <div className="mt-2 text-sm text-gray-700">
                            Processed (within last 1h): <span className="font-semibold">{processedCount}</span>
                            <br />
                            Added (new docs): <span className="font-semibold">{added}</span>
                            <br />
                            Updated (existing docs): <span className="font-semibold">{updated}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  <button
                    onClick={() => setOpenId(isOpen ? null : r.id)}
                    className={`text-xs font-bold uppercase tracking-wider ${
                      isOpen
                        ? "text-gray-600 hover:text-gray-900"
                        : (errorsCount || 0) > 0 || status === "FAILED" || status === "ENQUEUE_FAILED"
                        ? "text-red-600 hover:text-red-800"
                        : "text-indigo-600 hover:text-indigo-800"
                    }`}
                  >
                    {isOpen ? "Hide" : "View"}
                  </button>
                </div>
              </li>
            );
          })}

          {!runs.length && (
            <li className="px-4 py-12 text-center text-sm text-gray-500">
              No fetch runs yet. Click “Check for new jobs now” or wait for the scheduled poll.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
