// Rule-based score: parsing and scoring rules. Run: npm test (in functions/)
const test = require("node:test");
const assert = require("node:assert/strict");
const { ruleAssessJob, parseRequirements, profileSkills, descriptionLines } = require("../lib/ruleScore.cjs");

const PROFILE = {
  summary: "Software engineer with 5+ years of experience shipping production backend systems.",
  skillGroups: [
    { label: "Languages", skills: ["Python", "TypeScript", "Java", "SQL"] },
    { label: "Cloud", skills: ["AWS", "Docker", "Kubernetes", "Terraform", "GitHub Actions"] },
    { label: "Data", skills: ["PostgreSQL", "ETL pipelines"] },
  ],
  roles: [
    { title: "Senior Software Engineer", company: "A", startDate: "Aug 2021", endDate: "Present", description: "Designed high-volume REST APIs using Spring Boot\nBuilt distributed systems on AWS" },
    { title: "Software Development Engineer", company: "B", startDate: "Jan 2020", endDate: "Jul 2021", description: "Built microservices in Java" },
  ],
  education: [{ degree: "Master of Science, Computer Science", institution: "CSU" }],
};
const mine = profileSkills(PROFILE);

const jd = (must, nice = "") => `<h3>About us</h3><p>We are a great company with Salesforce customers.</p>
<h3>What you'll need</h3><ul>${must.map((m) => `<li>${m}</li>`).join("")}</ul>
${nice ? `<h3>Nice to have</h3><ul>${nice.split("|").map((m) => `<li>${m}</li>`).join("")}</ul>` : ""}
<h3>Benefits</h3><p>401k, health insurance, 18 years of age or older.</p>`;

test("HTML (even escaped) becomes lines with headings", () => {
  const lines = descriptionLines("&lt;h3&gt;Requirements&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Python&lt;/li&gt;&lt;/ul&gt;");
  assert.deepEqual(lines, ["Requirements", "- Python"]);
});

test("must and nice sections; about/benefits ignored", () => {
  const p = parseRequirements(jd(["5+ years of experience with Python and Go", "Experience with AWS or GCP"], "Kafka experience"));
  const byName = Object.fromEntries(p.requirements.map((q) => [q.r, q.n]));
  assert.equal(byName.Python, "must");
  assert.equal(byName.Go, "must");
  assert.equal(byName["AWS or GCP"], "must"); // alternatives are one requirement
  assert.equal(byName["Streaming/queues"], "nice");
  assert.ok(!("Salesforce" in byName)); // from the "About us" section
  assert.equal(p.minYears, 5); // not "18 years of age" from benefits
});

test("clearance only when one must already be held", () => {
  assert.equal(parseRequirements(jd(["Active TS/SCI clearance", "Python"])).clearance, true);
  assert.equal(parseRequirements(jd(["Ability to obtain a Secret clearance", "Python"])).clearance, false);
});

test("resume skills are found with a quotable line", () => {
  assert.ok(mine.have.has("python") && mine.have.has("kubernetes") && mine.have.has("spring"));
  assert.ok(!mine.have.has("go"));
});

test("covered skills score high, missing ones show in the reason", () => {
  const good = ruleAssessJob({ profile: PROFILE, mine, jobTitle: "Senior Software Engineer", description: jd(["3+ years of experience building backend services in Python or Java", "AWS", "Kubernetes and Docker", "PostgreSQL"]) });
  assert.ok(good.score >= 80, `got ${good.score}`);
  assert.equal(good.method, "rule");
  const gaps = ruleAssessJob({ profile: PROFILE, mine, jobTitle: "Software Engineer", description: jd(["Go", "Rust", "C++", "Python"]) });
  assert.ok(gaps.score < 40, `got ${gaps.score}`);
  assert.match(gaps.reason, /missing Go, Rust/);
});

test("close siblings earn partial credit, languages don't", () => {
  const r = ruleAssessJob({ profile: PROFILE, mine, jobTitle: "Software Engineer", description: jd(["Google Cloud (GCP)", "Scala"]) });
  const cov = Object.fromEntries(r.requirements.map((q) => [q.requirement, q.covered]));
  assert.equal(cov.GCP, "partial");
  assert.equal(cov.Scala, "no");
});

test("years and seniority caps match the AI score's", () => {
  const r = ruleAssessJob({ profile: PROFILE, mine, jobTitle: "Staff Software Engineer", description: jd(["10+ years of professional experience", "Python", "AWS"]) });
  assert.equal(r.score, 35);
  assert.match(r.capNote, /Asks for 10\+ years/);
});

test("role distance: near types capped at 60, far at 30, other fields at 15", () => {
  const d = jd(["Python", "AWS", "Kubernetes", "PostgreSQL"]);
  const near = ruleAssessJob({ profile: PROFILE, mine, jobTitle: "Site Reliability Engineer", description: d }).score;
  assert.ok(near > 30 && near <= 60, `near type got ${near}`);
  assert.equal(ruleAssessJob({ profile: PROFILE, mine, jobTitle: "Solutions Consultant", description: d, targets: ["software", "solutions"] }).score, 30);
  assert.equal(ruleAssessJob({ profile: PROFILE, mine, jobTitle: "Account Executive", description: d }).score, 15);
});

test("a description with nothing checkable is neutral, not zero", () => {
  const r = ruleAssessJob({ profile: PROFILE, mine, jobTitle: "Software Engineer", description: "<p>Join our team!</p>" });
  assert.ok(r.score <= 40);
  assert.match(r.reason, /Couldn't read requirements/);
});

test("thin evidence is pulled toward the middle; the title's head decides the type", () => {
  const thin = ruleAssessJob({ profile: PROFILE, mine, jobTitle: "Software Engineer", description: jd(["Python"]) });
  assert.ok(thin.score < 70, `1-requirement job got ${thin.score}`);
  const pm = ruleAssessJob({ profile: PROFILE, mine, jobTitle: "Senior Product Manager, Developer Platform", description: jd(["Python", "AWS", "Kubernetes", "PostgreSQL"]) });
  assert.ok(pm.score <= 15, `product manager got ${pm.score}`);
});
