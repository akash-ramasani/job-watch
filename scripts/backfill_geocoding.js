/**
 * scripts/backfill_geocoding.js
 * 
 * Geocodes all existing jobs in Firestore that are missing coordinates.
 * Uses OpenStreetMap Nominatim (respects 1 req/sec limit).
 */

const admin = require("firebase-admin");

// Initialize Firebase (assumes GOOGLE_APPLICATION_CREDENTIALS env var or default auth)
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

// Cache for geocoding to avoid duplicate requests for the same city
const _geoCache = new Map();

async function geocodeLocation(locationName) {
  if (!locationName) return null;

  const cleaned = locationName
    .replace(/remote/gi, "")
    .replace(/\bUS\b/g, "")
    .replace(/;/g, ",")
    .trim()
    .replace(/^,|,$/, "").trim();

  if (!cleaned || cleaned.length < 3) return null;

  const key = cleaned.toLowerCase();
  if (_geoCache.has(key)) return _geoCache.get(key);

  try {
    const encoded = encodeURIComponent(`${cleaned}, United States`);
    const url = `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1&countrycodes=us`;
    
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "JobWatch/1.0 (backfill-script; contact@jobwatch.app)",
        "Accept": "application/json",
      },
    });

    if (!resp.ok) {
      console.warn(`Geocode failed for "${cleaned}": HTTP ${resp.status}`);
      return null;
    }

    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) {
      _geoCache.set(key, null);
      return null;
    }

    const { lat, lon } = data[0];
    const coords = { lat: parseFloat(lat), lng: parseFloat(lon) };
    _geoCache.set(key, coords);
    return coords;
  } catch (e) {
    console.error(`Geocode error for "${cleaned}": ${e.message}`);
    return null;
  }
}

async function runBackfill() {
  console.log("🚀 Starting Geocode Backfill...");
  
  const usersSnap = await db.collection("users").get();
  console.log(`Found ${usersSnap.size} users.`);

  let totalUpdated = 0;
  let totalSkipped = 0;

  for (const userDoc of usersSnap.docs) {
    const userId = userDoc.id;
    const userName = userDoc.data().fullName || userId;
    console.log(`\nProcessing jobs for user: ${userName} (${userId})`);

    const jobsCol = db.collection("users").doc(userId).collection("jobs");
    // Fetch jobs that are NOT geocoded yet
    const jobsSnap = await jobsCol.where("geocoded", "!=", true).get();
    
    console.log(`Found ${jobsSnap.size} jobs needing geocoding.`);

    for (const jobDoc of jobsSnap.docs) {
      const jobData = jobDoc.data();
      const loc = jobData.locationName;

      if (!loc || loc.toLowerCase().includes("remote")) {
        await jobDoc.ref.update({ geocoded: false });
        totalSkipped++;
        continue;
      }

      const coords = await geocodeLocation(loc);
      if (coords) {
        await jobDoc.ref.update({
          coordinates: coords,
          geocoded: true,
          geocodedAt: admin.firestore.Timestamp.now()
        });
        totalUpdated++;
        console.log(`✅ [${totalUpdated}] Geocoded: "${loc}" -> ${coords.lat}, ${coords.lng}`);
      } else {
        await jobDoc.ref.update({ geocoded: false });
        totalSkipped++;
        console.log(`❌ Failed: "${loc}"`);
      }

      // Respect Nominatim rate limit (1 req/sec)
      await new Promise(r => setTimeout(r, 1100));
    }
  }

  console.log("\n✨ Backfill Complete!");
  console.log(`Updated: ${totalUpdated}`);
  console.log(`Skipped/Failed: ${totalSkipped}`);
  process.exit(0);
}

runBackfill().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
