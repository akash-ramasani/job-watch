/**
 * functions/index.js
 *
 * Node runtime: 20
 * Ensure your functions/package.json has "engines": { "node": "20" }
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Helper: normalize job array from feed JSON
function normalizeJobsFromFeedJson(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.jobs)) return json.jobs;
  if (json && Array.isArray(json.data)) return json.data;
  return [];
}

function safeJobKey(sourceUrl, job) {
  // Use stable id when available
  if (job && (job.id || job._id)) return String(job.id || job._id);
  const base = `${sourceUrl}::${job?.absolute_url || ""}::${job?.title || ""}`;
  return Buffer.from(base).toString("base64").replace(/=+$/g, "");
}

async function fetchJson(url) {
  const res = await fetch(url, {
    method: "GET",
    headers: { "user-agent": "job-watch-bot/1.0" },
  });
  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} for ${url}`);
  }
  return await res.json();
}

/**
 * Robust location parsing:
 * - Avoid missing ANY US jobs by using multiple US signals:
 *   - explicit "United States", "USA", "US", "U.S."
 *   - any US state code anywhere in the string
 *   - any US state full name anywhere in the string
 * - Extract ALL states found (important for multi-office jobs)
 * - For your supported profile countries, also detect explicitly:
 *   United States, Canada, Ireland, United Kingdom
 */
function parseLocationFields(locationNameRaw) {
  const locationName = String(locationNameRaw || "").trim();
  const s = locationName.toLowerCase();

  const SUPPORTED_COUNTRIES = ["United States", "Canada", "Ireland", "United Kingdom"];

  const US_MARKERS = [
    "united states",
    "united states of america",
    "u.s.",
    "u.s",
    "usa",
    "u.s.a",
  ];

  const US_STATE_CODES = [
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
    "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
    "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
  ];

  const US_STATE_NAMES_TO_CODE = {
    "alabama":"AL","alaska":"AK","arizona":"AZ","arkansas":"AR","california":"CA","colorado":"CO",
    "connecticut":"CT","delaware":"DE","florida":"FL","georgia":"GA","hawaii":"HI","idaho":"ID",
    "illinois":"IL","indiana":"IN","iowa":"IA","kansas":"KS","kentucky":"KY","louisiana":"LA","maine":"ME",
    "maryland":"MD","massachusetts":"MA","michigan":"MI","minnesota":"MN","mississippi":"MS","missouri":"MO",
    "montana":"MT","nebraska":"NE","nevada":"NV","new hampshire":"NH","new jersey":"NJ","new mexico":"NM",
    "new york":"NY","north carolina":"NC","north dakota":"ND","ohio":"OH","oklahoma":"OK","oregon":"OR",
    "pennsylvania":"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD","tennessee":"TN",
    "texas":"TX","utah":"UT","vermont":"VT","virginia":"VA","washington":"WA","west virginia":"WV",
    "wisconsin":"WI","wyoming":"WY","district of columbia":"DC",
  };

  // Extract all US state codes found as standalone-ish tokens
  const stateCodeRegex = new RegExp(
    `(?:^|[\\s,•|/()\\-])(${US_STATE_CODES.join("|")})(?=$|[\\s,•|/()\\-])`,
    "gi"
  );

  const statesSet = new Set();
  let m;
  while ((m = stateCodeRegex.exec(locationName)) !== null) {
    if (m[1]) statesSet.add(m[1].toUpperCase());
  }

  // If no state codes found, try full state names (can appear in office strings)
  if (statesSet.size === 0) {
    const stateNames = Object.keys(US_STATE_NAMES_TO_CODE).sort((a, b) => b.length - a.length);
    for (const name of stateNames) {
      if (s.includes(name)) {
        statesSet.add(US_STATE_NAMES_TO_CODE[name]);
        // don't break: could be multi-location with multiple state names
      }
    }
  }

  const states = Array.from(statesSet);

  // country detection: explicit supported-country match
  let country = null;
  for (const c of SUPPORTED_COUNTRIES) {
    if (s.includes(c.toLowerCase())) {
      country = c;
      break;
    }
  }

  // high-recall US detection
  const hasUsMarker =
    US_MARKERS.some((mk) => s.includes(mk)) ||
    /\b(us|u\.s\.|usa|u\.s\.a)\b/i.test(locationName);

  const hasRemoteUs =
    /remote\s*[-–—]?\s*(us|u\.s\.|usa|united states)/i.test(locationName) ||
    /(anywhere|nationwide|across)\s+the\s+(us|u\.s\.|usa)/i.test(locationName);

  const hasUsStateSignal = states.length > 0;

  if (!country && (hasUsMarker || hasRemoteUs || hasUsStateSignal)) {
    country = "United States";
  }

  return { locationName, country, states };
}

