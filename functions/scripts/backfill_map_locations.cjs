/**
 * scripts/backfill_map_locations.cjs
 * 
 * Backfills the `mapLocation` field on all job documents in Firestore.
 * Uses the locationNormalizer to convert raw locationName → { city, state, lat, lng }
 * 
 * mapLocation field:
 *   - { city: string, state: string, lat: number, lng: number } for resolved cities
 *   - null for remote/vague/unresolvable (classified as "Other" on the map)
 * 
 * Run from /functions directory:
 *   node scripts/backfill_map_locations.cjs
 */

const fs = require("fs");
const path = require("path");
const { normalizeToMapLocation } = require("../lib/locationNormalizer.cjs");

const PROJECT_ID = "greenhouse-jobs-scrapper";
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

async function fetchAllDocs(collectionPath, token) {
  const docs = [];
  let pageToken = null;

  while (true) {
    let url = `${BASE_URL}/${collectionPath}?pageSize=300`;
    if (pageToken) url += `&pageToken=${pageToken}`;

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json();

    if (data.documents) {
      docs.push(...data.documents);
    }

    if (data.nextPageToken) {
      pageToken = data.nextPageToken;
    } else {
      break;
    }
  }
  return docs;
}

function extractStringValue(field) {
  if (!field) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  return null;
}

/**
 * Converts a mapLocation object to Firestore REST format
 */
function toFirestoreValue(mapLocation) {
  if (mapLocation === null) {
    return { nullValue: null };
  }
  return {
    mapValue: {
      fields: {
        city: { stringValue: mapLocation.city },
        state: { stringValue: mapLocation.state },
        lat: { doubleValue: mapLocation.lat },
        lng: { doubleValue: mapLocation.lng },
      },
    },
  };
}

/**
 * Batch update using Firestore commit (batch writes)
 * Max 500 operations per batch
 */
async function batchUpdate(updates, token) {
  const BATCH_SIZE = 400; // Leave headroom under 500 limit
  let totalUpdated = 0;

  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);
    
    const writes = batch.map(({ docPath, mapLocation }) => ({
      update: {
        name: `projects/${PROJECT_ID}/databases/(default)/documents/${docPath}`,
        fields: {
          mapLocation: toFirestoreValue(mapLocation),
        },
      },
      updateMask: {
        fieldPaths: ["mapLocation"],
      },
    }));

    const resp = await fetch(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:commit`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ writes }),
      }
    );

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Batch commit failed (${resp.status}): ${err}`);
    }

    totalUpdated += batch.length;
    const pct = ((i + batch.length) / updates.length * 100).toFixed(1);
    process.stdout.write(`\r  Updated ${totalUpdated}/${updates.length} (${pct}%)`);
  }
  
  console.log(""); // newline after progress
  return totalUpdated;
}

async function runBackfill() {
  console.log("🚀 Starting mapLocation backfill...\n");
  
  const token = await getAccessToken();
  console.log("✅ Got access token\n");

  // Fetch all users
  const userDocs = await fetchAllDocs("users", token);
  console.log(`Found ${userDocs.length} users.\n`);

  let totalJobs = 0;
  let resolvedCount = 0;
  let otherCount = 0;
  const cityCounts = {};

  for (const userDoc of userDocs) {
    const userId = userDoc.name.split("/").pop();
    console.log(`Processing user: ${userId}`);
    
    const jobDocs = await fetchAllDocs(`users/${userId}/jobs`, token);
    console.log(`  Found ${jobDocs.length} jobs. Normalizing...`);
    totalJobs += jobDocs.length;
    
    const updates = [];
    
    for (const jobDoc of jobDocs) {
      const fields = jobDoc.fields || {};
      const locationName = extractStringValue(fields.locationName);
      const mapLocation = normalizeToMapLocation(locationName);
      
      // Build the update
      const docPath = `users/${userId}/jobs/${jobDoc.name.split("/").pop()}`;
      updates.push({ docPath, mapLocation });
      
      if (mapLocation) {
        resolvedCount++;
        const key = `${mapLocation.city}, ${mapLocation.state}`;
        cityCounts[key] = (cityCounts[key] || 0) + 1;
      } else {
        otherCount++;
      }
    }
    
    // Write in batches
    if (updates.length > 0) {
      await batchUpdate(updates, token);
    }
  }

  console.log("\n\n✨ Backfill Complete!");
  console.log(`Total jobs processed: ${totalJobs}`);
  console.log(`Resolved to city: ${resolvedCount} (${(resolvedCount/totalJobs*100).toFixed(1)}%)`);
  console.log(`Other (remote/null): ${otherCount} (${(otherCount/totalJobs*100).toFixed(1)}%)`);
  console.log(`Unique city clusters: ${Object.keys(cityCounts).length}`);
  
  // Save city stats
  const stats = Object.entries(cityCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([city, count]) => ({ city, count }));
  
  fs.writeFileSync(
    path.join(__dirname, "backfill_results.json"),
    JSON.stringify({ totalJobs, resolvedCount, otherCount, cities: stats }, null, 2)
  );
  console.log("\n📄 Results saved to scripts/backfill_results.json");
}

runBackfill().catch(err => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
