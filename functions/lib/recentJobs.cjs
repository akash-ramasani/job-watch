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
const { classifyTitle } = require("./jobFamilies.cjs");

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
    fam: classifyTitle(x.title), // job types, so the Jobs page can hide unrelated jobs before they're scored
    // Visa / citizenship / clearance flags (lib/eligibility.cjs), only when present.
    ...(Array.isArray(x.el) && x.el.length ? { el: x.el } : {}),
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
    fam: classifyTitle(x.title), // job types, so the Jobs page can hide unrelated jobs before they're scored
    // Visa / citizenship / clearance flags (lib/eligibility.cjs), only when present.
    ...(Array.isArray(x.el) && x.el.length ? { el: x.el } : {}),
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

const tsMillis = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : t && typeof t._seconds === "number" ? t._seconds * 1000 : null);

/**
 * Incremental version of rebuildRecentJobs + rebuildAllJobs for the sync:
 * merge the jobs written this run into the two lists and drop expired ones,
 * instead of re-querying ~2,000 job docs. Costs 2 reads + 2 writes.
 * The nightly reconciliation still does a full rebuild.
 *
 * @param {string} userId  corpus owner (admin)
 * @param {Array<object>} written  job objects as written this run (with jobDocId)
 * @param {{ ttlDays: number, dbInstance? }} opts
 * @returns {Promise<Set<string>>} ids now on either list
 */
async function mergeIntoJobLists(userId, written, { ttlDays, dbInstance } = {}) {
  const db = dbInstance || admin.firestore();
  const aggs = db.collection("users").doc(userId).collection("aggregations");
  const [recentSnap, allSnap] = await Promise.all([aggs.doc("recentJobs").get(), aggs.doc("allJobs").get()]);
  if (!recentSnap.exists || !allSnap.exists) {
    await rebuildRecentJobs(userId, db);
    await rebuildAllJobs(userId, db);
    return listedJobIds(db, userId);
  }

  const full = new Map((recentSnap.data().jobs || []).map((j) => [j.id, j]));
  const entries = new Map((allSnap.data().jobs || []).map((j) => [j.id, j]));
  for (const [id, j] of full) if (!entries.has(id)) entries.set(id, j);

  for (const job of written || []) {
    const id = job.jobDocId;
    if (!id) continue;
    const projected = projectJob(id, job);
    const prev = full.get(id) || entries.get(id) || {};
    // Fields this run didn't write keep their stored value (the doc was merged).
    for (const k of Object.keys(projected)) if (k !== "id" && job[k] === undefined && prev[k] !== undefined) projected[k] = prev[k];
    full.set(id, projected);
    entries.set(id, projected);
  }

  // Same rows the query would return: has sourceUpdatedTs, not yet expired, newest first.
  const expiredBefore = Date.now() - ttlDays * 86400000;
  const ranked = [...entries.values()]
    .filter((j) => tsMillis(j.sourceUpdatedTs) != null && tsMillis(j.sourceUpdatedTs) >= expiredBefore)
    .sort((a, b) => tsMillis(b.sourceUpdatedTs) - tsMillis(a.sourceUpdatedTs))
    .slice(0, ALL_JOBS_LIMIT);

  const recent = ranked.slice(0, RECENT_JOBS_LIMIT).map((j) => full.get(j.id) || { ...j, locationTokens: [] });
  const all = ranked.map((j) => {
    const { locationTokens, ...lean } = j; // eslint-disable-line no-unused-vars
    return lean;
  });
  const now = admin.firestore.Timestamp.now();
  await Promise.all([
    aggs.doc("recentJobs").set({ jobs: recent, count: recent.length, limit: RECENT_JOBS_LIMIT, updatedAt: now }),
    aggs.doc("allJobs").set({ jobs: all, count: all.length, limit: ALL_JOBS_LIMIT, updatedAt: now }),
  ]);
  return new Set(ranked.map((j) => j.id));
}

/** Ids on the admin's recentJobs + allJobs lists (2 reads). */
async function listedJobIds(dbInstance, ownerUid) {
  const db = dbInstance || admin.firestore();
  const aggs = db.collection("users").doc(ownerUid).collection("aggregations");
  const [r, a] = await Promise.all([aggs.doc("recentJobs").get(), aggs.doc("allJobs").get()]);
  const ids = new Set();
  for (const snap of [r, a]) for (const j of (snap.exists && snap.data().jobs) || []) if (j?.id) ids.add(j.id);
  return ids;
}

module.exports = {
  mergeIntoJobLists,
  listedJobIds,
  rebuildRecentJobs,
  rebuildAllJobs,
  RECENT_JOBS_LIMIT,
  ALL_JOBS_LIMIT,
};
