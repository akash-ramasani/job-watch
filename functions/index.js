/**
 * functions/index.js (Firebase Cloud Functions Gen2, Node 20)
 *
 * ✅ Hourly scheduler:
 * - Runs every 60 minutes
 * - Reads active feeds
 * - Fetches jobs
 * - Filters by locations (US cities/states + Remote-US strings)
 * - ONLY writes jobs updated within last 65 minutes
 * - Sets TTL field: expireAt = sourceUpdatedTs + 3 days
 *
 * ✅ Manual HTTP trigger:
 * - runSyncNow?userId=... forces a run and returns summary
 *
 * ✅ Run summary saved to Firestore:
 * - users/{uid}/syncRuns/{runId}
 *   includes startedAt, finishedAt, durationMs, feedsCount
 *
 * ✅ Manual admin tool:
 * - deleteSpacexJobs?userId=... deletes all SpaceX jobs for a user
 *
 * ⚠️ Firestore TTL must be enabled on field "expireAt" for collection group "jobs"
 */

/* eslint-disable max-len */
/* eslint-disable require-jsdoc */

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");
const Busboy = require("busboy");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

// p-limit CommonJS import fix
const pLimitPkg = require("p-limit");
const pLimit = pLimitPkg.default ?? pLimitPkg;

const Anthropic = require("@anthropic-ai/sdk");
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const anthropic = new Anthropic({ apiKey: CLAUDE_API_KEY });

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

/**
 * ----------------------------
 * CONFIG
 * ----------------------------
 */
const REGION = "us-central1";
const FEED_CONCURRENCY = 15;

const RECENT_WINDOW_MINUTES = 65;
const TTL_DAYS = 3;

const ONLY_USER_ID = process.env.ONLY_USER_ID || "";

/**
 * ----------------------------
 * LOCATION FILTER CONSTANTS
 * ----------------------------
 */
const US_STATES = [
  "Alabama","Arizona","Arkansas","California","Colorado","Connecticut","District of Columbia","Florida","Georgia",
  "Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky","Louisiana","Maryland","Massachusetts","Michigan","Minnesota",
  "Missouri","Nebraska","Nevada","New Hampshire","New Jersey","New Mexico","New York","North Carolina","Oklahoma",
  "Pennsylvania","Rhode Island","Tennessee","Texas","Utah","Virginia","Washington","Wisconsin",
];

const US_STATE_ABBREVIATIONS = [
  "AL","AZ","AR","CA","CO","CT","DC","FL","GA","ID","IL","IN","IA","KS","KY","LA",
  "MD","MA","MI","MN","MO","NE","NV","NH","NJ","NM","NY","NC","OK","PA","RI","TN",
  "TX","UT","VA","WA","WI",
];

const US_CITIES = [
  "Albuquerque","Anaheim","Ann Arbor","Arlington","Atlanta","Austin","Bakersfield","Baltimore","Baton Rouge","Bellevue",
  "Birmingham","Boise","Boston","Boulder","Brooklyn","Buffalo","Burbank","Cambridge","Charlotte","Chicago","Cincinnati",
  "Cleveland","Colorado Springs","Columbus","Dallas","Dayton","Denver","Des Moines","Detroit","Durham","El Paso",
  "Fort Collins","Fort Lauderdale","Fort Myers","Fort Worth","Fresno","Grand Rapids","Greensboro","Greenville",
  "Hartford","Henderson","Hoboken","Houston","Huntsville","Indianapolis","Irvine","Jacksonville","Jersey City",
  "Kansas City","Las Vegas","Lincoln","Little Rock","Long Beach","Los Angeles","Louisville","Madison","Memphis","Mesa",
  "Miami","Milwaukee","Minneapolis","Mountain View","Nashville","Naples","New Haven","New Orleans","New York","Newark",
  "Norfolk","Oakland","Oklahoma City","Omaha","Orlando","Palo Alto","Panama City","Pensacola","Philadelphia","Phoenix",
  "Pittsburgh","Plano","Portland","Providence","Provo","Raleigh","Redmond","Reston","Richmond","Riverside","Rochester",
  "Round Rock","Sacramento","Salt Lake City","San Antonio","San Diego","San Francisco","San Jose","San Mateo","Santa Ana",
  "Santa Clara","Santa Fe","Sarasota","Scottsdale","Seattle","Silver Spring","Spokane","St. Louis","St. Paul",
  "St. Petersburg","Sugar Land","Sunnyvale","Syracuse","Tallahassee","Tampa","Tempe","The Woodlands","Tucson","Tulsa",
  "Tysons","Virginia Beach","Washington","West Palm Beach","Wichita",
];

const REMOTE_US_ONLY = [
  "US-Remote","US Remote","US (Remote)","United States - Remote","Remote US","Remote USA","Remote-USA",
  "Remote in United States","Remote in the US","Remote - USA","Remote - US: All locations","Remote - US: Select locations",
  "Anywhere in the United States","United States","US",
];

const NORM = {
  states: new Set(US_STATES.map((s) => normalizeText(s))),
  cities: new Set(US_CITIES.map((s) => normalizeText(s))),
  remote: new Set(REMOTE_US_ONLY.map((s) => normalizeText(s))),
  abbr: new Set(US_STATE_ABBREVIATIONS.map((s) => s.toUpperCase())),
};

const LOCATION_SPLIT_REGEX = /[;|/]+|(?:\s*,\s*)/g;

/**
 * =====================================================================================
 * 1) SCHEDULED: Every 1 hour sync
 * =====================================================================================
 */
