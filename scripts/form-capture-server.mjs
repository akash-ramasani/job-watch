// form-capture-server.mjs — local bridge between the extension and an
// observations folder produced by observe-high-scores.mjs.
//
// Serves the high-score job list to the extension (GET /jobs) and writes each
// browser-rendered form capture it POSTs back (POST /capture) into
// <observations-run>/forms-dom/<jobDocId>.json. Already-captured jobs are
// skipped on the next run, so the capture is resumable.
//
// Usage:
//   node scripts/form-capture-server.mjs [path/to/observations/high-scores_...]
//   (default: the most recent scripts/observations/high-scores_* folder)
//   env: PORT=8899  ONLY_MISSING=1  (only jobs whose API form fetch failed)
//
// Then click "🧾 Capture Forms" in the extension popup.

import http from "node:http";
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 8899);
const ONLY_MISSING = process.env.ONLY_MISSING === "1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Resolve the observations run folder ──────────────────────────────────────
let runDir = process.argv[2];
if (!runDir) {
  const obsDir = path.join(__dirname, "observations");
  const runs = readdirSync(obsDir).filter((d) => d.startsWith("high-scores_")).sort();
  if (!runs.length) throw new Error("no observations/high-scores_* folder found — run observe-high-scores.mjs first");
  runDir = path.join(obsDir, runs[runs.length - 1]);
}
runDir = path.resolve(runDir);
const formsDir = path.join(runDir, "forms-dom");
mkdirSync(formsDir, { recursive: true });

const safe = (s) => String(s || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120);

// ── Build the capture list from jobs.json ────────────────────────────────────
const { jobs } = JSON.parse(readFileSync(path.join(runDir, "jobs.json"), "utf8"));

function applyUrlFor(j) {
  if (j.source === "ashbyhq") return j.jobUrl.replace(/\/$/, "") + "/application";
  if (j.source === "greenhouse") {
    const m = (j.feedEndpoint || "").match(/\/v1\/boards\/([^/]+)\/jobs/);
    if (m) return `https://job-boards.greenhouse.io/${m[1]}/jobs/${j.externalId}`;
  }
  return j.jobUrl || null; // eightfold & fallbacks: the raw job page
}

const list = jobs
  .filter((j) => !ONLY_MISSING || !j.applicationForm)
  .map((j) => ({
    jobDocId: j.jobDocId,
    title: j.title,
    companyName: j.companyName,
    source: j.source,
    externalId: j.externalId,
    relevanceScore: j.relevanceScore,
    applyUrl: applyUrlFor(j),
  }))
  .filter((j) => j.applyUrl);

console.log(`Run folder : ${runDir}`);
console.log(`Jobs       : ${list.length}${ONLY_MISSING ? " (missing API form only)" : ""}`);
console.log(`Captured so far: ${readdirSync(formsDir).length}`);
console.log(`Listening  : http://127.0.0.1:${PORT}  (GET /jobs, POST /capture)\n`);

// ── HTTP server ───────────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

http
  .createServer((req, res) => {
    if (req.method === "OPTIONS") return res.writeHead(204, CORS).end();

    if (req.method === "GET" && req.url === "/jobs") {
      const pending = list.filter((j) => !existsSync(path.join(formsDir, safe(j.jobDocId) + ".json")));
      res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
      return res.end(JSON.stringify(pending));
    }

    if (req.method === "POST" && req.url === "/capture") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const id = safe(body?.job?.jobDocId);
          if (!id || id === "unknown") throw new Error("capture missing job.jobDocId");
          writeFileSync(path.join(formsDir, id + ".json"), JSON.stringify(body, null, 2));
          const n = readdirSync(formsDir).length;
          const tag = body.error ? `❌ ${body.error}` : `✅ ${body.frames?.length ?? 0} frame(s)`;
          console.log(`[${n}/${list.length}] ${body.job.companyName} — ${body.job.title}  ${tag}`);
          res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
          res.end('{"ok":true}');
        } catch (e) {
          console.warn("bad capture:", e.message);
          res.writeHead(400, { ...CORS, "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404, CORS).end();
  })
  .listen(PORT, "127.0.0.1");
