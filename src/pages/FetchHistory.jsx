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

function pickRunTime(r) {
  // preferred order
  return r.startedAt || r.enqueuedAt || r.createdAt || r.updatedAt || null;
}

function normStatus(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "done";
  return s;
}

function titleCase(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/(^|_|\s|-)+([a-z])/g, (_, p1, p2) => `${p1 ? " " : ""}${p2.toUpperCase()}`)
    .trim();
}

function statusStyles(statusUpper) {
  const s = statusUpper;
  if (s === "DONE") return { cls: "text-green-700", label: "DONE" };
  if (s === "RUNNING") return { cls: "text-amber-700", label: "RUNNING" };
  if (s === "ENQUEUED") return { cls: "text-gray-600", label: "ENQUEUED" };
  if (s === "DONE_WITH_ERRORS") return { cls: "text-red-700", label: "DONE_WITH_ERRORS" };
  if (s === "FAILED" || s === "ENQUEUE_FAILED") return { cls: "text-red-700", label: s };
  if (s === "SKIPPED_LOCK_ACTIVE") return { cls: "text-slate-600", label: "SKIPPED_LOCK_ACTIVE" };
  return { cls: "text-gray-500", label: s };
}

function runTypeBadge(runType) {
  const isScheduled = runType === "scheduled";
  return {
    label: isScheduled ? "Scheduled" : "Manual",
    cls: isScheduled
      ? "bg-gray-100 text-gray-700 ring-gray-200"
      : "bg-indigo-50 text-indigo-700 ring-indigo-100",
  };
}