exports.syncRecentJobsHourly = onSchedule(
  {
    region: REGION,
    schedule: "every 60 minutes",
    timeZone: "America/Los_Angeles",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async () => {
    const now = admin.firestore.Timestamp.now();
    const recentCutoff = admin.firestore.Timestamp.fromDate(
      new Date(Date.now() - RECENT_WINDOW_MINUTES * 60 * 1000)
    );

    const userIds = await listUserIdsToProcess();

    for (const userId of userIds) {
      const startedAt = admin.firestore.Timestamp.now();
      const runId = String(startedAt.toMillis());
      const runRef = db.collection("users").doc(userId).collection("syncRuns").doc(runId);

      await runRef.set(
        {
          ok: true,
          userId,
          source: "syncRecentJobsHourly",
          runType: "scheduled",
          status: "RUNNING",
          startedAt,
          ranAt: startedAt,
          recentCutoffIso: recentCutoff.toDate().toISOString(),
          
        },
        { merge: true }
      );

      try {
        const summary = await syncUserRecentJobs({ userId, now, recentCutoff });

        const finishedAt = admin.firestore.Timestamp.now();
        const durationMs = finishedAt.toMillis() - startedAt.toMillis();

        await runRef.set(
          {
            status: "DONE",
            finishedAt,
            durationMs,

            ok: true,
            scanned: summary.jobsFetched,
            updated: summary.jobsWritten,
            jobsWritten: summary.jobsWritten,

            // ✅ NEW
            feedsCount: summary.feedsCount,

            // extra breakdown (optional)
            feedsProcessed: summary.feedsProcessed,
            failedFeeds: summary.failedFeeds,
            jobsFetched: summary.jobsFetched,
            jobsKeptRecent: summary.jobsKeptRecent,
          },
          { merge: true }
        );

        // Send Push Notification
        await sendPushNotification(userId, summary, durationMs);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error(`Scheduled user sync failed userId=${userId}: ${msg}`);

        const finishedAt = admin.firestore.Timestamp.now();
        const durationMs = finishedAt.toMillis() - startedAt.toMillis();

        await runRef.set(
          {
            ok: false,
            status: "FAILED",
            error: msg,
            finishedAt,
            durationMs,

            // ✅ NEW (still set something predictable)
            feedsCount: 0,
          },
          { merge: true }
        );
      }
    }
  }
);

/**
 * =====================================================================================
 * 2) MANUAL HTTP: Run sync now for one user
 * =====================================================================================
 *
 * Trigger:
 * https://us-central1-<PROJECT_ID>.cloudfunctions.net/runSyncNow?userId=<UID>
 */
exports.runSyncNow = onRequest(
  { region: REGION, timeoutSeconds: 540, memory: "1GiB", cors: true },
  async (req, res) => {
    const userId = String(req.query.userId || "").trim();
    const ADMIN_UID = "7Tojjo8l5PZIYctPmdwncf7PC133";
    if (!userId) return res.status(400).json({ error: "Missing userId query param." });
    if (userId !== ADMIN_UID) return res.status(403).json({ error: "Forbidden: Only the admin can trigger sync." });

    const startedAt = admin.firestore.Timestamp.now();
    const runId = String(startedAt.toMillis());
    const runRef = db.collection("users").doc(userId).collection("syncRuns").doc(runId);

    const now = admin.firestore.Timestamp.now();
    const recentCutoff = admin.firestore.Timestamp.fromDate(
      new Date(Date.now() - RECENT_WINDOW_MINUTES * 60 * 1000)
    );

    await runRef.set(
      {
        ok: true,
        userId,
        source: "runSyncNow",
        runType: "manual",
        status: "RUNNING",
        startedAt,
        ranAt: startedAt,
        recentCutoffIso: recentCutoff.toDate().toISOString(),
        
      },
      { merge: true }
    );

    try {
      const summary = await syncUserRecentJobs({ userId, now, recentCutoff });

      const finishedAt = admin.firestore.Timestamp.now();
      const durationMs = finishedAt.toMillis() - startedAt.toMillis();

      const response = {
        ok: true,
        userId,
        dryRun: false,
        scanned: summary.jobsFetched,
        updated: summary.jobsWritten,
        

        // ✅ NEW
        feedsCount: summary.feedsCount,

        ranAt: startedAt,
        recentCutoffIso: recentCutoff.toDate().toISOString(),
        finishedAt,
        durationMs,
        ...summary,
      };

      await runRef.set(
        {
          status: "DONE",
          finishedAt,
          durationMs,

          ok: true,
          scanned: summary.jobsFetched,
          updated: summary.jobsWritten,
          jobsWritten: summary.jobsWritten,

          // ✅ NEW
          feedsCount: summary.feedsCount,

          feedsProcessed: summary.feedsProcessed,
          failedFeeds: summary.failedFeeds,
          jobsFetched: summary.jobsFetched,
          jobsKeptRecent: summary.jobsKeptRecent,
        },
        { merge: true }
      );

      // Send Push Notification
      await sendPushNotification(userId, summary, durationMs);

      return res.json(response);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("runSyncNow failed:", e);

      const finishedAt = admin.firestore.Timestamp.now();
      const durationMs = finishedAt.toMillis() - startedAt.toMillis();

      await runRef.set(
        {
          ok: false,
          status: "FAILED",
          error: msg,
          finishedAt,
          durationMs,

          // ✅ NEW
          feedsCount: 0,
        },
        { merge: true }
      );

      return res.status(500).json({ error: msg });
    }
  }
);

/**
 * ----------------------------
 * USER SYNC CORE
 * ----------------------------
 */
async function syncUserRecentJobs({ userId, now, recentCutoff }) {
  const feedsSnap = await db
    .collection("users")
    .doc(userId)
    .collection("feeds")
    .where("archivedAt", "==", null)
    .get();

  const feeds = feedsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const feedsCount = feeds.length;

  if (feedsCount === 0) {
    return {
      ok: true,
      feedsCount,
      feedsProcessed: 0,
      failedFeeds: 0,
      jobsFetched: 0,
      jobsKeptRecent: 0,
      jobsWritten: 0,
    };
  }

  const limiter = pLimit(FEED_CONCURRENCY);
  const bw = db.bulkWriter();

  bw.onWriteError((err) => {
    logger.error("BulkWriter error:", err);
    return false;
  });

  let feedsProcessed = 0;
  let failedFeeds = 0;

  let jobsFetched = 0;
  let jobsKeptRecent = 0;
  let jobsWritten = 0;

  // Scoring metadata — collected during sync, consumed after bw.close()
  const newJobsForScoring = [];

  const tasks = feeds.map((feed) =>
    limiter(async () => {
      const feedId = feed.id;
      const feedRef = db.collection("users").doc(userId).collection("feeds").doc(feedId);

      try {
        const url = String(feed.url || "").trim();
        if (!url) throw new Error("Feed missing url");

        const source = String(feed.source || "").toLowerCase();
        const companyName = String(feed.companyName || feed.company || "Unknown");

        feedsProcessed += 1;

        // Upsert companies doc (for UI filter)
        const companyRef = db.collection("users").doc(userId).collection("companies").doc(feedId);
        bw.set(
          companyRef,
          {
            companyName,
            source,
            isActive: true,
            lastSeenAt: now,
            lastJobSyncAt: now,
          },
          { merge: true }
        );

        const recentCutoffMs = recentCutoff ? recentCutoff.toMillis() : null;
        const rawJobs = await fetchJobsFromFeed(url, source, recentCutoffMs);
        jobsFetched += rawJobs.length;

        const normalized = rawJobs
          .map((j) => normalizeJobMinimal(j, { source, companyName, companyKey: feedId, now, url }))
          .filter(Boolean);

        const locationFiltered = normalized.filter(jobMatchesLocationFilter);

        const recentOnly = locationFiltered.filter(
          (j) => j.sourceUpdatedTs && j.sourceUpdatedTs.toMillis() >= recentCutoff.toMillis()
        );

        jobsKeptRecent += recentOnly.length;

        for (const job of recentOnly) {
          const jobRef = db.collection("users").doc(userId).collection("jobs").doc(job.jobDocId);

          const baseTs = job.sourceUpdatedTs || now;
          const expireAt = addDaysTs(baseTs, TTL_DAYS);

          // Strip descriptionHint — scoring only, never written to Firestore
          const { descriptionHint, ...jobForFirestore } = job;

          bw.set(
            jobRef,
            {
              ...jobForFirestore,
              fetchedAt: now,
              expireAt,
            },
            { merge: true }
          );

          jobsWritten += 1;

          // Collect for post-sync scoring
          newJobsForScoring.push({
            jobDocId: job.jobDocId,
            source: job.source,
            externalId: job.externalId,
            feedUrl: url || feedConfig.url,
            descriptionHint: descriptionHint || null,
          });
        }

        await feedRef.set(
          {
            lastCheckedAt: now,
            lastError: null,
            lastJobCount: recentOnly.length,
          },
          { merge: true }
        );
      } catch (e) {
        failedFeeds += 1;
        const msg = e instanceof Error ? e.message : String(e);
        logger.error(`Feed failed userId=${userId} feedId=${feed.id}: ${msg}`);

        await feedRef.set(
          {
            lastCheckedAt: now,
            lastError: msg,
          },
          { merge: true }
        );
      }
    })
  );

  await Promise.all(tasks);
  await bw.close();

  // Fire-and-forget scoring — does NOT block sync return or timing
  if (newJobsForScoring.length > 0) {
    scoreNewJobsForUser(userId, newJobsForScoring).catch((err) =>
      logger.error(`scoreNewJobsForUser failed userId=${userId}: ${err?.message || err}`)
    );
  }

  return {
    ok: true,
    feedsCount,
    feedsProcessed,
    failedFeeds,
    jobsFetched,
    jobsKeptRecent,
    jobsWritten,
  };
}

/**
 * ----------------------------
 * LIST USERS TO PROCESS
 * ----------------------------
 */
async function listUserIdsToProcess() {
  return ["7Tojjo8l5PZIYctPmdwncf7PC133"];
}

/**
 * ----------------------------
 * FETCHING
 * ----------------------------
 */
async function fetchJobsFromFeed(url, source, recentCutoffMs) {
  if (
    source.includes("eightfold") ||
    source.includes("microsoft") ||
    source.includes("paypal") ||
    source.includes("netflix")
  ) {
    return await fetchEightfoldJobsPaginated(url, recentCutoffMs);
  }

  const json = await fetchJson(url);

  if (source.includes("greenhouse")) {
    return Array.isArray(json?.jobs) ? json.jobs : [];
  }

  if (source.includes("ashby")) {
    if (Array.isArray(json)) return json;
    if (Array.isArray(json?.jobs)) return json.jobs;
    if (Array.isArray(json?.results)) return json.results;
    if (Array.isArray(json?.data?.jobs)) return json.data.jobs;
    if (Array.isArray(json?.postings)) return json.postings;
    return [];
  }

  if (Array.isArray(json?.jobs)) return json.jobs;
  if (Array.isArray(json)) return json;
  return [];
}

/**
 * Paginated fetcher for Eightfold-based APIs (including Microsoft, PayPal, etc.).
 * Uses offset-based pagination (start=0, 10, 20, ...).
 * Stops early when jobs are older than recentCutoff to avoid unnecessary requests.
 */
async function fetchEightfoldJobsPaginated(baseUrl, recentCutoffMs) {
  const PAGE_SIZE = 10;
  const MAX_JOBS = 5000;
  const allPositions = [];

  // Parse URL and ensure start param can be manipulated
  const urlObj = new URL(baseUrl);
  let offset = parseInt(urlObj.searchParams.get("start") || "0", 10);

  while (allPositions.length < MAX_JOBS) {
    urlObj.searchParams.set("start", String(offset));
    const json = await fetchJson(urlObj.toString());

    const positions = json?.positions || json?.data?.positions;
    if (!Array.isArray(positions) || positions.length === 0) break;

    allPositions.push(...positions);

    // Smart stop: if the oldest job on this page is older than our cutoff, stop
    if (recentCutoffMs) {
      const oldestOnPage = positions[positions.length - 1];
      const oldestEpoch = oldestOnPage?.t_update || oldestOnPage?.postedTs || 0;
      const oldestTs = oldestEpoch * 1000; // epoch seconds → ms
      if (oldestTs > 0 && oldestTs < recentCutoffMs) {
        logger.info(`Eightfold pagination: stopping at offset=${offset}, oldest job on page is past cutoff`);
        break;
      }
    }

    // If we got fewer than PAGE_SIZE, we've reached the end
    if (positions.length < PAGE_SIZE) break;

    const totalCount = json?.count ?? json?.data?.count ?? Infinity;
    offset += PAGE_SIZE;
    if (offset >= totalCount) break;
  }

  logger.info(`Eightfold pagination: fetched ${allPositions.length} total positions`);
  return allPositions;
}

async function fetchJson(url) {
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json,text/plain,*/*",
      "user-agent": "firebase-functions-job-sync/6.0",
    },
  });

  if (!resp.ok) {
    const body = await safeReadText(resp);
    throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}. Body: ${(body || "").slice(0, 400)}`);
  }

  return await resp.json();
}

async function safeReadText(resp) {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

/**
 * ----------------------------
 * NORMALIZATION (MINIMAL)
 * - NO contentHtml, NO isRemote, NO applyUrl
 * ----------------------------
 */
function normalizeJobMinimal(rawJob, ctx) {
  const { source, companyName, companyKey, now, url } = ctx;
  if (!rawJob || typeof rawJob !== "object") return null;

  if (source.includes("greenhouse")) {
    const externalId =
      rawJob.id != null ? String(rawJob.id)
        : (rawJob.internal_job_id != null ? String(rawJob.internal_job_id) : null);

    const jobUrl = rawJob.absolute_url ? String(rawJob.absolute_url) : null;
    if (!externalId && !jobUrl) return null;

    const title = rawJob.title ? String(rawJob.title) : null;
    const locationName = rawJob?.location?.name ? String(rawJob.location.name) : null;

    const sourceUpdatedIso = rawJob.updated_at ? String(rawJob.updated_at) : null;
    const sourceUpdatedTs = toTimestampOrNull(sourceUpdatedIso) || now;

    const locationTokens = extractLocationTokens(locationName || "");
    const stateCodes = extractStateCodes(locationTokens);

    const meta = simplifyMetadataArray(rawJob.metadata);

    const jobDocId = makeJobDocId({
      source: "greenhouse",
      companyKey,
      externalId: externalId || jobUrl,
    });

    return {
      jobDocId,
      source: "greenhouse",
      companyKey,
      companyName,
      externalId,
      title,
      jobUrl,
      locationName,
      locationTokens,
      stateCodes,
      sourceUpdatedTs,
      sourceUpdatedIso,
      meta,
    };
  }

  if (source.includes("ashby")) {
    const externalId =
      rawJob.id != null ? String(rawJob.id)
        : (rawJob.jobId != null ? String(rawJob.jobId) : null);

    const jobUrl = rawJob.jobUrl ? String(rawJob.jobUrl) : (rawJob.url ? String(rawJob.url) : null);
    if (!externalId && !jobUrl) return null;

    const title = rawJob.title ? String(rawJob.title) : null;

    const primaryLoc = rawJob.location ? String(rawJob.location) : null;
    const secondary = Array.isArray(rawJob.secondaryLocations)
      ? rawJob.secondaryLocations.filter(Boolean).map(String)
      : [];
    const combinedLocation = [primaryLoc, ...secondary].filter(Boolean).join("; ");

    const sourceUpdatedIso = rawJob.publishedAt ? String(rawJob.publishedAt) : null;
    const sourceUpdatedTs = toTimestampOrNull(sourceUpdatedIso) || now;

    const locationTokens = extractLocationTokens(combinedLocation || "");
    const stateCodes = extractStateCodes(locationTokens);

    const meta = {};
    if (rawJob.employmentType != null) meta["Employment Type"] = rawJob.employmentType;
    if (rawJob.department != null) meta["Department"] = rawJob.department;
    if (rawJob.team != null) meta["Team"] = rawJob.team;

    // Ashby listings include the full JD in the feed response — capture for scoring (not stored in Firestore)
    const descriptionHint = rawJob.descriptionPlain
      ? String(rawJob.descriptionPlain).slice(0, 4000)
      : null;

    const jobDocId = makeJobDocId({
      source: "ashbyhq",
      companyKey,
      externalId: externalId || jobUrl,
    });

    return {
      jobDocId,
      source: "ashbyhq",
      companyKey,
      companyName,
      externalId,
      title,
      jobUrl,
      locationName: combinedLocation || primaryLoc || null,
      locationTokens,
      stateCodes,
      sourceUpdatedTs,
      sourceUpdatedIso,
      meta,
      descriptionHint, // scoring only, stripped before Firestore write
    };
  }

  if (
    source.includes("eightfold") ||
    source.includes("microsoft") ||
    source.includes("paypal") ||
    source.includes("netflix")
  ) {
    const externalId = rawJob.id != null ? String(rawJob.id)
      : (rawJob.displayJobId != null ? String(rawJob.displayJobId) : null);

    let domain = "careers.microsoft.com";
    try {
      if (url) {
        const urlObj = new URL(url);
        domain = urlObj.hostname;
      }
    } catch (e) {
      // fallback
    }

    const jobUrl = rawJob.canonicalPositionUrl || (rawJob.positionUrl
      ? `https://${domain}${rawJob.positionUrl}`
      : null);
    if (!externalId && !jobUrl) return null;

    const title = rawJob.name ? String(rawJob.name) : null;

    // Combine locations array into a single string
    const locationsArr = Array.isArray(rawJob.locations) ? rawJob.locations : [];
    const standardizedArr = Array.isArray(rawJob.standardizedLocations) ? rawJob.standardizedLocations : [];
    const locationName = locationsArr.join("; ") || null;

    // postedTs / t_update is epoch seconds
    const updatedEpoch = rawJob.t_update || rawJob.postedTs || 0;
    const sourceUpdatedTs = updatedEpoch
      ? admin.firestore.Timestamp.fromDate(new Date(updatedEpoch * 1000))
      : now;
    const sourceUpdatedIso = updatedEpoch
      ? new Date(updatedEpoch * 1000).toISOString()
      : null;

    // Use standardized locations as tokens (contains city, state abbrev, country)
    const allLocTokens = [...locationsArr, ...standardizedArr];
    const locationTokens = extractLocationTokens(allLocTokens.join("; "));
    const stateCodes = extractStateCodes(locationTokens);

    const meta = {};
    if (rawJob.department) meta["Department"] = rawJob.department;
    if (rawJob.workLocationOption) meta["Work Location"] = rawJob.workLocationOption;
    if (rawJob.displayJobId) meta["Job ID"] = rawJob.displayJobId;

    const sourceName = "eightfold";
    const jobDocId = makeJobDocId({
      source: sourceName,
      companyKey,
      externalId: externalId || jobUrl,
    });

    return {
      jobDocId,
      source: sourceName,
      companyKey,
      companyName,
      externalId,
      title,
      jobUrl,
      locationName,
      locationTokens,
      stateCodes,
      sourceUpdatedTs,
      sourceUpdatedIso,
      meta,
    };
  }

  return null;
}

function simplifyMetadataArray(metadata) {
  if (!Array.isArray(metadata)) return {};
  const out = {};
  for (const m of metadata) {
    if (!m || typeof m !== "object") continue;
    const name = m.name != null ? String(m.name) : null;
    if (!name) continue;
    out[name] = m.value ?? null;
  }
  return out;
}

/**
 * ----------------------------
 * LOCATION FILTERING
 * ----------------------------
 */
function normalizeText(s) {
  return String(s)
    .toLowerCase()
    .replace(/[().]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLocationTokens(locationString) {
  const raw = String(locationString || "").trim();
  if (!raw) return [];
  const pieces = raw
    .split(LOCATION_SPLIT_REGEX)
    .map((p) => p.trim())
    .filter(Boolean);

  const tokens = new Set([raw, ...pieces]);
  return Array.from(tokens);
}

function extractStateCodes(tokens) {
  const found = new Set();
  for (const t of tokens || []) {
    const upper = String(t).toUpperCase();
    const matches = upper.match(/\b[A-Z]{2}\b/g) || [];
    for (const code of matches) {
      if (NORM.abbr.has(code)) found.add(code);
    }
  }
  return Array.from(found);
}

function jobMatchesLocationFilter(job) {
  const tokens = Array.isArray(job.locationTokens) ? job.locationTokens : [];
  if (tokens.length === 0) return false;
  for (const t of tokens) {
    if (locationTokenMatches(t)) return true;
  }
  return false;
}

function locationTokenMatches(token) {
  const raw = String(token || "");
  if (!raw) return false;
  const n = normalizeText(raw);

  if (NORM.remote.has(n)) return true;

  for (const city of NORM.cities) {
    if (n.includes(city)) return true;
  }

  for (const st of NORM.states) {
    if (n.includes(st)) return true;
  }

  const abbrMatches = raw.toUpperCase().match(/\b[A-Z]{2}\b/g) || [];
  for (const abbr of abbrMatches) {
    if (NORM.abbr.has(abbr)) return true;
  }

  return false;
}

/**
 * ----------------------------
 * TIME + IDS + TTL
 * ----------------------------
 */
function toTimestampOrNull(isoOrDateString) {
  if (!isoOrDateString) return null;
  try {
    const d = new Date(isoOrDateString);
    if (Number.isNaN(d.getTime())) return null;
    return admin.firestore.Timestamp.fromDate(d);
  } catch {
    return null;
  }
}

function addDaysTs(ts, days) {
  const d = ts.toDate ? ts.toDate() : new Date();
  return admin.firestore.Timestamp.fromDate(new Date(d.getTime() + days * 24 * 60 * 60 * 1000));
}

function makeJobDocId({ source, companyKey, externalId }) {
  const base = `${String(source)}|${String(companyKey)}|${String(externalId)}`;
  return sanitizeId(base);
}

function sanitizeId(s) {
  const clean = s
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^\w|.-]+/g, "_")
    .replace(/\|+/g, "|")
    .slice(0, 150);

  const checksum = simpleChecksum(s);
  return `${clean}_${checksum}`;
}

function simpleChecksum(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

/**
 * =====================================================================================
 * 🤖 AI JOB RELEVANCE SCORING
 * =====================================================================================
 *
 * After each sync, scores newly written jobs against the user's saved resume profile.
 * Only { relevanceScore, scoreReason, scoredAt } is written back — JD is never persisted.
 */

/**
 * Strip HTML tags from a string cleanly.
 */
function stripHtml(html) {
  if (!html) return "";
  return String(html)
    .replace(/<\/?(p|li|h[1-6]|br|div|ul|ol)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&#43;/g, "+").replace(/&[a-z]+;/gi, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, 4000);
}

/**
 * Fetch a job description from the ATS-specific endpoint.
 * Returns plain text or null on failure.
 */
async function fetchJobDescription(source, externalId, feedUrl, descriptionHint) {
  try {
    // Ashby: description already captured from feed listing
    if (source === "ashbyhq" && descriptionHint) {
      return descriptionHint.slice(0, 4000);
    }

    if (source === "greenhouse") {
      // Try API feed URL: https://boards-api.greenhouse.io/v1/boards/{slug}/jobs
      let slug = null;
      const apiMatch = feedUrl.match(/boards-api\.greenhouse\.io\/v1\/boards\/([^/?#]+)/i);
      if (apiMatch) slug = apiMatch[1];

      // Fallback: jobUrl format: https://boards.greenhouse.io/{slug}/jobs/{id}
      if (!slug) {
        const jobMatch = feedUrl.match(/boards\.greenhouse\.io\/([^/?#]+)\/jobs/i);
        if (jobMatch) slug = jobMatch[1];
      }

      if (!slug || !externalId) return null;
      
      // Greenhouse IDs in normalized feed look like "7743800_5ca2b88". API only accepts "7743800"
      const realId = String(externalId).split("_")[0];

      const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${realId}`;
      const json = await fetchJson(url);
      const raw = json?.content || json?.description || "";
      return stripHtml(raw);
    }

    if (source === "eightfold") {
      // Netflix: uses its own endpoint (not the Eightfold /api/pcsx endpoint)
      if (feedUrl.includes("netflix") || (externalId && String(externalId).length < 20)) {
        // heuristic: Netflix externalIds are short numeric, Eightfold ones are very long
        // try Netflix endpoint first if URL hints at it
        if (feedUrl.includes("netflix")) {
          if (!externalId) return null;
          const url = `https://explore.jobs.netflix.net/api/apply/v2/jobs/${externalId}?domain=netflix.com`;
          const json = await fetchJson(url);
          const raw = json?.job_description || "";
          if (raw) return stripHtml(raw);
        }
      }

      // Other Eightfold companies (NVIDIA, Microsoft, PayPal, etc.)
      let apiBase = "";
      let domain = "";
      try {
        const u = new URL(feedUrl);
        apiBase = `${u.protocol}//${u.hostname}`;
        const subdomain = u.hostname.split(".")[0];
        domain = `${subdomain}.com`;
        if (u.hostname.includes("microsoft")) domain = "microsoft.com";
        if (u.hostname.includes("nvidia")) domain = "nvidia.com";
        if (u.hostname.includes("paypal")) domain = "paypal.com";
        // For Netflix canonical job URLs, repoint to Netflix API
        if (u.hostname.includes("netflix")) {
          const url = `https://explore.jobs.netflix.net/api/apply/v2/jobs/${externalId}?domain=netflix.com`;
          const json = await fetchJson(url);
          const raw = json?.job_description || "";
          return stripHtml(raw);
        }
      } catch (_) { return null; }
      if (!externalId || !apiBase) return null;
      const url = `${apiBase}/api/pcsx/position_details?position_id=${externalId}&domain=${domain}&hl=en`;
      const json = await fetchJson(url);
      const raw = json?.data?.jobDescription || "";
      return stripHtml(raw);
    }

    return null;
  } catch (err) {
    logger.warn(`fetchJobDescription failed source=${source} externalId=${externalId}: ${err?.message}`);
    return null;
  }
}

/**
 * Score a single job against a resume using Claude.
 * Returns { score: number, reason: string } or null.
 */
async function scoreJobWithClaude(jobTitle, jobDescription, resumeText) {
  const prompt = `You are a recruiting expert. Given a candidate's resume profile and a job description, score how relevant this job is for the candidate.

Return ONLY a JSON object with:
- "score": integer 0-100 (0=completely irrelevant, 100=perfect match)
- "reason": one sentence (max 15 words) explaining the score

Example: {"score": 82, "reason": "Strong React and TypeScript skills match this frontend engineering role."}

## Candidate Resume Profile
${resumeText}

## Job Title
${jobTitle}

## Job Description
${jobDescription}

Respond with ONLY the JSON object, no other text.`;

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 120,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = msg.content?.[0]?.text?.trim() || "";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  const parsed = JSON.parse(jsonMatch[0]);
  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score))));
  if (Number.isNaN(score)) return null;
  return { score, reason: String(parsed.reason || "").slice(0, 120) };
}

/**
 * Main scoring orchestrator — runs after every sync, fire-and-forget.
 * Fetches JDs, scores with Claude, writes score back to job doc.
 * Never stores the JD itself.
 */
async function scoreNewJobsForUser(userId, newJobs) {
  if (!newJobs || newJobs.length === 0) return;

  // Load user's saved resume profile
  let resumeProfile = null;
  try {
    const resumeSnap = await db.collection("users").doc(userId).collection("resume").doc("profile").get();
    if (!resumeSnap.exists) {
      logger.info(`scoreNewJobsForUser: no resume for userId=${userId}, skipping`);
      return;
    }
    resumeProfile = resumeSnap.data();
  } catch (err) {
    logger.warn(`scoreNewJobsForUser: failed to load resume for userId=${userId}: ${err?.message}`);
    return;
  }

  // Build a compact resume text for the prompt
  const resumeText = [
    resumeProfile.summary ? `Summary: ${resumeProfile.summary}` : "",
    resumeProfile.skills?.length ? `Skills: ${resumeProfile.skills.slice(0, 40).join(", ")}` : "",
    resumeProfile.roles?.length
      ? `Experience:\n${resumeProfile.roles.slice(0, 4).map((r) => `  - ${r.title} at ${r.company}: ${(r.description || "").slice(0, 200)}`).join("\n")}`
      : "",
    resumeProfile.education?.length
      ? `Education: ${resumeProfile.education.map((e) => `${e.degree} at ${e.institution}`).join("; ")}`
      : "",
    resumeProfile.projects?.length
      ? `Projects: ${resumeProfile.projects.slice(0, 3).map((p) => `${p.name} (${p.techStack})`).join("; ")}`
      : "",
  ].filter(Boolean).join("\n").slice(0, 2500);

  if (!resumeText) {
    logger.info(`scoreNewJobsForUser: resume has no content for userId=${userId}, skipping`);
    return;
  }

  const scoringLimiter = pLimit(3); // gentle on Claude & ATS APIs
  const scoredAt = admin.firestore.Timestamp.now();

  const scoringTasks = newJobs.map((job) =>
    scoringLimiter(async () => {
      try {
        // 1. Fetch JD
        let description = await fetchJobDescription(job.source, job.externalId, job.feedUrl, job.descriptionHint);
        if (!description || description.length < 50) {
          logger.info(`scoreNewJobsForUser: empty JD for ${job.jobDocId}, skipping`);
          return;
        }

        // Truncate to keep Claude tokens low
        description = description.slice(0, 3500);

        // Read job title from Firestore so we have full context
        const jobSnap = await db.collection("users").doc(userId).collection("jobs").doc(job.jobDocId).get();
        const jobTitle = jobSnap.exists ? (jobSnap.data()?.title || "") : "";

        // 2. Score with Claude
        const result = await scoreJobWithClaude(jobTitle, description, resumeText);
        if (!result) {
          logger.warn(`scoreNewJobsForUser: Claude returned no score for ${job.jobDocId}`);
          return;
        }

        // 3. Write ONLY score + reason (no JD) back to job doc
        await db.collection("users").doc(userId).collection("jobs").doc(job.jobDocId).set(
          { relevanceScore: result.score, scoreReason: result.reason, scoredAt },
          { merge: true }
        );

        logger.info(`Scored ${job.jobDocId}: ${result.score}/100 — ${result.reason}`);
      } catch (err) {
        logger.warn(`scoreNewJobsForUser: error scoring ${job.jobDocId}: ${err?.message}`);
      }
    })
  );

  await Promise.all(scoringTasks);
  logger.info(`scoreNewJobsForUser: finished scoring ${newJobs.length} jobs for userId=${userId}`);
}

/**
 * ----------------------------
 * PUSH NOTIFICATIONS
 * ----------------------------
 */
async function sendPushNotification(userId, summary, durationMs) {
  try {
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) return;

    const data = userDoc.data();
    const tokens = data.fcmTokens || [];
    if (!Array.isArray(tokens) || tokens.length === 0) return;

    const added = summary.jobsWritten || 0;
    const durationSec = (durationMs / 1000).toFixed(1);

    const payload = {
      notification: {
        title: "Job Sync Complete",
        body: `Added ${added} new jobs in ${durationSec}s.`,
      },
      data: {
        click_action: "https://jobwatch.akashramasani.com/jobs",
      },
      tokens: tokens,
    };

    const response = await admin.messaging().sendEachForMulticast(payload);
    
    // Cleanup invalid tokens
    const failedTokens = [];
    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        if (resp.error?.code === 'messaging/invalid-registration-token' ||
            resp.error?.code === 'messaging/registration-token-not-registered') {
          failedTokens.push(tokens[idx]);
        }
      }
    });

    if (failedTokens.length > 0) {
      await db.collection("users").doc(userId).update({
        fcmTokens: admin.firestore.FieldValue.arrayRemove(...failedTokens)
      });
      logger.info(`Removed ${failedTokens.length} dead FCM tokens for user ${userId}`);
    }

  } catch (err) {
    logger.error(`Error sending push notification to user ${userId}:`, err);
  }
}



