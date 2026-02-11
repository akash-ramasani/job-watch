// src/pages/FetchHistory.jsx
import React, { useEffect, useMemo, useState } from "react";
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

function statusLabel(s) {
  return String(s || "done").toUpperCase();
}

// Prefer the most “truthy” timeline point for “Ran X ago”
function pickRunTime(r) {
  return r.startedAt || r.enqueuedAt || r.createdAt || r.updatedAt || null;
}

function metric(n) {
  return Number.isFinite(n) ? n : 0;
}

export default function FetchHistory({ user }) {
  const [runs, setRuns] = useState([]);
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    if (!user?.uid) return;
    const ref = collection(db, "users", user.uid, "fetchRuns");
    const q = query(ref, orderBy("createdAt", "desc"), limit(60));
    return onSnapshot(q, (snap) => {
      setRuns(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
  }, [user?.uid]);

  const openRun = useMemo(() => runs.find((r) => r.id === openId) || null, [runs, openId]);

  return (
    <div className="space-y-8 py-10" style={{ fontFamily: "Ubuntu, sans-serif" }}>
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Fetch History</h1>
        <p className="mt-1 text-sm text-gray-600">
          Logs for the “Last 1 Hour” ingestion window.
        </p>

        <p className="mt-2 text-xs text-gray-500">
          <span className="font-semibold">Found</span> = jobs after location filter.
          {" "}
          <span className="font-semibold">Candidates</span> = jobs within the last 60 minutes.
          {" "}
          <span className="font-semibold">Added/Updated</span> = Firestore writes.
          {" "}
          <span className="font-semibold">Skipped (Old)</span> = older than 60 minutes.
          {" "}
          <span className="font-semibold">Skipped (Unchanged)</span> = not newer than what’s already stored.
        </p>
      </div>

      <div className="overflow-hidden bg-white shadow-sm ring-1 ring-gray-200 sm:rounded-xl">
        <div className="px-4 py-4 sm:px-6 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900">Recent Runs</h3>
        </div>

        <ul className="divide-y divide-gray-100">
          {runs.map((r) => {
            const isOpen = openId === r.id;

            const runType = r.runType === "scheduled" ? "Scheduled" : "Manual";
            const badgeCls =
              r.runType === "scheduled"
                ? "bg-gray-100 text-gray-700 ring-gray-200"
                : "bg-indigo-50 text-indigo-700 ring-indigo-100";

            const status = statusLabel(r.status);
            const statusCls =
              status === "DONE"
                ? "text-green-700"
                : status === "RUNNING" || status === "ENQUEUED"
                ? "text-amber-700"
                : status === "DONE_WITH_ERRORS" || status === "FAILED" || status === "ENQUEUE_FAILED"
                ? "text-red-700"
                : "text-gray-500";

            const runTime = pickRunTime(r);

            // ✅ Updated counter names from new backend
            const feedsCount = metric(r.feedsCount);
            const found = metric(r.found);
            const candidates = metric(r.candidates);
            const added = metric(r.added);
            const updated = metric(r.updated);
            const writes = metric(r.writes) || added + updated;

            const skippedOld = metric(r.skippedOld);
            const skippedUnchanged = metric(r.skippedUnchanged);
            const noTimestamp = metric(r.noTimestamp);

            const errorsCount = metric(r.errorsCount);
            const durationMs = r.durationMs;

            return (
              <li key={r.id} className="px-4 py-5 sm:px-6 hover:bg-gray-50 transition-colors">
                <div className="flex items-start justify-between gap-x-6">
                  <div className="min-w-0 flex-1">
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

                    {/* Topline summary */}
                    <div className="mt-2 text-sm text-gray-700">
                      Feeds <span className="font-semibold">{feedsCount}</span>
                      {" "}• Found <span className="font-semibold">{found}</span>
                      {" "}• Candidates <span className="font-semibold">{candidates}</span>
                      {" "}• Writes <span className="font-semibold">{writes}</span>
                      {" "}• Duration <span className="font-semibold">{fmtDuration(durationMs)}</span>
                    </div>

                    {/* Mini cards like your screenshot */}
                    <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div className="rounded-lg ring-1 ring-inset ring-gray-200 bg-white p-3">
                        <div className="text-[10px] font-black uppercase tracking-widest text-gray-400">
                          Skipped (Old)
                        </div>
                        <div className="mt-1 text-lg font-extrabold text-gray-900">{skippedOld}</div>
                      </div>

                      <div className="rounded-lg ring-1 ring-inset ring-gray-200 bg-white p-3">
                        <div className="text-[10px] font-black uppercase tracking-widest text-gray-400">
                          No Timestamp
                        </div>
                        <div className="mt-1 text-lg font-extrabold text-gray-900">{noTimestamp}</div>
                      </div>

                      <div className="rounded-lg ring-1 ring-inset ring-gray-200 bg-white p-3">
                        <div className="text-[10px] font-black uppercase tracking-widest text-gray-400">
                          Unchanged
                        </div>
                        <div className="mt-1 text-lg font-extrabold text-gray-900">{skippedUnchanged}</div>
                      </div>

                      <div className="rounded-lg ring-1 ring-inset ring-gray-200 bg-white p-3">
                        <div className="text-[10px] font-black uppercase tracking-widest text-gray-400">
                          Writes
                        </div>
                        <div className="mt-1 text-lg font-extrabold text-indigo-700">{writes}</div>
                      </div>
                    </div>

                    {isOpen && (
                      <div className="mt-5 space-y-4">
                        {(status === "RUNNING" || status === "ENQUEUED") && (
                          <div className="rounded-lg bg-amber-50 ring-1 ring-inset ring-amber-100 p-4">
                            <div className="text-xs font-bold uppercase tracking-widest text-amber-700">
                              In progress
                            </div>
                            <div className="mt-2 text-sm text-amber-800">
                              This run is still updating. Counters may change while it runs.
                            </div>
                          </div>
                        )}

                        {errorsCount > 0 ? (
                          <div className="rounded-lg bg-red-50 ring-1 ring-inset ring-red-100 p-4">
                            <div className="text-xs font-bold uppercase tracking-widest text-red-700">
                              Errors detected
                            </div>

                            <div className="mt-2 text-sm text-gray-700">
                              Errors count: <span className="font-semibold">{errorsCount}</span>
                            </div>

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

                            {Array.isArray(r.errorSamples) && r.errorSamples.length > 0 ? (
                              <div className="mt-4">
                                <div className="text-[11px] font-black uppercase tracking-widest text-red-700">
                                  Error samples
                                </div>
                                <ul className="mt-2 space-y-2">
                                  {r.errorSamples.slice(0, 12).map((e, idx) => (
                                    <li
                                      key={idx}
                                      className="text-xs font-mono text-red-900 whitespace-pre-wrap break-words"
                                    >
                                      {e}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          status !== "RUNNING" &&
                          status !== "ENQUEUED" && (
                            <div className="rounded-lg bg-green-50 ring-1 ring-inset ring-green-100 p-4">
                              <div className="text-xs font-bold uppercase tracking-widest text-green-700">
                                No errors in this run
                              </div>
                              <div className="mt-2 text-sm text-green-800">
                                All feeds completed successfully.
                              </div>
                            </div>
                          )
                        )}

                        {/* Timeline */}
                        <div className="rounded-lg bg-white ring-1 ring-inset ring-gray-200 p-4">
                          <div className="text-[11px] font-black uppercase tracking-widest text-gray-600">
                            Timeline
                          </div>

                          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm text-gray-700">
                            <div>
                              Created: <span className="font-semibold">{fmtDateTime(r.createdAt)}</span>
                            </div>
                            <div>
                              Enqueued: <span className="font-semibold">{fmtDateTime(r.enqueuedAt)}</span>
                            </div>
                            <div>
                              Started: <span className="font-semibold">{fmtDateTime(r.startedAt)}</span>
                            </div>
                            <div>
                              Finished: <span className="font-semibold">{fmtDateTime(r.finishedAt)}</span>
                            </div>
                          </div>

                          {/* Optional backend debug fields */}
                          {typeof r.windowMs === "number" ? (
                            <div className="mt-3 text-xs text-gray-600">
                              Window:{" "}
                              <span className="font-semibold">{Math.round(r.windowMs / 60000)} min</span>
                              {typeof r.cutoffMs === "number" ? (
                                <>
                                  {" "}• Cutoff:{" "}
                                  <span className="font-semibold">
                                    {new Date(r.cutoffMs).toLocaleString()}
                                  </span>
                                </>
                              ) : null}
                            </div>
                          ) : null}
                        </div>

                        {/* Human explanation */}
                        <div className="rounded-lg bg-indigo-50 ring-1 ring-inset ring-indigo-100 p-4">
                          <div className="text-[11px] font-black uppercase tracking-widest text-indigo-700">
                            How to read this run
                          </div>
                          <div className="mt-2 text-sm text-indigo-900/90 leading-relaxed">
                            <ul className="list-disc pl-5 space-y-1">
                              <li>
                                <span className="font-semibold">Found</span> is after location filtering.
                              </li>
                              <li>
                                <span className="font-semibold">Candidates</span> are only jobs updated/published within the last hour.
                              </li>
                              <li>
                                <span className="font-semibold">Skipped (Old)</span> means the job was outside the 1-hour window, so it was ignored.
                              </li>
                              <li>
                                <span className="font-semibold">Unchanged</span> means the job existed in Firestore and wasn’t newer, so no write.
                              </li>
                            </ul>
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
                        : errorsCount > 0 || status === "FAILED" || status === "ENQUEUE_FAILED"
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
              No fetch runs yet.
            </li>
          )}
        </ul>
      </div>

      {openRun ? (
        <div className="text-xs text-gray-500">
          Note: With the “last 1 hour” ingestion window,{" "}
          <span className="font-semibold">Candidates</span> should usually be much smaller than{" "}
          <span className="font-semibold">Found</span>.
        </div>
      ) : null}
    </div>
  );
}
