/**
 * functions/lib/recentJobs.cjs
 *
 * Maintains a single aggregation document containing the most recent jobs
 * (denormalized minimal fields) so the frontend /jobs page can render with a
 * single Firestore read per session instead of paginating the whole corpus.
 *
 * Doc path:   /users/{uid}/aggregations/recentJobs
 * Shape:      { jobs: Job[], count, updatedAt }
 *
 * Limit chosen so the doc stays well under Firestore's 1 MiB ceiling
 * (500 jobs × ~600 B ≈ 300 KiB headroom).
 */

const admin = require("firebase-admin");

const RECENT_JOBS_LIMIT = 500;

// The "All" view aggregation holds more rows but uses a leaner projection
// (no locationTokens) so it still fits comfortably under Firestore's 1 MiB
// per-document ceiling. ~1500 jobs × ~350 B ≈ 525 KiB.
const ALL_JOBS_LIMIT = 1500;

/**
 * Project a job document down to the fields actually rendered by the Jobs
 * page. Keep this list in sync with src/pages/Jobs.jsx if the UI changes.
 *
 * Note: relevanceScore / scoreReason are intentionally NOT projected here.
 * Those are per-user data and live at /users/{userId}/jobScores/{jobId},
 * rolled up to /users/{userId}/aggregations/myJobScores. The Jobs page
 * merges the two on the client.
 */
function projectJob(id, x) {
  return {
    id,
    title: x.title || "",
    companyKey: x.companyKey || "",
    companyName: x.companyName || "Unknown",
    locationName: x.locationName || "",
    locationTokens: Array.isArray(x.locationTokens) ? x.locationTokens : [],
    stateCodes: Array.isArray(x.stateCodes) ? x.stateCodes : [],
    isRemote: x.isRemote === true,
    workplaceType: x.workplaceType || "",
    source: x.source || "",
    externalId: x.externalId || "",
    jobUrl: x.jobUrl || "",
    applyUrl: x.applyUrl || "",
    sourceUpdatedTs: x.sourceUpdatedTs || null,
    firstSeenAt: x.firstSeenAt || null,
    fetchedAt: x.fetchedAt || null,
  };
}

/**
 * Leaner projection for the "All" view. Drops `locationTokens` (the heaviest
 * field) to keep the aggregation doc small. `locationName` + `stateCodes` are
 * already denormalized, so the UI doesn't need the raw tokens to render.
 */
function projectJobLean(id, x) {
  return {
    id,
    title: x.title || "",
    companyKey: x.companyKey || "",
    companyName: x.companyName || "Unknown",
    locationName: x.locationName || "",
    stateCodes: Array.isArray(x.stateCodes) ? x.stateCodes : [],
    isRemote: x.isRemote === true,
    workplaceType: x.workplaceType || "",
    source: x.source || "",
    externalId: x.externalId || "",
    jobUrl: x.jobUrl || "",
    applyUrl: x.applyUrl || "",
    sourceUpdatedTs: x.sourceUpdatedTs || null,
    firstSeenAt: x.firstSeenAt || null,
    fetchedAt: x.fetchedAt || null,
  };
}

/**
 * Rebuilds /users/{uid}/aggregations/recentJobs from the live jobs collection.
 * Safe to call concurrently; last writer wins. Cheap (1 ordered+limited read).
 */
async function rebuildRecentJobs(userId, dbInstance) {
  const db = dbInstance || admin.firestore();
  const jobsRef = db.collection("users").doc(userId).collection("jobs");

  const snap = await jobsRef
    .orderBy("sourceUpdatedTs", "desc")
    .limit(RECENT_JOBS_LIMIT)
    .get();

  const jobs = snap.docs.map((d) => projectJob(d.id, d.data()));

  await db
    .collection("users")
    .doc(userId)
    .collection("aggregations")
    .doc("recentJobs")
    .set({
      jobs,
      count: jobs.length,
      limit: RECENT_JOBS_LIMIT,
      updatedAt: admin.firestore.Timestamp.now(),
    });

  return jobs.length;
}

/**
 * Rebuilds /users/{uid}/aggregations/allJobs — the data source for the
 * Jobs page "All" timeframe. Uses a leaner projection and a larger row cap
 * so the frontend can render the full corpus with a single Firestore read
 * instead of paginating /users/{uid}/jobs (which previously capped at 300).
 */
async function rebuildAllJobs(userId, dbInstance) {
  const db = dbInstance || admin.firestore();
  const jobsRef = db.collection("users").doc(userId).collection("jobs");

  const snap = await jobsRef
    .orderBy("sourceUpdatedTs", "desc")
    .limit(ALL_JOBS_LIMIT)
    .get();

  const jobs = snap.docs.map((d) => projectJobLean(d.id, d.data()));

  await db
    .collection("users")
    .doc(userId)
    .collection("aggregations")
    .doc("allJobs")
    .set({
      jobs,
      count: jobs.length,
      limit: ALL_JOBS_LIMIT,
      updatedAt: admin.firestore.Timestamp.now(),
    });

  return jobs.length;
}

module.exports = {
  rebuildRecentJobs,
  rebuildAllJobs,
  RECENT_JOBS_LIMIT,
  ALL_JOBS_LIMIT,
};