/**
 * =====================================================================================
 * 🤖 AI ASSISTANT: Chat with your job data
 * =====================================================================================
 *
 * Trigger:
 * https://us-central1-<PROJECT_ID>.cloudfunctions.net/askAssistant
 */
exports.askAssistant = onRequest(
  { region: REGION, timeoutSeconds: 300, memory: "1GiB", cors: true },
  async (req, res) => {
    try {
      const { messages, userId } = req.body;
      const ADMIN_UID = "7Tojjo8l5PZIYctPmdwncf7PC133";
      
      const activeUserId = userId || ADMIN_UID; // Default to admin for now if missing
      
      if (!Array.isArray(messages)) {
        return res.status(400).json({ error: "Messages array is required." });
      }

      const tools = [
        {
          name: "list_feeds",
          description: "List all active job feeds/companies for the user.",
          input_schema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "get_recent_jobs",
          description: "Fetch the most recent job listings across all sources.",
          input_schema: {
            type: "object",
            properties: {
              limit: { type: "number", description: "Number of jobs to fetch (default: 10)" },
            },
          },
        },
        {
          name: "search_jobs",
          description: "Search for jobs by title or company name in the recent results.",
          input_schema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query (title or company)" },
              limit: { type: "number", description: "Number of results (default: 5)" },
            },
            required: ["query"],
          },
        },
        {
          name: "get_sync_status",
          description: "Check the status of the latest job sync runs.",
          input_schema: {
            type: "object",
            properties: {
              limit: { type: "number", description: "Number of latest runs (default: 3)" },
            },
          },
        },
      ];

      let currentMessages = [...messages];
      let finalResponse = null;

      // Tool handling loop
      while (true) {
        const response = await anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 1024,
          tools: tools,
          messages: currentMessages,
          system: `You are the JobWatch AI Assistant. You help users manage their job tracking, sync data, and analyze market trends.
          You have access to the user's specific job listings, feeds, and sync history via tools.
          Always be concise, professional, and helpful. 
          IMPORTANT: All timestamps and dates in your responses must be in Pacific Time (PT). 
          Current User ID: ${activeUserId}`,
        });

        if (response.stop_reason !== "tool_use") {
          finalResponse = response;
          break;
        }

        // Handle tool calls
        const toolResults = [];
        for (const block of response.content) {
          if (block.type === "tool_use") {
            const toolName = block.name;
            const args = block.input;
            const toolId = block.id;

            let resultData;
            try {
              switch (toolName) {
                case "list_feeds": {
                  const snap = await db.collection("users").doc(activeUserId).collection("feeds").where("archivedAt", "==", null).get();
                  resultData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                  break;
                }
                case "get_recent_jobs": {
                  const limit = args.limit || 10;
                  const snap = await db.collection("users").doc(activeUserId).collection("jobs").orderBy("sourceUpdatedTs", "desc").limit(limit).get();
                  resultData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                  break;
                }
                case "search_jobs": {
                  const query = args.query.toLowerCase();
                  const limit = args.limit || 5;
                  const snap = await db.collection("users").doc(activeUserId).collection("jobs").orderBy("sourceUpdatedTs", "desc").limit(50).get();
                  resultData = snap.docs
                    .map(d => ({ id: d.id, ...d.data() }))
                    .filter(j => (j.title && j.title.toLowerCase().includes(query)) || (j.companyName && j.companyName.toLowerCase().includes(query)))
                    .slice(0, limit);
                  break;
                }
                case "get_sync_status": {
                  const limit = args.limit || 3;
                  const snap = await db.collection("users").doc(activeUserId).collection("syncRuns").orderBy("startedAt", "desc").limit(limit).get();
                  resultData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                  break;
                }
                default:
                  resultData = { error: "Unknown tool" };
              }
            } catch (err) {
              resultData = { error: err.message };
            }

            toolResults.push({
              type: "tool_result",
              tool_use_id: toolId,
              content: JSON.stringify(resultData),
            });
          }
        }

        // Add assistant's response and tool results to history
        currentMessages.push({ role: "assistant", content: response.content });
        currentMessages.push({ role: "user", content: toolResults });
      }

      return res.json({
        ok: true,
        response: {
          role: "assistant",
          content: finalResponse.content[0].text,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("askAssistant failed:", e);
      return res.status(500).json({ error: msg });
    }
  }
);

