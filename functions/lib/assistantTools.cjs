/**
 * functions/lib/assistantTools.cjs
 *
 * The JobWatch assistant's tools, shared by the web chat (askAssistant in
 * functions/index.js) and the local MCP server (mcp-server/index.js).
 *
 * Everything here takes a Firestore instance from the caller and never
 * requires firebase-admin itself, so the MCP server can pass its own copy.
 *
 * Data model (see functions/index.js):
 *   /users/{ADMIN_UID}/jobs/*                      shared job corpus (last ~3 days)
 *   /users/{uid}/aggregations/myJobScores          this user's match scores
 *   /users/{uid}/jobScores/{jobId}                 the full assessment behind a score
 *   /users/{uid}/resume/profile                    parsed resume
 *   /users/{uid}/settings/preferences              jobTypes, aiScoringEnabled
 *   /users/{uid}/settings/assistantMemory          notes the assistant keeps about the user
 */

const { classifyTitle, familiesForProfile, familyLabel, FAMILY_IDS } = require("./jobFamilies.cjs");
const { CITY_COORDS, CITY_CANONICAL, STATE_TO_ABBR } = require("./locationNormalizer.cjs");
const { needsSponsorship } = require("./eligibility.cjs");
const { recentTitlesOf, candidateYearsOf } = require("./jobFit.cjs");

const ADMIN_UID = "7Tojjo8l5PZIYctPmdwncf7PC133";
const PT = "America/Los_Angeles";

// Jobs expire 3 days after posting (TTL_DAYS in index.js), so a wider window buys nothing.
const MAX_WINDOW_HOURS = 24 * 7;
const DEFAULT_WINDOW_HOURS = 72;
const MAX_SCAN = 9000; // most jobs ever in the corpus at once
const MAX_LIMIT = 30;
const MAX_MEMORY_NOTES = 30;

const JOB_FIELDS = [
  "title", "companyName", "companyKey", "locationName", "stateCodes", "isRemote", "workplaceType",
  "source", "jobUrl", "applyUrl", "sourceUpdatedTs", "firstSeenAt", "el",
];

const ABBR_TO_STATE = Object.fromEntries(Object.entries(STATE_TO_ABBR).map(([name, abbr]) => [abbr, name]));

// Metro areas people ask about by nickname → the cities to match in locationName.
const METROS = {
  "bay area": ["san francisco", "san jose", "palo alto", "mountain view", "sunnyvale", "santa clara", "san mateo", "redwood city", "menlo park", "oakland", "fremont", "cupertino", "berkeley", "foster city", "south san francisco", "burlingame", "milpitas", "emeryville", "san bruno"],
  "sf bay area": "bay area",
  "silicon valley": ["san jose", "palo alto", "mountain view", "sunnyvale", "santa clara", "cupertino", "menlo park", "redwood city", "milpitas", "los altos"],
  "seattle area": ["seattle", "bellevue", "redmond", "kirkland", "bothell"],
  "greater seattle": "seattle area",
  "puget sound": "seattle area",
  "nyc": ["new york", "brooklyn", "manhattan", "jersey city", "long island city"],
  "new york city": "nyc",
  "la": ["los angeles", "santa monica", "culver city", "pasadena", "burbank", "el segundo", "irvine", "long beach", "playa vista"],
  "los angeles area": "la",
  "greater los angeles": "la",
  "socal": ["los angeles", "san diego", "irvine", "santa monica", "pasadena", "long beach", "costa mesa", "santa ana", "burbank", "el segundo"],
  "southern california": "socal",
  "dc area": ["washington", "arlington", "alexandria", "reston", "mclean", "tysons", "bethesda", "herndon"],
  "dmv": "dc area",
  "dfw": ["dallas", "fort worth", "plano", "irving", "frisco", "richardson"],
  "dallas-fort worth": "dfw",
  "research triangle": ["raleigh", "durham", "chapel hill", "cary", "morrisville"],
  "rtp": "research triangle",
  "boston area": ["boston", "cambridge", "somerville", "waltham", "burlington", "lexington"],
  "greater boston": "boston area",
  "chicagoland": ["chicago", "evanston", "naperville", "schaumburg"],
  "twin cities": ["minneapolis", "st. paul", "saint paul"],
  "phoenix area": ["phoenix", "scottsdale", "tempe", "chandler", "mesa"],
  "denver area": ["denver", "boulder", "aurora", "broomfield", "englewood"],
  "atlanta area": ["atlanta", "alpharetta", "marietta"],
  "austin area": ["austin", "round rock"],
};

/* ------------------------------------------------------------------ */
/* Pure helpers (unit-tested in test/assistantTools.test.cjs)          */
/* ------------------------------------------------------------------ */

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

