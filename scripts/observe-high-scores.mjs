// observe-high-scores.mjs — observation snapshot for high-scoring jobs.
//
// Finds every job scored above MIN_SCORE in the past DAYS days and saves, per
// job: doc metadata, the full description, the feed (listing) endpoint, and the
// application-form schema fetched live from the ATS public API. Also saves the
// ENTIRE listing JSON of each involved feed endpoint (one file per feed).
//
// Form sources (no extension needed):
//   ashbyhq    → jobs.ashbyhq.com/api/non-user-graphql  op=ApiJobPosting
//   greenhouse → boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}?questions=true
//   eightfold  → no public form API; form is null with a note
//
// Usage: node scripts/observe-high-scores.mjs        (uses worker/service-account.json)
//   env: DAYS=3  MIN_SCORE=65  CONCURRENCY=4

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, ADMIN_UID } from "../worker/lib/firestore.mjs";

const DAYS = Number(process.env.DAYS || 3);
const MIN_SCORE = Number(process.env.MIN_SCORE || 65);
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const CUTOFF_MS = Date.now() - DAYS * 24 * 60 * 60 * 1000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT_DIR = path.join(__dirname, "observations", `high-scores_${ts}`);
const LISTINGS_DIR = path.join(OUT_DIR, "listings");

const safe = (s) => String(s || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 60);
const iso = (t) => t?.toDate?.()?.toISOString() || null;

async function pLimit(tasks, limit) {
  const results = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (i < tasks.length) {
        const idx = i++;
        results[idx] = await tasks[idx]();
      }
    })
  );
  return results;
}

// ── Form fetchers ─────────────────────────────────────────────────────────────

async function fetchAshbyForm(jobUrl, externalId) {
  const m = (jobUrl || "").match(/jobs\.ashbyhq\.com\/([^/]+)/);
  if (!m) throw new Error("cannot parse ashby org from jobUrl: " + jobUrl);
  const org = decodeURIComponent(m[1]);
  const QUERY =
    "query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) { applicationForm { sections { fieldEntries { field isRequired descriptionHtml } } } } }";
  const res = await fetch("https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operationName: "ApiJobPosting",
      variables: { organizationHostedJobsPageName: org, jobPostingId: externalId },
      query: QUERY,
    }),
  });
  if (!res.ok) throw new Error(`ashby graphql HTTP ${res.status}`);
  const json = await res.json();
  const form = json.data?.jobPosting?.applicationForm;
  if (!form) throw new Error("ashby graphql returned no applicationForm");
  return { kind: "ashby-graphql", org, form };
}

