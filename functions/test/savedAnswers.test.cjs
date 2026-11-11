// The answer bank (lib/apply/savedAnswers.cjs) and the engine reading it,
// plus the email tracker's matching and Lever in the auto-apply queue.
const test = require("node:test");
const assert = require("node:assert/strict");
const sa = require("../lib/apply/savedAnswers.cjs");
const { candidatesFor, trackEmails } = require("../lib/apply/emailTracker.cjs");
const { applyUrlFor, feedSlug } = require("../lib/apply/autoApply.cjs");
const { buildProfileForJob } = require("../lib/apply/ashby.cjs");

const engine = () => import("../lib/apply/answer-engine.mjs");

test("question normalization is the same on both sides", async () => {
  const { normQuestion } = await engine();
  for (const q of ["What is your favorite color? *", "  Preferred   name:", "Are you 18+?", "Which office✱"]) assert.equal(normQuestion(q), sa.normQuestion(q));
  assert.equal(sa.keyOf("Preferred name *"), sa.keyOf("preferred name:"));
});

test("learnable: short reusable facts only", () => {
  assert.equal(sa.learnable({ question: "Which school did you attend?", answer: "California State University - East Bay" }), true);
  assert.equal(sa.learnable({ question: "Why do you want to work at Ramp?", answer: "x" }), false);
  assert.equal(sa.learnable({ question: "Have you used Ramp's product?", answer: "No", companyName: "Ramp" }), false);
  assert.equal(sa.learnable({ question: "Resume", answer: "Akash_Ramasani_Resume.pdf" }), false);
  assert.equal(sa.learnable({ question: "Anything else?", answer: "No" }), false);
  assert.equal(sa.learnable({ question: "Shirt size", answer: "x".repeat(400) }), false);
});

test("one source of truth: saved answers from pages are not used, and nothing is learned", async () => {
  const user = { savedAnswers: { k: { question: "What is your T-shirt size?", answer: "Medium", source: "ai" }, p: { question: "Phone", answer: "5109356846+1", source: "you" } } };
  assert.deepEqual(sa.savedIndex(user), {});
  const { answerQuestion } = await engine();
  const profile = buildProfileForJob(user, {}, { companyName: "X" });
  const text = answerQuestion({ label: "What is your T-shirt size? *", required: true, fields: [{ name: "q1", type: "input_text" }] }, profile, null);
  assert.equal(text.answers.length, 0);
  const writes = [];
  const db = { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({}) }), update: async (u) => writes.push(u) }) }) };
  const r = await sa.learn(db, "U", { saved: [{ question: "Which school?", answer: "CSU East Bay", source: "you" }], missing: [{ question: "Clearance number" }] }, { FieldValue: {} });
  assert.deepEqual(r, { saved: 0, missing: 0 });
  assert.equal(writes.length, 0);
});

test("Lever jobs get their application page", () => {
  const feeds = new Map([["f3", feedSlug("https://api.lever.co/v0/postings/veeva?mode=json")], ["f4", feedSlug("https://jobs.eu.lever.co/acme")]]);
  assert.deepEqual(feeds.get("f3"), { source: "lever", slug: "veeva", eu: false });
  const id = "0a5ad123-7c5b-4d88-b498-5a0262beb331";
  assert.equal(applyUrlFor({ source: "lever", jobUrl: `https://jobs.lever.co/veeva/${id}` }, feeds), `https://jobs.lever.co/veeva/${id}/apply`);
  assert.equal(applyUrlFor({ source: "lever", companyKey: "f4", externalId: id, jobUrl: "" }, feeds), `https://jobs.eu.lever.co/acme/${id}/apply`);
  assert.equal(applyUrlFor({ source: "lever", companyKey: "zz", externalId: id, jobUrl: "" }, feeds), "");
});

test("email tracker: matches by company, Claude sorts, the record keeps the strongest outcome", async () => {
  const apps = [{ appId: "a1", companyName: "Stitch Fix, Inc.", jobTitle: "Software Engineer", status: "submitted", submittedAt: "2026-10-01T00:00:00Z" }, { appId: "a2", companyName: "Ramp", jobTitle: "Backend Engineer", status: "submitted", outcome: "interview" }];
  assert.deepEqual(candidatesFor({ from: "Stitch Fix Recruiting <no-reply@greenhouse.io>", subject: "Thanks for applying", snippet: "" }, apps).map((a) => a.appId), ["a1"]);
  assert.deepEqual(candidatesFor({ from: "news@rampart.com", subject: "Sale", snippet: "" }, apps), []);
  const sets = [];
  const db = {
    collection: () => ({ doc: () => ({ collection: () => ({ where: () => ({ get: async () => ({ docs: apps.map((a) => ({ id: a.appId, data: () => a })) }) }), doc: (id) => ({ id }) }) }) }),
    batch: () => ({ set: (ref, patch) => sets.push([ref.id, patch]), commit: async () => {} }),
  };
  const ai = { chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({ results: [{ id: "m1", kind: "rejection", app: 0 }, { id: "m2", kind: "confirmation", app: 0 }] }) } }] }) } } };
  const out = await trackEmails({ db, ai, model: "fast" }, "U", [
    { id: "m1", from: "Stitch Fix <jobs@stitchfix.com>", subject: "Your application", snippet: "Unfortunately", date: Date.parse("2026-10-05") },
    { id: "m2", from: "Ramp <jobs@ramp.com>", subject: "Application received", snippet: "", date: Date.parse("2026-10-05") },
  ]);
  assert.deepEqual(out.updates.map((u) => [u.appId, u.kind]), [["a1", "rejection"], ["a2", "confirmation"]]);
  assert.equal(sets[0][1].outcome, "rejection");
  assert.equal(sets[1][1].outcome, undefined); // an interview is not downgraded to a confirmation
  assert.equal(sets[1][1].confirmationAt, "2026-10-05T00:00:00.000Z");
});