/** "CA, texas; New York" → ["CA", "TX", "NY"]. Unknown names are dropped. */
function parseStates(input) {
  if (!input) return [];
  const list = Array.isArray(input) ? input : String(input).split(/[,;/|]+|\band\b/i);
  const out = [];
  for (const raw of list) {
    const t = norm(raw).replace(/^(state of|in)\s+/, "").replace(/\bstate$/, "").trim();
    if (!t) continue;
    let code = null;
    if (/^[a-z]{2}$/.test(t) && ABBR_TO_STATE[t.toUpperCase()]) code = t.toUpperCase();
    else if (STATE_TO_ABBR[t]) code = STATE_TO_ABBR[t];
    else if (t === "washington dc" || t === "washington d.c." || t === "district of columbia") code = "DC";
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * A city (or metro nickname) → { cities: lowercase names to match in locationName,
 * states: the state codes those cities are in, when known }.
 */
function parseCity(input) {
  const t = norm(input).replace(/,.*$/, "").replace(/\b(metro|area|region|greater)\b/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return { cities: [], states: [] };
  let metro = METROS[t] || METROS[norm(input)];
  while (typeof metro === "string") metro = METROS[metro];
  const cities = metro ? [...metro] : [norm(CITY_CANONICAL[t] || t)];
  const states = new Set();
  for (const c of cities) {
    const hit = CITY_COORDS[c];
    if (hit?.state) states.add(hit.state);
  }
  return { cities, states: [...states] };
}

/** "software engineer, backend" → [["software","engineer"],["backend"]]: any phrase, all its words. */
function parseKeywords(input) {
  if (!input) return [];
  const list = Array.isArray(input) ? input : String(input).split(/[,;|]+|\bor\b/i);
  return list.map((p) => norm(p).replace(/[^a-z0-9+#. ]/g, " ").split(" ").filter(Boolean)).filter((w) => w.length);
}

function titleMatches(title, phrases) {
  if (!phrases.length) return true;
  const t = ` ${norm(title).replace(/[^a-z0-9+#. ]/g, " ")} `;
  return phrases.some((words) => words.every((w) => t.includes(w.length <= 3 ? ` ${w} ` : w)));
}

function locationMatches(job, cities) {
  if (!cities.length) return true;
  const loc = norm(job.locationName);
  return cities.some((c) => loc.includes(c));
}

/** Same rule as src/lib/jobRelevanceCore.js: is this job one the user would want to see? */
function isRelatedJob(job, score, jobTypes, { needsSponsorship: sponsorship = false } = {}) {
  if (sponsorship && Array.isArray(job?.el) && job.el.length) return false;
  if (score?.o) return false;
  if (score && score.t !== undefined && score.m !== "r") return false;
  if (score?.k) return true;
  if (!jobTypes || jobTypes.length === 0) return true;
  const fam = Array.isArray(job?.fam) ? job.fam : null;
  if (!fam || fam.length === 0) return true;
  return fam.some((f) => jobTypes.includes(f));
}

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v.toDate === "function") return v.toDate();
  if (typeof v._seconds === "number") return new Date(v._seconds * 1000);
  if (typeof v.seconds === "number") return new Date(v.seconds * 1000);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtPT(d) {
  if (!d) return null;
  return d.toLocaleString("en-US", { timeZone: PT, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) + " PT";
}

function hoursAgo(d, now = new Date()) {
  if (!d) return null;
  return Math.max(0, Math.round(((now - d) / 3600000) * 10) / 10);
}

function agoText(h) {
  if (h == null) return "unknown";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
  if (h < 48) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function typeLabels(fam) {
  return (fam || []).map((f) => familyLabel(f)).filter(Boolean);
}

function stripHtml(s) {
  return String(s || "")
    .replace(/<(br|\/p|\/li|\/h[1-6]|\/div|\/tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, "\"")
    .split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/* ------------------------------------------------------------------ */
/* Tool definitions (OpenAI function-calling shape)                    */
/* ------------------------------------------------------------------ */

const TYPE_LIST = FAMILY_IDS.map((id) => `${id} (${familyLabel(id)})`).join(", ");

const COMMON_FILTERS = {
  keywords: { type: "string", description: "Words to find in the job title. Comma-separate alternatives: 'software engineer, backend developer' matches either phrase. Leave empty for all titles." },
  company: { type: "string", description: "Company name (partial match), e.g. 'Nvidia'." },
  state: { type: "string", description: "US state name or code, comma-separated for several: 'California', 'CA, WA', 'Texas'. Use this for state questions." },
  city: { type: "string", description: "City or metro: 'Seattle', 'San Francisco', 'Bay Area', 'NYC', 'DC area', 'Austin'. Use this for city questions." },
  remote: { type: "boolean", description: "true = only remote jobs, false = exclude remote. Omit for both." },
  postedWithinHours: { type: "number", description: `How far back to look, in hours. 'today' / 'latest' / 'past 24 hours' = 24, 'this week' = 168. Default ${DEFAULT_WINDOW_HOURS}, max ${MAX_WINDOW_HOURS} (older jobs are no longer stored).` },
  jobTypes: { type: "array", items: { type: "string", enum: FAMILY_IDS }, description: `Only these job types: ${TYPE_LIST}.` },
  onlyRelevantToMe: { type: "boolean", description: "Default true: only jobs of the user's targeted types they are eligible for. Set false when the user wants everything regardless of fit." },
  minScore: { type: "number", description: "Only jobs whose match score for this user is at least this (0-100). 60 = solid match, 80 = strong." },
};

const TOOL_DEFS = [
  {
    name: "search_jobs",
    description: "Search the tracked job postings (about the last 3 days across ~1,300 company career sites). Supports state, city/metro, remote, time window, title keywords, company, job type and the user's match score. ALWAYS call this before saying there are no jobs. Returns counts plus a page of jobs, newest first or best match first.",
    parameters: {
      type: "object",
      properties: {
        ...COMMON_FILTERS,
        sortBy: { type: "string", enum: ["newest", "score"], description: "newest (default) or score = best match for this user first." },
        limit: { type: "number", description: `Jobs to return (default 10, max ${MAX_LIMIT}).` },
        offset: { type: "number", description: "Skip this many results, for 'show me more'." },
      },
    },
  },
  {
    name: "job_stats",
    description: "Counts and breakdowns over the tracked jobs: how many came in today, which states/cities/companies/job types have the most, jobs per day. Accepts the same filters as search_jobs.",
    parameters: {
      type: "object",
      properties: {
        ...COMMON_FILTERS,
        groupBy: { type: "string", enum: ["state", "city", "company", "jobType", "day", "source", "remote", "scoreBand"], description: "What to break the count down by. Omit for totals only." },
        top: { type: "number", description: "How many groups to return (default 15, max 50)." },
      },
    },
  },
  {
    name: "get_job_details",
    description: "Full details for one job by its id (from search results): description, requirements coverage for this user, visa notes, links. Use when the user asks about a specific job or 'tell me more about #2'.",
    parameters: {
      type: "object",
      properties: { jobId: { type: "string", description: "The job id from search_jobs." } },
      required: ["jobId"],
    },
  },
  {
    name: "get_my_profile",
    description: "What JobWatch knows about this user: name, recent titles, years of experience, skills, targeted job types, location preferences, visa sponsorship need, and how their scored jobs are distributed. Use before advising on fit or when the user asks what you know about them.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "list_tracked_companies",
    description: "Which companies / career sites JobWatch tracks, optionally filtered by name. Use for 'do you track X?' and 'which companies do you watch?'.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Company name to look for (partial match)." },
        limit: { type: "number", description: "Max matches to return (default 25, max 100)." },
      },
    },
  },
  {
    name: "get_sync_status",
    description: "When jobs were last refreshed and how the recent sync runs went. Syncs run automatically about every 15 minutes.",
    parameters: {
      type: "object",
      properties: { limit: { type: "number", description: "How many recent runs (default 3, max 10)." } },
    },
  },
  {
    name: "update_memory",
    description: "Remember something about the user for future conversations (preferences like 'wants remote roles in Seattle', 'interviewing at Stripe', 'prefers backend'), or forget a note. Use when the user tells you something worth keeping, or asks you to remember/forget.",
    parameters: {
      type: "object",
      properties: {
        add: { type: "string", description: "A short note to remember (one sentence)." },
        remove: { type: "string", description: "Text of an existing note to forget (partial match)." },
      },
    },
  },
];

/** MCP wants `inputSchema`; OpenAI wants `parameters`. */
const toolsForOpenAI = () => TOOL_DEFS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
const toolsForMcp = () => TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }));

/* ------------------------------------------------------------------ */
/* Context: per-request caches for one user                            */
/* ------------------------------------------------------------------ */

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} userId  the person asking
 */
function createAssistantContext(db, userId, { adminUid = ADMIN_UID, now = () => new Date() } = {}) {
  const cache = {};
  const userRef = db.collection("users").doc(userId);

  async function userDoc() {
    if (!cache.user) cache.user = userRef.get().then((s) => (s.exists ? s.data() : {}));
    return cache.user;
  }
  async function profile() {
    if (!cache.profile) cache.profile = userRef.collection("resume").doc("profile").get().then((s) => (s.exists ? s.data() : null));
    return cache.profile;
  }
  async function prefs() {
    if (!cache.prefs) cache.prefs = userRef.collection("settings").doc("preferences").get().then((s) => (s.exists ? s.data() : {}));
    return cache.prefs;
  }
  async function scores() {
    if (!cache.scores) cache.scores = userRef.collection("aggregations").doc("myJobScores").get().then((s) => (s.exists ? s.data()?.scores || {} : {}));
    return cache.scores;
  }
  async function memory() {
    if (!cache.memory) cache.memory = userRef.collection("settings").doc("assistantMemory").get().then((s) => (s.exists ? s.data()?.notes || [] : []));
    return cache.memory;
  }
  async function jobTypes() {
    const [p, pr] = await Promise.all([profile(), prefs()]);
    const saved = Array.isArray(pr?.jobTypes) ? pr.jobTypes.filter((f) => FAMILY_IDS.includes(f) || f === "engineering_general") : [];
    return saved.length ? saved : familiesForProfile(p);
  }
  async function sponsorship() {
    return needsSponsorship(await userDoc());
  }

  return { db, userId, adminUid, now, userDoc, profile, prefs, scores, memory, jobTypes, sponsorship, _cache: cache };
}

/* ------------------------------------------------------------------ */
/* Job loading + filtering                                             */
/* ------------------------------------------------------------------ */

async function fetchJobsInWindow(ctx, cutoff, stateCodes) {
  const col = ctx.db.collection("users").doc(ctx.adminUid).collection("jobs");
  const base = () => col.where("sourceUpdatedTs", ">=", cutoff).orderBy("sourceUpdatedTs", "desc").select(...JOB_FIELDS);
  const docsOf = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // One state: let Firestore do the filtering (needs the stateCodes+sourceUpdatedTs index;
  // falls back to a full window scan while the index is still building).
  if (stateCodes.length) {
    try {
      const snaps = await Promise.all(stateCodes.map((code) => base().where("stateCodes", "array-contains", code).limit(MAX_SCAN).get()));
      const seen = new Map();
      for (const s of snaps) for (const j of docsOf(s)) seen.set(j.id, j);
      return { jobs: [...seen.values()], indexed: true };
    } catch (err) {
      if (!/index/i.test(err?.message || "")) throw err;
    }
  }
  const snap = await base().limit(MAX_SCAN).get();
  return { jobs: docsOf(snap), indexed: false };
}

/** How many remote jobs were posted in the window (cheap aggregate; 0 if the index is missing). */
async function countRemoteInWindow(ctx, cutoff) {
  try {
    const q = ctx.db.collection("users").doc(ctx.adminUid).collection("jobs").where("isRemote", "==", true).where("sourceUpdatedTs", ">=", cutoff);
    const snap = await q.count().get();
    return snap.data().count || 0;
  } catch {
    return 0;
  }
}

/** Load the jobs that match the common filters, annotated with the user's score and relevance. */
async function loadMatchingJobs(ctx, args) {
  const now = ctx.now();
  const hours = clampInt(args.postedWithinHours, DEFAULT_WINDOW_HOURS, 1, MAX_WINDOW_HOURS);
  const cutoff = new Date(now.getTime() - hours * 3600000);

  const states = parseStates(args.state);
  const cityQ = args.city ? parseCity(args.city) : { cities: [], states: [] };
  const queryStates = states.length ? states : cityQ.states; // "Seattle" → WA narrows the Firestore query
  const phrases = parseKeywords(args.keywords);
  const company = norm(args.company);
  const wantTypes = Array.isArray(args.jobTypes) ? args.jobTypes.filter((f) => FAMILY_IDS.includes(f)) : [];
  const remote = typeof args.remote === "boolean" ? args.remote : null;
  const minScore = Number.isFinite(Number(args.minScore)) ? Number(args.minScore) : null;
  const onlyRelevant = args.onlyRelevantToMe !== false;

  const wantRemoteCount = (queryStates.length || cityQ.cities.length) && remote !== true;
  const [{ jobs: raw }, scores, jobTypes, sponsorship, remoteInWindow] = await Promise.all([
    fetchJobsInWindow(ctx, cutoff, queryStates),
    ctx.scores(), ctx.jobTypes(), ctx.sponsorship(),
    wantRemoteCount ? countRemoteInWindow(ctx, cutoff) : Promise.resolve(0),
  ]);

  const all = [];
  for (const j of raw) {
    const posted = toDate(j.sourceUpdatedTs);
    if (!posted || posted < cutoff) continue;
    if (queryStates.length && !(j.stateCodes || []).some((c) => queryStates.includes(c))) continue;
    if (!locationMatches(j, cityQ.cities)) continue;
    if (remote === true && !j.isRemote) continue;
    if (remote === false && j.isRemote) continue;
    if (company && !norm(j.companyName).includes(company)) continue;
    if (!titleMatches(j.title, phrases)) continue;
    const fam = classifyTitle(j.title);
    if (wantTypes.length && !fam.some((f) => wantTypes.includes(f))) continue;
    const score = scores[j.id] || null;
    const related = isRelatedJob({ ...j, fam }, score, jobTypes, { needsSponsorship: sponsorship });
    all.push({ ...j, fam, posted, score, related });
  }

  let relevant = all.filter((j) => j.related);
  if (minScore != null) relevant = relevant.filter((j) => (j.score?.score ?? -1) >= minScore);
  let chosen = onlyRelevant ? relevant : (minScore != null ? all.filter((j) => (j.score?.score ?? -1) >= minScore) : all);
  let note = null;
  if (onlyRelevant && chosen.length === 0 && all.length > 0) {
    chosen = minScore != null ? [] : all;
    note = minScore != null
      ? `No job in this set has a match score of ${minScore}+ for you yet. ${all.length} jobs matched the other filters.`
      : `None of the ${all.length} matching jobs are in the user's targeted job types (or they are visa-blocked), so all of them are returned. Say so.`;
  }

  return {
    now, hours, cutoff, states: queryStates, cities: cityQ.cities, phrases, company, remote, minScore, onlyRelevant,
    all, relevant, chosen, note, remoteInWindow, jobTypes, sponsorship,
  };
}

function presentJob(j, now) {
  const h = hoursAgo(j.posted, now);
  const out = {
    id: j.id,
    title: j.title,
    company: j.companyName || "Unknown",
    location: j.locationName || (j.isRemote ? "Remote" : "Not listed"),
    remote: j.isRemote === true,
    posted: fmtPT(j.posted),
    postedAgo: agoText(h),
    types: typeLabels(j.fam),
    url: j.jobUrl || j.applyUrl || null,
  };
  if (j.score) {
    out.myScore = j.score.score;
    if (j.score.reason) out.myScoreReason = j.score.reason;
  }
  if (Array.isArray(j.el) && j.el.length) out.visaFlags = j.el;
  return out;
}

function describeFilters(m, args) {
  const f = [];
  if (m.states.length) f.push(`state ${m.states.map((c) => ABBR_TO_STATE[c] ? `${c} (${ABBR_TO_STATE[c]})` : c).join(", ")}`);
  if (m.cities.length) f.push(`city ${args.city}`);
  if (m.remote === true) f.push("remote only");
  if (m.remote === false) f.push("no remote");
  if (m.phrases.length) f.push(`title has ${args.keywords}`);
  if (m.company) f.push(`company ${args.company}`);
  if (Array.isArray(args.jobTypes) && args.jobTypes.length) f.push(`types ${args.jobTypes.join(", ")}`);
  if (m.minScore != null) f.push(`match score ≥ ${m.minScore}`);
  f.push(`posted in the last ${m.hours} hours (since ${fmtPT(m.cutoff)})`);
  return f.join("; ");
}

/* ------------------------------------------------------------------ */
/* Tool implementations                                                */
/* ------------------------------------------------------------------ */

async function searchJobs(ctx, args = {}) {
  const m = await loadMatchingJobs(ctx, args);
  const limit = clampInt(args.limit, 10, 1, MAX_LIMIT);
  const offset = clampInt(args.offset, 0, 0, 100000);
  const sorted = [...m.chosen];
  if (args.sortBy === "score") sorted.sort((a, b) => ((b.score?.score ?? -1) - (a.score?.score ?? -1)) || (b.posted - a.posted));
  else sorted.sort((a, b) => b.posted - a.posted);
  const page = sorted.slice(offset, offset + limit);
  const out = {
    filters: describeFilters(m, args),
    counts: {
      matchingFilters: m.all.length,
      relevantToUser: m.relevant.length,
      returned: page.length,
      offset,
      hasMore: offset + page.length < sorted.length,
    },
    jobs: page.map((j) => presentJob(j, m.now)),
  };
  if (m.note) out.note = m.note;
  if (m.remoteInWindow) out.alsoRemote = `${m.remoteInWindow} remote jobs (any state) were posted in this window; search with remote=true to see them.`;
  if (args.state && !m.states.length && !m.cities.length) out.warning = `Could not understand state '${args.state}'. Use a US state name or code.`;
  return out;
}

function scoreBand(s) {
  if (s == null) return "not scored yet";
  if (s >= 80) return "80-100 strong match";
  if (s >= 60) return "60-79 good match";
  if (s >= 40) return "40-59 partial match";
  return "0-39 weak match";
}

async function jobStats(ctx, args = {}) {
  const m = await loadMatchingJobs(ctx, args);
  const top = clampInt(args.top, 15, 1, 50);
  const groupBy = args.groupBy;
  const set = m.chosen;
  const out = {
    filters: describeFilters(m, args),
    counts: { matchingFilters: m.all.length, relevantToUser: m.relevant.length, counted: set.length },
  };
  if (m.note) out.note = m.note;
  if (groupBy) {
    const counts = new Map();
    const bump = (k) => counts.set(k, (counts.get(k) || 0) + 1);
    for (const j of set) {
      switch (groupBy) {
        case "state": (j.stateCodes?.length ? j.stateCodes : [j.isRemote ? "Remote (no state)" : "Unknown"]).forEach(bump); break;
        case "city": bump(j.locationName ? j.locationName.split(/[;|]/)[0].trim() : (j.isRemote ? "Remote" : "Unknown")); break;
        case "company": bump(j.companyName || "Unknown"); break;
        case "jobType": (j.fam.length ? typeLabels(j.fam) : ["Other / unclassified"]).forEach(bump); break;
        case "day": bump(j.posted.toLocaleDateString("en-US", { timeZone: PT, weekday: "short", month: "short", day: "numeric" })); break;
        case "source": bump(j.source || "unknown"); break;
        case "remote": bump(j.isRemote ? "Remote" : "On-site / hybrid"); break;
        case "scoreBand": bump(scoreBand(j.score?.score)); break;
        default: bump("all");
      }
    }
    out.groupBy = groupBy;
    out.groups = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([key, count]) => ({ key, count }));
    out.groupCount = counts.size;
  }
  return out;
}

async function getJobDetails(ctx, args = {}) {
  const jobId = String(args.jobId || "").trim();
  if (!jobId) return { error: "jobId is required." };
  const [snap, fitSnap, scores] = await Promise.all([
    ctx.db.collection("users").doc(ctx.adminUid).collection("jobs").doc(jobId).get(),
    ctx.db.collection("users").doc(ctx.userId).collection("jobScores").doc(jobId).get(),
    ctx.scores(),
  ]);
  if (!snap.exists) return { error: "That job is no longer stored (postings are kept for about 3 days)." };
  const j = { id: snap.id, ...snap.data() };
  const posted = toDate(j.sourceUpdatedTs);
  const fam = classifyTitle(j.title);
  const out = presentJob({ ...j, fam, posted, score: scores[jobId] || null }, ctx.now());
  out.applyUrl = j.applyUrl || null;
  out.workplaceType = j.workplaceType || null;
  out.source = j.source || null;
  if (j.meta && typeof j.meta === "object") {
    out.meta = Object.fromEntries(Object.entries(j.meta).filter(([, v]) => typeof v === "string" || typeof v === "number").slice(0, 12));
  }
  const desc = stripHtml(j.fullDescription || j.description || "");
  out.description = desc ? desc.slice(0, 5000) + (desc.length > 5000 ? "\n…(truncated)" : "") : "No description stored.";
  const fit = fitSnap.exists ? fitSnap.data()?.fit : null;
  if (fit) {
    out.myAssessment = {
      score: fit.score, method: fit.method === "rule" ? "rule-based (AI pending)" : "AI", roleFit: fit.roleFit, seniorityFit: fit.seniorityFit,
      minYears: fit.minYears, candidateYears: fit.candidateYears, capNote: fit.capNote || null,
      requirements: (fit.requirements || []).slice(0, 25).map((r) => ({ requirement: r.requirement, need: r.need, covered: r.covered, evidence: r.evidence || "" })),
    };
  }
  if (Array.isArray(j.el) && j.el.length) {
    out.visaNote = `This posting mentions: ${j.el.join(", ")}.` + ((await ctx.sponsorship()) ? " The user needs sponsorship, so this job is normally hidden from them." : "");
  }
  return out;
}

async function getMyProfile(ctx) {
  const [u, p, jobTypes, sponsorship, scores] = await Promise.all([ctx.userDoc(), ctx.profile(), ctx.jobTypes(), ctx.sponsorship(), ctx.scores()]);
  const vals = Object.values(scores).map((s) => s?.score).filter((s) => typeof s === "number");
  const groups = Array.isArray(p?.skillGroups) && p.skillGroups.length ? p.skillGroups : (p?.skills?.length ? [{ label: "Skills", skills: p.skills }] : []);
  return {
    name: [u.firstName || u.preferredName, u.lastName].filter(Boolean).join(" ") || u.fullName || null,
    preferredName: u.preferredName || u.firstName || null,
    email: u.email || null,
    location: [u.city, u.region].filter(Boolean).join(", ") || u.location || null,
    metroAreas: Array.isArray(u.metroAreas) ? u.metroAreas : (u.metroArea ? [u.metroArea] : []),
    willingToRelocate: u.willingToRelocate ?? null,
    willingToWorkHybrid: u.willingToWorkHybrid ?? null,
    needsVisaSponsorship: sponsorship,
    visaStatus: u.visaStatus || null,
    currentCompany: u.currentCompany || null,
    resumeUploaded: Boolean(p && (p.roles?.length || p.rawText)),
    recentTitles: recentTitlesOf(p),
    yearsOfExperience: p ? Math.round(candidateYearsOf(p) * 10) / 10 : null,
    summary: p?.summary ? String(p.summary).replace(/\*\*/g, "").slice(0, 600) : null,
    skills: groups.slice(0, 8).map((g) => ({ group: g.label, skills: (g.skills || []).slice(0, 15) })),
    roles: (p?.roles || []).slice(0, 5).map((r) => ({ title: r.title, company: r.company, dates: [r.startDate, r.endDate].filter(Boolean).join(" – ") })),
    education: (p?.education || []).slice(0, 3).map((e) => [e.degree, e.institution].filter(Boolean).join(", ")),
    targetedJobTypes: jobTypes.map((f) => ({ id: f, label: familyLabel(f) })),
    scoredJobs: {
      total: vals.length,
      strong80plus: vals.filter((s) => s >= 80).length,
      good60to79: vals.filter((s) => s >= 60 && s < 80).length,
      partial40to59: vals.filter((s) => s >= 40 && s < 60).length,
    },
  };
}

async function listTrackedCompanies(ctx, args = {}) {
  const q = norm(args.query);
  const limit = clampInt(args.limit, 25, 1, 100);
  const snap = await ctx.db.collection("users").doc(ctx.adminUid).collection("aggregations").doc("feedList").get();
  let feeds = snap.exists ? Object.entries(snap.data()?.feeds || {}) : [];
  if (!feeds.length) {
    const s = await ctx.db.collection("users").doc(ctx.adminUid).collection("feeds").where("archivedAt", "==", null).select("companyName", "company", "source", "lastError", "url").get();
    feeds = s.docs.map((d) => [d.id, d.data()]);
  }
  const rows = feeds.map(([id, f]) => ({ id, company: f.companyName || f.company || "", source: f.source || "", failing: Boolean(f.lastError), url: f.url || "" }));
  const bySource = {};
  for (const r of rows) bySource[r.source || "unknown"] = (bySource[r.source || "unknown"] || 0) + 1;
  const matches = (q ? rows.filter((r) => norm(r.company).includes(q) || norm(r.url).includes(q)) : rows)
    .sort((a, b) => a.company.localeCompare(b.company));
  return {
    totalTracked: rows.length,
    bySource,
    matchCount: matches.length,
    companies: matches.slice(0, limit).map(({ company, source, failing }) => ({ company, source, ...(failing ? { failing: true } : {}) })),
  };
}

async function getSyncStatus(ctx, args = {}) {
  const limit = clampInt(args.limit, 3, 1, 10);
  const snap = await ctx.db.collection("users").doc(ctx.adminUid).collection("syncRuns").orderBy("startedAt", "desc").limit(limit).get();
  const now = ctx.now();
  const runs = snap.docs.map((d) => {
    const x = d.data();
    const started = toDate(x.startedAt);
    const finished = toDate(x.finishedAt);
    const row = { startedAt: fmtPT(started), startedAgo: agoText(hoursAgo(started, now)), status: x.status || null, ok: x.ok ?? null, runType: x.runType || null };
    if (finished) row.durationSec = Math.round((finished - started) / 1000);
    for (const [k, v] of Object.entries(x)) {
      if (["startedAt", "finishedAt", "ranAt", "expireAt", "userId", "status", "ok", "runType", "source", "recentCutoffIso"].includes(k)) continue;
      if (typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length < 200)) row[k] = v;
    }
    return row;
  });
  return { schedule: "Automatic sync about every 15 minutes; jobs are kept for 3 days after they are posted.", runs };
}

