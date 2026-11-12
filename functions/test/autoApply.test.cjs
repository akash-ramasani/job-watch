// Auto-apply queue helpers: apply URLs per board, the tailored resume's file
// name, and the server copy of the LaTeX resume builder staying identical to
// the web app's.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { applyUrlFor, feedSlug, resumeFileName } = require("../lib/apply/autoApply.cjs");

test("apply URLs: Ashby application page, Greenhouse embedded form", () => {
  const feeds = new Map([["f1", feedSlug("https://boards-api.greenhouse.io/v1/boards/stitchfix/jobs?content=true")], ["f2", feedSlug("https://api.ashbyhq.com/posting-api/job-board/notion")]]);
  assert.equal(applyUrlFor({ source: "greenhouse", companyKey: "f1", externalId: "8031204", jobUrl: "https://www.stitchfix.com/careers/jobs?gh_jid=8031204" }, feeds), "https://job-boards.greenhouse.io/embed/job_app?for=stitchfix&token=8031204");
  assert.equal(applyUrlFor({ source: "greenhouse", companyKey: "zz", externalId: "", jobUrl: "https://job-boards.greenhouse.io/anthropic/jobs/4567" }, feeds), "https://job-boards.greenhouse.io/embed/job_app?for=anthropic&token=4567");
  assert.equal(applyUrlFor({ source: "ashbyhq", companyKey: "f2", externalId: "0a5ad123-7c5b-4d88-b498-5a0262beb331", jobUrl: "https://jobs.ashbyhq.com/notion/0a5ad123-7c5b-4d88-b498-5a0262beb331" }, feeds), "https://jobs.ashbyhq.com/notion/0a5ad123-7c5b-4d88-b498-5a0262beb331/application");
  assert.equal(applyUrlFor({ source: "ashbyhq", companyKey: "f2", externalId: "0a5ad123-7c5b-4d88-b498-5a0262beb331", jobUrl: "" }, feeds), "https://jobs.ashbyhq.com/notion/0a5ad123-7c5b-4d88-b498-5a0262beb331/application");
  assert.equal(applyUrlFor({ source: "workday", jobUrl: "https://x.wd5.myworkdayjobs.com/a" }, feeds), "");
});

test("apply URLs: Workday posting -> Apply Manually", () => {
  const feeds = new Map();
  const wd = (jobUrl) => applyUrlFor({ source: "workday", jobUrl }, feeds);
  assert.equal(wd("https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-Engineer_JR1987654"),
    "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-Engineer_JR1987654/apply/applyManually");
  assert.equal(wd("https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-Engineer_JR1987654/apply?source=x"),
    "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-Engineer_JR1987654/apply/applyManually");
  assert.equal(wd("https://wd1.myworkdaysite.com/recruiting/acme/External/job/Remote/Data-Analyst_R-12345"),
    "https://wd1.myworkdaysite.com/recruiting/acme/External/job/Remote/Data-Analyst_R-12345/apply/applyManually");
  assert.equal(wd("https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite"), "");
});

test("resume file name: First_Last_Resume_Job_Title.pdf", () => {
  assert.equal(resumeFileName("Akash Ramasani", "Lead Engineer - Product Catalog Team"), "Akash_Ramasani_Resume_Lead_Engineer_Product_Catalog_Team.pdf");
  assert.equal(resumeFileName("Akash Ramasani", "Senior Software Engineer, Payments (Req 12345)"), "Akash_Ramasani_Resume_Senior_Software_Engineer_Payments.pdf");
  assert.equal(resumeFileName("José Núñez", "C++ / C# Engineer"), "Jose_Nunez_Resume_C_Plus_Plus_C_Sharp_Engineer.pdf");
  assert.equal(resumeFileName("", ""), "Resume_Resume.pdf".replace("Resume_Resume", "Resume_Resume"));
});

test("functions/lib/resumeLatex.mjs is the web app's resumeLatex.js", () => {
  const app = fs.readFileSync(path.join(__dirname, "../../src/lib/resumeLatex.js"), "utf8");
  const copy = fs.readFileSync(path.join(__dirname, "../lib/resumeLatex.mjs"), "utf8").split("\n").slice(3).join("\n");
  assert.equal(copy, app, "copy src/lib/resumeLatex.js over functions/lib/resumeLatex.mjs (keeping its 3-line header)");
});