function safeNum(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

function coalesceCount(r, keys, fallback = 0) {
  for (const k of keys) {
    const v = r?.[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return fallback;
}

function coalesceString(r, keys, fallback = "") {
  for (const k of keys) {
    const v = r?.[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return fallback;
}

function coalesceArray(r, keys) {
  for (const k of keys) {
    const v = r?.[k];
    if (Array.isArray(v) && v.length) return v;
  }
  return [];
}

function fmtIso(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString();
}

function fmtMsAsTime(ms) {
  if (ms == null) return "—";
  const d = new Date(ms);
  return d.toLocaleString();
}

export default function FetchHistory({ user }) {
  const [runs, setRuns] = useState([]);
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    if (!user?.uid) return;
    const ref = collection(db, "users", user.uid, "fetchRuns");
    const q = query(ref, orderBy("createdAt", "desc"), limit(80));

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
          Every scheduled poll and manual fetch is logged here. Expanding a run shows counters and
          error samples captured by the backend.
        </p>
      </div>

      <div className="overflow-hidden bg-white shadow-sm ring-1 ring-gray-200 sm:rounded-xl">
        <div className="px-4 py-4 sm:px-6 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900">Recent Runs</h3>
          <p className="text-xs text-gray-500 mt-1">
            “Added” = new job docs created. “Updated” = existing job docs updated (upsert). “Processed”
            counts jobs within your ingestion window.
          </p>
        </div>

        <ul className="divide-y divide-gray-100">
          {runs.map((r) => {
            const isOpen = openId === r.id;

            const runType = r.runType === "scheduled" ? "scheduled" : "manual";
            const badge = runTypeBadge(runType);

            const status = normStatus(r.status);
            const statusUpper = status.toUpperCase();
            const st = statusStyles(statusUpper);

            const runTime = pickRunTime(r);

            const feedsCount = coalesceCount(r, ["feedsCount"], 0);

            // support multiple schema variants
            const processedCount = coalesceCount(r, ["processed", "processedCount"], 0);
            const addedCount = coalesceCount(r, ["createdCount", "newCount", "addedCount"], 0);
            const updatedCount = coalesceCount(r, ["updatedCount"], 0);
            const errorsCount = coalesceCount(r, ["errorsCount"], 0);

            const durationMs = r.durationMs ?? null;

            const viewCls =
              isOpen
                ? "text-gray-600 hover:text-gray-900"
                : errorsCount > 0 || statusUpper === "FAILED" || statusUpper === "ENQUEUE_FAILED"
                ? "text-red-600 hover:text-red-800"
                : statusUpper === "SKIPPED_LOCK_ACTIVE"
                ? "text-slate-600 hover:text-slate-800"
                : "text-indigo-600 hover:text-indigo-800";

            return (
              <li key={r.id} className="px-4 py-5 sm:px-6 hover:bg-gray-50 transition-colors">
                <div className="flex items-start justify-between gap-x-6">
                  <div className="min-w-0 flex-1">
                    {/* Top line */}
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${badge.cls}`}
                      >
                        {badge.label}
                      </span>

                      <span className="text-sm font-semibold text-gray-900">
                        Ran {fmtSince(runTime)}
                      </span>

                      <span className="text-gray-300">|</span>

                      <span className="text-sm text-gray-600">{fmtDateTime(runTime)}</span>

                      <span className="text-gray-300">|</span>

                      <span className={`text-xs font-black uppercase tracking-widest ${st.cls}`}>
                        {st.label}
                      </span>
                    </div>

                    {/* Summary line */}
                    <div className="mt-2 text-sm text-gray-700">
                      Feeds <span className="font-semibold">{feedsCount}</span> • Processed{" "}
                      <span className="font-semibold">{processedCount}</span> • Added{" "}
                      <span className="font-semibold">{addedCount}</span> • Updated{" "}
                      <span className="font-semibold">{updatedCount}</span> • Duration{" "}
                      <span className="font-semibold">{fmtDuration(durationMs)}</span>
                    </div>

                    {/* Expanded */}
                    {isOpen && (
                      <ExpandedRunDetails
                        r={r}
                        statusUpper={statusUpper}
                        errorsCount={errorsCount}
                      />
                    )}
                  </div>

                  <button
                    onClick={() => setOpenId(isOpen ? null : r.id)}
                    className={`text-xs font-bold uppercase tracking-wider ${viewCls}`}
                  >
                    {isOpen ? "Hide" : "View"}
                  </button>
                </div>
              </li>
            );
          })}

          {!runs.length && (
            <li className="px-4 py-12 text-center text-sm text-gray-500">
              No fetch runs yet. Trigger a manual fetch or wait for the schedule.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

function ExpandedRunDetails({ r, statusUpper, errorsCount }) {
  const createdAt = r.createdAt || null;
  const enqueuedAt = r.enqueuedAt || null;
  const startedAt = r.startedAt || null;
  const finishedAt = r.finishedAt || null;

  const enqueueError = coalesceString(r, ["enqueueError"], "");
  const runError = coalesceString(r, ["error"], "");

  const errorSamples = coalesceArray(r, ["errorSamples"]);
  const skipReason = coalesceString(r, ["skipReason"], "");

  const processedCount = coalesceCount(r, ["processed", "processedCount"], 0);
  const addedCount = coalesceCount(r, ["createdCount", "newCount", "addedCount"], 0);
  const updatedCount = coalesceCount(r, ["updatedCount"], 0);

  const lock = r.lock || null;
  const debug = r.debug || null;
  const windowInfo = debug?.window || null;

  const showInProgress = statusUpper === "RUNNING" || statusUpper === "ENQUEUED";

  const hasErrors =
    errorsCount > 0 ||
    statusUpper === "FAILED" ||
    statusUpper === "ENQUEUE_FAILED" ||
    statusUpper === "DONE_WITH_ERRORS";

  const isSkippedLock = statusUpper === "SKIPPED_LOCK_ACTIVE";

  return (
    <div className="mt-5 space-y-4">
      {/* Status banner */}
      {showInProgress ? (
        <div className="rounded-lg bg-amber-50 ring-1 ring-inset ring-amber-100 p-4">
          <div className="text-xs font-bold uppercase tracking-widest text-amber-700">
            In progress
          </div>
          <div className="mt-2 text-sm text-amber-800">
            This run is still updating. Counters will change while it runs.
          </div>
        </div>
      ) : isSkippedLock ? (
        <div className="rounded-lg bg-slate-50 ring-1 ring-inset ring-slate-200 p-4">
          <div className="text-xs font-bold uppercase tracking-widest text-slate-700">
            Skipped (lock active)
          </div>
          <div className="mt-2 text-sm text-slate-800">
            {skipReason || "Another run was still active, so this one was skipped."}
          </div>
        </div>
      ) : !hasErrors ? (
        <div className="rounded-lg bg-green-50 ring-1 ring-inset ring-green-100 p-4">
          <div className="text-xs font-bold uppercase tracking-widest text-green-700">
            No errors in this run
          </div>
          <div className="mt-2 text-sm text-green-800">All feeds completed successfully.</div>
        </div>
      ) : (
        <div className="rounded-lg bg-red-50 ring-1 ring-inset ring-red-100 p-4">
          <div className="text-xs font-bold uppercase tracking-widest text-red-700">
            Errors detected
          </div>
          <div className="mt-2 text-sm text-red-800">
            {statusUpper === "ENQUEUE_FAILED"
              ? "The run could not be enqueued."
              : statusUpper === "FAILED"
              ? "The task failed."
              : "Some feeds failed during the run."}
          </div>
          <div className="mt-2 text-sm text-gray-700">
            Errors count: <span className="font-semibold">{safeNum(errorsCount, 0)}</span>
          </div>

          {enqueueError ? (
            <div className="mt-3 text-xs text-red-800 font-mono whitespace-pre-wrap break-words">
              {enqueueError}
            </div>
          ) : null}

          {runError ? (
            <div className="mt-3 text-xs text-red-800 font-mono whitespace-pre-wrap break-words">
              {runError}
            </div>
          ) : null}

          {Array.isArray(errorSamples) && errorSamples.length > 0 ? (
            <div className="mt-4">
              <div className="text-[11px] font-black uppercase tracking-widest text-red-700">
                Error samples
              </div>
              <div className="mt-2 space-y-2">
                {errorSamples.slice(0, 10).map((s, idx) => (
                  <div
                    key={idx}
                    className="rounded-md bg-white/60 ring-1 ring-inset ring-red-100 p-3"
                  >
                    <div className="text-[11px] text-gray-600">
                      {s?.when ? fmtIso(s.when) : "—"}{" "}
                      {s?.url ? (
                        <>
                          • <span className="font-mono break-all">{s.url}</span>
                        </>
                      ) : null}
                    </div>
                    <div className="mt-2 text-xs font-mono text-red-800 whitespace-pre-wrap break-words">
                      {String(s?.error || "").slice(0, 1200)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* Run details */}
      <div className="rounded-xl bg-white ring-1 ring-gray-200 p-4">
        <div className="text-xs font-black uppercase tracking-widest text-gray-600">
          Run details
        </div>

        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm text-gray-700">
          <div>
            Created: <span className="font-semibold">{fmtDateTime(createdAt)}</span>
          </div>
          <div>
            Enqueued: <span className="font-semibold">{fmtDateTime(enqueuedAt)}</span>
          </div>
          <div>
            Started: <span className="font-semibold">{fmtDateTime(startedAt)}</span>
          </div>
          <div>
            Finished: <span className="font-semibold">{fmtDateTime(finishedAt)}</span>
          </div>
        </div>

        {windowInfo ? (
          <div className="mt-3 text-xs text-gray-500">
            Window:{" "}
            <span className="font-mono">
              last {(safeNum(windowInfo.windowMs, 0) / (60 * 1000)).toFixed(0)}m
            </span>{" "}
            • Cutoff{" "}
            <span className="font-mono">
              {windowInfo.cutoffIso ? fmtIso(windowInfo.cutoffIso) : "—"}
            </span>
          </div>
        ) : null}
      </div>

      {/* Counters */}
      <div className="rounded-xl bg-white ring-1 ring-gray-200 p-4">
        <div className="text-xs font-black uppercase tracking-widest text-gray-600">Counters</div>
        <div className="mt-3 space-y-1 text-sm text-gray-700">
          <div>
            Processed (within window): <span className="font-semibold">{processedCount}</span>
          </div>
          <div>
            Added (new docs): <span className="font-semibold">{addedCount}</span>
          </div>
          <div>
            Updated (existing docs): <span className="font-semibold">{updatedCount}</span>
          </div>
        </div>
      </div>

      {/* Lock debug */}
      {lock ? (
        <div className="rounded-xl bg-white ring-1 ring-gray-200 p-4">
          <div className="text-xs font-black uppercase tracking-widest text-gray-600">
            Lock (debug)
          </div>
          <div className="mt-3 space-y-1 text-sm text-gray-700">
            <div>
              runId: <span className="font-mono">{lock.runId || "—"}</span>
            </div>
            <div>
              acquiredAt:{" "}
              <span className="font-mono">
                {typeof lock.acquiredAtMs === "number" ? fmtMsAsTime(lock.acquiredAtMs) : "—"}
              </span>
            </div>
            <div>
              expiresAt:{" "}
              <span className="font-mono">
                {typeof lock.expiresAtMs === "number" ? fmtMsAsTime(lock.expiresAtMs) : "—"}
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {/* Debug phases */}
      {debug?.phase ? (
        <div className="rounded-xl bg-white ring-1 ring-gray-200 p-4">
          <div className="text-xs font-black uppercase tracking-widest text-gray-600">
            Debug phases
          </div>
          <div className="mt-3 text-xs font-mono text-gray-700 space-y-1">
            <div>taskStartedAtMs: {debug.phase.taskStartedAtMs ?? "—"}</div>
            <div>feedsLoadedAtMs: {debug.phase.feedsLoadedAtMs ?? "—"}</div>
            <div>feedLoopStartAtMs: {debug.phase.feedLoopStartAtMs ?? "—"}</div>
            <div>feedLoopDoneAtMs: {debug.phase.feedLoopDoneAtMs ?? "—"}</div>
            <div>finalizedAtMs: {debug.phase.finalizedAtMs ?? "—"}</div>
            <div>lastHeartbeatAtMs: {debug.lastHeartbeatAtMs ?? "—"}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
