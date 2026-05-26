/**
 * scripts/backfill_user_scores.cjs
 *
 * One-time migration. Copies relevanceScore / scoreReason from each existing
 * job doc at /users/{ADMIN_UID}/jobs/* into /users/{ADMIN_UID}/jobScores/*
 * and writes /users/{ADMIN_UID}/aggregations/myJobScores.
 *
 * Going forward, scoreNewJobsForUser writes scores directly to the per-user
 * jobScores collection, so this script only ever needs to run once.
 *
 * Run from /functions:   node scripts/backfill_user_scores.cjs
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
  if (!data.access_token) throw new Error("Token error: " + JSON.stringify(data));
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
  if (val && typeof val === "object" && val.__ts__) return { timestampValue: val.__ts__ };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFirestoreValue) } };
  if (typeof val === "object") {
    const fields = {};
    for (const [k, v] of Object.entries(val)) fields[k] = toFirestoreValue(v);
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

async function fetchAllScoredJobs(token) {
  // Paginated list. We need every job that has a relevanceScore set so we
  // can mirror it into the per-user scores collection.
  const docs = [];
  let pageToken = null;
  while (true) {
    let url = `${BASE_URL}/users/${ADMIN_UID}/jobs?pageSize=300`;
    if (pageToken) url += `&pageToken=${pageToken}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await resp.json();
    if (!resp.ok) throw new Error(`list jobs: ${resp.status} ${JSON.stringify(data)}`);
    for (const doc of data.documents || []) {
      const id = doc.name.split("/").pop();
      const fields = extractFields(doc);
      if (!fields) continue;
      if (typeof fields.relevanceScore !== "number") continue;
      docs.push({ id, score: fields.relevanceScore, reason: fields.scoreReason || "" });
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
    process.stdout.write(`\r  Scanned, kept ${docs.length} scored jobs...`);
  }
  console.log(`\r  Found ${docs.length} scored jobs.`);
  return docs;
}

async function writeJobScore(token, jobId, score, reason) {
  const url = `${BASE_URL}/users/${ADMIN_UID}/jobScores/${encodeURIComponent(jobId)}`;
  const fields = {
    score: toFirestoreValue(score),
    reason: toFirestoreValue(reason || ""),
    scoredAt: toFirestoreValue({ __ts__: new Date().toISOString() }),
  };
  const resp = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!resp.ok) throw new Error(`write score ${jobId}: ${resp.status} ${await resp.text()}`);
}

async function writeMyJobScoresAgg(token, entries) {
  const url = `${BASE_URL}/users/${ADMIN_UID}/aggregations/myJobScores`;
  const scores = {};
  for (const e of entries) {
    scores[e.id] = { score: e.score, reason: e.reason || "" };
  }
  const payload = {
    scores,
    count: entries.length,
    limit: 2000,
    updatedAt: { __ts__: new Date().toISOString() },
  };
  const fields = {};
  for (const [k, v] of Object.entries(payload)) fields[k] = toFirestoreValue(v);
  const resp = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!resp.ok) throw new Error(`write myJobScores: ${resp.status} ${await resp.text()}`);
}

async function main() {
  console.log("🔄 Migrating admin job scores → per-user model\n");
  const token = await getAccessToken();

  console.log("1. Scanning shared corpus for scored jobs...");
  const scored = await fetchAllScoredJobs(token);

  if (scored.length === 0) {
    console.log("⚠️  No scored jobs found — nothing to mirror.");
    return;
  }

  // Cap the aggregation at the 2000 most recently-scored to stay under 1 MiB
  // headroom. (Currently the corpus is small enough that this is a no-op.)
  const limited = scored.slice(0, 2000);

  console.log(`2. Mirroring ${limited.length} scores into /users/${ADMIN_UID}/jobScores/...`);
  let written = 0;
  // Tiny concurrency to be polite to Firestore REST and stay well below quotas.
  const CONCURRENCY = 8;
  let idx = 0;
  async function worker() {
    while (idx < limited.length) {
      const i = idx++;
      const j = limited[i];
      await writeJobScore(token, j.id, j.score, j.reason);
      written++;
      if (written % 25 === 0) process.stdout.write(`\r   ...${written}/${limited.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`\r   ...${written}/${limited.length} ✅`);

  console.log("3. Writing /users/" + ADMIN_UID + "/aggregations/myJobScores ...");
  await writeMyJobScoresAgg(token, limited);

  console.log("\n✨ Done. Admin now sees personalized scores from myJobScores.");
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