test("queue: related Ashby/Greenhouse jobs, newest first, minus applied and unrelated", async () => {
  const { buildQueue } = require("../lib/apply/autoApply.cjs");
  const docs = (rows) => ({ docs: rows.map(([id, data]) => ({ id, data: () => data })), exists: true });
  const jobs = [
    { id: "j1", source: "greenhouse", companyKey: "f1", externalId: "111", title: "Software Engineer", companyName: "Stitch Fix", jobUrl: "https://www.stitchfix.com/careers/jobs?gh_jid=111", sourceUpdatedTs: "2026-10-30T00:00:00Z", fam: ["software"] },
    { id: "j2", source: "ashbyhq", companyKey: "f2", externalId: "0a5ad123-7c5b-4d88-b498-5a0262beb331", title: "Backend Engineer", companyName: "Notion", jobUrl: "https://jobs.ashbyhq.com/notion/0a5ad123-7c5b-4d88-b498-5a0262beb331", sourceUpdatedTs: "2026-10-31T00:00:00Z", fam: ["software"] },
    { id: "j3", source: "greenhouse", companyKey: "f1", externalId: "222", title: "Account Executive", companyName: "Stitch Fix", jobUrl: "", sourceUpdatedTs: "2026-10-31T00:00:00Z", fam: ["sales"] },
    { id: "j4", source: "greenhouse", companyKey: "f1", externalId: "333", title: "Data Engineer", companyName: "Stitch Fix", jobUrl: "", sourceUpdatedTs: "2026-10-29T00:00:00Z", fam: ["software"] },
    { id: "j7", source: "greenhouse", companyKey: "f1", externalId: "555", title: "Senior Software Engineer", companyName: "Roblox", jobUrl: "https://job-boards.greenhouse.io/roblox/jobs/555", sourceUpdatedTs: "2026-11-01T00:00:00Z", fam: ["software"] },
    { id: "j5", source: "workday", title: "Engineer", companyName: "NVIDIA", fam: ["software"] },
    { id: "j6", source: "greenhouse", companyKey: "f1", externalId: "444", title: "ML Engineer", companyName: "Stitch Fix", jobUrl: "", sourceUpdatedTs: "2026-10-28T00:00:00Z", fam: ["software"], el: ["citizenship"] },
    // j8: a better match, ahead of the same day's j9 (Lever, with no score).
    { id: "j8", source: "ashbyhq", companyKey: "f2", externalId: "1b5ad123-7c5b-4d88-b498-5a0262beb331", title: "Platform Engineer", companyName: "Notion", jobUrl: "https://jobs.ashbyhq.com/notion/1b5ad123-7c5b-4d88-b498-5a0262beb331", sourceUpdatedTs: "2026-10-31T20:00:00Z", fam: ["software"] },
    { id: "j9", source: "lever", companyKey: "f3", externalId: "3c5ad123-7c5b-4d88-b498-5a0262beb331", title: "Software Engineer", companyName: "Plaid", jobUrl: "https://jobs.lever.co/plaid/3c5ad123-7c5b-4d88-b498-5a0262beb331", sourceUpdatedTs: "2026-11-01T00:00:00Z", fam: ["software"] },
    // Greenhouse moved its date on an edit; JobWatch saw it on Oct 29: that day counts.
    { id: "j10", source: "greenhouse", companyKey: "f1", externalId: "666", title: "Backend Engineer", companyName: "Stitch Fix", jobUrl: "", sourceUpdatedTs: "2026-11-01T18:00:00Z", firstSeenAt: "2026-10-29T18:00:00Z", fam: ["software"] },
  ];
  const data = {
    "users/A/aggregations/allJobs": { jobs }, "users/A/aggregations/recentJobs": { jobs: [] },
    "users/U/aggregations/myJobScores": { scores: { j2: { score: 60 }, j8: { score: 90 } } }, "users/U/settings/preferences": { jobTypes: ["software"], excludedCompanies: ["Roblox"], autoApplyMinScore: 0 },
    "users/U": { requiresSponsorship: "Yes" }, "users/U/resume/profile": {},
  };
  const coll = {
    "users/A/feeds": [["f1", { url: "https://boards-api.greenhouse.io/v1/boards/stitchfix/jobs?content=true" }], ["f2", { url: "https://api.ashbyhq.com/posting-api/job-board/notion" }], ["f3", { url: "https://api.lever.co/v0/postings/plaid" }]],
    "users/U/applications": [["x", { status: "submitted", jobId: "j4" }]],
  };
  const ref = (path) => ({
    get: async () => (coll[path] ? docs(coll[path]) : { exists: path in data, data: () => data[path] }),
    collection: (c) => ref(`${path}/${c}`),
    doc: (d) => ref(`${path}/${d}`),
  });
  const db = { collection: (c) => ref(c) };
  const q = await buildQueue(db, "U", { adminUid: "A" });
  // Newest day first (Pacific), best score first within it; j3 unrelated, j4 applied, j5 not Ashby/GH/Lever, j6 not open to visa holders, j7 a hidden company.
  assert.deepEqual(q.map((j) => j.jobId), ["j8", "j9", "j2", "j1", "j10"]);
  assert.equal(q[1].applyUrl, "https://jobs.lever.co/plaid/3c5ad123-7c5b-4d88-b498-5a0262beb331/apply");
  assert.equal(q[3].applyUrl, "https://job-boards.greenhouse.io/embed/job_app?for=stitchfix&token=111");
  assert.equal(q[2].source, "ashby");
  assert.equal(q[1].source, "lever");
  // By default only matching jobs: a score of 40 (Partial Match) or more; unscored ones wait.
  delete data["users/U/settings/preferences"].autoApplyMinScore;
  assert.deepEqual((await buildQueue(db, "U", { adminUid: "A" })).map((j) => j.jobId), ["j8", "j2"]);
  data["users/U/aggregations/myJobScores"].scores.j2 = { score: 39 };
  assert.deepEqual((await buildQueue(db, "U", { adminUid: "A" })).map((j) => j.jobId), ["j8"]);
});