// Poll feeds for single user -> writes new jobs into users/{uid}/jobs
async function pollForUser(uid) {
  const userRef = db.collection("users").doc(uid);
  const feedsSnap = await userRef.collection("feeds").get();

  if (feedsSnap.empty) {
    // update lastFetchAt even if there are no feeds
    await userRef.set({ lastFetchAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { newCount: 0, feeds: 0 };
  }

  const feeds = feedsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  let totalNewCount = 0;

  // Limit concurrency per user
  const concurrency = 3;
  let i = 0;
  const workers = new Array(Math.min(concurrency, feeds.length)).fill(0).map(async () => {
    while (i < feeds.length) {
      const idx = i++;
      const feed = feeds[idx];
      const url = feed.url;
      const feedRef = userRef.collection("feeds").doc(feed.id);
      const jobsCol = userRef.collection("jobs");

      try {
        const json = await fetchJson(url);
        const jobs = normalizeJobsFromFeedJson(json);

        let batch = db.batch();
        let ops = 0;
        let newCount = 0;

        for (const job of jobs) {
          const jobKey = safeJobKey(url, job);
          const jobRef = jobsCol.doc(jobKey);

          // IMPORTANT: do not overwrite old jobs
          const existing = await jobRef.get();
          if (existing.exists) continue;

          const companyName = job.company_name || null;
          const rawLocationName = job?.location?.name || job?.location_name || job?.location || "";
          const { locationName, country, states } = parseLocationFields(rawLocationName);

          // pick fields to store (store entire job object as well)
          const payload = {
            // normalized fields (easy UI + filtering)
            title: job.title || job.name || job.position || null,
            absolute_url: job.absolute_url || job.url || job.apply_url || null,
            companyName,
            locationName,
            country,
            states, // array of US state codes if detected (e.g., ["CA","NY"])

            // metadata
            source: url,
            raw: job,

            // timestamps
            firstSeenAt: admin.firestore.FieldValue.serverTimestamp(),
          };

          // batch.create() guarantees we NEVER overwrite even if called concurrently
          batch.create(jobRef, payload);
          ops++;
          newCount++;

          if (ops >= 450) {
            await batch.commit();
            batch = db.batch();
            ops = 0;
          }
        }

        if (ops > 0) await batch.commit();

        totalNewCount += newCount;

        // update feed metadata
        await feedRef.set(
          {
            lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastNewCount: newCount,
            lastError: null,
          },
          { merge: true }
        );
      } catch (err) {
        console.error("Feed error", uid, url, err?.message || err);
        await feedRef.set(
          {
            lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastError: String(err?.message || err),
          },
          { merge: true }
        );
      }
    }
  });

  await Promise.all(workers);

  // update user lastFetchAt
  await userRef.set({ lastFetchAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

  return { newCount: totalNewCount, feeds: feeds.length };
}

// Scheduled: every 30 minutes - polls all users
exports.pollGreenhouseFeeds = functions.pubsub
  .schedule("every 30 minutes")
  .timeZone("Etc/UTC")
  .onRun(async () => {
    const usersSnap = await db.collection("users").get();
    if (usersSnap.empty) return null;

    // Limit concurrency across users
    const userDocs = usersSnap.docs;
    const concurrency = 5;
    let i = 0;
    const workers = new Array(Math.min(concurrency, userDocs.length)).fill(0).map(async () => {
      while (i < userDocs.length) {
        const idx = i++;
        const userDoc = userDocs[idx];
        try {
          await pollForUser(userDoc.id);
        } catch (err) {
          console.error("User poll error", userDoc.id, err?.message || err);
        }
      }
    });

    await Promise.all(workers);
    return null;
  });

// Manual: onCall - authenticated user can trigger polling for their account only
exports.pollNow = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    // automatically rejects if no auth
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated to poll now.");
  }

  const uid = context.auth.uid;

  try {
    const result = await pollForUser(uid);
    // return summary to client
    return { ok: true, newCount: result.newCount, feeds: result.feeds };
  } catch (err) {
    console.error("Manual poll error", uid, err?.message || err);
    throw new functions.https.HttpsError("internal", "Polling failed: " + String(err?.message || err));
  }
});
