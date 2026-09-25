// Scoring math, evidence checks and caps for jobFit — no model calls.
// Run: npm test (in functions/)
const test = require("node:test");
const assert = require("node:assert/strict");
const { scoreAssessment, evidenceSupported, contentWords, buildProfileText, reasonFor, candidateYearsOf } = require("../lib/jobFit.cjs");

const PROFILE = buildProfileText({
  summary: "Software engineer with 5+ years of experience **shipping production backend systems**.",
  skillGroups: [{ label: "Languages", skills: ["Python", "TypeScript", "Java"] }, { label: "Cloud", skills: ["AWS", "Kubernetes", "Terraform"] }],
  roles: [
    { title: "Senior Software Engineer", company: "Compass Group", startDate: "Aug 2024", endDate: "May 2026", description: "Led a zero-downtime DB2 to PostgreSQL migration\nDesigned high-volume REST APIs using Spring Boot and JPA" },
    { title: "Machine Learning Engineer", company: "ICAR", startDate: "Jan 2022", endDate: "May 2022", description: "Built a TensorFlow CNN pipeline for rice-crop classification from satellite imagery" },
  ],
});

test("evidence must actually be in the profile", () => {
  const words = new Set(contentWords(PROFILE));
  assert.equal(evidenceSupported("Led a zero-downtime DB2 to PostgreSQL migration", words), true);
  assert.equal(evidenceSupported("TensorFlow CNN pipeline", words), true);
  assert.equal(evidenceSupported("5+ years of experience in digital media", words), false);
  assert.equal(evidenceSupported("Kafka", words), false);
  assert.equal(evidenceSupported("Kubernetes", words), true);
  assert.equal(evidenceSupported("", words), false);
});

test("unsupported yes drops to partial, unsupported partial drops to no", () => {
  const r = scoreAssessment({
    roleFit: "same", seniorityFit: "ok",
    requirements: [
      { r: "PostgreSQL", n: "must", c: "yes", e: "zero-downtime DB2 to PostgreSQL migration" },
      { r: "Digital media experience", n: "must", c: "yes", e: "5+ years of experience in digital media" },
      { r: "Kafka", n: "nice", c: "partial", e: "streaming with Kafka topics" },
    ],
  }, PROFILE);
  assert.equal(r.requirements[0].covered, "yes");
  assert.equal(r.requirements[1].covered, "partial");
  assert.equal(r.requirements[2].covered, "no");
  assert.equal(r.requirements[2].evidence, "");
  assert.equal(r.downgraded, 2);
});

test("score is weighted coverage: must = 2, nice = 1; partial = half", () => {
  const r = scoreAssessment({
    roleFit: "same", seniorityFit: "ok",
    requirements: [
      { r: "Python", n: "must", c: "yes", e: "Python, TypeScript, Java" },
      { r: "AWS", n: "must", c: "yes", e: "AWS, Kubernetes, Terraform" },
      { r: "Go", n: "must", c: "no", e: "" },
      { r: "Terraform", n: "nice", c: "yes", e: "AWS, Kubernetes, Terraform" },
    ],
  }, PROFILE);
  // (2 + 2 + 0 + 1) / (2 + 2 + 2 + 1) = 5/7 = 71%
  assert.equal(r.coverage, 71);
  assert.equal(r.score, 71);
  assert.match(r.reason, /^Covers 2 of 3 must-haves · missing Go$/);
});

test("different role is capped at 15, adjacent at 60", () => {
  const all = [{ r: "REST APIs", n: "must", c: "yes", e: "Designed high-volume REST APIs using Spring Boot" }];
  const sales = scoreAssessment({ roleFit: "different", roleNote: "Sales role, not engineering", requirements: all }, PROFILE, { jobTitle: "Account Executive" });
  assert.equal(sales.coverage, 100);
  assert.equal(sales.score, 15);
  assert.match(sales.reason, /^Sales role, not engineering · covers 1 of 1 must-haves$/);
  const adj = scoreAssessment({ roleFit: "adjacent", requirements: all }, PROFILE, { jobTitle: "Senior Data Engineer" });
  assert.equal(adj.score, 60);
});

