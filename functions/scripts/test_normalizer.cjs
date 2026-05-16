/**
 * scripts/test_normalizer.cjs
 * 
 * Tests the locationNormalizer against all real location data from the analysis.
 */
const fs = require("fs");
const path = require("path");
const { normalizeToMapLocation } = require("../lib/locationNormalizer.cjs");

const analysisPath = path.join(__dirname, "location_analysis.json");
const data = JSON.parse(fs.readFileSync(analysisPath, "utf8"));

let resolvedCount = 0;
let unresolvedCount = 0;
let otherCount = 0; // intentionally null (remote/vague)

const resolvedCities = {};
const unresolved = [];

for (const loc of data.allLocations) {
  const locationName = loc.locationName;
  if (locationName === "(null/empty)") {
    otherCount += loc.count;
    continue;
  }
  
  const result = normalizeToMapLocation(locationName);
  
  if (result) {
    resolvedCount += loc.count;
    const key = `${result.city}, ${result.state}`;
    if (!resolvedCities[key]) resolvedCities[key] = { ...result, jobCount: 0 };
    resolvedCities[key].jobCount += loc.count;
  } else {
    // null result means either remote/vague OR unresolvable city
    // Classify: if it SHOULD be null (remote, state-only, international, multiple locations), it's "Other"
    const isIntentionallyOther = /remote|^united states|^us$|^usa$|anywhere|multiple locations|in-office|^(california|massachusetts|new jersey|rhode island|new hampshire|maryland|arkansas|florida|texas|virginia|colorado|washington|georgia|illinois|ohio|north carolina|south carolina|tennessee|pennsylvania|michigan|minnesota|indiana|arizona|oregon|connecticut|utah|wisconsin|iowa|nevada|kentucky|missouri|louisiana|nebraska|oklahoma|montana|idaho|kansas|delaware|maine|vermont|wyoming|hawaii|new mexico|south dakota|north dakota|west virginia|mississippi|alabama)$/i.test(locationName)
      || /toronto|bengaluru|bangalore|london|paris|berlin|sydney|tel aviv|abu dhabi|marseille|canada|india|europe/i.test(locationName)
      || /^(us|united states)\s*[\/ ]\s*(canada|remote)/i.test(locationName);
    
    if (isIntentionallyOther) {
      otherCount += loc.count;
    } else {
      unresolvedCount += loc.count;
      unresolved.push({ locationName, count: loc.count });
    }
  }
}

console.log("=== NORMALIZER TEST RESULTS ===\n");
console.log(`Total jobs: ${data.totalJobs}`);
console.log(`✅ Resolved to city: ${resolvedCount} jobs (${(resolvedCount/data.totalJobs*100).toFixed(1)}%)`);
console.log(`🌐 Remote/Other (correct null): ${otherCount} jobs (${(otherCount/data.totalJobs*100).toFixed(1)}%)`);
console.log(`❌ Unresolved (city not found): ${unresolvedCount} jobs (${(unresolvedCount/data.totalJobs*100).toFixed(1)}%)`);
console.log(`\nCity clusters: ${Object.keys(resolvedCities).length}`);

console.log("\n=== TOP 30 RESOLVED CITIES ===\n");
const sortedCities = Object.entries(resolvedCities)
  .sort((a, b) => b[1].jobCount - a[1].jobCount);
for (const [key, info] of sortedCities.slice(0, 30)) {
  console.log(`  ${String(info.jobCount).padStart(5)} jobs | ${key} (${info.lat}, ${info.lng})`);
}

console.log("\n=== TOP 50 UNRESOLVED LOCATIONS ===\n");
const sortedUnresolved = unresolved.sort((a, b) => b.count - a.count);
for (const item of sortedUnresolved.slice(0, 50)) {
  console.log(`  ${String(item.count).padStart(4)}x "${item.locationName}"`);
}

// Save resolved cities for map use
const mapData = sortedCities.map(([key, info]) => ({
  city: info.city,
  state: info.state,
  lat: info.lat,
  lng: info.lng,
  jobCount: info.jobCount,
}));
fs.writeFileSync(path.join(__dirname, "map_cities.json"), JSON.stringify(mapData, null, 2));
console.log("\n✅ Saved resolved cities to scripts/map_cities.json");
