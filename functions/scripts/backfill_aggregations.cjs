/**
 * scripts/backfill_aggregations.cjs
 * 
 * One-time script to create initial aggregation docs (mapClusters + companyStats).
 * Uses Firestore REST API with Firebase CLI OAuth tokens.
 * 
 * Run from /functions directory:
 *   node scripts/backfill_aggregations.cjs
 */

const fs = require("fs");
const path = require("path");

const PROJECT_ID = "greenhouse-jobs-scrapper";
const ADMIN_UID = "7Tojjo8l5PZIYctPmdwncf7PC133";
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

async function getAccessToken() {
  const configPath = path.join(require("os").homedir(), ".config/configstore/firebase-tools.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const refreshToken = config.tokens.refresh_token;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
      client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
    }),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error("Failed to get access token: " + JSON.stringify(data));
  return data.access_token;
}

function extractFields(firestoreDoc) {
  if (!firestoreDoc || !firestoreDoc.fields) return null;
  const fields = firestoreDoc.fields;
  const result = {};

  for (const [key, val] of Object.entries(fields)) {
    if (val.stringValue !== undefined) result[key] = val.stringValue;
    else if (val.integerValue !== undefined) result[key] = Number(val.integerValue);
    else if (val.doubleValue !== undefined) result[key] = val.doubleValue;
    else if (val.booleanValue !== undefined) result[key] = val.booleanValue;
    else if (val.nullValue !== undefined) result[key] = null;
    else if (val.mapValue) result[key] = extractMapValue(val.mapValue);
    else if (val.arrayValue) result[key] = (val.arrayValue.values || []).map(extractValue);
  }
  return result;
}

function extractMapValue(mapVal) {
  if (!mapVal || !mapVal.fields) return {};
  const result = {};
  for (const [k, v] of Object.entries(mapVal.fields)) {
    result[k] = extractValue(v);
  }
  return result;
}

function extractValue(val) {
  if (val.stringValue !== undefined) return val.stringValue;
  if (val.integerValue !== undefined) return Number(val.integerValue);
  if (val.doubleValue !== undefined) return val.doubleValue;
  if (val.booleanValue !== undefined) return val.booleanValue;
  if (val.nullValue !== undefined) return null;
  if (val.mapValue) return extractMapValue(val.mapValue);
  if (val.arrayValue) return (val.arrayValue.values || []).map(extractValue);
  return null;
}

function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === "string") return { stringValue: val };
  if (typeof val === "number") {
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (typeof val === "boolean") return { booleanValue: val };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(toFirestoreValue) } };
  }
  if (typeof val === "object") {
    const fields = {};
    for (const [k, v] of Object.entries(val)) {
      fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

async function fetchAllJobs(token) {
  const jobs = [];
  let pageToken = null;

  while (true) {
    let url = `${BASE_URL}/users/${ADMIN_UID}/jobs?pageSize=300`;
    if (pageToken) url += `&pageToken=${pageToken}`;

    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await resp.json();

    if (data.documents) {
      for (const doc of data.documents) {
        const fields = extractFields(doc);
        if (fields) jobs.push(fields);
      }
    }

    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
    process.stdout.write(`\r  Fetched ${jobs.length} jobs...`);
  }

  console.log(`\r  Fetched ${jobs.length} jobs total.`);
  return jobs;
}

function computeAggregations(jobs) {
  const clusters = {};
  const companies = {};

  for (const job of jobs) {
    // Map clusters
    const loc = job.mapLocation;
    if (loc && loc.city && loc.state) {
      const key = `${loc.city}|${loc.state}`;
      if (!clusters[key]) {
        clusters[key] = { lat: loc.lat, lng: loc.lng, count: 0, cityPin: 0, remotePin: 0, statePin: 0 };
      }
      clusters[key].count++;
      const ptKey = (loc.pinType || "city") + "Pin";
      if (clusters[key][ptKey] !== undefined) clusters[key][ptKey]++;
    }

    // Company stats
    const ck = job.companyKey;
    const cn = job.companyName || "Unknown";
    if (ck) {
      if (!companies[ck]) companies[ck] = { name: cn, count: 0 };
      companies[ck].count++;
    }
  }

  return { clusters, companies };
}

async function writeAggregationDoc(token, docName, data) {
  const url = `${BASE_URL}/users/${ADMIN_UID}/aggregations/${docName}`;

  const fields = {};
  for (const [key, val] of Object.entries(data)) {
    fields[key] = toFirestoreValue(val);
  }

  const resp = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Failed to write ${docName}: ${resp.status} ${errText}`);
  }

  console.log(`  ✅ Written aggregations/${docName}`);
}

async function main() {
  console.log("🔄 Backfilling aggregation docs...\n");

  const token = await getAccessToken();

  console.log("1. Fetching all jobs...");
  const jobs = await fetchAllJobs(token);

  console.log("\n2. Computing aggregations...");
  const { clusters, companies } = computeAggregations(jobs);
  console.log(`   ${Object.keys(clusters).length} city clusters`);
  console.log(`   ${Object.keys(companies).length} companies`);
  console.log(`   ${jobs.length} total jobs`);

  console.log("\n3. Writing aggregation docs...");
  const now = new Date().toISOString();

  await writeAggregationDoc(token, "mapClusters", {
    clusters,
    totalJobs: jobs.length,
    updatedAt: now,
  });

  await writeAggregationDoc(token, "companyStats", {
    companies,
    totalCompanies: Object.keys(companies).length,
    updatedAt: now,
  });

  // Also write an initial scoringStatus doc
  const recentScores = jobs
    .filter((j) => typeof j.relevanceScore === "number" && j.relevanceScore >= 0)
    .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
    .slice(0, 50)
    .map((j) => ({ id: j.jobDocId || "", score: j.relevanceScore, reason: j.scoreReason || "" }));

  await writeAggregationDoc(token, "scoringStatus", {
    recentScores,
    pendingCount: 0,
    scoringInProgress: false,
    updatedAt: now,
  });

  console.log("\n✨ Aggregation backfill complete!");
  console.log(`   mapClusters: ${Object.keys(clusters).length} cities, ${jobs.length} total jobs`);
  console.log(`   companyStats: ${Object.keys(companies).length} companies`);
  console.log(`   scoringStatus: ${recentScores.length} recent scores`);
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
