const admin = require("firebase-admin");
const { getFunctions } = require("firebase-admin/functions");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onTaskDispatched } = require("firebase-functions/v2/tasks");
const logger = require("firebase-functions/logger");
const pLimit = require("p-limit").default;

admin.initializeApp();
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;

// ------------------------ CONFIG ------------------------
const REGION = "us-central1";

// Concurrency
const FEED_CONCURRENCY = 6;
const JOB_WRITE_CONCURRENCY = 25;

// ✅ Start at 11:15 PM now and continue every 30 mins => :15 and :45
// (This will run at 11:15, 11:45, 12:15, 12:45, ...)
const POLL_SCHEDULE = "15,45 * * * *";
const TIME_ZONE = "America/Los_Angeles";

// ✅ Cleanup at 03:00 AM every 2 days
const CLEANUP_SCHEDULE = "0 3 */2 * *";

// Ingestion window: last 1 hour only
const INGEST_WINDOW_MS = 60 * 60 * 1000;

// Retention for cleanup (adjust anytime)
const JOB_RETENTION_DAYS = 14;      // keep jobs for 14 days
const RUN_RETENTION_DAYS = 14;      // keep fetchRuns for 14 days
const COMPANY_RETENTION_DAYS = 30;  // keep companies if seen within last 30 days

// Fetch reliability
const FETCH_TIMEOUT_MS = 90_000;
const FETCH_RETRIES = 3;
const FETCH_RETRY_BASE_DELAY_MS = 800;

// Progress heartbeat
const HEARTBEAT_EVERY_MS = 10_000;

// Firestore doc safety
const MAX_HTML_CHARS = 120_000;

// Batched read chunk size for db.getAll(...refs)
const GETALL_CHUNK = 450;

// If you want "remote anywhere worldwide", set this to [].
const REMOTE_EXCLUDE_SUBSTRINGS = [
  // Europe
  "albania","andorra","austria","belgium","bosnia and herzegovina","bulgaria","croatia",
  "cyprus","czech republic","denmark","estonia","finland","france","germany","greece",
  "hungary","iceland","ireland","italy","latvia","liechtenstein","lithuania","luxembourg",
  "malta","monaco","montenegro","netherlands","north macedonia","norway","poland",
  "portugal","romania","san marino","serbia","slovakia","slovenia","spain","sweden",
  "switzerland","ukraine","united kingdom","vatican city",

  // Asia
  "afghanistan","armenia","azerbaijan","bahrain","bangladesh","bhutan","brunei",
  "cambodia","china","georgia","india","indonesia","iran","iraq","israel","japan",
  "jordan","kazakhstan","kuwait","kyrgyzstan","laos","lebanon","malaysia","maldives",
  "mongolia","myanmar","nepal","north korea","oman","pakistan","philippines","qatar",
  "saudi arabia","singapore","south korea","sri lanka","syria","tajikistan","thailand",
  "timor-leste","turkey","turkmenistan","united arab emirates","uzbekistan","vietnam","yemen",

  // Africa
  "algeria","angola","benin","botswana","burkina faso","burundi","cabo verde",
  "cameroon","central african republic","chad","comoros","congo","costa d'ivoire",
  "djibouti","egypt","equatorial guinea","eritrea","eswatini","ethiopia","gabon",
  "gambia","ghana","guinea","guinea-bissau","kenya","lesotho","liberia","libya",
  "madagascar","malawi","mali","mauritania","mauritius","morocco","mozambique",
  "namibia","niger","nigeria","rwanda","sao tome and principe","senegal","seychelles",
  "sierra leone","somalia","south africa","south sudan","sudan","tanzania","togo",
  "tunisia","uganda","zambia","zimbabwe",

  // South America
  "argentina","bolivia","brazil","chile","colombia","ecuador","guyana","paraguay",
  "peru","suriname","uruguay","venezuela",

  // Central America & Caribbean
  "antigua and barbuda","bahamas","barbados","belize","cuba","dominica",
  "dominican republic","el salvador","grenada","guatemala","haiti","honduras",
  "jamaica","nicaragua","panama","saint kitts and nevis","saint lucia",
  "saint vincent and the grenadines","trinidad and tobago",

  // North America (explicitly included, excluding USA)
  "canada","mexico",

  // Oceania
  "australia","fiji","kiribati","marshall islands","micronesia","nauru",
  "new zealand","palau","papua new guinea","samoa","solomon islands","tonga",
  "tuvalu","vanuatu"
];

// ---------------- US Location Filtering ----------------
const US_STATE_CODES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA",
  "ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK",
  "OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
];

const US_KEYWORDS = [
  "REMOTE",
  "UNITED STATES",
  "USA",
  "AMER - US",
  "USCA",
  "US-REMOTE",
  "US REMOTE",
  "REMOTE US",
  "REMOTE - US",
  "US-NATIONAL",
  "ANYWHERE IN THE UNITED STATES",
  "U.S.",
];