async function updateMemory(ctx, args = {}) {
  const ref = ctx.db.collection("users").doc(ctx.userId).collection("settings").doc("assistantMemory");
  let notes = [...(await ctx.memory())];
  const add = String(args.add || "").trim().slice(0, 240);
  const remove = norm(args.remove);
  let removed = 0;
  if (remove) {
    const before = notes.length;
    notes = notes.filter((n) => !norm(n).includes(remove));
    removed = before - notes.length;
  }
  if (add && !notes.some((n) => norm(n) === norm(add))) notes.push(add);
  notes = notes.slice(-MAX_MEMORY_NOTES);
  await ref.set({ notes, updatedAt: new Date() }, { merge: true });
  ctx._cache.memory = Promise.resolve(notes);
  return { ok: true, added: add || null, removed, notes };
}

async function runTool(ctx, name, args = {}) {
  switch (name) {
    case "search_jobs": return searchJobs(ctx, args);
    case "job_stats": return jobStats(ctx, args);
    case "get_job_details": return getJobDetails(ctx, args);
    case "get_my_profile": return getMyProfile(ctx);
    case "list_tracked_companies": return listTrackedCompanies(ctx, args);
    case "get_sync_status": return getSyncStatus(ctx, args);
    case "update_memory": return updateMemory(ctx, args);
    default: return { error: `Unknown tool: ${name}` };
  }
}

