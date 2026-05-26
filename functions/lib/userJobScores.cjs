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
  const snap = await db
    .collection("users")
    .doc(userId)
    .collection("jobScores")
    .orderBy("scoredAt", "desc")
    .limit(MAX_SCORES_IN_AGG)
    .get();

  const scores = {};
  snap.forEach((d) => {
    const x = d.data();
    scores[d.id] = {
      score: typeof x.score === "number" ? x.score : null,
      reason: x.reason || "",
    };
  });

  await db
    .collection("users")
    .doc(userId)
    .collection("aggregations")
    .doc("myJobScores")
    .set({
      scores,
      count: snap.size,
      limit: MAX_SCORES_IN_AGG,
      updatedAt: admin.firestore.Timestamp.now(),
    });

  return snap.size;
}

module.exports = { writeUserScores, rebuildUserJobScores, MAX_SCORES_IN_AGG };
