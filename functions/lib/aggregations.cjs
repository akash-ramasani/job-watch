/**
 * functions/lib/aggregations.cjs
 *
 * Computes and writes aggregation documents for efficient frontend reads.
 * Used by: (1) daily reconciliation scheduled function, (2) one-time backfill script.
 *
 * Aggregation docs:
 *   /users/{uid}/aggregations/mapClusters   — city counts for map page
 *   /users/{uid}/aggregations/companyStats   — company job counts for filter dropdown
 */

const admin = require("firebase-admin");

/**
 * Reads all jobs for a user and computes + writes aggregation docs.
 * @param {string} userId - The user ID to reconcile
 * @param {FirebaseFirestore.Firestore} [dbInstance] - Optional Firestore instance (for testing)
 * @returns {{ totalJobs: number, cities: number, companies: number }}
 */
async function rebuildAggregations(userId, dbInstance) {
  const db = dbInstance || admin.firestore();
  const jobsRef = db.collection("users").doc(userId).collection("jobs");
  const aggRef = db.collection("users").doc(userId).collection("aggregations");

  // Read all jobs (paginated to avoid memory issues with very large collections)
  const PAGE_SIZE = 500;
  let lastDoc = null;
  const clusters = {};    // "City|State" → { lat, lng, count, city, remote, state }
  const companies = {};   // companyKey → { name, count }
  let totalJobs = 0;

  while (true) {
    let q = jobsRef.orderBy("__name__").limit(PAGE_SIZE);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      const data = doc.data();
      totalJobs++;

      // --- Map clusters ---
      const loc = data.mapLocation;
      if (loc && loc.city && loc.state) {
        const key = `${loc.city}|${loc.state}`;
        if (!clusters[key]) {
          clusters[key] = { lat: loc.lat, lng: loc.lng, count: 0, city: 0, remote: 0, state: 0 };
        }
        clusters[key].count++;
        const pt = loc.pinType || "city";
        if (clusters[key][pt] !== undefined) clusters[key][pt]++;
      }

      // --- Company stats ---
      const ck = data.companyKey;
      const cn = data.companyName || "Unknown";
      if (ck) {
        if (!companies[ck]) companies[ck] = { name: cn, count: 0 };
        companies[ck].count++;
      }
    }

    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < PAGE_SIZE) break;
  }

  // Write aggregation docs
  const now = admin.firestore.Timestamp.now();

  await aggRef.doc("mapClusters").set({
    clusters,
    totalJobs,
    updatedAt: now,
  });

  await aggRef.doc("companyStats").set({
    companies,
    totalCompanies: Object.keys(companies).length,
    updatedAt: now,
  });

  return {
    totalJobs,
    cities: Object.keys(clusters).length,
    companies: Object.keys(companies).length,
  };
}

module.exports = { rebuildAggregations };