test("job locations: the work mode is not part of the city", () => {
  const { parsePlace } = require("../lib/apply/ashby.cjs");
  const city = (s) => parsePlace(s)?.city ?? null;
  assert.equal(city("Hybrid - San Francisco"), "San Francisco");
  assert.equal(city("San Francisco (Hybrid)"), "San Francisco");
  assert.equal(city("On-site: Austin, TX"), "Austin");
  assert.equal(city("New York, NY - Hybrid"), "New York");
  assert.equal(city("Hybrid"), null);
  assert.equal(city("Remote - US"), null);
});

test("a lone optional opt-out box is left unticked; a lone acknowledgement is ticked", async () => {
  const { answerQuestion } = await engine();
  const profile = buildProfileForJob({ eeoGender: "Male" }, {}, { companyName: "Airbnb" });
  const q = (required, label) => ({ label: "U.S. Equal Opportunity Employment Information (Completion is voluntary)", required, fields: [{ name: "q[]", type: "multi_value_multi_select", values: [{ label, value: 1 }] }] });
  assert.equal(answerQuestion(q(false, "I decline to answer the following questions."), profile, null).answers.length, 0);
  assert.equal(answerQuestion(q(true, "I decline to answer the following questions."), profile, null).answers.length, 1);
  assert.equal(answerQuestion({ label: "Privacy notice", required: false, fields: [{ name: "x", type: "multi_value_single_select", values: [{ label: "I acknowledge", value: 2 }] }] }, profile, null).answers.length, 1);
});

test("Stripe-style questions: current or previous title/employer, anticipated work location, abbreviated degrees", async () => {
  const { answerQuestion } = await engine();
  const profile = buildProfileForJob({}, { roles: [{ title: "Senior Software Engineer", company: "Runn Technologies", startDate: "Jan 2023", endDate: "Present" }], education: [{ degree: "Master of Science, Computer Science" }] }, { companyName: "Stripe", locationName: "New York, NY" });
  const text = (label) => answerQuestion({ label, required: true, fields: [{ name: "q", type: "input_text" }] }, profile, null).answers[0]?.value;
  assert.equal(text("What is your current or previous job title?"), "Senior Software Engineer");
  assert.equal(text("Who is your current or previous employer?"), "Runn Technologies");
  assert.equal(text("Please select the location you anticipate working in for the role in which you are applying."), "New York, NY");
  const edu = answerQuestion({ label: "What is the highest level of education you have completed?", required: true, fields: [{ name: "e", type: "multi_value_single_select", values: [{ label: "B.A./ B.S.", value: 1 }, { label: "M.A./ M.S.", value: 2 }, { label: "Ph.D", value: 3 }] }] }, profile, null);
  assert.deepEqual(edu.answers, [{ name: "e", value: 2 }]);
});

test("application emails match by the sender's address too (HP, xAI, Workday tenants)", () => {
  const { candidatesFor } = require("../lib/apply/emailTracker.cjs");
  const apps = [{ companyName: "HP", org: "hp" }, { companyName: "Workday", org: "workday" }, { companyName: "xAI", org: "xai" }, { companyName: "Clera", org: "clera" }];
  const names = (e) => candidatesFor(e, apps).map((a) => a.companyName).join(",");
  assert.equal(names({ from: "Workday HRHPI <hp@myworkday.com>", subject: "Thank you - we've received your job application", snippet: "Thank you for your interest in HP." }), "HP");
  assert.equal(names({ from: "workday@myworkday.com", subject: "Thanks for applying at Workday", snippet: "" }), "Workday");
  assert.equal(names({ from: "no-reply@x.ai", subject: "Thank you for applying to SpaceXSI", snippet: "" }), "xAI");
  assert.equal(names({ from: "Clera Hiring Team <no-reply@ashbyhq.com>", subject: "Thanks for applying to Clera!", snippet: "" }), "Clera");
});
