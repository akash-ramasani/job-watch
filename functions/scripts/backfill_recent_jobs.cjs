/**
 * scripts/backfill_recent_jobs.cjs
 *
 * One-time backfill for /users/{ADMIN_UID}/aggregations/recentJobs so the
 * frontend Jobs page can render with a single Firestore read on first visit.
 * After this runs once, the doc is kept fresh automatically by Cloud Functions
 * (syncUserRecentJobs, scoreNewJobsForUser, dailyAggregationReconciliation).
 *
 * Run from /functions:   node scripts/backfill_recent_jobs.cjs
 */

const fs = require("fs");
const path = require("path");

const PROJECT_ID = "greenhouse-jobs-scrapper";
const ADMIN_UID = "7Tojjo8l5PZIYctPmdwncf7PC133";
const RECENT_LIMIT = 500;
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const RUN_QUERY_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;

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

function extractValue(val) {
  if (val == null) return null;
  if (val.stringValue !== undefined) return val.stringValue;
  if (val.integerValue !== undefined) return Number(val.integerValue);
  if (val.doubleValue !== undefined) return val.doubleValue;
  if (val.booleanValue !== undefined) return val.booleanValue;
  if (val.nullValue !== undefined) return null;
  if (val.timestampValue !== undefined) return { __ts__: val.timestampValue };
  if (val.mapValue) return extractMap(val.mapValue);
  if (val.arrayValue) return (val.arrayValue.values || []).map(extractValue);
  return null;
}
function extractMap(mapVal) {
  if (!mapVal || !mapVal.fields) return {};
  const out = {};
  for (const [k, v] of Object.entries(mapVal.fields)) out[k] = extractValue(v);
  return out;
}
function extractFields(doc) {
  if (!doc || !doc.fields) return null;
  const out = {};
  for (const [k, v] of Object.entries(doc.fields)) out[k] = extractValue(v);
  return out;
}

function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === "string") return { stringValue: val };
  if (typeof val === "number") {
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (typeof val === "boolean") return { booleanValue: val };
  if (val && typeof val === "object" && val.__ts__) {
    return { timestampValue: val.__ts__ };
  }
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(toFirestoreValue) } };
  }
  if (typeof val === "object") {
    const fields = {};
    for (const [k, v] of Object.entries(val)) fields[k] = toFirestoreValue(v);
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

async function fetchRecentJobs(token) {
  // Structured query: order by sourceUpdatedTs desc, limit 500
  const body = {
    structuredQuery: {
      from: [{ collectionId: "jobs" }],
      orderBy: [{ field: { fieldPath: "sourceUpdatedTs" }, direction: "DESCENDING" }],
      limit: RECENT_LIMIT,
    },
  };
  const parent = `projects/${PROJECT_ID}/databases/(default)/documents/users/${ADMIN_UID}`;
  const url = `https://firestore.googleapis.com/v1/${parent}:runQuery`;
  console.log("   POST " + url);
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error("fetch failed: " + (e && (e.cause?.message || e.message)) + " | stack: " + (e && e.stack));
  }
  if (!resp.ok) {
    throw new Error(`runQuery failed: ${resp.status} ${await resp.text()}`);
  }
  const rows = await resp.json();
  const docs = [];
  for (const row of rows) {
    if (!row.document) continue;
    const id = row.document.name.split("/").pop();
    const fields = extractFields(row.document);
    if (fields) docs.push({ id, fields });
  }
  return docs;
}

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
    relevanceScore: typeof x.relevanceScore === "number" ? x.relevanceScore : null,
    scoreReason: x.scoreReason || "",
  };
}

async function writeRecentJobs(token, jobs) {
  const url = `${BASE_URL}/users/${ADMIN_UID}/aggregations/recentJobs`;
  const payload = {
    jobs,
    count: jobs.length,
    limit: RECENT_LIMIT,
    updatedAt: { __ts__: new Date().toISOString() },
  };
  const fields = {};
  for (const [k, v] of Object.entries(payload)) fields[k] = toFirestoreValue(v);
  const resp = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!resp.ok) throw new Error(`PATCH failed: ${resp.status} ${await resp.text()}`);
}

async function main() {
  console.log("🔄 Backfilling /users/" + ADMIN_UID + "/aggregations/recentJobs ...\n");
  const token = await getAccessToken();

  console.log("1. Querying latest " + RECENT_LIMIT + " jobs by sourceUpdatedTs desc...");
  const docs = await fetchRecentJobs(token);
  console.log("   Got " + docs.length + " jobs.");

  if (docs.length === 0) {
    console.log("⚠️  No jobs found. Nothing to write.");
    return;
  }

  console.log("2. Projecting + writing aggregation doc...");
  const jobs = docs.map(({ id, fields }) => projectJob(id, fields));
  await writeRecentJobs(token, jobs);

  console.log("✨ Done. recentJobs now contains " + jobs.length + " jobs.");
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