/* ------------------------------------------------------------------ */
/* System prompt                                                       */
/* ------------------------------------------------------------------ */

async function buildSystemPrompt(ctx) {
  const [u, p, jobTypes, sponsorship, notes] = await Promise.all([ctx.userDoc(), ctx.profile(), ctx.jobTypes(), ctx.sponsorship(), ctx.memory()]);
  const now = ctx.now();
  const nowPT = now.toLocaleString("en-US", { timeZone: PT, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" });
  const name = u.preferredName || u.firstName || null;
  const titles = recentTitlesOf(p);
  const years = p ? Math.round(candidateYearsOf(p) * 10) / 10 : null;

  const who = [
    name ? `Name: ${name}` : null,
    titles.length ? `Recent titles: ${titles.join("; ")}` : "No resume uploaded yet (suggest uploading one on the Profile page when fit comes up).",
    years ? `About ${years} years of experience` : null,
    jobTypes.length ? `Targeted job types: ${jobTypes.map(familyLabel).join(", ")}` : null,
    (u.city || u.region) ? `Lives in ${[u.city, u.region].filter(Boolean).join(", ")}` : null,
    Array.isArray(u.metroAreas) && u.metroAreas.length ? `Preferred metros: ${u.metroAreas.join(", ")}` : null,
    sponsorship ? "Needs visa sponsorship: jobs that require citizenship, clearance or say no sponsorship are hidden from them." : "Does not need visa sponsorship.",
    u.willingToRelocate != null ? `Willing to relocate: ${u.willingToRelocate}` : null,
  ].filter(Boolean).join("\n");

  return `You are JobWatch AI, the in-app assistant of JobWatch, a personal job tracker that watches about 1,300 company career sites (Greenhouse, Ashby, Lever, Workday, SmartRecruiters and more), stores every posting from the last 3 days, and scores each one against the user's resume (0-100 match score).

CURRENT TIME: ${nowPT}. All dates and times you say are Pacific Time. "Today", "latest", "new", "recent" and "past 24 hours" mean postedWithinHours=24; "this week" means 168.

ABOUT THE USER
${who}
${notes.length ? `\nTHINGS TO REMEMBER ABOUT THEM (from earlier conversations)\n${notes.map((n) => `- ${n}`).join("\n")}` : ""}

HOW TO BEHAVE
- You are talking to a person in the middle of a job search. That is stressful. Read the feeling behind each message: frustration ("still nothing?"), anxiety, disappointment, excitement, tiredness. Acknowledge it in one natural sentence when it is there, then help. Be warm and human, never saccharine, never lecturing, no therapy clichés, no exclamation-mark spam. Celebrate real wins (a strong match, an interview) briefly and genuinely. If they are discouraged, give them something concrete: counts, strong matches, next steps.
- This is one continuous conversation. Every message continues the previous ones. A short follow-up such as "in past 24Hrs?", "and remote?", "what about Texas?", "only backend", "show more" changes ONE thing about the previous request: keep every other filter (place, keywords, type, window) from the last search and change only what they asked. Never ask them to repeat something they already said. "Show more" = same search with offset advanced.
- Use tools for facts. NEVER say there are no jobs, no matches or no data without calling search_jobs or job_stats with the right filters first. Places: a US state → state; a city or metro → city (Seattle, Bay Area, NYC, DC area…); "remote" → remote=true. Company names → company. Role words → keywords or jobTypes.
- If a search returns 0 results, before answering retry once with a broader window (72 or 168 hours) or onlyRelevantToMe=false, then tell them exactly what you tried ("nothing in Seattle in the last 24 hours, but 12 in the last 3 days").
- "How many", "which companies", "breakdown", "busiest" → job_stats with groupBy. "Best matches", "what fits me" → search_jobs sortBy=score (minScore 60 unless told otherwise). "Tell me more about #2 / that Nvidia one" → get_job_details with the id from the earlier list.
- When they share a preference or a life update (interviewing somewhere, only wants remote, moving to Austin), save it with update_memory so you remember next time, and say you noted it.
- Never invent jobs, companies, URLs, scores or dates. Only report what tools returned. Do not repeat the raw user id or internal ids in prose.

FORMAT
- Markdown, compact. Lead with the answer, then the list.
- Job list: numbered, one job per item:
  **Title** — Company · Location · posted 3 h ago · match 78% · [View job](url)
  Omit "match" when there is no score. Keep the score reason out unless asked.
- Show at most 10 jobs unless asked for more; then say how many matched in total and offer more.
- When counts differ, explain plainly: "1,041 jobs in California in the last 24 hours, 212 of them in your job types; here are the newest 10."
- Short answers for short questions. No headers for short replies. No sign-off lines like "let me know if…".`;
}

module.exports = {
  ADMIN_UID,
  TOOL_DEFS,
  toolsForOpenAI,
  toolsForMcp,
  createAssistantContext,
  runTool,
  buildSystemPrompt,
  // exported for tests
  parseStates,
  parseCity,
  parseKeywords,
  titleMatches,
  locationMatches,
  isRelatedJob,
  stripHtml,
  fmtPT,
  agoText,
  METROS,
};
