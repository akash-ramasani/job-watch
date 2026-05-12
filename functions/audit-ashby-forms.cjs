#!/usr/bin/env node
/**
 * audit-ashby-forms.js  (TEMP / ONE-OFF TOOL)
 *
 * Queries Firestore for every Ashby job saved in the last 24 hours,
 * fetches the raw application-form HTML for each, and writes it to:
 *   ashby_html_files/YYYY-MM-DDTHH-MM-SS_{CompanyKey}_{ExternalId}.html
 *
 * Usage:
 *   cd /path/to/job-watch
 *   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json node scripts/audit-ashby-forms.js
 *
 * Optional env vars:
 *   HOURS=48            — look back N hours instead of 24
 *   CONCURRENCY=5       — parallel fetches (default 3)
 *   OUT_DIR=./my_forms  — output directory (default ./ashby_html_files)
 */

const admin  = require("firebase-admin");
const https  = require("https");
const http   = require("http");
const fs     = require("fs");
const path   = require("path");

// ── Config ────────────────────────────────────────────────────────────────────
const HOURS       = parseInt(process.env.HOURS       || "24",  10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "3",   10);
const OUT_DIR     = path.resolve(process.env.OUT_DIR  || path.join(__dirname, "..", "ashby_html_files"));

const CUTOFF_MS   = Date.now() - HOURS * 60 * 60 * 1000;

// ── Init Firebase Admin ───────────────────────────────────────────────────────
const KEY_CANDIDATES = [
  process.env.GOOGLE_APPLICATION_CREDENTIALS,
  path.join(__dirname, "serviceAccountKey.json"),
  path.join(__dirname, "..", "serviceAccountKey.json"),
].filter(Boolean);

const keyPath = KEY_CANDIDATES.find((p) => fs.existsSync(p));

if (!keyPath) {
  console.error(`
❌  No service account key found.

To generate one:
  1. Go to: https://console.firebase.google.com/project/greenhouse-jobs-scrapper/settings/serviceaccounts/adminsdk
  2. Click "Generate new private key"
  3. Save the downloaded JSON as:
       ${path.join(__dirname, "serviceAccountKey.json")}
  4. Re-run this script.

Or set:  GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json node audit-ashby-forms.cjs
`);
  process.exit(1);
}

console.log(`🔑  Using credentials: ${keyPath}`);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require(keyPath)),
    projectId: "greenhouse-jobs-scrapper",
  });
}
const db = admin.firestore();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Sanitize a string for use as a filename */
function safe(str) {
  return String(str || "unknown")
    .replace(/[^a-zA-Z0-9_\-\.]/g, "_")
    .substring(0, 60);
}

/** Fetch raw HTML from a URL (follows up to 5 redirects) */
function fetchRaw(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("Too many redirects: " + url));

    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    }, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const location = res.headers["location"];
        if (!location) return reject(new Error(`Redirect with no Location header from ${url}`));
        const nextUrl = location.startsWith("http") ? location : new URL(location, url).href;
        res.resume();
        return resolve(fetchRaw(nextUrl, redirectCount + 1));
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end",  ()  => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });

    req.on("error", reject);
    req.setTimeout(20_000, () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}

