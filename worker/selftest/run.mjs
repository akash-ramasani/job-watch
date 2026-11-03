// run.mjs — the nightly self-test: fill fresh live Ashby, Greenhouse and
// Lever forms with the real extension (worker/selftest/harness.mjs, which
// never submits) and alert when a board fills fewer forms than it should.
//   node worker/selftest/run.mjs            # 30 forms per board
//   PER_BOARD=10 node worker/selftest/run.mjs
// Writes worker/selftest/reports/<date>.json (and latest.json) and shows a
// macOS notification with the result; one board under its floor, or 10
// points under the night before, makes it an alert. Boards change their
// forms without notice: this is how a change shows up before real
// applications start to stop.
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPORTS = path.join(HERE, "reports");
const PER_BOARD = Number(process.env.PER_BOARD) || 30;
// Below this share of fully filled forms, a board is failing.
const FLOOR = { ashby: 0.85, greenhouse: 0.8, lever: 0.85 };

const ASHBY_ORGS = ["openai", "crusoe", "harvey", "ramp", "sierra", "eliseai", "legora", "skydio", "hadrian-automation", "perplexity", "notion", "linear", "vanta", "replit", "reducto", "factory", "applied", "snowflake", "langchain", "cursor", "elevenlabs", "deepgram", "decagon", "glean", "baseten", "modal", "posthog", "supabase", "clerk", "mercor"];
const GH_BOARDS = ["stripe", "databricks", "figma", "robinhood", "coinbase", "discord", "dropbox", "pinterest", "instacart", "reddit", "asana", "gitlab", "cloudflare", "datadog", "mongodb", "elastic", "twilio", "okta", "samsara", "brex", "gusto", "affirm", "chime", "scaleai", "togetherai", "nuro", "waymo", "vercel", "squarespace", "toast", "pallet", "otter", "verkada", "andurilindustries", "sofi", "airtable", "carta", "benchling", "rubrik", "postman"];
const LEVER_SITES = ["palantir", "spotify", "zoox", "wealthfront", "outreach", "shieldai", "matchgroup", "sysdig", "hive", "rover", "ro", "dnb", "jumpcloud", "gopuff", "aledade", "enable", "levelai", "metabase", "whatnot", "plaid"];
const ENG = /software engineer|backend|full.?stack|platform engineer|data engineer|machine learning engineer|developer/i;
const US = /united states|remote|, (ca|ny|wa|tx|ma|co|il|ga|or)\b|san francisco|new york|seattle|austin|boston/i;

async function json(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status}`); return r.json(); }
const shuffle = (a) => a.map((x) => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);

/** Up to `n` live engineering forms, at most two per company, companies in random order. */
async function pick(board, n) {
  const out = [];
  const list = shuffle(board === "ashby" ? ASHBY_ORGS : board === "greenhouse" ? GH_BOARDS : LEVER_SITES);
  for (const c of list) {
    if (out.length >= n) break;
    try {
      let jobs = [];
      if (board === "ashby") jobs = ((await json(`https://api.ashbyhq.com/posting-api/job-board/${c}`)).jobs || []).filter((j) => ENG.test(j.title) && US.test(`${j.location || ""} ${j.isRemote ? "remote" : ""}`)).map((j) => `https://jobs.ashbyhq.com/${c}/${j.id}/application`);
      else if (board === "greenhouse") jobs = ((await json(`https://boards-api.greenhouse.io/v1/boards/${c}/jobs`)).jobs || []).filter((j) => ENG.test(j.title) && US.test(j.location?.name || "")).map((j) => `https://job-boards.greenhouse.io/embed/job_app?for=${c}&token=${j.id}`);
      else jobs = ((await json(`https://api.lever.co/v0/postings/${c}?mode=json&limit=200`)) || []).filter((j) => ENG.test(j.text) && US.test(`${j.categories?.location || ""} ${j.country || ""}`)).map((j) => `${j.hostedUrl}/apply`);
      out.push(...shuffle(jobs).slice(0, 2));
    } catch (_) { /* a board that will not answer is skipped */ }
  }
  return out.slice(0, n);
}

