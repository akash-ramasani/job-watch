// Mistakes found in the audit of every submitted application (2026-11-12).
const test = require("node:test");
const assert = require("node:assert/strict");
const { bestSchool, bestDegree, bestDiscipline, degreeLevel } = require("../lib/apply/prepare.cjs");

const P = { firstName: "Akash", lastName: "Ramasani", requiresSponsorship: "Yes", workAuthorized: "Yes", visaStatus: { student: true }, visaType: "H-1B",
  country: "United States", city: "San Francisco", region: "California", noticePeriod: "1 week", salaryExpectation: "Open to discussion" };
const sel = (label, opts) => ({ label, required: true, fields: [{ name: "q", type: "multi_value_single_select", values: opts.map((o) => ({ label: o, value: o })) }] });
const txt = (label) => ({ label, required: true, fields: [{ name: "q", type: "input_text" }] });
let ae;
const val = (q, p = P) => ae.answerQuestion(q, p, null).answers.map((a) => a.value)[0];
test.before(async () => { ae = await import("../lib/apply/answer-engine.mjs"); });

test("work authorization worded with 'employed' or 'begin employment' is Yes (Superhuman, Twitch)", () => {
  assert.equal(val(sel("Are you authorized to be employed in the United States?", ["Yes", "No"])), "Yes");
  assert.equal(val(sel("If offered employment by Amazon, would you be legally eligible to begin employment immediately?", ["Yes", "No"])), "Yes");
  // Past employment is still a relationship question.
  assert.equal(val(sel("Have you ever been employed by Superhuman?", ["Yes", "No"])), "No");
  // Without sponsorship stays the sponsorship answer.
  assert.equal(val(sel("Are you authorized to work in the United States without current or future visa sponsorship?", ["Yes", "No"])), "No");
});

test("salary and notice period in one box get both (Rain)", () => {
  const v = val(txt("What is your gross annual salary expectation for this role, and do you have a specific notice period we should be aware of?"));
  assert.match(v, /Open to discussion/);
  assert.match(v, /Notice period: 1 week/);
});

test("'what sponsorship would you require' names the visa (Brex)", () => {
  assert.equal(val(txt("If you're not authorized to work at the stated location, what sponsorship would you require for the role?")), "H-1B visa sponsorship");
});

test("a full country list picks the country, not the outlying islands (KAYAK)", () => {
  const countries = ["AFGHANISTAN", "UNITED KINGDOM", "UNITED STATES MINOR OUTLYING ISLANDS", "UNITED STATES OF AMERICA", "URUGUAY"];
  assert.equal(val(sel("Where do you currently reside?", countries)), "UNITED STATES OF AMERICA");
  assert.equal(val(sel("Country", countries)), "UNITED STATES OF AMERICA");
});

test("education: Computer Science not Science, the plain Master's, the right campus", async () => {
  const it = (xs) => xs.map((text, id) => ({ id, text }));
  assert.equal(bestDiscipline(it(["Science", "Computer Science", "Computer Engineering", "Computer and Information Science"]), "Computer Science").text, "Computer Science");
  assert.equal(bestDiscipline(it(["Science", "Biology"]), "Computer Science"), null);
  assert.equal(bestDegree(it(["Accelerated Master's", "Non-Master's International Diploma", "Master's Degree", "Bachelor's Degree"]), degreeLevel("Master of Science")).text, "Master's Degree");
  assert.equal(bestDegree(it(["Non-Master's International Diploma", "Master", "Bachelor"]), degreeLevel("Master of Science")).text, "Master");
  assert.equal(bestDegree(it(["Associate's Degree", "Bachelor's Degree"]), degreeLevel("Bachelor of Technology")).text, "Bachelor's Degree");
  const imc = it(["California State University - Chico", "California State University - Monterey Bay"]);
  assert.equal(await bestSchool("California State University, East Bay", async () => imc), null);
  const block = it(["California State University - Monterey Bay", "California State University - East Bay"]);
  assert.equal((await bestSchool("California State University, East Bay", async () => block)).text, "California State University - East Bay");
});