/** Run an array of async tasks with a max concurrency limit */
async function pLimit(tasks, limit) {
  const results = [];
  let i = 0;

  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      try {
        results[idx] = await tasks[idx]();
      } catch (e) {
        results[idx] = { error: e.message };
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🔍  Auditing Ashby forms from last ${HOURS}h`);
  console.log(`    Cutoff : ${new Date(CUTOFF_MS).toISOString()}`);
  console.log(`    Output : ${OUT_DIR}\n`);

  // Ensure output directory exists
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ── 1. Find all users ───────────────────────────────────────────────────────
  const usersSnap = await db.collection("users").listDocuments();
  console.log(`👤  Found ${usersSnap.length} user(s)`);

  // ── 2. Collect recent Ashby jobs across all users ───────────────────────────
  const jobs = [];

  for (const userRef of usersSnap) {
    const snap = await userRef
      .collection("jobs")
      .where("source", "==", "ashbyhq")
      .where("createdAt", ">=", admin.firestore.Timestamp.fromMillis(CUTOFF_MS))
      .get();

    snap.forEach((doc) => {
      const d = doc.data();
      jobs.push({
        uid:        userRef.id,
        docId:      doc.id,
        companyKey: d.companyKey   || "unknown",
        externalId: d.externalId  || "",
        title:      d.title        || "",
        jobUrl:     d.jobUrl       || "",
        createdAt:  d.createdAt?.toDate?.()?.toISOString() || "",
      });
    });
  }

  if (jobs.length === 0) {
    console.log("ℹ️   No Ashby jobs found in the last " + HOURS + "h. Done.");
    return;
  }

  console.log(`📋  Found ${jobs.length} Ashby job(s) to audit\n`);

  // ── 3. Print manifest before fetching ──────────────────────────────────────
  jobs.forEach((j, i) => {
    const applyUrl = j.jobUrl ? `${j.jobUrl.replace(/\/$/, "")}/application` : null;
    console.log(`  [${String(i + 1).padStart(3)}] ${j.title}`);
    console.log(`        company : ${j.companyKey}`);
    console.log(`        created : ${j.createdAt}`);
    console.log(`        url     : ${applyUrl || "—"}`);
  });
  console.log();

  // ── 4. Fetch + save raw HTML ────────────────────────────────────────────────
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  const tasks = jobs.map((j) => async () => {
    if (!j.jobUrl) {
      console.warn(`  ⚠️  [${j.docId}] No jobUrl — skipping`);
      return { skipped: true };
    }

    const applyUrl = `${j.jobUrl.replace(/\/$/, "")}/application`;
    const fileName = `${timestamp}_${safe(j.companyKey)}_${safe(j.externalId)}.html`;
    const filePath = path.join(OUT_DIR, fileName);

    // Skip if already saved
    if (fs.existsSync(filePath)) {
      console.log(`  ✓  Already exists: ${fileName}`);
      return { skipped: true, path: filePath };
    }

    process.stdout.write(`  ⬇️  Fetching: ${j.title} (${j.companyKey})…`);

    try {
      const html = await fetchRaw(applyUrl);

      // Prepend a metadata comment so we know where this came from
      const meta = [
        `<!-- AUDIT METADATA`,
        `  Saved    : ${new Date().toISOString()}`,
        `  Title    : ${j.title}`,
        `  Company  : ${j.companyKey}`,
        `  Source   : ashbyhq`,
        `  ExternalId: ${j.externalId}`,
        `  JobUrl   : ${j.jobUrl}`,
        `  ApplyUrl : ${applyUrl}`,
        `  DocId    : ${j.docId}`,
        `  CreatedAt: ${j.createdAt}`,
        `-->`,
      ].join("\n");

      fs.writeFileSync(filePath, meta + "\n" + html, "utf8");
      console.log(` ✅  ${fileName} (${(html.length / 1024).toFixed(1)} KB)`);
      return { ok: true, path: filePath, size: html.length };

    } catch (err) {
      console.log(` ❌  ${err.message}`);

      // Save error stub so we know it was attempted
      const stub = [
        `<!-- AUDIT METADATA`,
        `  Saved    : ${new Date().toISOString()}`,
        `  Title    : ${j.title}`,
        `  Company  : ${j.companyKey}`,
        `  ApplyUrl : ${applyUrl}`,
        `  ERROR    : ${err.message}`,
        `-->`,
        `<p>Fetch failed: ${err.message}</p>`,
      ].join("\n");

      fs.writeFileSync(filePath.replace(".html", ".ERROR.html"), stub, "utf8");
      return { error: err.message };
    }
  });

  const results = await pLimit(tasks, CONCURRENCY);

  // ── 5. Summary ──────────────────────────────────────────────────────────────
  const ok      = results.filter((r) => r?.ok).length;
  const skipped = results.filter((r) => r?.skipped).length;
  const failed  = results.filter((r) => r?.error).length;

  console.log("\n──────────────────────────────────────────");
  console.log(`✅  Saved   : ${ok}`);
  console.log(`⏭️   Skipped : ${skipped}`);
  console.log(`❌  Failed  : ${failed}`);
  console.log(`📁  Output  : ${OUT_DIR}`);
  console.log("──────────────────────────────────────────\n");
}

main().catch((err) => {
  console.error("\n💥  Fatal:", err);
  process.exit(1);
});
