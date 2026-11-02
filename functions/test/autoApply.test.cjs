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
    { id: "j5", source: "workday", title: "Engineer", companyName: "NVIDIA", fam: ["software"] },
    { id: "j6", source: "greenhouse", companyKey: "f1", externalId: "444", title: "ML Engineer", companyName: "Stitch Fix", jobUrl: "", sourceUpdatedTs: "2026-10-28T00:00:00Z", fam: ["software"], el: ["citizenship"] },
  ];
  const data = {
    "users/A/aggregations/allJobs": { jobs }, "users/A/aggregations/recentJobs": { jobs: [] },
    "users/U/aggregations/myJobScores": { scores: {} }, "users/U/settings/preferences": { jobTypes: ["software"] },
    "users/U": { requiresSponsorship: "Yes" }, "users/U/resume/profile": {},
  };
  const coll = {
    "users/A/feeds": [["f1", { url: "https://boards-api.greenhouse.io/v1/boards/stitchfix/jobs?content=true" }], ["f2", { url: "https://api.ashbyhq.com/posting-api/job-board/notion" }]],
    "users/U/applications": [["x", { status: "submitted", jobId: "j4" }]],
  };
  const ref = (path) => ({
    get: async () => (coll[path] ? docs(coll[path]) : { exists: path in data, data: () => data[path] }),
    collection: (c) => ref(`${path}/${c}`),
    doc: (d) => ref(`${path}/${d}`),
  });
  const db = { collection: (c) => ref(c) };
  const q = await buildQueue(db, "U", { adminUid: "A" });
  assert.deepEqual(q.map((j) => j.jobId), ["j2", "j1"]); // newest first; j3 unrelated, j4 applied, j5 not Ashby/GH, j6 not open to visa holders
  assert.equal(q[1].applyUrl, "https://job-boards.greenhouse.io/embed/job_app?for=stitchfix&token=111");
  assert.equal(q[0].source, "ashby");
});
