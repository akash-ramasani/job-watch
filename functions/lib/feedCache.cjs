"use strict";
// Per-feed memory for the job sync (Greenhouse, Ashby and other list feeds
// read by update time):
//   e  — the board's ETag from the last list we processed. The next run sends
//        it back (If-None-Match); an unchanged board answers 304 with no body,
//        so ~1,700 Ashby boards (up to 14 MB each, descriptions included) and
//        ~1,700 Greenhouse lists are not downloaded and parsed every 2 minutes.
//   ok — when this feed was last read successfully. The next read keeps every
//        job updated since then (minus a margin), not only the last 20 minutes,
//        so a skipped run, a deploy, or a board that failed for an hour never
//        loses a posting.
// Stored as one JSON string (one index entry, ~400 KB for ~3,500 feeds) in
// users/{uid}/syncState/feeds.

const MARGIN_MS = 5 * 60 * 1000;

function parseCache(str) {
  if (!str) return {};
  try {
    const x = JSON.parse(str);
    return x && typeof x === "object" && !Array.isArray(x) ? x : {};
  } catch (_) {
    return {};
  }
}

/**
 * Oldest update time to keep for one feed: the usual recent window, widened
 * back to the last successful read of this feed, never past maxAgeMs.
 */
function feedCutoffMs({ recentCutoffMs, lastOkMs, nowMs, maxAgeMs }) {
  if (recentCutoffMs == null) return null;
  let cutoff = recentCutoffMs;
  if (Number.isFinite(lastOkMs) && lastOkMs > 0) cutoff = Math.min(cutoff, lastOkMs - MARGIN_MS);
  return Math.max(cutoff, nowMs - maxAgeMs);
}

/**
 * The cache after a run: entries for feeds read this run replaced, the rest
 * kept, and entries for feeds no longer followed dropped.
 */
function mergeCache(prev, updates, activeIds) {
  const out = {};
  for (const id of activeIds) {
    const u = updates[id];
    const p = prev[id];
    if (u) out[id] = u;
    else if (p) out[id] = p;
  }
  return out;
}

module.exports = { parseCache, feedCutoffMs, mergeCache, MARGIN_MS };