const MAJOR_US_CITIES = [
  "SAN FRANCISCO","NYC","NEW YORK CITY","LOS ANGELES","CHICAGO","HOUSTON","PHOENIX","PHILADELPHIA",
  "SAN ANTONIO","SAN DIEGO","DALLAS","SAN JOSE","AUSTIN","JACKSONVILLE","FORT WORTH","COLUMBUS",
  "CHARLOTTE","INDIANAPOLIS","SEATTLE","DENVER","BOSTON","EL PASO","NASHVILLE","DETROIT",
  "OKLAHOMA CITY","PORTLAND","LAS VEGAS","MEMPHIS","LOUISVILLE","BALTIMORE","MILWAUKEE",
  "ALBUQUERQUE","TUCSON","FRESNO","SACRAMENTO","MESA","KANSAS CITY","ATLANTA","OMAHA",
  "COLORADO SPRINGS","RALEIGH","LONG BEACH","VIRGINIA BEACH","MIAMI","OAKLAND","MINNEAPOLIS",
  "TULSA","BAKERSFIELD","WICHITA","ARLINGTON",
];

function isUSLocation(locationText) {
  if (!locationText) return false;
  const text = String(locationText).toUpperCase();

  if (US_KEYWORDS.some((kw) => text.includes(kw))) return true;

  if (MAJOR_US_CITIES.some((city) => new RegExp(`(?:^|[,\\s\\/•\\-|\\|])${city}(?:[\\s,;\\/•\\-|\\|]|$)`).test(text))) {
    return true;
  }

  return (
    US_STATE_CODES.some((code) => new RegExp(`(?:^|[,\\s\\/•\\-|\\|])${code}(?:[\\s,;\\/•\\-|\\|]|$)`).test(text)) ||
    /\bUS\b/.test(text) ||
    text.includes("U.S.")
  );
}

function isRemoteLocation(locationText) {
  if (!locationText) return false;
  const s = String(locationText).trim().toLowerCase();
  if (!s.includes("remote")) return false;

  if (s.includes("us-remote") || s.includes("remote us") || s.includes("remote - us")) return true;

  for (const bad of REMOTE_EXCLUDE_SUBSTRINGS) {
    if (s.includes(bad)) return false;
  }

  return true;
}

function shouldKeepJobByLocation(locationName, jobRaw) {
  if (jobRaw && jobRaw.isRemote === true) return true;
  return isUSLocation(locationName) || isRemoteLocation(locationName);
}

function extractStateCodes(locationText) {
  if (!locationText) return [];
  const text = String(locationText).toUpperCase();
  const codes = new Set();

  if (
    text.includes("WASHINGTON, D.C") ||
    text.includes("WASHINGTON D.C") ||
    text.includes("WASHINGTON DC")
  ) {
    codes.add("DC");
  }

  const tokens = text.match(/\b[A-Z]{2}\b/g) || [];
  for (const t of tokens) {
    if (US_STATE_CODES.includes(t)) codes.add(t);
  }

  return Array.from(codes);
}

// ------------------------ FEED TYPE DETECTION ------------------------
function detectFeedSource(feedUrl) {
  const u = String(feedUrl || "").toLowerCase();
  if (u.includes("boards-api.greenhouse.io")) return "greenhouse";
  if (u.includes("api.ashbyhq.com/posting-api/job-board")) return "ashby";
  return "unknown";
}

// ------------------------ TIME HELPERS ------------------------
function isoToTimestampOrNull(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Timestamp.fromDate(d);
}

function isoToMsOrNull(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  return ms;
}

/**
 * ✅ Upsert timestamp rules (what we compare to decide whether to write)
 * - Greenhouse: max(updated_at, first_published)
 * - Ashby: publishedAt (BUT if we don't have it directly, we accept greenhouse-like updated_at/first_published too)
 *
 * Returns ISO string or null if missing/invalid.
 */
function computeSourceUpdatedIso(source, jobRaw) {
  if (source === "ashby") {
    // Prefer publishedAt if present (raw Ashby shape), else fall back to greenhouse-like fields.
    const iso =
      jobRaw?.publishedAt ||
      jobRaw?.updated_at ||
      jobRaw?.first_published ||
      null;

    const ms = isoToMsOrNull(iso);
    return ms ? iso : null;
  }

  // greenhouse-like
  const a = jobRaw?.updated_at || null;
  const b = jobRaw?.first_published || null;

  const aMs = isoToMsOrNull(a);
  const bMs = isoToMsOrNull(b);

  if (aMs && bMs) return aMs >= bMs ? a : b;
  if (aMs) return a;
  if (bMs) return b;
  return null;
}

