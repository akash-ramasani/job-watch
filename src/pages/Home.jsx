import React, { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { db } from "../firebase";

export default function Home({ user }) {
  const [company, setCompany] = useState("");
  const [url, setUrl] = useState("");
  const [feeds, setFeeds] = useState([]);
  const [busyNow, setBusyNow] = useState(false);
  const [toast, setToast] = useState(null);
  const [busyArchiveId, setBusyArchiveId] = useState(null);

  useEffect(() => {
    const feedsRef = collection(db, "users", user.uid, "feeds");
    const qFeeds = query(feedsRef, orderBy("createdAt", "desc"));
    return onSnapshot(qFeeds, (snap) =>
      setFeeds(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    );
  }, [user.uid]);

  const activeFeeds = useMemo(() => feeds.filter((f) => !f.archivedAt), [feeds]);
  const archivedFeeds = useMemo(() => feeds.filter((f) => !!f.archivedAt), [feeds]);

  async function addFeed(e) {
    e.preventDefault();
    if (!company.trim() || !url.trim()) return;

    const u = url.trim();
    if (!/^https:\/\/.+/i.test(u)) {
      alert("Please use an https:// URL");
      return;
    }

    await addDoc(collection(db, "users", user.uid, "feeds"), {
      company: company.trim(),
      url: u,
      createdAt: serverTimestamp(),
      lastCheckedAt: null,
      lastError: null,
      archivedAt: null,
    });

    setCompany("");
    setUrl("");
  }

  async function fetchNow() {
    setBusyNow(true);
    try {
      const functions = getFunctions();
      const callFn = httpsCallable(functions, "pollNow");
      const resp = await callFn({});
      const data = resp.data || {};
      setToast({
        text: `Fetched ${data.feeds ?? 0} feed(s). ${data.newCount ?? 0} new job(s).`,
      });
      setTimeout(() => setToast(null), 6000);
    } catch (err) {
      setToast({ text: "Fetch failed: " + (err?.message || err), error: true });
      setTimeout(() => setToast(null), 8000);
    } finally {
      setBusyNow(false);
    }
  }

  async function archiveFeed(feedId) {
    setBusyArchiveId(feedId);
    try {
      await updateDoc(doc(db, "users", user.uid, "feeds", feedId), {
        archivedAt: serverTimestamp(),
      });
    } finally {
      setBusyArchiveId(null);
    }
  }

  async function restoreFeed(feedId) {
    setBusyArchiveId(feedId);
    try {
      await updateDoc(doc(db, "users", user.uid, "feeds", feedId), {
        archivedAt: null,
      });
    } finally {
      setBusyArchiveId(null);
    }
  }

  return (
    <div className="space-y-12 py-10">
      {/* ===== TOP GRID (LEFT INFO + RIGHT FORM) ===== */}
      <div className="section-grid">
        {/* LEFT COLUMN */}
        <div>
          <h2 className="text-base font-semibold text-gray-900">Job Board Sources</h2>
          <p className="mt-1 text-sm text-gray-600">
            Connect Greenhouse job boards. Our system will automatically monitor these for new opportunities.
          </p>

          <div className="mt-6">
            <button
              onClick={fetchNow}
              disabled={busyNow}
              className="btn-secondary w-full sm:w-auto"
            >
              {busyNow ? "Checking..." : "Check for new jobs now"}
            </button>
          </div>
        </div>

        {/* RIGHT COLUMN (FORM ONLY) */}
        <div className="md:col-span-2">
          <form onSubmit={addFeed} className="space-y-4">
            <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-6">
              <div className="sm:col-span-4">
                <label className="block text-sm font-medium text-gray-900">
                  Company Name
                </label>
                <input
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  className="input-standard mt-2"
                  placeholder="e.g. OpenAI"
                />
              </div>

              <div className="col-span-full">
                <label className="block text-sm font-medium text-gray-900">
                  Greenhouse API Endpoint
                </label>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="input-standard mt-2"
                  placeholder="https://boards-api.greenhouse.io/v1/..."
                />
              </div>
            </div>

            {/* Button below the form */}
            <button type="submit" className="btn-primary w-full sm:w-auto">
              Add Feed
            </button>
          </form>
        </div>
      </div>

      {/* ===== CENTERED FEEDS (ACTIVE + ARCHIVED BELOW) ===== */}
      <div className="mx-auto max-w-3xl space-y-10">
        {/* ACTIVE FEEDS */}
        <div className="bg-white shadow-sm ring-1 ring-gray-200 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900">Active Feeds</h3>
            <p className="text-xs text-gray-500 mt-1">
              These feeds are monitored for new jobs.
            </p>
          </div>

          <ul className="divide-y divide-gray-100">
            {activeFeeds.map((feed) => (
              <li
                key={feed.id}
                className="flex items-center justify-between gap-x-6 px-6 py-4 hover:bg-gray-50 transition-colors"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900">{feed.company || "Company"}</p>
                  <p className="mt-1 truncate text-xs text-gray-500 font-mono">{feed.url}</p>
                  {feed.lastError ? (
                    <p className="mt-1 text-xs text-red-600">{feed.lastError}</p>
                  ) : null}
                </div>

                <button
                  onClick={() => archiveFeed(feed.id)}
                  disabled={busyArchiveId === feed.id}
                  className="text-xs font-bold uppercase tracking-wider text-amber-700 hover:text-amber-900 disabled:opacity-50"
                >
                  {busyArchiveId === feed.id ? "Archiving..." : "Archive"}
                </button>
              </li>
            ))}

            {activeFeeds.length === 0 && (
              <li className="px-6 py-10 text-center text-sm text-gray-500">
                No active feeds.
              </li>
            )}
          </ul>
        </div>

        {/* ARCHIVED FEEDS (BELOW ACTIVE, CENTERED LIKE BEFORE) */}
        <div className="bg-white shadow-sm ring-1 ring-gray-200 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900">Archived Feeds</h3>
            <p className="text-xs text-gray-500 mt-1">
              Archived feeds are not monitored. You can restore them anytime.
            </p>
          </div>

          <ul className="divide-y divide-gray-100">
            {archivedFeeds.map((feed) => (
              <li
                key={feed.id}
                className="flex items-center justify-between gap-x-6 px-6 py-4 hover:bg-gray-50 transition-colors"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900">{feed.company || "Company"}</p>
                  <p className="mt-1 truncate text-xs text-gray-500 font-mono">{feed.url}</p>
                  {feed.archivedAt?.toDate ? (
                    <p className="mt-1 text-xs text-gray-400">
                      Archived on {feed.archivedAt.toDate().toLocaleString()}
                    </p>
                  ) : null}
                </div>

                <button
                  onClick={() => restoreFeed(feed.id)}
                  disabled={busyArchiveId === feed.id}
                  className="text-xs font-bold uppercase tracking-wider text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
                >
                  {busyArchiveId === feed.id ? "Restoring..." : "Restore"}
                </button>
              </li>
            ))}

            {archivedFeeds.length === 0 && (
              <li className="px-6 py-10 text-center text-sm text-gray-500">
                No archived feeds.
              </li>
            )}
          </ul>
        </div>
      </div>

      {/* TOAST */}
      {toast ? (
        <div
          className={`fixed right-6 bottom-6 z-40 px-4 py-3 rounded-lg shadow-lg ${
            toast.error ? "bg-red-700 text-white" : "bg-zinc-900 text-zinc-100"
          }`}
        >
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}