async function fetchGreenhouseForm(feedUrl, externalId) {
  const m = (feedUrl || "").match(/\/v1\/boards\/([^/]+)\/jobs/);
  if (!m) throw new Error("cannot parse board token from feed url: " + feedUrl);
  const token = m[1];
  const res = await fetch(
    `https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${externalId}?questions=true`
  );
  if (!res.ok) throw new Error(`greenhouse job HTTP ${res.status}`);
  const data = await res.json();
  return { kind: "greenhouse-questions", token, form: data };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const fdb = await db();
const userRef = fdb.collection("users").doc(ADMIN_UID);

console.log(`Jobs with score > ${MIN_SCORE} scored in the past ${DAYS} days`);
console.log(`Cutoff: ${new Date(CUTOFF_MS).toISOString()}\n`);

const snap = await userRef.collection("jobs").where("relevanceScore", ">", MIN_SCORE).get();
const jobs = snap.docs
  .map((d) => ({ id: d.id, ...d.data() }))
  .filter((x) => {
    const when = x.scoredAt?.toMillis?.() ?? x.fetchedAt?.toMillis?.() ?? 0;
    return when >= CUTOFF_MS;
  })
  .sort((a, b) => b.relevanceScore - a.relevanceScore);

console.log(`Matched ${jobs.length} of ${snap.size} jobs with score > ${MIN_SCORE}\n`);
if (!jobs.length) {
  console.log("Nothing to observe. Done.");
  process.exit(0);
}

await mkdir(LISTINGS_DIR, { recursive: true });

// Feed endpoints for every company involved
const companyKeys = [...new Set(jobs.map((j) => j.companyKey).filter(Boolean))];
const feedByCompany = new Map();
for (let i = 0; i < companyKeys.length; i += 100) {
  const refs = companyKeys.slice(i, i + 100).map((k) => userRef.collection("feeds").doc(k));
  const snaps = await fdb.getAll(...refs);
  snaps.forEach((s) => s.exists && feedByCompany.set(s.id, s.data()));
}

// Save the ENTIRE listing JSON of each feed endpoint (once per feed)
const listingFiles = new Map();
await pLimit(
  companyKeys.map((key) => async () => {
    const feed = feedByCompany.get(key);
    if (!feed?.url) return console.warn(`  ⚠️  no feed url for companyKey ${key}`);
    const file = `${safe(feed.source)}_${safe(feed.company)}_${safe(key)}.json`;
    try {
      const res = await fetch(feed.url);
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { nonJsonBody: text.slice(0, 200000) }; }
      await writeFile(
        path.join(LISTINGS_DIR, file),
        JSON.stringify({ endpoint: feed.url, source: feed.source, company: feed.company, fetchedAt: new Date().toISOString(), httpStatus: res.status, listing: body }, null, 2)
      );
      listingFiles.set(key, file);
      console.log(`  📥 listing saved: ${feed.company} (${feed.source}) → listings/${file}`);
    } catch (e) {
      console.warn(`  ❌ listing fetch failed for ${feed.company}: ${e.message}`);
      listingFiles.set(key, null);
    }
  }),
  CONCURRENCY
);

// Per-job records: metadata + description + endpoint + live application form
const records = await pLimit(
  jobs.map((j) => async () => {
    const feed = feedByCompany.get(j.companyKey);
    const rec = {
      jobDocId: j.id,
      title: j.title || "",
      companyName: j.companyName || "",
      source: j.source || "",
      relevanceScore: j.relevanceScore,
      scoreReason: j.scoreReason || "",
      scoredAt: iso(j.scoredAt),
      fetchedAt: iso(j.fetchedAt),
      externalId: j.externalId || "",
      companyKey: j.companyKey || "",
      jobUrl: j.jobUrl || "",
      locationName: j.locationName || "",
      workplaceType: j.workplaceType || null,
      isRemote: j.isRemote ?? null,
      feedEndpoint: feed?.url || null,
      listingFile: listingFiles.get(j.companyKey) ? `listings/${listingFiles.get(j.companyKey)}` : null,
      description: j.fullDescription || "",
      applicationForm: null,
      formError: null,
    };
    try {
      if (j.source === "ashbyhq") rec.applicationForm = await fetchAshbyForm(j.jobUrl, j.externalId);
      else if (j.source === "greenhouse") rec.applicationForm = await fetchGreenhouseForm(feed?.url, j.externalId);
      else rec.formError = `no public form API for source "${j.source}"`;
    } catch (e) {
      rec.formError = e.message;
    }
    const status = rec.applicationForm ? "✅ form" : `⚠️  ${rec.formError}`;
    console.log(`  ${String(rec.relevanceScore).padStart(3)}  ${rec.companyName} — ${rec.title}  ${status}`);
    return rec;
  }),
  CONCURRENCY
);

await writeFile(
  path.join(OUT_DIR, "jobs.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      criteria: { minScore: MIN_SCORE, days: DAYS, cutoff: new Date(CUTOFF_MS).toISOString() },
      count: records.length,
      jobs: records,
    },
    null,
    2
  )
);

const withForm = records.filter((r) => r.applicationForm).length;
console.log(`\n──────────────────────────────────────────`);
console.log(`Jobs observed : ${records.length}`);
console.log(`Forms fetched : ${withForm}  (failed/none: ${records.length - withForm})`);
console.log(`Listings saved: ${[...listingFiles.values()].filter(Boolean).length} / ${companyKeys.length} feeds`);
console.log(`Output        : ${OUT_DIR}`);
process.exit(0);