test("software titles are never a different field; adjacent titles are never below adjacent", () => {
  const all = [{ r: "Python", n: "must", c: "yes", e: "Python, TypeScript, Java" }];
  const bci = scoreAssessment({ roleFit: "different", roleNote: "BCI role", requirements: all }, PROFILE, { jobTitle: "Software Engineer, BCI Applications" });
  assert.equal(bci.roleFit, "same");
  assert.equal(bci.score, 100);
  const data = scoreAssessment({ roleFit: "different", requirements: all }, PROFILE, { jobTitle: "Senior Data Engineer - US" });
  assert.equal(data.roleFit, "adjacent");
  const mfg = scoreAssessment({ roleFit: "different", requirements: all }, PROFILE, { jobTitle: "Sr. Manufacturing Engineer" });
  assert.equal(mfg.roleFit, "different");
  const ti = scoreAssessment({ roleFit: "different", requirements: all }, PROFILE, { jobTitle: "Applications Engineer | IPP PMIC" });
  assert.equal(ti.roleFit, "different");
});

test("level comes from the title and years, not the model", () => {
  const all = [{ r: "Python", n: "must", c: "yes", e: "Python, TypeScript, Java" }];
  const ctx = (jobTitle, extra = {}) => scoreAssessment({ roleFit: "same", requirements: all, ...extra }, PROFILE, { jobTitle, candidateYears: 5.7 });
  assert.equal(ctx("Software Engineering Intern").score, 20);
  assert.equal(ctx("New Grad Software Engineer (2026)").score, 20);
  assert.equal(ctx("Principal Software Engineer").score, 35);
  assert.equal(ctx("Senior Software Development Engineer", { seniorityFit: "too_junior" }).score, 100); // the model's old field is ignored
  assert.equal(ctx("Engineer III, Cloud Native", { minYears: 5 }).score, 100);
  const tooMany = ctx("Staff Software Engineer", { minYears: 10 });
  assert.equal(tooMany.score, 35);
  assert.equal(tooMany.capNote, "Asks for 10+ years; your resume shows about 5");
});

test("candidate years merge overlapping roles and count to present", () => {
  const now = new Date(2026, 8, 25); // Sep 2026
  const years = candidateYearsOf({ roles: [
    { startDate: "Jun 2026", endDate: "Present" },
    { startDate: "Aug 2024", endDate: "May 2026" },
    { startDate: "May 2022", endDate: "Jul 2024" },
    { startDate: "Jan 2022", endDate: "May 2022" },
    { startDate: "Jan 2021", endDate: "Jan 2022" },
  ] }, now);
  assert.ok(years > 5.4 && years < 5.8, `got ${years}`);
});

test("soft traits are not scored as requirements", () => {
  const r = scoreAssessment({ roleFit: "same", requirements: [
    { r: "Python", n: "must", c: "yes", e: "Python, TypeScript, Java" },
    { r: "You're comfortable with ambiguity", n: "must", c: "no" },
    { r: "Evidence of exceptional ability in engineering", n: "must", c: "no" },
    { r: "Strong communication and collaboration skills", n: "must", c: "no" },
  ] }, PROFILE, { jobTitle: "Software Engineer" });
  assert.deepEqual(r.requirements.map((q) => q.requirement), ["Python"]);
  assert.equal(r.score, 100);
});

test("garbage input is handled", () => {
  const r = scoreAssessment({ requirements: [{ r: "", c: "yes" }, { requirement: "Rust", covered: "maybe" }] }, PROFILE);
  assert.equal(r.requirements.length, 1);
  assert.equal(r.requirements[0].covered, "no");
  assert.equal(r.score, 0);
});

test("reason lists up to two gaps and counts the rest", () => {
  const reason = reasonFor({
    requirements: ["A", "B", "C", "D"].map((x) => ({ requirement: `Tool ${x}`, need: "must", covered: "no" })),
  });
  assert.equal(reason, "Covers 0 of 4 must-haves · missing Tool A, Tool B +2");
});

test("profile text keeps every role and bullet, without bold markers", () => {
  assert.match(PROFILE, /Machine Learning Engineer at ICAR/);
  assert.match(PROFILE, /- Designed high-volume REST APIs/);
  assert.doesNotMatch(PROFILE, /\*\*/);
});