// ------------------------ HTTP / FETCH ------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function isRetryableHttpStatus(status) {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function fetchJson(url) {
  let attempt = 0;

  while (attempt <= FETCH_RETRIES) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "user-agent": "jobs-aggregator/6.0",
          accept: "application/json",
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await safeReadText(res);
        const msg = `HTTP ${res.status} ${res.statusText} for ${url} :: ${(body || "").slice(0, 300)}`;

        if (isRetryableHttpStatus(res.status) && attempt < FETCH_RETRIES) {
          const delay = FETCH_RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
          logger.warn("retryable http error", { url, status: res.status, attempt, delay });
          await sleep(delay);
          attempt += 1;
          continue;
        }
        throw new Error(msg);
      }

      return await res.json();
    } catch (err) {
      const isAbort = err?.name === "AbortError";
      const retryable = isAbort || /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(String(err?.message || err));

      if (attempt < FETCH_RETRIES && retryable) {
        const delay = FETCH_RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
        logger.warn("retryable network error", { url, attempt, delay, error: String(err?.message || err) });
        await sleep(delay);
        attempt += 1;
        continue;
      }

      if (isAbort) throw new Error(`Timeout after ${FETCH_TIMEOUT_MS}ms for ${url}`);
      throw err;
    } finally {
      clearTimeout(t);
    }
  }

  throw new Error(`Fetch failed after retries for ${url}`);
}