test("queue: a job first seen in the last 2 hours goes before the backlog, whatever its score (2026-11-11)", async () => {
  const { buildQueue } = require("../lib/apply/autoApply.cjs");
  const docs = (rows) => ({ docs: rows.map(([id, data]) => ({ id, data: () => data })), exists: true });
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const gh = (id, ext, title, ts) => ({ id, source: "greenhouse", companyKey: "f1", externalId: ext, title, companyName: "Stitch Fix", jobUrl: "", sourceUpdatedTs: ts, fam: ["software"] });
  const jobs = [
    gh("old95", "1", "Staff Engineer", ago(5 * 60)), // this morning, best match
    gh("new45", "2", "Backend Engineer", ago(10)), // posted 10 minutes ago, weaker match
    gh("new60", "3", "Platform Engineer", ago(40)),
  ];
  const data = {
    "users/A/aggregations/allJobs": { jobs }, "users/A/aggregations/recentJobs": { jobs: [] },
    "users/U/aggregations/myJobScores": { scores: { old95: { score: 95 }, new45: { score: 45 }, new60: { score: 60 } } },
    "users/U/settings/preferences": { jobTypes: ["software"] }, "users/U": {}, "users/U/resume/profile": {},
  };
  const coll = { "users/A/feeds": [["f1", { url: "https://boards-api.greenhouse.io/v1/boards/stitchfix/jobs?content=true" }]], "users/U/applications": [] };
  const ref = (path) => ({ get: async () => (coll[path] ? docs(coll[path]) : { exists: path in data, data: () => data[path] }), collection: (c) => ref(`${path}/${c}`), doc: (d) => ref(`${path}/${d}`) });
  const q = await buildQueue({ collection: (c) => ref(c) }, "U", { adminUid: "A" });
  // Today all three; before, the 95 went first and a fresh job waited behind the day's backlog.
  const fresh = q.filter((j) => j.fresh).map((j) => j.jobId);
  assert.deepEqual(q.map((j) => j.jobId).slice(0, 2), ["new45", "new60"]);
  assert.deepEqual(fresh, ["new45", "new60"]);
  assert.equal(q[2].jobId, "old95");
});
