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
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");
const Busboy = require("busboy");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const { jsonrepair } = require("jsonrepair");

// p-limit CommonJS import fix
const pLimitPkg = require("p-limit");
const pLimit = pLimitPkg.default ?? pLimitPkg;

const Anthropic = require("@anthropic-ai/sdk");
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const anthropic = new Anthropic({ apiKey: CLAUDE_API_KEY });



if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const storageBucket = admin.storage().bucket("greenhouse-jobs-scrapper.firebasestorage.app");

/**
 * ----------------------------
 * CONFIG
 * ----------------------------
 */
const REGION = "us-central1";
const FEED_CONCURRENCY = 15;

const RECENT_WINDOW_MINUTES = 65;
const TTL_DAYS = 3;

/**
 * Allowed origins for CORS. Set ALLOWED_ORIGINS env var as comma-separated list
 * to override (e.g. your Vercel domain). Localhost is always included for dev.
 */
const CORS_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : [
    "https://greenhouse-jobs-scrapper.web.app",
    "https://greenhouse-jobs-scrapper.firebaseapp.com",
    "https://jobwatch.akashramasani.com",
    "https://greenhouse-jobs-scrapper.vercel.app",
    "http://localhost:5173",
    "http://localhost:4173",
  ];

/**
 * Verify a Firebase ID token from the Authorization header.
 * Throws with a 401-friendly error if missing or invalid.
 * Returns the decoded token (uid, email, etc.)
 *
 * NOTE: We do NOT use checkRevoked=true here. Firebase's revokeRefreshTokens
 * invalidates ALL tokens for a user — including the new session that just
 * called registerSession. That would block the new device's own API calls.
 * Instead, we enforce single-session at the application layer via the
 * X-Session-Token header (verifySessionToken), which is precise and safe.
 */
async function verifyToken(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    const err = new Error("Missing or invalid Authorization header.");
    err.statusCode = 401;
    throw err;
  }
  const idToken = authHeader.slice(7);
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);

    // Enforce single-session on API layer via custom session token header
    await verifySessionToken(req, decoded.uid);

    return decoded;
  } catch (e) {
    if (e.code === "SESSION_EJECTED") throw e;
    const err = new Error("Invalid or expired token. Please log in again.");
    err.statusCode = 401;
    throw err;
  }
}

const ONLY_USER_ID = process.env.ONLY_USER_ID || "";

/**
 * ----------------------------
 * EXTENSION AUTH FLOW
 * ----------------------------
 *
 * Enterprise pattern:
 *   1. Web app user (already logged in) hits /extension-auth page.
 *   2. Page calls createExtensionCode — server creates a 10-second one-time code
 *      stored in Firestore: extensionAuthCodes/{code} = { uid, expiresAt }.
 *   3. Page redirects to https://<ext-id>.chromiumapp.org/callback?code=<code>
 *   4. Extension background intercepts redirect, extracts code.
 *   5. Extension calls exchangeExtensionCode — server validates + deletes code,
 *      mints a Firebase Custom Token, returns it.
 *   6. Extension signs in with signInWithCustomToken → gets its own idToken + refreshToken.
 *
 * Security:
 *   - Codes expire in 10 seconds (server-enforced) and are single-use.
 *   - Extension never sees the user's password or web session cookie.
 *   - Custom tokens are short-lived (1 hour) and auto-refreshed.
 */

