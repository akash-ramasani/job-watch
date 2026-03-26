import React, { useEffect, useRef, useState } from "react";
import { collection, query, orderBy, limit, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircleIcon, XCircleIcon, XMarkIcon } from "@heroicons/react/24/outline";

export default function JobSyncNotification({ user }) {
  const [notification, setNotification] = useState(null);
  const mountTime = useRef(Date.now());
  const lastRunId = useRef(null);

  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, "users", user.uid, "syncRuns"),
      orderBy("finishedAt", "desc"),
      limit(1)
    );

    const unsub = onSnapshot(q, (snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type === "added" || change.type === "modified") {
          const run = change.doc.data();
          const runId = change.doc.id;

          if (run.finishedAt && (run.status === "DONE" || run.status === "FAILED")) {
            // Avoid triggering again for the identical run logic
            if (lastRunId.current === runId) return;

            const finishedMs = run.finishedAt.toMillis();
            // Show if it finished while using the app, or if it finished within the last 5 minutes before opening
            const isRecent = finishedMs > mountTime.current || (Date.now() - finishedMs < 5 * 60 * 1000);

            if (isRecent) {
              lastRunId.current = runId;
              setNotification({
                id: runId,
                status: run.status,
                jobs: run.jobsWritten || 0,
                duration: (run.durationMs / 1000).toFixed(1),
                error: run.error || null,
              });

              // Auto dismiss after 6 seconds
              setTimeout(() => {
                setNotification((current) => (current?.id === runId ? null : current));
              }, 6000);
            }
          }
        }
      });
    });

    return () => unsub();
  }, [user]);

  return (
    <AnimatePresence>
      {notification && (
        <motion.div
          key="job-sync-notification"
          initial={{ opacity: 0, y: -40, x: "-50%", scale: 0.95 }}
          animate={{ opacity: 1, y: 0, x: "-50%", scale: 1 }}
          exit={{ opacity: 0, y: -20, x: "-50%", scale: 0.95 }}
          transition={{ type: "spring", stiffness: 400, damping: 25 }}
          className="fixed top-24 left-1/2 z-[100] w-full max-w-sm px-4 sm:px-0"
        >
          <div className="overflow-hidden rounded-2xl bg-white/70 backdrop-blur-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-white/50 ring-1 ring-black/5 p-4">
            <div className="flex items-start gap-4">
              <div className="flex-shrink-0 mt-0.5">
                {notification.status === "DONE" ? (
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/10 border border-emerald-500/20">
                    <CheckCircleIcon className="h-6 w-6 text-emerald-500" aria-hidden="true" />
                  </div>
                ) : (
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-rose-500/10 border border-rose-500/20">
                    <XCircleIcon className="h-6 w-6 text-rose-500" aria-hidden="true" />
                  </div>
                )}
              </div>
              <div className="flex-1 pt-1">
                <p className="text-sm font-semibold text-gray-900 tracking-tight">
                  {notification.status === "DONE" ? "Job Sync Complete" : "Job Sync Failed"}
                </p>
                <div className="mt-1 flex items-center">
                  <span className="text-sm font-medium text-gray-500/90">
                    {notification.status === "DONE" 
                      ? `Added ${notification.jobs} new jobs in ${notification.duration}s` 
                      : notification.error}
                  </span>
                </div>
              </div>
              <div className="flex flex-shrink-0 ml-4">
                <button
                  type="button"
                  className="inline-flex rounded-full p-1.5 text-gray-400 hover:bg-black/5 hover:text-gray-500 focus:outline-none transition-colors"
                  onClick={() => setNotification(null)}
                >
                  <span className="sr-only">Close</span>
                  <XMarkIcon className="h-5 w-5" aria-hidden="true" />
                </button>
              </div>
            </div>
            {notification.status === "DONE" && (
              <motion.div 
                className="absolute bottom-0 left-0 h-1 bg-emerald-500/80"
                initial={{ width: "0%" }}
                animate={{ width: "100%" }}
                transition={{ duration: 6, ease: "linear" }}
              />
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