/**
 * =====================================================================================
 * 📄 RESUME PARSER: Upload a PDF/DOCX/TXT file and extract structured JSON via Claude
 * =====================================================================================
 *
 * POST multipart/form-data with fields:
 *   - resume  (file): The resume file (PDF, DOCX, or TXT, max 10 MB)
 *   - userId  (string): The authenticated user's UID
 *
 * Returns: { ok: true, parsed: { summary, skills, roles, education, projects, certifications, rawText } }
 */
exports.parseResume = onRequest(
  { region: REGION, timeoutSeconds: 120, memory: "512MiB", cors: true },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed. Use POST." });
    }

    try {
      // ─── 1. Parse multipart form data with Busboy ───────────────────────
      const { fileBuffer, mimeType, originalName, userId } = await new Promise((resolve, reject) => {
        const bb = Busboy({
          headers: req.headers,
          limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB hard limit
        });

        let fileBuffer = null;
        let mimeType = "";
        let originalName = "";
        let userId = "";
        let fileTooLarge = false;

        bb.on("field", (name, value) => {
          if (name === "userId") userId = value;
        });

        bb.on("file", (fieldname, stream, info) => {
          mimeType = info.mimeType || "";
          originalName = info.filename || "";
          const chunks = [];

          stream.on("data", (chunk) => chunks.push(chunk));

          stream.on("limit", () => {
            fileTooLarge = true;
            stream.resume(); // drain to avoid hanging
          });

          stream.on("end", () => {
            if (!fileTooLarge) {
              fileBuffer = Buffer.concat(chunks);
            }
          });
        });

        bb.on("finish", () => {
          if (fileTooLarge) {
            return reject(new Error("File exceeds the 10 MB limit."));
          }
          if (!fileBuffer) {
            return reject(new Error("No file received. Please attach a resume field."));
          }
          resolve({ fileBuffer, mimeType, originalName, userId });
        });

        bb.on("error", (err) => reject(err));

        // Firebase Functions Gen2 consumes the request stream before the handler runs.
        // req.rawBody is a Buffer that Firebase preserves for exactly this use case.
        bb.end(req.rawBody);
      });

      // ─── 2. Validate user ───────────────────────────────────────────────
      if (!userId || typeof userId !== "string" || userId.trim() === "") {
        return res.status(400).json({ error: "Missing or invalid userId." });
      }

      // ─── 3. Detect file type and extract plain text ─────────────────────
      const ext = (originalName.split(".").pop() || "").toLowerCase();
      const isPdf = ext === "pdf" || mimeType === "application/pdf";
      const isDocx =
        ext === "docx" ||
        mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      const isTxt = ext === "txt" || mimeType === "text/plain";

      if (!isPdf && !isDocx && !isTxt) {
        return res
          .status(400)
          .json({ error: `Unsupported file type "${ext}". Please upload a PDF, DOCX, or TXT file.` });
      }

      let rawText = "";

      if (isPdf) {
        const result = await pdfParse(fileBuffer);
        rawText = result.text || "";
      } else if (isDocx) {
        const result = await mammoth.extractRawText({ buffer: fileBuffer });
        rawText = result.value || "";
      } else {
        rawText = fileBuffer.toString("utf-8");
      }

      rawText = rawText.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();

      if (!rawText || rawText.length < 20) {
        return res.status(422).json({ error: "Could not extract readable text from the file. Please try a different format." });
      }

      const truncatedText = rawText.slice(0, 12000); // keep Claude prompt manageable

      // ─── 4. Call Claude to extract structured JSON ──────────────────────
      const systemPrompt = `You are a professional resume parser. The user will provide the raw text of a resume.
Your job is to extract all relevant information and return it as a single, valid JSON object — NO markdown, NO explanation, ONLY the JSON object.

The JSON must follow this exact schema:
{
  "summary": "A concise 2-3 sentence professional summary synthesized from the resume",
  "skills": ["skill1", "skill2"],
  "roles": [
    {
      "title": "Job Title",
      "company": "Company Name",
      "startDate": "Month Year or Year",
      "endDate": "Month Year, Year, or Present",
      "description": "Bullet-point style description of responsibilities and achievements"
    }
  ],
  "education": [
    {
      "degree": "Degree Name and Major",
      "institution": "School Name",
      "startDate": "Year or Month Year",
      "endDate": "Year, Month Year, or Present",
      "description": "GPA, honors, relevant coursework, or other details if mentioned"
    }
  ],
  "projects": [
    {
      "name": "Project Name",
      "description": "What the project does and your role/contribution",
      "technologies": ["tech1", "tech2"]
    }
  ],
  "certifications": ["Certification Name (Issuer, Year if available)"]
}

Rules:
- If a section has no data, use an empty array [] or empty string "".
- Dates: preserve whatever format is in the resume; do not invent missing dates.
- Output ONLY the raw JSON object. No markdown fences, no explanation.`;

      const claudeRes = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: "user", content: `Resume text:\n\n${truncatedText}` }],
      });

      const rawOutput = claudeRes.content[0]?.text || "";

      // Strip any accidental markdown fences Claude might add
      const jsonStr = rawOutput.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();

      let parsed;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (parseErr) {
        logger.error("Claude returned non-JSON output:", rawOutput);
        return res.status(500).json({ error: "AI returned an unexpected response format. Please try again." });
      }

      // Attach truncated raw text (first 5000 chars) for Firestore storage
      parsed.rawText = rawText.slice(0, 5000);
      parsed.fileName = originalName;

      logger.info(`parseResume: userId=${userId}, file=${originalName}, skills=${(parsed.skills || []).length}, roles=${(parsed.roles || []).length}`);

      return res.json({ ok: true, parsed });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("parseResume failed:", e);
      return res.status(500).json({ error: msg });
    }
  }
);