exports.createExtensionCode = onRequest(
  { region: REGION, cors: CORS_ORIGINS },
  async (req, res) => {
    try {
      const decoded = await verifyToken(req);
      const uid = decoded.uid;

      // Generate a cryptographically random 32-byte hex code
      const crypto = require("crypto");
      const code = crypto.randomBytes(32).toString("hex");

      // Store in Firestore — expires in 10 seconds
      await db.collection("extensionAuthCodes").doc(code).set({
        uid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: new Date(Date.now() + 10_000), // 10s TTL
      });

      res.json({ ok: true, code });
    } catch (err) {
      res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  }
);

exports.exchangeExtensionCode = onRequest(
  { region: REGION, cors: true }, // extension calls this — allow any origin
  async (req, res) => {
    try {
      const { code } = req.body;
      if (!code || typeof code !== "string") {
        return res.status(400).json({ ok: false, error: "Missing code." });
      }

      const ref = db.collection("extensionAuthCodes").doc(code);
      const snap = await ref.get();

      if (!snap.exists) {
        return res.status(401).json({ ok: false, error: "Invalid or expired code." });
      }

      const { uid, expiresAt } = snap.data();

      // Delete immediately — one-time use
      await ref.delete();

      // Validate expiry
      if (expiresAt.toDate() < new Date()) {
        return res.status(401).json({ ok: false, error: "Code expired." });
      }

      // Mint a Firebase Custom Token for the extension
      const customToken = await admin.auth().createCustomToken(uid, {
        source: "extension",
      });

      res.json({ ok: true, customToken });
    } catch (err) {
      logger.error("exchangeExtensionCode error:", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

/**
 * ----------------------------
 * SINGLE-SESSION ENFORCEMENT
 * ----------------------------
 *
 * Enterprise-grade "one login at a time" security.
 *
 * How it works:
 *   1. Client calls registerSession immediately after signInWithEmailAndPassword.
 *   2. Server generates a cryptographic session token, captures IP + user-agent,
 *      and writes { activeSession: { token, ip, ua, registeredAt } } to the user doc.
 *   3. Server revokes ALL existing Firebase refresh tokens for the user — this
 *      forces old sessions to fail on their next token refresh (~1h max).
 *   4. Client stores the token in sessionStorage and opens a Firestore onSnapshot
 *      listener on users/{uid}.
 *   5. If activeSession.token changes (because the user logged in on another device),
 *      every OTHER tab/device detects the mismatch and auto-signs out.
 *   6. The NEW login always wins — the latest registerSession call ejects all others.
 *
 * Security layers (defense in depth):
 *   Layer 1: Firestore realtime listener → sub-second client-side ejection
 *   Layer 2: Refresh token revocation → old sessions can't renew auth (within 1h)
 *   Layer 3: Session token header validation → API calls fail for stale sessions
 *   Layer 4: Heartbeat polling → catches network-delayed ejections
 *   Layer 5: Session audit log → full history in users/{uid}/sessionHistory
 */
exports.registerSession = onRequest(
  { region: REGION, cors: CORS_ORIGINS },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "POST only" });
    }

    try {
      const decoded = await verifyToken(req);
      const uid = decoded.uid;

      const crypto = require("crypto");
      const sessionToken = crypto.randomBytes(32).toString("hex");

      // Extract client IP — supports proxies (Cloudflare, Firebase Hosting, etc.)
      const ip =
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
        req.headers["x-real-ip"] ||
        req.connection?.remoteAddress ||
        "unknown";

      const userAgent = req.headers["user-agent"] || "";

      // ── Device type ──
      const isMobile    = /mobile|android|iphone|ipad|ipod/i.test(userAgent);
      const isTablet    = /ipad|tablet/i.test(userAgent) && !/mobile/i.test(userAgent);
      const isExtension = /chrome-extension|moz-extension/i.test(userAgent) ||
        decoded.source === "extension";

      let deviceType = "Desktop";
      if (isExtension)   deviceType = "Extension";
      else if (isTablet) deviceType = "Tablet";
      else if (isMobile) deviceType = "Mobile";

      // ── OS detection ──
      // Order matters — check specific versions before generic names
      let os = "Unknown OS";
      if (/windows nt 10\.0.*win64/i.test(userAgent))      os = "Windows 11"; // Win11 still reports NT 10
      else if (/windows nt 10/i.test(userAgent))            os = "Windows 10";
      else if (/windows nt 6\.3/i.test(userAgent))         os = "Windows 8.1";
      else if (/windows/i.test(userAgent))                  os = "Windows";
      else if (/iphone/i.test(userAgent))                   os = "iOS";
      else if (/ipad/i.test(userAgent))                     os = "iPadOS";
      else if (/mac os x|macintosh/i.test(userAgent))       os = "macOS";
      else if (/android/i.test(userAgent))                  os = "Android";
      else if (/cros/i.test(userAgent))                     os = "ChromeOS";
      else if (/linux/i.test(userAgent))                    os = "Linux";

      // ── Browser detection ──
      // Order matters — Edge and Opera contain "Chrome" in their UA strings
      let browser = "Unknown Browser";
      if (/edg\//i.test(userAgent))                                          browser = "Edge";
      else if (/opr\/|opera/i.test(userAgent))                               browser = "Opera";
      else if (/chrome\/[\d.]+/i.test(userAgent) && !/chromium/i.test(userAgent)) browser = "Chrome";
      else if (/chromium\/[\d.]+/i.test(userAgent))                         browser = "Chromium";
      else if (/firefox\/[\d.]+/i.test(userAgent))                          browser = "Firefox";
      else if (/safari\/[\d.]+/i.test(userAgent))                           browser = "Safari";
      else if (/msie|trident/i.test(userAgent))                             browser = "Internet Explorer";

      // ── LAYER 2: Revoke all existing Firebase refresh tokens ──
      // This forces every other device to fail on its next token refresh
      // (Firebase tokens last ~1h, so worst case the old session dies in 1h).
      // Combined with the Firestore realtime listener (Layer 1), ejection is
      // near-instant in practice.
      try {
        await admin.auth().revokeRefreshTokens(uid);
        logger.info(`registerSession: revoked refresh tokens for uid=${uid}`);
      } catch (revokeErr) {
        // Non-fatal — Layer 1 (Firestore listener) still handles immediate ejection
        logger.warn(`registerSession: revokeRefreshTokens failed: ${revokeErr.message}`);
      }

      const sessionData = {
        token: sessionToken,
        ip,
        userAgent: userAgent.slice(0, 300),
        browser,
        os,
        deviceType,
        registeredAt: admin.firestore.FieldValue.serverTimestamp(),
        version: Date.now(),
      };

      // ── Write new session to Firestore FIRST ──
      const userRef = db.collection("users").doc(uid);
      await userRef.set({ activeSession: sessionData }, { merge: true });

      // ── LAYER 5: Audit log ──
      const deviceInfo = { browser, os, deviceType };
      const historyRef = userRef.collection("sessionHistory").doc();
      await historyRef.set({
        action: "login",
        sessionToken: sessionToken.slice(0, 8) + "…",
        ip,
        deviceInfo,            // nested — read by Profile.jsx
        browser,               // top-level for backwards compat
        os,
        deviceType,
        userAgent: userAgent.slice(0, 200),
        loginAt:   admin.firestore.FieldValue.serverTimestamp(),
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

      logger.info(`registerSession: uid=${uid} ip=${ip} device=${deviceType} browser=${browser}`);

      res.json({
        ok: true,
        sessionToken,
        device: { browser, deviceType, ip: ip.slice(0, 3) + "***" },
      });
    } catch (err) {
      logger.error("registerSession error:", err);
      res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  }
);


/**
 * Validate that a request's session token matches the user's active session.
 * Call this from any authenticated endpoint to enforce single-session on the API layer.
 *
 * Returns true if valid (or if no session enforcement header is present — graceful).
 * Throws 401 if the session token is present but doesn't match.
 */
async function verifySessionToken(req, uid) {
  const sessionToken = req.headers["x-session-token"];
  if (!sessionToken) return true; // Graceful — old clients may not send it yet

  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) return true;

  const activeToken = userSnap.data()?.activeSession?.token;
  if (!activeToken) return true; // No session enforcement configured yet

  if (activeToken !== sessionToken) {
    const err = new Error("Session expired. You have been signed out because another login was detected.");
    err.statusCode = 401;
    err.code = "SESSION_EJECTED";
    throw err;
  }
  return true;
}


/**
 * ----------------------------
 * LOCATION FILTER CONSTANTS
 * ----------------------------
 */
const US_STATES = [
  "Alabama", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "District of Columbia", "Florida", "Georgia",
  "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maryland", "Massachusetts", "Michigan", "Minnesota",
  "Missouri", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "Oklahoma",
  "Pennsylvania", "Rhode Island", "Tennessee", "Texas", "Utah", "Virginia", "Washington", "Wisconsin",
];

const US_STATE_ABBREVIATIONS = [
  "AL", "AZ", "AR", "CA", "CO", "CT", "DC", "FL", "GA", "ID", "IL", "IN", "IA", "KS", "KY", "LA",
  "MD", "MA", "MI", "MN", "MO", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "OK", "PA", "RI", "TN",
  "TX", "UT", "VA", "WA", "WI",
];

const US_CITIES = [
  "Albuquerque", "Anaheim", "Ann Arbor", "Arlington", "Atlanta", "Austin", "Bakersfield", "Baltimore", "Baton Rouge", "Bellevue",
  "Birmingham", "Boise", "Boston", "Boulder", "Brooklyn", "Buffalo", "Burbank", "Cambridge", "Charlotte", "Chicago", "Cincinnati",
  "Cleveland", "Colorado Springs", "Columbus", "Dallas", "Dayton", "Denver", "Des Moines", "Detroit", "Durham", "El Paso",
  "Fort Collins", "Fort Lauderdale", "Fort Myers", "Fort Worth", "Fresno", "Grand Rapids", "Greensboro", "Greenville",
  "Hartford", "Henderson", "Hoboken", "Houston", "Huntsville", "Indianapolis", "Irvine", "Jacksonville", "Jersey City",
  "Kansas City", "Las Vegas", "Lincoln", "Little Rock", "Long Beach", "Los Angeles", "Louisville", "Madison", "Memphis", "Mesa",
  "Miami", "Milwaukee", "Minneapolis", "Mountain View", "Nashville", "Naples", "New Haven", "New Orleans", "New York", "Newark",
  "Norfolk", "Oakland", "Oklahoma City", "Omaha", "Orlando", "Palo Alto", "Panama City", "Pensacola", "Philadelphia", "Phoenix",
  "Pittsburgh", "Plano", "Portland", "Providence", "Provo", "Raleigh", "Redmond", "Reston", "Richmond", "Riverside", "Rochester",
  "Round Rock", "Sacramento", "Salt Lake City", "San Antonio", "San Diego", "San Francisco", "San Jose", "San Mateo", "Santa Ana",
  "Santa Clara", "Santa Fe", "Sarasota", "Scottsdale", "Seattle", "Silver Spring", "Spokane", "St. Louis", "St. Paul",
  "St. Petersburg", "Sugar Land", "Sunnyvale", "Syracuse", "Tallahassee", "Tampa", "Tempe", "The Woodlands", "Tucson", "Tulsa",
  "Tysons", "Virginia Beach", "Washington", "West Palm Beach", "Wichita",
];

const REMOTE_US_ONLY = [
  "US-Remote", "US Remote", "US (Remote)", "United States - Remote", "Remote US", "Remote USA", "Remote-USA",
  "Remote in United States", "Remote in the US", "Remote - USA", "Remote - US: All locations", "Remote - US: Select locations",
  "Anywhere in the United States", "United States", "US",
];

const NORM = {
  states: new Set(US_STATES.map((s) => normalizeText(s))),
  cities: new Set(US_CITIES.map((s) => normalizeText(s))),
  remote: new Set(REMOTE_US_ONLY.map((s) => normalizeText(s))),
  abbr: new Set(US_STATE_ABBREVIATIONS.map((s) => s.toUpperCase())),
};

const LOCATION_SPLIT_REGEX = /[;|/]+|(?:\s*,\s*)/g;

const NON_US_LOCATION_RE = /\b(afghanistan|albania|algeria|angola|argentina|armenia|australia|austria|azerbaijan|bahrain|bangladesh|belarus|belgium|belize|benin|bolivia|bosnia|botswana|brazil|bulgaria|burkina|burundi|cambodia|cameroon|canada|cape verde|chad|chile|china|colombia|congo|costa rica|croatia|cuba|cyprus|czech|denmark|dominican|ecuador|egypt|el salvador|eritrea|estonia|ethiopia|finland|france|gabon|ghana|greece|guatemala|guinea|haiti|honduras|hungary|iceland|india|indonesia|iran|iraq|ireland|israel|italy|ivory coast|jamaica|japan|jordan|kazakhstan|kenya|kosovo|kuwait|kyrgyzstan|laos|latvia|lebanon|lesotho|liberia|libya|liechtenstein|lithuania|luxembourg|madagascar|malawi|malaysia|mali|malta|mauritania|mauritius|mexico|moldova|mongolia|montenegro|morocco|mozambique|myanmar|namibia|nepal|netherlands|new zealand|nicaragua|niger|nigeria|north korea|norway|oman|pakistan|palestine|panama|paraguay|peru|philippines|poland|portugal|qatar|romania|russia|rwanda|saudi arabia|senegal|serbia|sierra leone|singapore|slovakia|slovenia|somalia|south africa|south korea|south sudan|spain|sri lanka|sudan|sweden|switzerland|syria|taiwan|tajikistan|tanzania|thailand|togo|tunisia|turkey|turkmenistan|uganda|ukraine|united arab emirates|uae|united kingdom|uruguay|uzbekistan|venezuela|vietnam|yemen|zambia|zimbabwe|europe|european|emea|latam|apac|mena|apj)\b/i;

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
  { region: REGION, timeoutSeconds: 540, memory: "1GiB", cors: CORS_ORIGINS },
  async (req, res) => {
    let decodedToken;
    try {
      decodedToken = await verifyToken(req);
    } catch (err) {
      return res.status(err.statusCode || 401).json({ error: err.message });
    }

    const ADMIN_UID = "7Tojjo8l5PZIYctPmdwncf7PC133";
    if (decodedToken.uid !== ADMIN_UID) {
      return res.status(403).json({ error: "Forbidden: Admin only." });
    }
    const userId = decodedToken.uid;

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
        let url = String(feed.url || "").trim();
        if (!url) throw new Error("Feed missing url");

        const source = String(feed.source || "").toLowerCase();
        const companyName = String(feed.companyName || feed.company || "Unknown");

        // Force Greenhouse to fetch full descriptions natively
        if (source.includes("greenhouse") && !url.includes("content=true")) {
          url += url.includes("?") ? "&content=true" : "?content=true";
        }

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

        // Enrich Eightfold/Netflix jobs with descriptions during sync.
        // Greenhouse & Ashby already have them from the feed. Eightfold bulk feeds
        // don't include descriptions, so we fetch them per-job now and save to DB,
        // completely eliminating the need to re-fetch during AI scoring.
        const descEnricher = pLimit(5);
        await Promise.all(
          recentOnly.map((job) =>
            descEnricher(async () => {
              if (job.fullDescription) return; // Already have it (Greenhouse/Ashby)
              if (job.source !== "eightfold") return; // Only needed for Eightfold/Netflix

              try {
                const desc = await fetchJobDescription(job.source, job.externalId, url, null);
                if (desc && desc.length > 50) {
                  job.fullDescription = desc;
                }
              } catch (e) {
                logger.warn(`Desc enrichment failed for ${job.jobDocId}: ${e.message}`);
              }
            })
          )
        );

        for (const job of recentOnly) {
          const jobRef = db.collection("users").doc(userId).collection("jobs").doc(job.jobDocId);

          const baseTs = job.sourceUpdatedTs || now;
          const expireAt = addDaysTs(baseTs, TTL_DAYS);

          bw.set(
            jobRef,
            {
              ...job,
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
            feedUrl: url || feed.url,
            jobUrl: job.jobUrl || null,
            fullDescription: job.fullDescription || null,
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

  // AWAIT scoring — Cloud Functions terminate any un-awaited Promises immediately upon return!
  if (newJobsForScoring.length > 0) {
    await scoreNewJobsForUser(userId, newJobsForScoring).catch((err) =>
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

async function fetchJson(url, maxRetries = 2) {
  let attempts = 0;
  while (true) {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json,text/plain,*/*",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    if (!resp.ok) {
      if ((resp.status === 429 || resp.status === 403 || resp.status >= 500) && attempts < maxRetries) {
        attempts++;
        await new Promise((r) => setTimeout(r, 1500 * attempts));
        continue;
      }
      const body = await safeReadText(resp);
      throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}. Body: ${(body || "").slice(0, 400)}`);
    }

    return await resp.json();
  }
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

    const rawDesc = rawJob.content || rawJob.description || "";
    const fullDescription = stripHtml(rawDesc);

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
      fullDescription, // Save directly into Firestore
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
      ? rawJob.secondaryLocations
          .map(s => typeof s === "string" ? s : (s?.location ? String(s.location) : null))
          .filter(Boolean)
      : [];
    const combinedLocation = [primaryLoc, ...secondary].filter(Boolean).join("; ");

    // Skip non-US jobs
    if (combinedLocation && NON_US_LOCATION_RE.test(combinedLocation)) return null;

    const sourceUpdatedIso = rawJob.publishedAt ? String(rawJob.publishedAt) : null;
    const sourceUpdatedTs = toTimestampOrNull(sourceUpdatedIso) || now;

    const locationTokens = extractLocationTokens(combinedLocation || "");
    const stateCodes = extractStateCodes(locationTokens);

    const meta = {};
    if (rawJob.employmentType != null) meta["Employment Type"] = rawJob.employmentType;
    if (rawJob.department != null) meta["Department"] = rawJob.department;
    if (rawJob.team != null) meta["Team"] = rawJob.team;

    // Ashby listings include the full JD in the feed response
    const rawDesc = rawJob.descriptionHtml || rawJob.descriptionPlain || rawJob.description || "";
    const fullDescription = stripHtml(rawDesc);

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
      workplaceType: rawJob.workplaceType || null,
      isRemote: rawJob.isRemote != null ? Boolean(rawJob.isRemote) : null,
      sourceUpdatedTs,
      sourceUpdatedIso,
      meta,
      fullDescription,
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
      if (!externalId) return null;

      // ── Netflix: has its own backend separate from standard Eightfold ──
      // Feed URL: https://explore.jobs.netflix.net/api/apply/v2/jobs?...
      // Detail:   https://explore.jobs.netflix.net/api/apply/v2/jobs/<id>?domain=netflix.com
      if (feedUrl.includes("netflix")) {
        const url = `https://explore.jobs.netflix.net/api/apply/v2/jobs/${externalId}?domain=netflix.com`;
        const json = await fetchJson(url);
        const raw = json?.job_description || "";
        return raw ? stripHtml(raw) : null;
      }

      // ── Standard Eightfold companies (BNY Mellon, Microsoft, Morgan Stanley, Nvidia, etc.) ──
      // Every Eightfold feed URL already contains ?domain=<company>.com — extract it directly.
      // This means ANY new Eightfold company added to feeds will work without code changes.
      let apiBase = "";
      let domain = "";
      try {
        const u = new URL(feedUrl);
        apiBase = `${u.protocol}//${u.hostname}`;

        // Best source: the domain= param already embedded in the feed URL
        // e.g. https://bnymellon.eightfold.ai/api/pcsx/search?domain=bnymellon.com → "bnymellon.com"
        domain = u.searchParams.get("domain") ||
          // Fallback: strip .eightfold.ai suffix
          u.hostname.replace(/\.eightfold\.ai$/, ".com");
      } catch (_) {
        return null;
      }

      if (!apiBase || !domain) return null;

      // pcsx/position_details is the canonical detail endpoint for all Eightfold companies
      const url = `${apiBase}/api/pcsx/position_details?position_id=${externalId}&domain=${domain}&hl=en`;
      const json = await fetchJson(url);
      const raw = json?.data?.jobDescription || "";
      return raw ? stripHtml(raw) : null;
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
  const systemPrompt = `You are a technical recruiting expert. Score this job's relevance for the candidate. Be fast and decisive.

SCORING RUBRIC (apply in order — first match wins):

HARD CAPS (override everything else):
- Title has "Intern", "New Grad", "PhD Intern", "University Graduate", "Co-op" → score 0-20
- Title has "Product Manager", "Program Manager", "Data Scientist", "Analyst", "Sales", "Marketing", "Finance", "Recruiter", "Designer" → score 0-15
- Title has "Principal", "Distinguished", "VP", "Director", "Head of", "C-level" → score 0-30

SCORE BANDS:
- 85-100: Core tech stack is a strong match AND right seniority level (SWE 0-8 yrs)
- 65-84: Good overlap, 1-2 missing but learnable tools
- 40-64: Partial match — right field but tech stack gaps
- 20-39: Weak match — misaligned role OR requires 10+ years experience not in resume
- 0-19: Wrong field entirely

KEY RULES:
- Ignore lack of domain knowledge (AdTech, FinTech, HealthTech) if core SWE skills match — engineers learn domains
- Judge primarily on: languages, frameworks, cloud tools, system design experience
- Be decisive. Do not hedge with mid-range scores like 50 unless truly uncertain

## Candidate Resume
${resumeText}`;

  const userPrompt = `## Job Title
${jobTitle}

## Job Description
${jobDescription}

Reply with ONLY valid JSON: {"score": <0-100>, "reason": "<15 words max>"}`;

  const msg = await anthropic.messages.create(
    {
      model: "claude-haiku-4-5",
      max_tokens: 80,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userPrompt }],
    },
    { timeout: 30000 } // 30 second timeout — generous enough for slow Claude responses
  );

  const raw = msg.content?.[0]?.text?.trim() || "";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    return null;
  }
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

  // Check user's AI scoring toggle — stored at users/{uid}/settings/preferences
  try {
    const settingsSnap = await db.collection("users").doc(userId).collection("settings").doc("preferences").get();
    if (settingsSnap.exists && settingsSnap.data()?.aiScoringEnabled === false) {
      logger.info(`scoreNewJobsForUser: AI scoring disabled for userId=${userId}, skipping`);
      return;
    }
  } catch (err) {
    logger.warn(`scoreNewJobsForUser: could not read settings for userId=${userId}: ${err?.message}`);
  }

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
  ].filter(Boolean).join("\n").slice(0, 15000);

  if (!resumeText) {
    logger.info(`scoreNewJobsForUser: resume has no content for userId=${userId}, skipping`);
    return;
  }

  // ─── OPTIMIZATION 1: Batch pre-read all job docs in ONE Firestore round-trip ──
  // Replaces N individual reads that burned concurrency slots doing nothing useful.
  // Gets: (a) already-scored check, (b) job titles — all before any tasks start.
  const jobsCol = db.collection("users").doc(userId).collection("jobs");

  // Deduplicate before batch read to prevent db.getAll duplicate ref errors
  const uniqueJobsMap = new Map();
  for (const job of newJobs) {
    uniqueJobsMap.set(job.jobDocId, job);
  }
  const uniqueNewJobs = Array.from(uniqueJobsMap.values());
  const docRefs = uniqueNewJobs.map((job) => jobsCol.doc(job.jobDocId));

  // db.getAll() uses JS spread — chunk to 300 to guard against call stack overflow on large syncs
  const CHUNK = 300;
  const snapshots = [];
  for (let i = 0; i < docRefs.length; i += CHUNK) {
    const batch = await db.getAll(...docRefs.slice(i, i + CHUNK));
    snapshots.push(...batch);
  }

  const titleMap = {};
  const unscoredJobs = [];

  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    const job = uniqueNewJobs[i];
    const existingScore = snap.exists ? snap.data()?.relevanceScore : null;
    if (existingScore !== null && existingScore >= 0) {
      logger.info(`scoreNewJobsForUser: ${job.jobDocId} already has valid score (${existingScore}), skipping`);
      continue;
    }

    const title = snap.exists ? (snap.data()?.title || "") : "";
    titleMap[job.jobDocId] = title;

    unscoredJobs.push(job);
  }

  if (unscoredJobs.length === 0) {
    logger.info(`scoreNewJobsForUser: all ${newJobs.length} jobs already scored, nothing to do`);
    return;
  }

  logger.info(`scoreNewJobsForUser: ${unscoredJobs.length} unscored / ${uniqueNewJobs.length} total — starting`);

  // Claude Tier 1: 50K TPM — use concurrency of 1 to avoid rate limits
  const concurrency = 1;
  const scoringLimiter = pLimit(concurrency);
  const scoredAt = admin.firestore.Timestamp.now();

  const scoringTasks = unscoredJobs.map((job) =>
    scoringLimiter(async () => {
      try {
        // Title pre-loaded from batch read — no Firestore read needed here
        const jobTitle = titleMap[job.jobDocId];

        // 1. Fetch JD (Greenhouse & Ashby natively injected via Sync loop; others via HTTPS)
        let description = job.fullDescription;

        if (!description) {
          description = await fetchJobDescription(job.source, job.externalId, job.feedUrl, null);

          // Universal Web Scraper Fallback (Jina Reader API) for Workday, Lever, etc.
          if (!description && job.jobUrl) {
            logger.info(`scoreNewJobsForUser: falling back to Universal Scraper for ${job.jobUrl}`);
            try {
              const jinaReq = await fetch(`https://r.jina.ai/${job.jobUrl}`);
              if (jinaReq.ok) {
                const jinaText = await jinaReq.text();
                if (jinaText.length > 50) description = stripHtml(jinaText);
              }
            } catch (e) { }
          }
        }
        if (!description || description.length < 50) {
          logger.info(`scoreNewJobsForUser: empty JD for ${job.jobDocId}, writing fallback score`);
          await jobsCol.doc(job.jobDocId).set(
            { relevanceScore: -1, scoreReason: "Could not fetch Job Description directly.", scoredAt },
            { merge: true }
          );
          return;
        }
        // Trim to 2000 chars — enough context for scoring, fast enough to avoid timeouts
        const jd = description.slice(0, 2000);

        // Score — up to 5 attempts, handles rate limits AND timeouts
        let result = null;
        let attempts = 0;

        while (attempts < 5) {
          attempts++;
          try {
            result = await scoreJobWithClaude(jobTitle, jd, resumeText);
            if (result) break;
            logger.warn(`scoreJobWithClaude: attempt ${attempts}/5 returned invalid format for ${job.jobDocId}, retrying...`);
            await new Promise((r) => setTimeout(r, 1000));
          } catch (apiErr) {
            const isRetryable =
              apiErr.status === 429 ||
              apiErr.status === 529 ||
              apiErr.status === 408 ||
              apiErr.message?.toLowerCase().includes("rate") ||
              apiErr.message?.toLowerCase().includes("timeout") ||
              apiErr.message?.toLowerCase().includes("timed out") ||
              apiErr.constructor?.name === "APIConnectionTimeoutError" ||
              apiErr.constructor?.name === "APIConnectionError";
            if (isRetryable && attempts < 5) {
              const waitSec = 10 * attempts;
              logger.warn(`scoreJobWithAI: attempt ${attempts}/5 failed (${apiErr.message?.slice(0, 60)}), retrying in ${waitSec}s...`);
              await new Promise((r) => setTimeout(r, 1000 * waitSec));
            } else {
              logger.warn(`scoreJobWithAI: non-retryable error: ${apiErr.message?.slice(0, 100)}`);
              break;
            }
          }
        }

        if (!result) {
          logger.warn(`scoreNewJobsForUser: AI returned no score/error for ${job.jobDocId}`);
          await jobsCol.doc(job.jobDocId).set(
            { relevanceScore: -1, scoreReason: "AI returned invalid response format or rate limited.", scoredAt },
            { merge: true }
          );
          return;
        }

        // 3. Write ONLY score + reason (no JD) back to job doc
        await jobsCol.doc(job.jobDocId).set(
          { relevanceScore: result.score, scoreReason: result.reason, scoredAt },
          { merge: true }
        );

        logger.info(`Scored ${job.jobDocId}: ${result.score}/100 — ${result.reason}`);
      } catch (err) {
        logger.warn(`scoreNewJobsForUser: error scoring ${job.jobDocId}: ${err?.message}`);
        await jobsCol.doc(job.jobDocId).set(
          { relevanceScore: -1, scoreReason: "AI timeout or processing error.", scoredAt },
          { merge: true }
        ).catch(() => { });
      }
    })
  );

  await Promise.all(scoringTasks);
  logger.info(`scoreNewJobsForUser: done — scored ${unscoredJobs.length}/${uniqueNewJobs.length} jobs for userId=${userId}`);
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
  { region: REGION, timeoutSeconds: 300, memory: "1GiB", cors: CORS_ORIGINS },
  async (req, res) => {
    try {
      let decodedToken;
      try {
        decodedToken = await verifyToken(req);
      } catch (err) {
        return res.status(err.statusCode || 401).json({ error: err.message });
      }

      const { messages } = req.body;
      const activeUserId = decodedToken.uid;

      // Check if AI scoring is enabled
      const settingsSnap = await db.collection("users").doc(activeUserId).collection("settings").doc("preferences").get();

      if (settingsSnap.exists && settingsSnap.data()?.aiScoringEnabled === false) {
        return res.status(403).json({ error: "AI features are disabled in your settings." });
      }

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

      const systemPrompt = `You are the JobWatch AI Assistant. You help users manage their job tracking, sync data, and analyze market trends.
          You have access to the user's specific job listings, feeds, and sync history via tools.
          Always be concise, professional, and helpful. 
          IMPORTANT: All timestamps and dates in your responses must be in Pacific Time (PT). 
          Current User ID: ${activeUserId}`;

      // Tool handling loop
      while (true) {
        let generatedText = "";
        let toolCalls = [];

        const response = await anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 4096,
          system: systemPrompt,
          messages: currentMessages,
          tools: tools,
        });

        if (response.stop_reason === "tool_use") {
          toolCalls = response.content.filter(c => c.type === "tool_use");
          currentMessages.push({ role: "assistant", content: response.content });
        } else {
          finalResponse = response.content[0].text;
          break;
        }

        if (toolCalls.length > 0) {
          const toolResults = [];
          for (const block of toolCalls) {
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

          currentMessages.push({ role: "user", content: toolResults });
        }
      }

      return res.json({
        ok: true,
        response: {
          role: "assistant",
          content: finalResponse,
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
  { region: REGION, timeoutSeconds: 120, memory: "512MiB", cors: CORS_ORIGINS },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed. Use POST." });
    }

    // Verify Firebase ID token before processing any file data
    let decodedToken;
    try {
      decodedToken = await verifyToken(req);
    } catch (err) {
      return res.status(err.statusCode || 401).json({ error: err.message });
    }

    try {
      // ─── 1. Parse multipart form data with Busboy ───────────────────────
      const { fileBuffer, mimeType, originalName } = await new Promise((resolve, reject) => {
        const bb = Busboy({
          headers: req.headers,
          limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB hard limit
        });

        let fileBuffer = null;
        let mimeType = "";
        let originalName = "";
        let fileTooLarge = false;

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
          resolve({ fileBuffer, mimeType, originalName });
        });

        bb.on("error", (err) => reject(err));

        bb.end(req.rawBody);
      });

      // ─── 2. Use uid from verified token ────────────────────────────────
      const userId = decodedToken.uid;

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

      // ─── 4. Call AI to extract structured JSON ──────────────────────
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
      // Use Claude for resume parsing with jsonrepair as safety net
      const claudeRes = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: "user", content: `Resume text:\n\n${truncatedText}\n\nIMPORTANT: Output ONLY a raw JSON object. No markdown fences, no explanation, no text before or after.` }],
      });
      const rawOutput = claudeRes.content[0]?.text?.trim() || "";

      // Strip markdown fences and extract the JSON object robustly
      let jsonStr = rawOutput.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();
      // If there's preamble text, find the first { ... } block
      const jsonBlockMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonBlockMatch) jsonStr = jsonBlockMatch[0];

      let parsed;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (parseErr) {
        // Try to auto-repair common JSON issues (unescaped quotes, trailing commas, etc.)
        try {
          parsed = JSON.parse(jsonrepair(jsonStr));
          logger.warn("parseResume: used jsonrepair to fix Claude output");
        } catch (repairErr) {
          logger.error("JSON parse failed even after repair. Raw output:", rawOutput.slice(0, 2000));
          return res.status(500).json({ error: "AI returned an unexpected response format. Please try again." });
        }
      }

      // Attach truncated raw text (first 5000 chars) for Firestore storage
      parsed.rawText = rawText.slice(0, 5000);
      parsed.fileName = originalName;

      // ─── 5. Upload PDF to Firebase Storage (server-side, no CORS) ──────
      let resumeUrl = null;
      try {
        const storagePath = `resumes/${userId}/resume.${ext}`;
        const fileRef = storageBucket.file(storagePath);
        // Generate a stable download token so the URL never expires
        const downloadToken = require("crypto").randomUUID();
        await fileRef.save(fileBuffer, {
          metadata: {
            contentType: mimeType || "application/octet-stream",
            metadata: { firebaseStorageDownloadTokens: downloadToken },
          },
        });
        const encodedPath = encodeURIComponent(storagePath);
        resumeUrl = `https://firebasestorage.googleapis.com/v0/b/${storageBucket.name}/o/${encodedPath}?alt=media&token=${downloadToken}`;
        parsed.resumeUrl = resumeUrl;
      } catch (storageErr) {
        logger.warn("parseResume: Storage upload failed (non-fatal):", storageErr.message);
      }

      logger.info(`parseResume: userId=${userId}, file=${originalName}, skills=${(parsed.skills || []).length}, roles=${(parsed.roles || []).length}`);

      return res.json({ ok: true, parsed });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("parseResume failed:", msg, e?.stack);
      return res.status(500).json({ error: msg });
    }
  }
);

/**
 * ----------------------------
 * 1-Click AI Cover Letter Generator
 * ----------------------------
 */
exports.generateCoverLetter = onCall(
  {
    region: REGION,
    minInstances: 0,
    maxInstances: 10,
    timeoutSeconds: 60,
  },
  async (request) => {
    // 1. Auth check
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "You must be logged in to generate a cover letter.");
    }

    // Single-session enforcement for Callable functions
    const sessionToken = request.rawRequest?.headers?.["x-session-token"];
    if (sessionToken) {
      const userSnap = await db.collection("users").doc(uid).get();
      if (userSnap.exists) {
        const activeToken = userSnap.data()?.activeSession?.token;
        if (activeToken && activeToken !== sessionToken) {
          throw new HttpsError("unauthenticated", "Session expired. You have been signed out because another login was detected.");
        }
      }
    }

    const { jobId } = request.data;
    if (!jobId) {
      throw new HttpsError("invalid-argument", "Missing jobId.");
    }

    try {
      // Check if AI is enabled
      const settingsSnap = await db.collection("users").doc(uid).collection("settings").doc("preferences").get();

      if (settingsSnap.exists && settingsSnap.data()?.aiScoringEnabled === false) {
        throw new HttpsError("failed-precondition", "AI features are currently disabled in your settings.");
      }

      // 2. Fetch User Resume
      const resumeSnap = await db.collection("users").doc(uid).collection("resume").doc("profile").get();
      if (!resumeSnap.exists) {
        throw new HttpsError("failed-precondition", "No resume profile found. Please upload a resume first.");
      }

      const resumeText = [];
      const dOptions = resumeSnap.data();
      if (dOptions.rawText) resumeText.push(dOptions.rawText);
      const builtResumeStr = resumeText.join("\\n\\n").trim();
      if (!builtResumeStr) {
        throw new HttpsError("failed-precondition", "Your resume has no parseable text. Please re-upload.");
      }

      // 3. Fetch Job Details
      const jobSnap = await db.collection("users").doc(uid).collection("jobs").doc(jobId).get();
      if (!jobSnap.exists) {
        throw new HttpsError("not-found", "Job not found in database.");
      }
      const jobData = jobSnap.data();
      const jobDesc = (jobData.fullDescription || jobData.title || "No description available.").slice(0, 5000);
      const companyName = jobData.companyName || "the company";
      const jobTitle = jobData.title || "the role";

      // 4. Construct Prompt & Call AI
      const systemPrompt = `You are an expert career coach making highly professional, modern, and engaging cover letters.`;

      const userPrompt = `
Write a 3-paragraph compelling cover letter bridging this exact resume and this specific job at ${companyName} for the ${jobTitle} role.

Rules:
1. Write conversationally and exactly like a human software engineer. DO NOT use AI text patterns, overly complex SAT vocabulary, or fluffy corporate buzzwords.
2. NEVER use em-dashes (—). Strip them from your vocabulary completely. Use commas or short, punchy sentences instead.
3. Focus on exactly how the candidate's specific past experience maps to the job requirements.
4. Use a standard business letter format (without the physical address block).
5. Do not include placeholders like "[Your Name]" unless absolutely necessary; try to extract the name from the resume or leave it generically signed "Sincerely,\n[Applicant]".
6. Keep it to exactly 3 well-crafted paragraphs. No bullet points.
7. Return ONLY the final text of the cover letter. Do not include introductory conversational text.

## Job Description
${jobDesc}

## Candidate Resume
${builtResumeStr}
`;

      const msg = await anthropic.messages.create(
          {
            model: "claude-haiku-4-5",
            max_tokens: 600,
            temperature: 0.7,
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
          },
          { timeout: 30000 }
        );
      const generatedText = msg.content?.[0] ? msg.content[0].text.trim() : "";

      if (!generatedText) throw new Error("AI returned an empty string.");

      return { ok: true, text: generatedText };
    } catch (err) {
      logger.error("generateCoverLetter error:", err);
      throw new HttpsError("internal", "Failed to generate cover letter: " + err.message);
    }
  }
);

/**
 * =====================================================================================
 * 🤖 EXTENSION: Map job application form fields to user profile using AI
 * =====================================================================================
 *
 * Called by the Chrome/Edge extension background service worker.
 * Takes scraped form fields + job context, returns a field_id → answer mapping.
 *
 * System fields (_systemfield_name, _systemfield_email, _systemfield_resume) are
 * mapped deterministically. Unknown UUID fields are handled by Claude Haiku.
 */
exports.mapFormFields = onCall(
  {
    region: REGION,
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Login required.");

    const { fields = [], jobTitle = "", companyName = "", jobLocationName = "", jobWorkplaceType = "", errorContext = null } = request.data;
    if (!Array.isArray(fields) || fields.length === 0) {
      throw new HttpsError("invalid-argument", "fields array is required.");
    }

    // Fetch user profile and resume in parallel
    const [userSnap, resumeSnap] = await Promise.all([
      db.collection("users").doc(uid).get(),
      db.collection("users").doc(uid).collection("resume").doc("profile").get(),
    ]);

    const user = userSnap.exists ? userSnap.data() : {};
    const resume = resumeSnap.exists ? resumeSnap.data() : {};

    const fullName = user.fullName || `${user.firstName || ""} ${user.lastName || ""}`.trim();

    // Skills, experience, education from resume for richer Claude context
    const topSkills = (resume.skills || []).slice(0, 20).join(", ");
    const topRoles = (resume.roles || resume.experience || []).slice(0, 3)
      .map(r => `${r.title || r.role || ""} at ${r.company || r.employer || ""} (${r.startDate || ""}–${r.endDate || "present"})`)
      .filter(s => s.trim() !== "at ()").join("; ");
    const topEdu = (resume.education || []).slice(0, 2)
      .map(e => `${e.degree || ""} from ${e.institution || ""} (${e.endDate || ""})`)
      .filter(s => s.trim() !== "from ()").join("; ");

    const userContext = {
      name: fullName,
      firstName: user.firstName || "",
      middleName: user.middleName || "",
      email: user.email || "",
      phone: user.phone || "",
      linkedin: user.linkedin || "",
      github: user.github || "",
      portfolio: user.portfolio || "",
      pronouns: user.pronouns || "",
      city: user.city || "",
      region: user.region || "",
      country: user.country || "United States",
      address: [user.addressLine1, user.city, user.region, user.postalCode, user.country]
        .filter(Boolean).join(", "),
      university: user.university || "",
      currentCompany: resume.roles?.[0]?.company || resume.experience?.[0]?.company || user.currentCompany || "",
      availability: user.availability || "Immediately",
      workAuthorized: user.workAuthorized || "Yes",
      requiresSponsorship: user.requiresSponsorship || "No",
      willingToRelocate: user.willingToRelocate || "No",
      willingToWorkHybrid: user.willingToWorkHybrid || "Yes",
      clearanceStatus: user.clearanceStatus || "None",
      namePronunciation: user.namePronunciation || "",
      eeoGender: user.eeoGender || "Decline to self-identify",
      eeoEthnicity: user.eeoEthnicity || "Decline to self-identify",
      eeoVeteran: user.eeoVeteran || "I am not a protected veteran",
      eeoDisability: user.eeoDisability || "No, I don't have a disability",
      currentTitle: resume.roles?.[0]?.title || resume.experience?.[0]?.title || resume.roles?.[0]?.role || "",
      summary: resume.summary || "",
      skills: topSkills,
      experience: topRoles,
      education: topEdu,
    };

    const result = {};
    const unknownFields = [];

    // ── Deterministic mapping for known patterns ────────────────────────────
    for (const field of fields) {
      const { id, label = "", type } = field;

      // System fields
      if (id === "_systemfield_name") { result[id] = userContext.name; continue; }
      if (id === "_systemfield_email") { result[id] = userContext.email; continue; }
      if (id === "_systemfield_resume") { result[id] = "__FILE__"; continue; }
      if (id === "_systemfield_location") {
        // Use the job posting location, not the user's home address
        result[id] = jobLocationName || [user.city, user.country].filter(Boolean).join(", ") || "";
        continue;
      }
      // EEO system fields — use profile values
      if (id === "_systemfield_eeoc_gender") { result[id] = userContext.eeoGender; continue; }
      if (id === "_systemfield_eeoc_race") { result[id] = userContext.eeoEthnicity; continue; }
      if (id === "_systemfield_eeoc_veteran_status") { result[id] = userContext.eeoVeteran; continue; }

      const lbl = label.toLowerCase();

      // Date fields — start/availability → 20 days from today
      if (type === "date") {
        if (lbl.includes("start") || lbl.includes("availab") || lbl.includes("when can you") || lbl.includes("earliest")) {
          const d = new Date(); d.setDate(d.getDate() + 20);
          const mm = String(d.getMonth() + 1).padStart(2, "0");
          const dd = String(d.getDate()).padStart(2, "0");
          result[id] = `${mm}/${dd}/${d.getFullYear()}`; continue;
        }
      }

      // Text/textarea "how did you hear" → always LinkedIn
      if ((type === "text" || type === "textarea") &&
          (lbl.includes("how did you hear") || lbl.includes("where did you hear") || lbl.includes("how did you find") || lbl.includes("how did you learn") || lbl.includes("where did you learn") || lbl.includes("where did you find"))) {
        result[id] = "LinkedIn"; continue;
      }

      // Text availability/start → "Immediately"
      if (type === "text" &&
          (lbl.includes("availab") || (lbl.includes("start") && lbl.includes("date")) || lbl.includes("when can you start"))) {
        result[id] = "Immediately"; continue;
      }


      if (lbl.includes("legal name") || lbl === "full legal name") {
        result[id] = userContext.name; continue;
      }

      // Current / most recent job title
      if ((lbl.includes("current") || lbl.includes("most recent")) && lbl.includes("title")) {
        result[id] = userContext.currentTitle; continue;
      }
      if (lbl === "job title" || lbl === "current title") {
        result[id] = userContext.currentTitle; continue;
      }

      // Name pronunciation
      if (lbl.includes("name pronunciation") || lbl.includes("pronounce your name")) {
        result[id] = userContext.namePronunciation; continue;
      }

      // Programming language — always Python
      if (lbl.includes("proficient programming language") || lbl.includes("preferred programming language") ||
          lbl.includes("preferred interview language") || lbl.includes("preferred coding language")) {
        result[id] = "Python"; continue;
      }
      if (lbl === "first name" || lbl.startsWith("first name")) {
        result[id] = user.firstName || ""; continue;
      }
      if (lbl.includes("last name") || lbl.includes("surname")) {
        result[id] = user.lastName || ""; continue;
      }
      if (lbl.includes("middle name")) { result[id] = userContext.middleName; continue; }
      if (lbl.includes("preferred name") || lbl === "nickname") {
        result[id] = user.firstName || ""; continue;
      }

      // Contact
      if (lbl.includes("linkedin")) { result[id] = userContext.linkedin; continue; }
      if (lbl.includes("github")) { result[id] = user.github || ""; continue; }
      if (lbl.includes("website") || lbl.includes("portfolio")) { result[id] = user.portfolio || ""; continue; }
      if (lbl.includes("pronouns")) { result[id] = user.pronouns || ""; continue; }
      if (lbl.includes("phone")) { result[id] = userContext.phone; continue; }

      // Address subfields
      if (lbl.includes("address") && lbl.includes("line 1")) { result[id] = user.addressLine1 || ""; continue; }
      if (lbl.includes("address") && lbl.includes("line 2")) { result[id] = user.addressLine2 || ""; continue; }
      if (lbl.includes("city")) { result[id] = user.city || ""; continue; }
      if (lbl.includes("state") || lbl.includes("province") || lbl.includes("region")) { result[id] = user.region || ""; continue; }
      if (lbl.includes("zip") || lbl.includes("postal")) { result[id] = user.postalCode || ""; continue; }
      if (lbl.includes("country")) { result[id] = user.country || "United States"; continue; }

      // Radio fields — location/office questions use job location from Firestore
      if (type === "radio") {
        const isLocationQ = lbl.includes("location") || lbl.includes("office") ||
          lbl.includes("which city") || lbl.includes("interested in") || lbl.includes("which site");
        if (isLocationQ && jobLocationName && field.options?.length) {
          const jl = jobLocationName.toLowerCase();
          // Find option whose label most overlaps with the job location
          const best = field.options.find(o => {
            const ol = o.label.toLowerCase();
            return ol.includes(jl) || jl.includes(ol);
          }) || field.options.reduce((a, b) => {
            const scoreA = jl.split(/[\s,]+/).filter(w => w.length > 2 && a.label.toLowerCase().includes(w)).length;
            const scoreB = jl.split(/[\s,]+/).filter(w => w.length > 2 && b.label.toLowerCase().includes(w)).length;
            return scoreB > scoreA ? b : a;
          });
          result[id] = best.label; continue;
        }

        // Yes/No radio questions — same deterministic rules as yesno buttons
        if (lbl.includes("legally authorized") || lbl.includes("authorized to work") || lbl.includes("authorized to work lawfully")) {
          result[id] = user.workAuthorized === "No" ? "No" : "Yes"; continue;
        }
        if (lbl.includes("work authorization") || lbl.includes("require authorization") || lbl.includes("require sponsorship") || lbl.includes("sponsorship") || lbl.includes("visa")) {
          result[id] = user.requiresSponsorship === "Yes" ? "Yes" : "No"; continue;
        }
        if (lbl.includes("relocat")) {
          result[id] = user.willingToRelocate === "Yes" ? "Yes" : "No"; continue;
        }
        if (lbl.includes("relative") || lbl.includes("family member") || lbl.includes("currently working for") || lbl.includes("conflict of interest") || lbl.includes("government official") || lbl.includes("previously worked") || lbl.includes("worked at") || lbl.includes("employed by")) {
          result[id] = "No"; continue;
        }
        if (lbl.includes("agree") || lbl.includes("understand") || lbl.includes("policy") || lbl.includes("confirm") || lbl.includes("acknowledge")) {
          result[id] = "Yes"; continue;
        }
        if (lbl.includes("hybrid") || lbl.includes("in-office") || lbl.includes("in office") || lbl.includes("on-site") || lbl.includes("onsite") || lbl.includes("days per week")) {
          result[id] = userContext.willingToWorkHybrid === "Yes" ? "Yes" : "No"; continue;
        }
        if (lbl.includes("export control") || lbl.includes("u.s. person") || lbl.includes("us person")) {
          result[id] = user.usPersonExportControl === "No" ? "No" : "Yes"; continue;
        }
      }

      // Common yes/no questions with safe deterministic answers
      if (type === "yesno") {
        if (lbl.includes("legally authorized") || lbl.includes("authorized to work")) {
          result[id] = user.workAuthorized === "No" ? "no" : "yes"; continue;
        }
        if (lbl.includes("work authorization") || lbl.includes("require authorization") || lbl.includes("require sponsorship") || lbl.includes("sponsorship") || lbl.includes("visa")) {
          result[id] = user.requiresSponsorship === "Yes" ? "yes" : "no"; continue;
        }
        if (lbl.includes("relative") || lbl.includes("family member") || lbl.includes("currently working for")) {
          result[id] = "no"; continue;
        }
        if (lbl.includes("agree") || lbl.includes("understand") || lbl.includes("policy") || lbl.includes("confirm") || lbl.includes("acknowledge")) {
          result[id] = "yes"; continue;
        }
        if (lbl.includes("hybrid") || lbl.includes("in-office") || lbl.includes("in office") || lbl.includes("can you meet") || lbl.includes("days per week") || lbl.includes("on-site") || lbl.includes("onsite")) {
          result[id] = userContext.willingToWorkHybrid === "Yes" ? "yes" : "no"; continue;
        }
        if (lbl.includes("relocat")) {
          result[id] = user.willingToRelocate === "Yes" ? "yes" : "no"; continue;
        }
        if (lbl.includes("conflict of interest") || lbl.includes("government official") || lbl.includes("previously worked") || lbl.includes("worked at") || lbl.includes("worked for") || lbl.includes("employed by")) {
          result[id] = "no"; continue;
        }
        if (lbl.includes("export control") || lbl.includes("u.s. person") || lbl.includes("us person")) {
          result[id] = user.usPersonExportControl === "No" ? "no" : "yes"; continue;
        }
        if (lbl.includes("sms") || lbl.includes("whatsapp") || lbl.includes("text message")) {
          result[id] = user.smsConsent === "Yes" ? "yes" : "no"; continue;
        }
      }

      // Select fields — deterministic answers
      if (type === "select") {
        if (lbl.includes("authorized to work") || lbl.includes("legally authorized")) {
          result[id] = user.workAuthorized === "No" ? "No" : "Yes"; continue;
        }
        if (lbl.includes("sponsorship") || lbl.includes("require sponsorship") || lbl.includes("immigration")) {
          result[id] = user.requiresSponsorship === "Yes" ? "Yes" : "No"; continue;
        }
        if (lbl.includes("export control") || lbl.includes("u.s. person") || lbl.includes("deemed export")) {
          result[id] = user.usPersonExportControl === "No" ? "No" : "Yes"; continue;
        }
        if (lbl.includes("relocat")) {
          result[id] = user.willingToRelocate === "Yes" ? "Yes" : "No"; continue;
        }
        if (lbl.includes("previously worked") || lbl.includes("worked at") || lbl.includes("employed by") || lbl.includes("worked for") || lbl.includes("history with")) {
          result[id] = "No"; continue;
        }
        if (lbl.includes("conflict of interest") || lbl.includes("government official")) {
          result[id] = "No"; continue;
        }
        if (lbl.includes("preferred office location") || lbl.includes("office location preference") || lbl.includes("office preference")) {
          result[id] = "__ALL__"; continue;
        }
        if (lbl.includes("in office") || lbl.includes("in-office") || lbl.includes("hybrid") || lbl.includes("onsite") || lbl.includes("on-site") || lbl.includes("days per week") || lbl.includes("can you meet") || lbl.includes("confirm you can")) {
          result[id] = userContext.willingToWorkHybrid === "Yes" ? "Yes" : "No"; continue;
        }
        if (lbl.includes("sms") || lbl.includes("whatsapp") || lbl.includes("text message")) {
          result[id] = user.smsConsent === "Yes" ? "Yes" : "No"; continue;
        }
        if (lbl.includes("clearance")) {
          result[id] = user.clearanceStatus || "None"; continue;
        }
        if (lbl.includes("gender") || lbl.includes("pronoun")) {
          result[id] = userContext.eeoGender; continue;
        }
        if (lbl.includes("hispanic") || lbl.includes("ethnicity") || lbl.includes("race")) {
          result[id] = userContext.eeoEthnicity; continue;
        }
        if (lbl.includes("veteran")) {
          result[id] = userContext.eeoVeteran; continue;
        }
        if (lbl.includes("disability")) {
          result[id] = userContext.eeoDisability; continue;
        }
        if (lbl.includes("how did you hear") || lbl.includes("where did you") || lbl.includes("how did you find") || lbl.includes("how did you learn")) {
          result[id] = "LinkedIn"; continue;
        }
      }

      unknownFields.push(field);
    }

    // ── Claude Haiku for open-ended / custom fields ─────────────────────────
    if (unknownFields.length > 0) {
      const fieldList = unknownFields
        .map((f) => {
          let line = `- ID: "${f.id}" | Label: "${f.label}" | Type: ${f.type} | Required: ${f.required}`;
          if (f.options?.length) line += ` | Options: ${f.options.map(o => o.label).join(" / ")}`;
          return line;
        })
        .join("\n");

      const errorSection = errorContext && Array.isArray(errorContext) && errorContext.length
        ? `\n\nIMPORTANT — Previous submit attempt failed with these validation errors:\n${errorContext.map(e => `  - ${e}`).join("\n")}\nYou MUST provide correct, non-empty answers for those specific fields.`
        : "";

      const prompt = `You are filling out a job application for "${jobTitle}" at "${companyName}".
Job location: ${jobLocationName || "Not specified"} (workplace type: ${jobWorkplaceType || "unspecified"}).${errorSection}

Candidate profile:
- Name: ${userContext.name}
- Name Pronunciation: ${userContext.namePronunciation}
- Current Title: ${userContext.currentTitle}
- Email: ${userContext.email}
- Phone: ${userContext.phone}
- Location: ${userContext.city}${userContext.region ? ", " + userContext.region : ""}, ${userContext.country}
- LinkedIn: ${userContext.linkedin}
- GitHub: ${userContext.github}
- Portfolio: ${userContext.portfolio}
- University: ${userContext.university}
- Current Company: ${userContext.currentCompany}
- Availability / Start Date: ${userContext.availability}
- Work Authorized (US): ${userContext.workAuthorized}
- Requires Visa Sponsorship: ${userContext.requiresSponsorship}
- Willing to Relocate: ${userContext.willingToRelocate}
- Security Clearance: ${userContext.clearanceStatus}
- Pronouns: ${userContext.pronouns}
- Summary: ${userContext.summary}
- Skills: ${userContext.skills}
- Recent Experience: ${userContext.experience}
- Education: ${userContext.education}

Rules:
- For yes/no or select fields: use the candidate profile above to answer accurately.
- For radio fields: you MUST return EXACTLY one of the option labels listed for that field (copy it verbatim, case-sensitive). Never invent a new value.
- For "how did you hear about us?" → "LinkedIn"
- For salary / compensation questions → "Open to discussion"
- For cover letter / essay / motivation fields → write 2–3 natural sentences from the candidate's summary and experience.
- CRITICAL WRITING STYLE: You MUST write like a real human. DO NOT use em dashes. DO NOT use typical AI buzzwords, bullet points, or standard AI essay structures. It is highly encouraged to include minor, natural grammatical imperfections (like missing a comma or using casual phrasing) so it passes as human. The primary goal is to sound completely organic to maximize the chances of getting an interview callback.
- For "when can you start?" → use the availability field above.
- For unknown text fields → a brief, natural answer based on the profile.
- Omit fields where you have no basis to answer.

Return ONLY a valid JSON object: {"field_id": "answer"} — no explanation, no markdown.

Fields:
${fieldList}`;

      try {
        const msg = await anthropic.messages.create({
          model: "claude-haiku-4-5",
          max_tokens: 500,
          messages: [{ role: "user", content: prompt }],
        });
        const raw = msg.content?.[0]?.text?.trim() || "{}";
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) Object.assign(result, JSON.parse(jsonMatch[0]));
      } catch (e) {
        logger.warn("mapFormFields: Claude call failed:", e.message);
      }
    }

    logger.info(`mapFormFields: uid=${uid}, fields=${fields.length}, unknown=${unknownFields.length}`);
    return { ok: true, mappings: result };
  }
);

// ── Generate name pronunciation ─────────────────────────────────────────────
exports.generateNamePronunciation = onRequest(
  { region: REGION, timeoutSeconds: 15, memory: "128MiB", cors: CORS_ORIGINS },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: "name required" });
    try {
      const msg = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 60,
        messages: [{
          role: "user",
          content: `Generate a simple phonetic pronunciation guide for the name "${name}". Return ONLY the pronunciation string, e.g. "Ah-kash Rah-mah-sah-nee". No explanation.`,
        }],
      });
      const pronunciation = msg.content?.[0]?.text?.trim() || name;
      res.json({ pronunciation });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);
