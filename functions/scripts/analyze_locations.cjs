/**
 * scripts/analyze_locations.cjs
 * 
 * Fetches all jobs from Firestore via REST API and analyzes locationName values
 * across different sources (greenhouse, ashby, eightfold).
 * 
 * Run from /functions directory:
 *   node scripts/analyze_locations.cjs
 */

const fs = require("fs");
const path = require("path");

const PROJECT_ID = "greenhouse-jobs-scrapper";
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// Get access token
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

// Fetch all documents from a collection using pagination
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

// Extract field value from Firestore REST format
function extractValue(field) {
  if (!field) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.integerValue !== undefined) return parseInt(field.integerValue);
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.nullValue !== undefined) return null;
  if (field.arrayValue) {
    return (field.arrayValue.values || []).map(extractValue);
  }
  if (field.mapValue) {
    const result = {};
    for (const [k, v] of Object.entries(field.mapValue.fields || {})) {
      result[k] = extractValue(v);
    }
    return result;
  }
  return null;
}

async function analyzeLocations() {
  console.log("🔍 Getting access token...");
  const token = await getAccessToken();
  
  console.log("🔍 Fetching users...");
  const userDocs = await fetchAllDocs("users", token);
  console.log(`Found ${userDocs.length} users.`);

  const allJobs = [];

  for (const userDoc of userDocs) {
    const userId = userDoc.name.split("/").pop();
    console.log(`  Fetching jobs for user: ${userId}...`);
    
    const jobDocs = await fetchAllDocs(`users/${userId}/jobs`, token);
    console.log(`    Found ${jobDocs.length} jobs.`);
    
    for (const jobDoc of jobDocs) {
      const fields = jobDoc.fields || {};
      allJobs.push({
        id: jobDoc.name.split("/").pop(),
        source: extractValue(fields.source) || "unknown",
        locationName: extractValue(fields.locationName) || null,
        locationTokens: extractValue(fields.locationTokens) || [],
        stateCodes: extractValue(fields.stateCodes) || [],
        isRemote: extractValue(fields.isRemote) || false,
        companyName: extractValue(fields.companyName) || "unknown",
        title: extractValue(fields.title) || "unknown",
        coordinates: extractValue(fields.coordinates) || null,
        geocoded: extractValue(fields.geocoded) || false,
      });
    }
  }

  console.log(`\n📊 Total jobs: ${allJobs.length}\n`);

  // Group by source
  const bySource = {};
  for (const job of allJobs) {
    if (!bySource[job.source]) bySource[job.source] = [];
    bySource[job.source].push(job);
  }

  console.log("=== JOBS BY SOURCE ===");
  for (const [source, jobs] of Object.entries(bySource)) {
    console.log(`  ${source}: ${jobs.length} jobs`);
  }
  console.log("");

  // Unique locationName values with frequency
  const locationFreq = {};
  for (const job of allJobs) {
    const loc = job.locationName || "(null/empty)";
    if (!locationFreq[loc]) locationFreq[loc] = { count: 0, sources: new Set(), companies: new Set() };
    locationFreq[loc].count++;
    locationFreq[loc].sources.add(job.source);
    locationFreq[loc].companies.add(job.companyName);
  }

  // Sort by frequency
  const sorted = Object.entries(locationFreq)
    .sort((a, b) => b[1].count - a[1].count);

  console.log(`=== ALL UNIQUE LOCATION VALUES: ${sorted.length} total ===\n`);
  console.log("Count | Sources          | Location Value");
  console.log("------|------------------|---------------");
  for (const [loc, info] of sorted) {
    const sources = Array.from(info.sources).join(",");
    console.log(`${String(info.count).padStart(5)} | ${sources.padEnd(16)} | ${loc}`);
  }

  // Identify patterns that should be "Remote/Other"
  console.log("\n\n=== REMOTE / VAGUE LOCATIONS (should be 'Other') ===\n");
  const remotePatterns = /^(remote|united states|anywhere|US|USA|U\.S\.)$/i;
  const remoteContains = /\bremote\b/i;
  
  const categorized = { remote: [], city: [] };
  
  for (const [loc, info] of sorted) {
    if (loc === "(null/empty)") {
      categorized.remote.push({ loc, count: info.count });
      continue;
    }
    if (remotePatterns.test(loc.trim()) || remoteContains.test(loc)) {
      categorized.remote.push({ loc, count: info.count });
    } else {
      categorized.city.push({ loc, count: info.count });
    }
  }
  
  console.log("Remote/Vague (classify as 'Other'):");
  for (const item of categorized.remote) {
    console.log(`  ${String(item.count).padStart(4)}x "${item.loc}"`);
  }
  
  console.log(`\nCity-based locations (${categorized.city.length} unique):`);
  for (const item of categorized.city.slice(0, 50)) {
    console.log(`  ${String(item.count).padStart(4)}x "${item.loc}"`);
  }
  if (categorized.city.length > 50) {
    console.log(`  ... and ${categorized.city.length - 50} more`);
  }

  // Save full analysis to file for reference
  const output = {
    totalJobs: allJobs.length,
    bySource: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, v.length])),
    uniqueLocations: sorted.length,
    allLocations: sorted.map(([loc, info]) => ({
      locationName: loc,
      count: info.count,
      sources: Array.from(info.sources),
    })),
    remoteLocations: categorized.remote,
    cityLocations: categorized.city,
  };
  
  fs.writeFileSync(
    path.join(__dirname, "location_analysis.json"),
    JSON.stringify(output, null, 2)
  );
  console.log("\n\n✅ Full analysis saved to scripts/location_analysis.json");
}

analyzeLocations().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
