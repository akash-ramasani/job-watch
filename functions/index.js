/**
 * functions/index.js
 * Node runtime: 20
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Helper: normalize job array from feed JSON
function normalizeJobsFromFeedJson(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.jobs)) return json.jobs;
  if (json && Array.isArray(json.data)) return json.data;
  return [];
}

function safeJobKey(sourceUrl, job) {
  // Use stable id when available
  if (job && (job.id || job._id)) return String(job.id || job._id);
  const base = `${sourceUrl}::${job?.absolute_url || ""}::${job?.title || ""}`;
  return Buffer.from(base).toString("base64").replace(/=+$/g, "");
}

async function fetchJson(url) {
  const res = await fetch(url, {
    method: "GET",
    headers: { "user-agent": "job-watch-bot/1.0" },
  });
  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} for ${url}`);
  }
  return await res.json();
}

/**
 * Poll feeds for single user -> writes new jobs into users/{uid}/jobs
 * Logs each run into users/{uid}/fetchRuns/{runId}
 *
 * IMPORTANT:
 * - Only adds new jobs (does not update old docs)
 * - Skips archived feeds (feeds with archivedAt)
 */
async function pollForUser(uid, runType = "scheduled") {
  const userRef = db.collection("users").doc(uid);

  // Create run log doc early
  const runRef = userRef.collection("fetchRuns").doc();
  const startedAtMs = Date.now();

  await runRef.set(
    {
      runType,
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      finishedAt: null,
      durationMs: null,
      feedsCount: 0,
      newCount: 0,
      errorsCount: 0,
      errorSamples: [],
    },
    { merge: true }
  );

  const feedsSnap = await userRef.collection("feeds").get();

  if (feedsSnap.empty) {
    // update user lastFetchAt even if there are no feeds
    await userRef.set({ lastFetchAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

    await runRef.set(
      {
        finishedAt: admin.firestore.FieldValue.serverTimestamp(),
        durationMs: Date.now() - startedAtMs,
        feedsCount: 0,
        newCount: 0,
        errorsCount: 0,
        errorSamples: [],
      },
      { merge: true }
    );

    return { newCount: 0, feeds: 0 };
  }

  // Include docs but skip archived in workers
  const feeds = feedsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  let totalNewCount = 0;
  let errorsCount = 0;
  const errorSamples = [];

  // Limit concurrency per user
  const concurrency = 3;
  let i = 0;

  const workers = new Array(Math.min(concurrency, feeds.length)).fill(0).map(async () => {
    while (i < feeds.length) {
      const idx = i++;
      const feed = feeds[idx];

      // Skip archived feeds
      if (feed.archivedAt) continue;

      const url = feed.url;
      const feedRef = userRef.collection("feeds").doc(feed.id);
      const jobsCol = userRef.collection("jobs");

      try {
        const json = await fetchJson(url);
        const jobs = normalizeJobsFromFeedJson(json);

        let batch = db.batch();
        let ops = 0;
        let newCount = 0;

        // For small feeds this per-doc existence check is fine.
        for (const job of jobs) {
          const jobKey = safeJobKey(url, job);
          const jobRef = jobsCol.doc(jobKey);

          const existing = await jobRef.get();
          if (existing.exists) continue; // ✅ only add new jobs

          const payload = {
            title: job.title || job.name || job.position || null,
            absolute_url: job.absolute_url || job.url || job.apply_url || null,

            // normalized top-level fields for UI
            companyName: job.company_name || null,
            locationName: job?.location?.name || job.location_name || null,

            // keep full job object for filtering/sorting
            raw: job,
            source: url,

            // when we first saw it
            firstSeenAt: admin.firestore.FieldValue.serverTimestamp(),
          };

          batch.set(jobRef, payload);
          ops++;
          newCount++;

          if (ops >= 450) {
            await batch.commit();
            batch = db.batch();
            ops = 0;
          }
        }

        if (ops > 0) await batch.commit();

        totalNewCount += newCount;

        // update feed metadata
        await feedRef.set(
          {
            lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastNewCount: newCount,
            lastError: null,
          },
          { merge: true }
        );
      } catch (err) {
        errorsCount++;
        const msg = String(err?.message || err);

        console.error("Feed error", uid, url, msg);

        if (errorSamples.length < 5) {
          errorSamples.push({
            feedId: feed.id,
            url,
            message: msg,
          });
        }

        await feedRef.set(
          {
            lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastError: msg,
          },
          { merge: true }
        );
      }
    }
  });

  await Promise.all(workers);

  // update user lastFetchAt
  await userRef.set({ lastFetchAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

  // finalize run log
  await runRef.set(
    {
      finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      durationMs: Date.now() - startedAtMs,
      feedsCount: feeds.filter((f) => !f.archivedAt).length,
      newCount: totalNewCount,
      errorsCount,
      errorSamples,
    },
    { merge: true }
  );

  return { newCount: totalNewCount, feeds: feeds.filter((f) => !f.archivedAt).length };
}

// Scheduled: every 30 minutes - polls all users
exports.pollGreenhouseFeeds = functions.pubsub
  .schedule("every 30 minutes")
  .timeZone("Etc/UTC")
  .onRun(async () => {
    const usersSnap = await db.collection("users").get();
    if (usersSnap.empty) return null;

    // Limit concurrency across users
    const userDocs = usersSnap.docs;
    const concurrency = 5;
    let i = 0;

    const workers = new Array(Math.min(concurrency, userDocs.length)).fill(0).map(async () => {
      while (i < userDocs.length) {
        const idx = i++;
        const userDoc = userDocs[idx];
        try {
          await pollForUser(userDoc.id, "scheduled");
        } catch (err) {
          console.error("User poll error", userDoc.id, err?.message || err);
        }
      }
    });

    await Promise.all(workers);
    return null;
  });

// Manual: onCall - authenticated user can trigger polling for their account only
exports.pollNow = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated to poll now.");
  }

  const uid = context.auth.uid;

  try {
    const result = await pollForUser(uid, "manual");
    return { ok: true, newCount: result.newCount, feeds: result.feeds };
  } catch (err) {
    console.error("Manual poll error", uid, err?.message || err);
    throw new functions.https.HttpsError("internal", "Polling failed: " + String(err?.message || err));
  }
});
