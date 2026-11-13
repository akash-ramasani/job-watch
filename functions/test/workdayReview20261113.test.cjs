// Workday applications held at Review by the answer check (2026-11-10 to
// 11-13): each wrong answer the check found, now answered right at the fill.
const test = require("node:test");
const assert = require("node:assert/strict");

const P = { firstName: "Akash", lastName: "Ramasani", requiresSponsorship: "Yes", workAuthorized: "Yes", visaStatus: { student: true }, visaType: "H-1B",
  country: "United States", city: "San Francisco", region: "California", willingToRelocate: "Yes", yearsOfExperience: 5.7,
  resumeText: "Software Engineer at Oracle. Built services in Java, Python and TypeScript with React front ends." };
const sel = (label, opts) => ({ label, required: true, fields: [{ name: "q", type: "multi_value_single_select", values: opts.map((o) => ({ label: o, value: o })) }] });
const txt = (label) => ({ label, required: true, fields: [{ name: "q", type: "input_text" }] });
let ae;
const val = (q, p = P) => ae.answerQuestion(q, p, null).answers.map((a) => a.value)[0];
test.before(async () => { ae = await import("../lib/apply/answer-engine.mjs"); });

test("time-limited status: 'indefinite basis' and 'unrestricted right to work' are No on OPT (Analog Devices, Salesforce)", () => {
  assert.equal(val(sel("Are you authorized to work in the United States on a fulltime and indefinite basis? If you are hired, you will be required to present proof of your identity and authorization to work on your first day of work. Persons not authorized to work in the U.S. on an indefinite basis include F-1, J-1/2, H-1B/4, L-1/2 nonimmigrants, among others.", ["Yes", "No"])), "No");
  assert.equal(val(sel("Do you have the unrestricted right to work in the country to which you're applying? (You must answer “No” if you are on any visa or possess a work permit)", ["Yes", "No"])), "No");
  // A plain authorization question stays Yes; a green-card holder stays Yes.
  assert.equal(val(sel("Are you legally authorized to work in the United States?", ["Yes", "No"])), "Yes");
  assert.equal(val(sel("Are you authorized to work in the United States on a fulltime and indefinite basis?", ["Yes", "No"]), { ...P, requiresSponsorship: "No", visaStatus: {} }), "Yes");
});

test("countries needing sponsorship get the country, not a sentence (HPE)", () => {
  assert.equal(val(txt("For those locations or countries in which you are seeking employment, indicate all locations or countries for which you now, or in the future, will require sponsorship for an employment visa")), "United States");
  assert.match(val(txt("Will you now or in the future require sponsorship?")), /^Yes\. /);
});

test("notice period: available immediately is None, the shortest bucket otherwise (ResMed, State Street)", () => {
  const { buildProfileForJob } = require("../lib/apply/ashby.cjs");
  const p = buildProfileForJob({ firstName: "A", lastName: "B", availability: "Immediately" }, {}, { title: "SWE", companyName: "X" });
  assert.equal(p.noticePeriod, "None, available immediately");
  assert.equal(val(sel("Please detail the duration of your notice period?", ["None", "1 Week", "2 Week", "1 Month"]), p), "None");
  assert.equal(val(sel("What is your current notice period?", ["1-2 weeks", "3-4 weeks", "1 month"]), p), "1-2 weeks");
});

test("the role's stack named by example, and enterprise software, are Yes from the resume (PayPal)", () => {
  assert.equal(val(sel("Do you have professional experience working with the specific language or tech stack for this role (e.g., Python, Java, React)?", ["Yes", "No"])), "Yes");
  assert.equal(val(sel("Have you worked in an enterprise software environment before?", ["Yes", "No"])), "Yes");
});

test("commutable distance or intend to relocate: willing to relocate (PayPal)", () => {
  assert.equal(val(sel("Do you currently live within commutable distance to the office or intend to relocate to a commutable distance?", ["Yes", "No", "Planning to relocate"])), "Planning to relocate");
});

test("basic qualifications and a Code of Conduct acknowledgement are Yes (Capital One)", () => {
  assert.equal(val(sel("Do you meet all of the Basic Qualifications for this role as specified in the job description?", ["Yes", "No"])), "Yes");
  assert.equal(val(sel("All Capital One associates must follow the Code of Conduct. The Code requires that you inform your manager and submit a Conflict of Interest Disclosure Form to the Ethics Office and receive approval before engaging in any secondary employment or outside business activity. To proceed with your application, please acknowledge receipt and confirm your understanding.", ["Yes", "No"])), "Yes");
  // An outside-activities question itself is still the Profile's answer.
  assert.equal(val(sel("Do you have any outside business activities or secondary employment?", ["Yes", "No"]), { ...P, outsideActivities: "No" }), "No");
});

test("location preference: the job's city, else an office, never Remote only (Dimensional)", () => {
  const opts = ["Austin", "Charlotte", "Santa Monica", "Remote only", "Not open to relocation"];
  const q = sel("If this opportunity is available in multiple locations, please indicate your location preference.", opts);
  assert.equal(val(q), "Austin");
  assert.equal(val(q, { ...P, jobLocationName: "Charlotte, NC" }), "Charlotte");
});
