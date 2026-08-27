/**
 * functions/lib/userJobScores.cjs
 *
 * Per-user AI relevance scores for the shared job corpus.
 *
 * Architecture: jobs are stored once at /users/{ADMIN_UID}/jobs/*, but each
 * user gets their own personalized score against their resume, stored at
 * /users/{userId}/jobScores/{jobId}. To keep frontend reads cheap, all of
 * a user's scores are rolled up into a single aggregation document.
 *
 * Aggregation doc:
 *   /users/{userId}/aggregations/myJobScores
 *   { scores: { [jobId]: { score, reason } }, count, updatedAt }
 *
 * Read cost: 1 document per /jobs session per user, regardless of corpus size.
 */

const admin = require("firebase-admin");

const MAX_SCORES_IN_AGG = 2000; // keep the aggregation doc well under 1 MiB

// Owner of the shared job corpus and the recentJobs/allJobs aggregations.
// Must match ADMIN_UID in functions/index.js.
const ADMIN_UID = "7Tojjo8l5PZIYctPmdwncf7PC133";

/**
 * Upsert a batch of scores for a user and refresh their aggregation doc.
 * @param {string} userId
 * @param {Array<{ jobId: string, score: number, reason: string }>} entries
 * @param {FirebaseFirestore.Firestore} [dbInstance]
 */
async function writeUserScores(userId, entries, dbInstance) {
  const db = dbInstance || admin.firestore();
  if (!Array.isArray(entries) || entries.length === 0) return 0;

  const scoredAt = admin.firestore.Timestamp.now();
  const userRef = db.collection("users").doc(userId);
  const scoresRef = userRef.collection("jobScores");

  // Firestore batches max 500 ops — chunk to be safe.
  const CHUNK = 400;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const batch = db.batch();
    for (const { jobId, score, reason } of entries.slice(i, i + CHUNK)) {
      if (!jobId) continue;
      batch.set(
        scoresRef.doc(jobId),
        {
          score: typeof score === "number" ? score : null,
          reason: reason || "",
          scoredAt,
        },
        { merge: true }
      );
    }
    await batch.commit();
  }

  await rebuildUserJobScores(userId, db);
  return entries.length;
}

/**
 * Rebuilds /users/{userId}/aggregations/myJobScores from the live jobScores
 * subcollection. Safe to call concurrently; last writer wins.
 */
async function rebuildUserJobScores(userId, dbInstance) {
  const db = dbInstance || admin.firestore();
  const scoresRef = db.collection("users").doc(userId).collection("jobScores");

  // The Jobs page can only display jobs present in the admin-owned
  // recentJobs/allJobs aggregations, so the rollup mirrors exactly those ids.
  // Ranking by scoredAt recency is wrong here: a still-live job scored weeks
  // ago falls out of the window and renders unscored after a repost.
  const adminAggs = db.collection("users").doc(ADMIN_UID).collection("aggregations");
  const [recentSnap, allSnap] = await Promise.all([
    adminAggs.doc("recentJobs").get(),
    adminAggs.doc("allJobs").get(),
  ]);
  const ids = new Set();
  for (const snap of [recentSnap, allSnap]) {
    const jobs = snap.exists ? snap.data()?.jobs : null;
    if (Array.isArray(jobs)) for (const j of jobs) if (j?.id) ids.add(j.id);
  }

  const scores = {};
  let count = 0;

  if (ids.size > 0) {
    const idList = [...ids].slice(0, MAX_SCORES_IN_AGG);
    const CHUNK = 300;
    for (let i = 0; i < idList.length; i += CHUNK) {
      const snaps = await db.getAll(...idList.slice(i, i + CHUNK).map((id) => scoresRef.doc(id)));
      for (const s of snaps) {
        if (!s.exists) continue;
        const x = s.data();
        scores[s.id] = {
          score: typeof x.score === "number" ? x.score : null,
          reason: x.reason || "",
        };
        count++;
      }
    }
  } else {
    // Fallback (aggregations missing/empty): most recently scored entries.
    const snap = await scoresRef.orderBy("scoredAt", "desc").limit(MAX_SCORES_IN_AGG).get();
    snap.forEach((d) => {
      const x = d.data();
      scores[d.id] = {
        score: typeof x.score === "number" ? x.score : null,
        reason: x.reason || "",
      };
    });
    count = snap.size;
  }

  await db
    .collection("users")
    .doc(userId)
    .collection("aggregations")
    .doc("myJobScores")
    .set({
      scores,
      count,
      limit: MAX_SCORES_IN_AGG,
      updatedAt: admin.firestore.Timestamp.now(),
    });

  return count;
}

module.exports = { writeUserScores, rebuildUserJobScores, MAX_SCORES_IN_AGG };