// ------------------------ CONTENT CLEANING (ONLY contentHtmlClean) ------------------------
function decodeHtmlEntities(s) {
  if (!s) return "";
  return String(s)
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ");
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeTracking(html) {
  if (!html) return "";
  let s = String(html);

  // remove img pixels
  s = s.replace(/<img\b[^>]*>/gi, " ");

  const trackerDomains = [
    "click.appcast.io",
    "track.jobadx.com",
    "jobadx.com",
    "appcast.io",
    "doubleclick.net",
    "googlesyndication.com",
  ];
  for (const d of trackerDomains) {
    const re = new RegExp(`<a\\b[^>]*href=["'][^"']*${escapeRegex(d)}[^"']*["'][^>]*>([\\s\\S]*?)<\\/a>`, "gi");
    s = s.replace(re, "$1");
  }
  return s;
}

function capStr(s, n) {
  if (!s) return "";
  const str = String(s);
  if (str.length <= n) return str;
  return str.slice(0, n);
}

function normalizeContentHtmlClean(rawContent) {
  const decoded = decodeHtmlEntities(rawContent || "");
  const noTrack = removeTracking(decoded);
  return capStr(noTrack, MAX_HTML_CHARS);
}

// ------------------------ METADATA NORMALIZATION ------------------------
function normalizeMetadata(metadataArr) {
  if (!Array.isArray(metadataArr)) return { metadataKV: {}, metadataList: [] };

  const kv = {};
  const list = [];

  for (const item of metadataArr) {
    if (!item || !item.name) continue;
    const name = String(item.name).trim();
    let value = item.value;

    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;

    let normalizedValue = value;

    if (item.value_type === "currency" && value && typeof value === "object" && !Array.isArray(value)) {
      const unit = value.unit || "USD";
      const amountStr = value.amount;
      const amountNum = amountStr != null ? Number(amountStr) : null;
      normalizedValue = { unit, amount: Number.isFinite(amountNum) ? amountNum : amountStr };
    } else if (Array.isArray(value)) {
      normalizedValue = value.map((v) => (typeof v === "string" ? v.trim() : v)).filter(Boolean);
    } else if (typeof value === "object") {
      normalizedValue = value;
    } else if (typeof value === "string") {
      normalizedValue = value.trim();
    }

    if (kv[name] === undefined) {
      kv[name] = normalizedValue;
      list.push({ name, value: normalizedValue });
    }
  }

  return { metadataKV: kv, metadataList: list };
}

// ------------------------ ASHBY -> GH-LIKE SHIM ------------------------
function toGreenhouseLikeJob(source, jobRaw) {
  if (source === "greenhouse") return jobRaw;

  return {
    id: jobRaw?.id,
    title: jobRaw?.title || null,
    absolute_url: jobRaw?.jobUrl || null,
    apply_url: jobRaw?.applyUrl || null,

    // IMPORTANT: put publishedAt here so greenhouse-like logic can read it too
    updated_at: jobRaw?.publishedAt || null,
    first_published: jobRaw?.publishedAt || null,

    company_name: null,
    requisition_id: null,
    language: null,
    internal_job_id: null,
    location: { name: jobRaw?.location || "" },
    metadata: [
      ...(jobRaw?.department ? [{ name: "Department", value: jobRaw.department, value_type: "short_text" }] : []),
      ...(jobRaw?.team ? [{ name: "Team", value: jobRaw.team, value_type: "short_text" }] : []),
      ...(jobRaw?.employmentType ? [{ name: "Employment Type", value: jobRaw.employmentType, value_type: "short_text" }] : []),
    ],
    content: jobRaw?.descriptionHtml || "",
    _ashby: {
      // keep useful bits, but DO NOT rely on it for publishedAt
      isRemote: jobRaw?.isRemote ?? null,
      jobUrl: jobRaw?.jobUrl ?? null,
      applyUrl: jobRaw?.applyUrl ?? null,
      address: jobRaw?.address ?? null,
      isListed: jobRaw?.isListed ?? null,
    },
    isRemote: jobRaw?.isRemote === true,
  };
}

function extractJobsFromFeedJson(source, json) {
  if (source === "greenhouse") {
    return Array.isArray(json?.jobs) ? json.jobs : [];
  }
  if (source === "ashby") {
    if (Array.isArray(json?.jobs)) return json.jobs;
    if (Array.isArray(json)) return json;
    if (Array.isArray(json?.jobBoard?.jobs)) return json.jobBoard.jobs;
    return [];
  }
  if (Array.isArray(json?.jobs)) return json.jobs;
  if (Array.isArray(json)) return json;
  return [];
}

// ------------------------ JOB KEY / NORMALIZATION ------------------------
function jobDocId(companyKey, jobId) {
  return `${companyKey}__${jobId}`;
}

function inferAshbyCompanyKeyFromUrl(feedUrl) {
  try {
    const u = new URL(feedUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("job-board");
    if (idx !== -1 && parts[idx + 1]) return parts[idx + 1].toLowerCase();
  } catch {}
  return null;
}

function inferGreenhouseCompanyKeyFromUrl(feedUrl) {
  try {
    const u = new URL(feedUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("boards");
    if (idx !== -1 && parts[idx + 1]) return parts[idx + 1].toLowerCase();
  } catch {}
  return null;
}

function feedCompanyKey(feed) {
  const source = detectFeedSource(feed.url);

  if (source === "greenhouse") {
    return inferGreenhouseCompanyKeyFromUrl(feed.url) || feed.id;
  }

  if (source === "ashby") {
    return inferAshbyCompanyKeyFromUrl(feed.url) || feed.id;
  }

  try {
    const u = new URL(feed.url);
    const host = u.hostname.replaceAll(".", "_");
    return `${host}_${feed.id}`.toLowerCase();
  } catch {
    return feed.id;
  }
}

// ✅ Company name ONLY from feed doc
function companyNameFromFeed(feed) {
  return (feed?.name || "").trim() || "Unknown";
}

/**
 * normalizeJob now includes:
 * - sourceUpdatedIso/sourceUpdatedTs/sourceUpdatedMs
 * This is what we compare in Firestore to decide if we need to write.
 *
 * NOTE: updatedAtTs/updatedAtIso are what your frontend queries.
 */
function normalizeJob(uid, feed, jobRawGreenhouseLike, source) {
  const locationName = jobRawGreenhouseLike?.location?.name || "";

  const sourceUpdatedIso = computeSourceUpdatedIso(source, jobRawGreenhouseLike);
  const sourceUpdatedTs = isoToTimestampOrNull(sourceUpdatedIso);
  const sourceUpdatedMs = isoToMsOrNull(sourceUpdatedIso);

  const { metadataKV, metadataList } = normalizeMetadata(jobRawGreenhouseLike.metadata);
  const contentHtmlClean = normalizeContentHtmlClean(jobRawGreenhouseLike.content || "");

  const explicitRemote = jobRawGreenhouseLike?.isRemote === true || jobRawGreenhouseLike?._ashby?.isRemote === true;
  const computedRemote = isRemoteLocation(locationName) || (!locationName && true);
  const isRemote = explicitRemote || computedRemote;

  const stateCodes = extractStateCodes(locationName);
  const companyKey = feedCompanyKey(feed);

  return {
    uid,

    source, // "greenhouse" | "ashby" | "unknown"
    companyKey,
    companyName: companyNameFromFeed(feed),

    locationName: locationName || "Remote",
    absolute_url: jobRawGreenhouseLike.absolute_url || null,
    applyUrl: jobRawGreenhouseLike.apply_url || jobRawGreenhouseLike?._ashby?.applyUrl || null,

    title: jobRawGreenhouseLike.title || null,

    // the "freshness" we compare + frontend uses
    sourceUpdatedIso,        // raw ISO
    sourceUpdatedTs,         // Timestamp or null
    sourceUpdatedMs,         // number or null

    // ✅ FRONTEND FIELD NAMES
    updatedAtIso: sourceUpdatedIso || null,
    updatedAtTs: sourceUpdatedTs || null,

    stateCodes,
    isRemote,

    jobId: jobRawGreenhouseLike.id,
    internalJobId: jobRawGreenhouseLike.internal_job_id ?? jobRawGreenhouseLike.internalJobId ?? null,
    requisitionId: jobRawGreenhouseLike.requisition_id ?? null,
    language: jobRawGreenhouseLike.language || null,
    firstPublishedIso: jobRawGreenhouseLike.first_published || null,

    metadataKV,
    metadataList,

    contentHtmlClean,

    lastSeenAt: FieldValue.serverTimestamp(),
    lastIngestedAt: FieldValue.serverTimestamp(),
  };
}

// ------------------------ FEED PROCESSING ------------------------
async function loadUserFeeds(uid) {
  const snap = await db.collection("users").doc(uid).collection("feeds").get();
  const feeds = [];

  snap.forEach((d) => {
    const data = d.data() || {};

    const active = data.active !== false;

    // ✅ archived if ANY of these are set
    const archived =
      data.archived === true ||
      data.isArchived === true ||
      data.active === false ||
      data.archivedAt != null; // <-- IMPORTANT (matches your Firestore schema)

    if (!active || archived) return;

    feeds.push({
      id: d.id,
      name: (data.company || data.name || "").trim() || "Unknown",
      url: data.url || null,
      active: true,
      source: data.source || null,
    });
  });

  return feeds.filter((f) => f.url);
}

async function upsertCompanyDoc(uid, feed) {
  const companyKey = feedCompanyKey(feed);
  const ref = db.collection("users").doc(uid).collection("companies").doc(companyKey);

  await ref.set(
    {
      companyKey,
      companyName: companyNameFromFeed(feed), // ✅ feed-only
      lastSeenAt: FieldValue.serverTimestamp(),
      url: feed.url || null,
      source: detectFeedSource(feed.url),
      archived: false,
    },
    { merge: true }
  );
}

// --------- batched getAll() for existing docs ----------
async function getExistingUpdatedMsMap(docRefs) {
  const out = new Map(); // docPath -> sourceUpdatedMs (number) or null
  for (let i = 0; i < docRefs.length; i += GETALL_CHUNK) {
    const chunk = docRefs.slice(i, i + GETALL_CHUNK);
    const snaps = await db.getAll(...chunk);
    for (const s of snaps) {
      if (!s.exists) continue;
      const data = s.data() || {};
      const v = data.sourceUpdatedMs;
      out.set(s.ref.path, typeof v === "number" ? v : null);
    }
  }
  return out;
}

function isAlreadyExistsError(e) {
  const code = e?.code;
  if (code === 6) return true; // ALREADY_EXISTS
  const msg = String(e?.message || "");
  return msg.includes("ALREADY_EXISTS") || msg.includes("already exists");
}

// Writes are only performed AFTER timestamp comparison
async function writeJobIfNeeded({ bulkWriter, ref, normalized, existingUpdatedMs }) {
  const incomingMs = normalized.sourceUpdatedMs;

  // If missing timestamp, we should NOT write
  if (!Number.isFinite(incomingMs)) {
    return { added: 0, updated: 0, skippedUnchanged: 0, noTimestamp: 1 };
  }

  // New doc -> create
  if (existingUpdatedMs === undefined) {
    try {
      await bulkWriter.create(ref, {
        ...normalized,
        createdAt: FieldValue.serverTimestamp(),
        firstSeenAt: FieldValue.serverTimestamp(),
      });
      return { added: 1, updated: 0, skippedUnchanged: 0, noTimestamp: 0 };
    } catch (e) {
      // If create races, fall back to merge set
      if (!isAlreadyExistsError(e)) throw e;
      await bulkWriter.set(ref, normalized, { merge: true });
      return { added: 0, updated: 1, skippedUnchanged: 0, noTimestamp: 0 };
    }
  }

  // Existing doc: if it has no value, treat as update
  const prevMs = existingUpdatedMs ?? -1;

  // Not newer -> skip write
  if (incomingMs <= prevMs) {
    return { added: 0, updated: 0, skippedUnchanged: 1, noTimestamp: 0 };
  }

  // Newer -> update
  await bulkWriter.set(ref, normalized, { merge: true });
  return { added: 0, updated: 1, skippedUnchanged: 0, noTimestamp: 0 };
}

async function processOneFeed(uid, feed, bulkWriter) {
  const nowMs = Date.now();
  const windowThresholdMs = nowMs - INGEST_WINDOW_MS;

  const source = feed.source || detectFeedSource(feed.url);
  const json = await fetchJson(feed.url);
  const jobsRaw = extractJobsFromFeedJson(source, json);

  // filter by location rules
  const keptRaw = [];
  for (const j of jobsRaw) {
    const loc = source === "greenhouse" ? j?.location?.name : j?.location;
    if (!loc || shouldKeepJobByLocation(loc, j)) keptRaw.push(j);
  }

  const companyKey = feedCompanyKey(feed);
  const jobsCol = db.collection("users").doc(uid).collection("jobs");

  // Build normalized payloads + refs
  const found = keptRaw.length;

  let candidates = 0;
  let skippedOld = 0;
  let noTimestamp = 0;

  const incomingCandidates = [];

  for (const jobRaw of keptRaw) {
    const ghLike = toGreenhouseLikeJob(source, jobRaw);
    const normalized = normalizeJob(uid, feed, ghLike, source);

    // missing timestamp => track, skip
    if (!Number.isFinite(normalized.sourceUpdatedMs)) {
      noTimestamp += 1;
      continue;
    }

    // outside 1h window => track, skip
    if (normalized.sourceUpdatedMs < windowThresholdMs) {
      skippedOld += 1;
      continue;
    }

    // candidate
    candidates += 1;
    const docId = jobDocId(companyKey, ghLike.id);
    const ref = jobsCol.doc(docId);
    incomingCandidates.push({ ref, normalized });
  }

  // If no candidates, still upsert company and exit fast
  await upsertCompanyDoc(uid, feed);

  if (incomingCandidates.length === 0) {
    return {
      found,
      candidates,
      added: 0,
      updated: 0,
      skippedOld,
      skippedUnchanged: 0,
      noTimestamp,
    };
  }

  // Batched read for existing docs (only candidates)
  const refs = incomingCandidates.map((x) => x.ref);
  const existingMap = await getExistingUpdatedMsMap(refs);

  // Perform writes only if needed
  const limitWrite = pLimit(JOB_WRITE_CONCURRENCY);

  let added = 0;
  let updated = 0;
  let skippedUnchanged = 0;
  let noTimestampWrites = 0;

  await Promise.all(
    incomingCandidates.map((x) =>
      limitWrite(async () => {
        const key = x.ref.path;
        const existingUpdatedMs = existingMap.has(key) ? existingMap.get(key) : undefined;

        const res = await writeJobIfNeeded({
          bulkWriter,
          ref: x.ref,
          normalized: x.normalized,
          existingUpdatedMs,
        });

        added += res.added;
        updated += res.updated;
        skippedUnchanged += res.skippedUnchanged;
        noTimestampWrites += res.noTimestamp;
      })
    )
  );

  // noTimestampWrites should be 0 because we filtered earlier, but keep safe.
  noTimestamp += noTimestampWrites;

  return {
    found,
    candidates,
    added,
    updated,
    skippedOld,
    skippedUnchanged,
    noTimestamp,
  };
}

// ------------------------ FETCH RUN HELPERS ------------------------
function fetchRunRef(uid, runId) {
  return db.collection("users").doc(uid).collection("fetchRuns").doc(runId);
}

async function createFetchRun(uid, runType, initialStatus, extra = {}) {
  const ref = db.collection("users").doc(uid).collection("fetchRuns").doc();
  await ref.set({
    runType,
    status: initialStatus,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...extra,
  });
  return { runId: ref.id, ref };
}

// ------------------------ TASK URI HELPERS ------------------------
function getProjectId() {
  return process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || process.env.PROJECT_ID || null;
}

function taskFunctionUri(functionName) {
  const projectId = getProjectId();
  if (!projectId) throw new Error("Missing project ID env var (GCLOUD_PROJECT/GCP_PROJECT/PROJECT_ID). Cannot build task URI.");
  return `https://${REGION}-${projectId}.cloudfunctions.net/${functionName}`;
}

// ------------------------ ENQUEUE (used by BOTH manual + scheduled) ------------------------
async function enqueueUserRun(uid, runType) {
  const { runId, ref } = await createFetchRun(uid, runType, "enqueued", {
    enqueuedAt: FieldValue.serverTimestamp(),
  });

  const queue = getFunctions().taskQueue("pollUserTaskV2");
  const targetUri = taskFunctionUri("pollUserTaskV2");

  try {
    await queue.enqueue({ uid, runType, runId }, { uri: targetUri });
    return { ok: true, runId, status: "enqueued" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ref.set(
      {
        status: "enqueue_failed",
        updatedAt: FieldValue.serverTimestamp(),
        enqueueError: msg,
      },
      { merge: true }
    );
    throw err;
  }
}

// ------------------------ TASK BODY ------------------------
async function processUserFeeds(uid, runType, runId) {
  const startedAtMs = Date.now();
  const feeds = await loadUserFeeds(uid);
  const runRef = fetchRunRef(uid, runId);

  let foundTotal = 0;           // all jobs in feed after location filter
  let candidatesTotal = 0;      // jobs within 1 hour window
  let addedTotal = 0;
  let updatedTotal = 0;
  let skippedOldTotal = 0;      // older than 1h
  let skippedUnchangedTotal = 0;// timestamp not newer than Firestore
  let noTimestampTotal = 0;

  let errorsCount = 0;
  const errorSamples = [];

  await runRef.set(
    {
      runType,
      status: "running",
      startedAt: FieldValue.serverTimestamp(),
      feedsCount: feeds.length,
      updatedAt: FieldValue.serverTimestamp(),

      // Counters
      found: 0,
      candidates: 0,
      added: 0,
      updated: 0,
      skippedOld: 0,
      skippedUnchanged: 0,
      noTimestamp: 0,
      writes: 0,

      errorsCount: 0,
      errorSamples: [],
    },
    { merge: true }
  );

  const writeHeartbeat = async () => {
    await runRef.set(
      {
        updatedAt: FieldValue.serverTimestamp(),
        found: foundTotal,
        candidates: candidatesTotal,
        added: addedTotal,
        updated: updatedTotal,
        skippedOld: skippedOldTotal,
        skippedUnchanged: skippedUnchangedTotal,
        noTimestamp: noTimestampTotal,
        writes: addedTotal + updatedTotal,
        errorsCount,
        errorSamples,
      },
      { merge: true }
    );
  };

  const heartbeatTimer = setInterval(() => {
    writeHeartbeat().catch((e) => logger.warn("heartbeat write failed", { runId, error: String(e?.message || e) }));
  }, HEARTBEAT_EVERY_MS);

  const bulkWriter = db.bulkWriter();
  bulkWriter.onWriteError((error) => {
    const code = error?.code;
    const retryable =
      code === 4 ||  // DEADLINE_EXCEEDED
      code === 8 ||  // RESOURCE_EXHAUSTED
      code === 10 || // ABORTED
      code === 13 || // INTERNAL
      code === 14;   // UNAVAILABLE

    if (retryable && error.failedAttempts < 5) return true;

    logger.error("BulkWriter write failed", {
      code,
      message: error?.message,
      name: error?.name,
      failedAttempts: error?.failedAttempts,
      docPath: error?.documentRef?.path,
    });
    return false;
  });

  const limitFeed = pLimit(FEED_CONCURRENCY);

  try {
    await Promise.all(
      feeds.map((feed) =>
        limitFeed(async () => {
          try {
            const summary = await processOneFeed(uid, feed, bulkWriter);

            foundTotal += summary.found;
            candidatesTotal += summary.candidates;
            addedTotal += summary.added;
            updatedTotal += summary.updated;
            skippedOldTotal += summary.skippedOld;
            skippedUnchangedTotal += summary.skippedUnchanged;
            noTimestampTotal += summary.noTimestamp;
          } catch (err) {
            errorsCount += 1;
            const msg = String(err?.message || err);

            if (errorSamples.length < 8) errorSamples.push(`${feed.url} :: ${msg}`);
            logger.warn("feed failed", { uid, url: feed.url, error: msg });
          }
        })
      )
    );

    await bulkWriter.close();

    const durationMs = Date.now() - startedAtMs;

    await runRef.set(
      {
        status: errorsCount ? "done_with_errors" : "done",
        finishedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        durationMs,

        found: foundTotal,
        candidates: candidatesTotal,
        added: addedTotal,
        updated: updatedTotal,
        skippedOld: skippedOldTotal,
        skippedUnchanged: skippedUnchangedTotal,
        noTimestamp: noTimestampTotal,
        writes: addedTotal + updatedTotal,

        errorsCount,
        errorSamples,
      },
      { merge: true }
    );

    return {
      runId,
      feedsCount: feeds.length,
      found: foundTotal,
      candidates: candidatesTotal,
      added: addedTotal,
      updated: updatedTotal,
      skippedOld: skippedOldTotal,
      skippedUnchanged: skippedUnchangedTotal,
      noTimestamp: noTimestampTotal,
      writes: addedTotal + updatedTotal,
      durationMs,
      errorsCount,
    };
  } finally {
    clearInterval(heartbeatTimer);
  }
}

// ------------------------ CLEANUP HELPERS ------------------------
function daysAgoMs(days) {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

async function deleteInBatches(queryRef, maxLoops = 50) {
  let loops = 0;

  while (loops < maxLoops) {
    const snap = await queryRef.get();
    if (snap.empty) return { deleted: 0 };

    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();

    loops += 1;

    // if fewer than limit returned, we're done
    if (snap.size < 400) break;
  }

  return { deleted: loops * 400 };
}

async function cleanupOldDataForUser(uid) {
  const jobsCutoff = Timestamp.fromDate(new Date(daysAgoMs(JOB_RETENTION_DAYS)));
  const runsCutoff = Timestamp.fromDate(new Date(daysAgoMs(RUN_RETENTION_DAYS)));
  const companiesCutoff = Timestamp.fromDate(new Date(daysAgoMs(COMPANY_RETENTION_DAYS)));

  // Jobs: delete old by updatedAtTs (or sourceUpdatedTs if you prefer)
  const jobsCol = db.collection("users").doc(uid).collection("jobs");
  const jobsQ = jobsCol
    .where("updatedAtTs", "<", jobsCutoff)
    .orderBy("updatedAtTs", "asc")
    .limit(400);

  // FetchRuns: delete old by createdAt
  const runsCol = db.collection("users").doc(uid).collection("fetchRuns");
  const runsQ = runsCol
    .where("createdAt", "<", runsCutoff)
    .orderBy("createdAt", "asc")
    .limit(400);

  // Companies: delete those not seen for a long time
  const companiesCol = db.collection("users").doc(uid).collection("companies");
  const companiesQ = companiesCol
    .where("lastSeenAt", "<", companiesCutoff)
    .orderBy("lastSeenAt", "asc")
    .limit(400);

  let jobsDeleted = 0;
  let runsDeleted = 0;
  let companiesDeleted = 0;

  // Repeat until empty (bounded loops)
  for (let i = 0; i < 20; i++) {
    const s = await jobsQ.get();
    if (s.empty) break;
    const batch = db.batch();
    s.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    jobsDeleted += s.size;
    if (s.size < 400) break;
  }

  for (let i = 0; i < 20; i++) {
    const s = await runsQ.get();
    if (s.empty) break;
    const batch = db.batch();
    s.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    runsDeleted += s.size;
    if (s.size < 400) break;
  }

  for (let i = 0; i < 20; i++) {
    const s = await companiesQ.get();
    if (s.empty) break;
    const batch = db.batch();
    s.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    companiesDeleted += s.size;
    if (s.size < 400) break;
  }

  return { jobsDeleted, runsDeleted, companiesDeleted };
}

// ------------------------ CLOUD FUNCTIONS ------------------------

exports.pollNowV2 = onCall({ region: REGION }, async (req) => {
  if (!req.auth?.uid) throw new HttpsError("unauthenticated", "You must be signed in.");

  try {
    return await enqueueUserRun(req.auth.uid, "manual");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpsError("internal", msg);
  }
});

exports.pollGreenhouseFeedsV2 = onSchedule(
  { region: REGION, schedule: POLL_SCHEDULE, timeZone: TIME_ZONE },
  async () => {
    const usersSnap = await db.collection("users").get();
    logger.info("scheduler tick", { users: usersSnap.size, schedule: POLL_SCHEDULE, tz: TIME_ZONE });

    const limitEnq = pLimit(50);

    await Promise.all(
      usersSnap.docs.map((u) =>
        limitEnq(async () => {
          const uid = u.id;
          try {
            await enqueueUserRun(uid, "scheduled");
          } catch (err) {
            logger.error("scheduled enqueue failed", { uid, error: String(err?.message || err) });
          }
        })
      )
    );

    return null;
  }
);

// ✅ Cleanup at 03:00 AM every 2 days
exports.cleanupOldJobsV2 = onSchedule(
  { region: REGION, schedule: CLEANUP_SCHEDULE, timeZone: TIME_ZONE },
  async () => {
    const usersSnap = await db.collection("users").get();
    logger.info("cleanup tick", {
      users: usersSnap.size,
      schedule: CLEANUP_SCHEDULE,
      tz: TIME_ZONE,
      JOB_RETENTION_DAYS,
      RUN_RETENTION_DAYS,
      COMPANY_RETENTION_DAYS,
    });

    const limitUsers = pLimit(10);

    await Promise.all(
      usersSnap.docs.map((u) =>
        limitUsers(async () => {
          const uid = u.id;
          try {
            const res = await cleanupOldDataForUser(uid);
            logger.info("cleanup user done", { uid, ...res });
          } catch (err) {
            logger.error("cleanup user failed", { uid, error: String(err?.message || err) });
          }
        })
      )
    );

    return null;
  }
);

exports.pollUserTaskV2 = onTaskDispatched(
  {
    region: REGION,
    timeoutSeconds: 540,
    memory: "1GiB",
    rateLimits: { maxConcurrentDispatches: 10 },

    // ✅ NO RETRIES (and handler never throws)
    retryConfig: { maxAttempts: 1 },
  },
  async (req) => {
    const { uid, runType, runId } = req.data || {};
    if (!uid || !runId) return;

    logger.info("task start", { uid, runType, runId });

    try {
      await processUserFeeds(uid, runType || "scheduled", runId);
      logger.info("task done", { uid, runType, runId });
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Write failure for UI
      try {
        await fetchRunRef(uid, runId).set(
          {
            status: "failed",
            updatedAt: FieldValue.serverTimestamp(),
            finishedAt: FieldValue.serverTimestamp(),
            error: msg,
          },
          { merge: true }
        );
      } catch (e) {
        logger.error("failed to write run failure", { uid, runId, error: String(e?.message || e) });
      }

      // ✅ DO NOT throw => Cloud Tasks will NOT retry
      logger.error("task failed (no retry)", { uid, runType, runId, error: msg });
      return;
    }
  }
);
