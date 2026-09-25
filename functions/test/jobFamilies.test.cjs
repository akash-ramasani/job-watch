// Job types and the "should this user's AI assessment run?" gate.
// Titles are real ones from the corpus. Run: npm test (in functions/)
const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyTitle, familiesForProfile, shouldAssess, targetsKey, ADJACENT } = require("../lib/jobFamilies.cjs");

const SDE = familiesForProfile({ roles: [
  { title: "Senior AI Native Software Engineer" }, { title: "Senior Software Engineer" }, { title: "Software Development Engineer II" }, { title: "Machine Learning Engineer" },
] });
const DA = familiesForProfile({ roles: [{ title: "Data Analyst" }, { title: "Business Intelligence Analyst Intern" }] });
const MISSION = "We are building the future of our industry with a world-class team. ".repeat(5);

test("profiles get their own types plus realistic neighbours", () => {
  for (const f of ["software", "ml_ai", "data_engineering", "devops_cloud", "security", "qa_test", "solutions", "engineering_general"]) assert.ok(SDE.includes(f), f);
  assert.ok(!SDE.includes("data_analytics") && !SDE.includes("sales"));
  assert.deepEqual([...DA].sort(), ["data_analytics", "data_engineering", "data_science"]);
  assert.deepEqual(familiesForProfile({}), []);
});

test("software profile: every job that scored 40+ in the audit set is assessed", () => {
  for (const t of ["Software Engineer, Agent - Retail", "Staff Software Engineer, Tax Experiences", "Senior Staff Software Engineer - Pricing and Packaging",
    "Software Engineer, Robot Manufacturing", "Sr. Forward Deployed Engineer (FDE) - Manufacturing", "Globalization Tech Lead", "Senior Data Engineer - US",
    "Senior Software Security Engineer, Infrastructure & Identity", "Senior Implementation Engineer", "Application Engineer", "Enterprise People Platform Engineer",
    "Data Specialist II, Cat Digital", "Agent Engineer", "Staff Modeling Engineer", "Data Scientist, Payments", "Applied AI Engineer", "Senior Founding Engineer"]) {
    assert.equal(shouldAssess(t, SDE, MISSION).assess, true, t);
  }
});

test("software profile skips other professions", () => {
  for (const t of ["Grad Pharmacist", "Family Nurse Practitioner - NP/PA (Part-time)", "GTM Recruiter (Fixed Term)", "Account Executive, Mid-Market",
    "Partner Marketing Manager, Online & Regional Events", "Demand Planner II (Hybrid)", "Senior Electrical Engineer (Onsite)", "Part-Time Keyholder - Park Meadows"]) {
    assert.equal(shouldAssess(t, SDE, MISSION).assess, false, t);
  }
});

test("data-analyst profile keeps anything analytical, including other departments' analysts", () => {
  for (const t of ["Data Analyst II", "Business Intelligence Developer", "Senior Product Analyst", "Marketing Analytics Manager", "Financial Analyst, FP&A",
    "Financial Planning and Analysis (FP&A) - Associate Director", "Operations Analyst", "Reporting Specialist", "Data Specialist II, Cat Digital",
    "Senior Data Engineer - US", "Data Scientist, Payments", "Insights Manager, Consumer Research", "Power BI Developer", "Revenue Operations Analyst"]) {
    assert.equal(shouldAssess(t, DA, MISSION).assess, true, t);
  }
});

test("data-analyst profile skips engineering and unrelated fields", () => {
  for (const t of ["Senior Software Engineer - Camera Platform", "Staff Backend Engineer - Streaming", "Agent Engineer", "Grad Pharmacist",
    "Account Executive, Mid-Market", "Senior Electrical Engineer (Onsite)", "Site Reliability Engineer"]) {
    assert.equal(shouldAssess(t, DA, MISSION).assess, false, t);
  }
});

test("a title with no type falls back to the description, and assesses when unsure", () => {
  const sqlJob = "You will build dashboards in Tableau and write SQL for weekly reporting. ".repeat(4);
  const storeJob = "Lead store teams, merchandising, customer service and scheduling. ".repeat(4);
  assert.equal(classifyTitle("Rotational Development Program").length, 0);
  assert.equal(shouldAssess("Rotational Development Program", DA, sqlJob).assess, true);
  assert.equal(shouldAssess("Rotational Development Program", DA, storeJob).assess, false);
  assert.equal(shouldAssess("Rotational Development Program", DA, "").assess, true); // no description: assess
  assert.equal(shouldAssess("", SDE, storeJob).assess, true); // no title: assess
  assert.equal(shouldAssess("Anything at all", [], storeJob).assess, true); // no targets: assess
  // Marketing profile: no vocabulary defined, so untyped titles are assessed.
  assert.equal(shouldAssess("Rotational Development Program", ADJACENT.marketing, storeJob).assess, true);
});

test("multi-type titles are kept if any type is targeted", () => {
  assert.deepEqual(classifyTitle("Data Analyst, Sales Operations").includes("sales"), true);
  assert.equal(shouldAssess("Data Analyst, Sales Operations", DA, MISSION).assess, true);
  assert.equal(shouldAssess("Principal Specialist Sales Engineer, Data Security", SDE, MISSION).assess, true);
});

test("targets key is order-independent", () => {
  assert.equal(targetsKey(["b", "a"]), targetsKey(["a", "b"]));
});

test("the web app's job-type list matches these types", () => {
  const fs = require("fs");
  const path = require("path");
  const { FAMILY_IDS, FAMILIES } = require("../lib/jobFamilies.cjs");
  const src = fs.readFileSync(path.join(__dirname, "../../src/lib/jobTypes.js"), "utf8");
  const web = [...src.matchAll(/id: "([a-z_]+)", label: ("[^"]*")/g)].map((m) => [m[1], JSON.parse(m[2])]);
  const backend = [...FAMILY_IDS, "engineering_general"].map((id) => [id, FAMILIES[id].label]);
  assert.deepEqual(web, backend);
});

test("audit fixes: engineer titles, design engineers, eng directors, business analytics, dense descriptions", () => {
  for (const t of ["Technical Product Manager / Engineer", "Senior GRC Engineer", "Senior Design Engineer, Design Systems", "UX Design Engineer, Content Tooling", "Director of Engineering, Logistics"]) {
    assert.equal(shouldAssess(t, SDE, MISSION).assess, true, t);
  }
  for (const t of ["Manager, Sales Strategy & Operations", "Associate Manager, Consumer Pricing & Affordability", "Revenue Operations Manager", "Business Operations Associate"]) {
    assert.equal(shouldAssess(t, DA, MISSION).assess, true, t);
  }
  const dense = "SQL, Tableau, Power BI, Looker dashboards, Excel, statistics, A/B testing, KPIs and weekly reporting with Python and dbt. ".repeat(3);
  assert.equal(shouldAssess("Finance & Business Management", DA, dense).assess, true);
  assert.equal(shouldAssess("Finance & Business Management", DA, MISSION).assess, false);
});
