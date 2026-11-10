const test = require("node:test");
const assert = require("node:assert");
const { applicationResume } = require("../lib/apply/applicationResume.cjs");
const { applicantNotes } = require("../lib/apply/applicantNotes.cjs");

const resume = { summary: "s", education: [{ institution: "CSU East Bay", degree: "MS CS" }], certifications: ["Old cert"] };

test("forms use Application Defaults education and certifications, with dates", () => {
  const user = { applicationEducation: [{ institution: "California State University, East Bay", degree: "Master of Science", field: "Computer Science", startDate: "Aug 2024", endDate: "May 2026" }], certifications: ["AWS SAA", " "] };
  const r = applicationResume(user, resume);
  assert.equal(r.education[0].startDate, "Aug 2024");
  assert.deepEqual(r.certifications, ["AWS SAA"]);
  assert.equal(r.summary, "s");
  assert.equal(resume.education[0].startDate, undefined, "the resume itself is untouched");
});

test("without Application Defaults, the resume's own lists are used", () => {
  const r = applicationResume({}, resume);
  assert.equal(r.education[0].institution, "CSU East Bay");
  assert.deepEqual(r.certifications, ["Old cert"]);
});

test("applicant notes ignore the removed About you note and old keys", () => {
  const notes = applicantNotes({ answerContext: "About me text", applicantFacts: { status: "F-1 OPT through Aug 2029", startAndPay: "old" } });
  assert.match(notes, /Visa timeline: F-1 OPT through Aug 2029/);
  assert.doesNotMatch(notes, /About me|old/);
});

test("the resume's contact line comes from the account; a tailored resume keeps its per-job city", async () => {
  const { buildResumeLatex } = await import("../lib/resumeLatex.mjs");
  const contact = { name: "Akash Ramasani", phone: "5109356846", email: "a@b.com", location: "Hayward, CA" };
  const stale = buildResumeLatex({ header: { name: "Old Name", phone: "000" }, education: [] }, contact);
  assert.match(stale, /Akash Ramasani/);
  assert.doesNotMatch(stale, /Old Name/);
  const tailored = buildResumeLatex({ header: { location: "Seattle, WA" }, education: [] }, contact);
  assert.match(tailored, /Seattle, WA/);
});
