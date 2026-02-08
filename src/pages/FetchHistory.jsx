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

export default function FetchHistory({ user }) {
  const [runs, setRuns] = useState([]);
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    if (!user?.uid) return;
    const ref = collection(db, "users", user.uid, "fetchRuns");
    const q = query(ref, orderBy("startedAt", "desc"), limit(50));
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
            “Total new” = number of new job docs created during that run.
          </p>
        </div>

        <ul className="divide-y divide-gray-100">
          {runs.map((r) => {
            const isOpen = openId === r.id;

            const runType = r.runType === "scheduled" ? "Scheduled" : "Manual";
            const badgeCls =
              r.runType === "scheduled"
                ? "bg-gray-100 text-gray-700 ring-gray-200"
                : "bg-indigo-50 text-indigo-700 ring-indigo-100";

            const status = (r.status || "done").toUpperCase();
            const statusCls =
              status === "DONE"
                ? "text-green-700"
                : status === "RUNNING"
                ? "text-amber-700"
                : status === "DONE_WITH_ERRORS"
                ? "text-red-700"
                : "text-gray-500";

            const feedsCount = r.feedsCount ?? 0;
            const processedCount = r.processed ?? r.processedCount ?? 0;
            const totalNew = r.newCount ?? r.totalNew ?? 0;

            const perFeed = Array.isArray(r.perFeedSummary)
              ? r.perFeedSummary
              : Array.isArray(r.results)
              ? r.results
              : [];

            const errorSamples = Array.isArray(r.errorSamples) ? r.errorSamples : [];

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
                        Ran {fmtSince(r.startedAt)}
                      </span>

                      <span className="text-gray-300">|</span>

                      <span className="text-sm text-gray-600">{fmtDateTime(r.startedAt)}</span>

                      <span className="text-gray-300">|</span>

                      <span className={`text-xs font-black uppercase tracking-widest ${statusCls}`}>
                        {status}
                      </span>
                    </div>

                    {/* Summary line */}
                    <div className="mt-2 text-sm text-gray-700">
                      Feeds <span className="font-semibold">{feedsCount}</span> • Processed{" "}
                      <span className="font-semibold">{processedCount}</span> • Total new{" "}
                      <span className="font-semibold">{totalNew}</span> • Duration{" "}
                      <span className="font-semibold">{fmtDuration(r.durationMs)}</span>
                    </div>

                    {/* Expanded content */}
                    {isOpen && (
                      <div className="mt-5 space-y-4">
                        {/* Errors */}
                        {errorSamples.length === 0 ? (
                          <div className="rounded-lg bg-green-50 ring-1 ring-inset ring-green-100 p-4">
                            <div className="text-xs font-bold uppercase tracking-widest text-green-700">
                              No errors in this run
                            </div>
                            <div className="mt-2 text-sm text-green-800">
                              All feeds polled successfully.
                            </div>
                          </div>
                        ) : (
                          <div className="rounded-lg bg-red-50 ring-1 ring-inset ring-red-100 p-4">
                            <div className="text-xs font-bold uppercase tracking-widest text-red-700">
                              Error samples
                            </div>
                            <ul className="mt-3 space-y-3">
                              {errorSamples.map((e, idx) => (
                                <li key={idx} className="text-sm">
                                  <div className="text-xs text-gray-500 font-mono truncate">{e.url}</div>
                                  <div className="text-sm text-red-800 mt-1">{e.message}</div>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* Per-feed summary */}
                        {perFeed.length > 0 && (
                          <div className="rounded-xl bg-white ring-1 ring-gray-200 p-4">
                            <div className="text-xs font-black uppercase tracking-widest text-gray-500 mb-3">
                              Per-feed summary
                            </div>

                            <div className="space-y-3">
                              {perFeed.map((x, idx) => {
                                const name =
                                  x.companyName ||
                                  x.company ||
                                  x.name ||
                                  x.feedId;

                                const ok = x.ok !== false && !x.error;
                                const processed = x.kept ?? x.processed ?? 0;
                                const newCount = x.newCount ?? 0;

                                return (
                                  <div key={idx} className="flex items-center justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="text-sm font-semibold text-gray-900 truncate">
                                        {name}
                                      </div>
                                      {x.url ? (
                                        <div className="text-[11px] text-gray-500 font-mono truncate">
                                          {x.url}
                                        </div>
                                      ) : null}
                                      {!ok && x.error ? (
                                        <div className="text-xs text-red-700 mt-1 truncate">
                                          {x.error}
                                        </div>
                                      ) : null}
                                    </div>

                                    <div
                                      className={`text-xs font-bold whitespace-nowrap ${
                                        ok ? "text-green-700" : "text-red-700"
                                      }`}
                                    >
                                      {ok ? `+${newCount} new / ${processed} jobs` : "FAILED"}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Right action */}
                  <button
                    onClick={() => setOpenId(isOpen ? null : r.id)}
                    className={`text-xs font-bold uppercase tracking-wider ${
                      isOpen
                        ? "text-gray-600 hover:text-gray-900"
                        : (r.errorsCount || 0) > 0
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