/** Run the harness on a list; resolves with its results. */
function harness(list, tag) {
  return new Promise((resolve) => {
    const listFile = path.join(REPORTS, `.${tag}.txt`);
    const outFile = path.join(REPORTS, `.${tag}.json`);
    fs.writeFileSync(listFile, list.join("\n"));
    const child = spawn(process.execPath, [path.join(HERE, "harness.mjs"), listFile, outFile], { stdio: ["ignore", "ignore", "ignore"] });
    child.on("exit", () => { try { resolve(JSON.parse(fs.readFileSync(outFile, "utf8"))); } catch { resolve([]); } });
  });
}

/** Complete = nothing left but the resume (the test never uploads one). */
function grade(rows) {
  const notResume = (x) => !/^(resume|resume\/cv|cv)\b/i.test(x) && !/resume|\bcv\b|^file/i.test(x);
  const loaded = rows.filter((r) => !/HARNESS ERROR/.test(r.card));
  const open = loaded.map((r) => ({ url: r.url, left: [...new Set([...(r.items || []), ...(r.emptyRequired || []).map((x) => x.replace(/^\w+: /, ""))])].filter(notResume) }));
  const complete = open.filter((o) => !o.left.length).length;
  const why = {};
  for (const o of open) for (const l of o.left) why[l.slice(0, 80)] = (why[l.slice(0, 80)] || 0) + 1;
  return { tried: rows.length, loaded: loaded.length, complete, rate: loaded.length ? complete / loaded.length : 0, top: Object.entries(why).sort((a, b) => b[1] - a[1]).slice(0, 8), failing: open.filter((o) => o.left.length).slice(0, 15) };
}

function notify(title, text) {
  try { execFileSync("osascript", ["-e", `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`]); } catch (_) { /* not macOS */ }
}

fs.mkdirSync(REPORTS, { recursive: true });
const started = new Date();
const boards = ["ashby", "greenhouse", "lever"];
const lists = Object.fromEntries(await Promise.all(boards.map(async (b) => [b, await pick(b, PER_BOARD)])));
// The three boards side by side; one browser each.
const results = Object.fromEntries(await Promise.all(boards.map(async (b) => [b, grade(await harness(lists[b], b))])));

let prev = null;
try { prev = JSON.parse(fs.readFileSync(path.join(REPORTS, "latest.json"), "utf8")); } catch (_) { /* first night */ }
const alerts = boards.filter((b) => results[b].loaded >= 5 && (results[b].rate < FLOOR[b] || (prev?.results?.[b] && results[b].rate < prev.results[b].rate - 0.1)));
const report = { at: started.toISOString(), minutes: Math.round((Date.now() - started) / 60000), perBoard: PER_BOARD, results, alerts };
const day = started.toISOString().slice(0, 10);
fs.writeFileSync(path.join(REPORTS, `${day}.json`), JSON.stringify(report, null, 1));
fs.writeFileSync(path.join(REPORTS, "latest.json"), JSON.stringify(report, null, 1));

const line = boards.map((b) => `${b[0].toUpperCase() + b.slice(1)} ${results[b].complete}/${results[b].loaded}`).join(", ");
if (alerts.length) notify("JobWatch self-test: forms are failing", `${line}. Worst: ${alerts.map((b) => `${b} (${results[b].top[0]?.[0] || "?"})`).join("; ")}. Report: worker/selftest/reports/${day}.json`);
else notify("JobWatch self-test passed", `${line} forms filled completely.`);
console.log(`self-test ${day}: ${line}${alerts.length ? ` — ALERT: ${alerts.join(", ")}` : ""}`);
for (const b of boards) if (results[b].top.length) console.log(`  ${b} top gaps:`, results[b].top.map(([k, n]) => `${n}× ${k}`).join(" | "));
process.exit(0);
