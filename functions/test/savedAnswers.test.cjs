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

test("savedIndex: the person's answer wins over a learned one", () => {
  const idx = sa.savedIndex({ savedAnswers: { a: { question: "T-shirt size?", answer: "M", source: "ai" }, b: { question: "t-shirt size", answer: "L", source: "you" }, c: { question: "Blank", answer: "" } } });
  assert.deepEqual(idx, { "t-shirt size": { answer: "L", source: "you" } });
});

test("engine: a saved answer fills a question no rule knows, and picks the matching option", async () => {
  const { answerQuestion } = await engine();
  const profile = buildProfileForJob({ savedAnswers: { k: { question: "What is your T-shirt size?", answer: "Medium", source: "ai" }, j: { question: "Which shift do you prefer?", answer: "Night", source: "you" } } }, {}, { companyName: "X" });
  const text = answerQuestion({ label: "What is your T-shirt size? *", required: true, fields: [{ name: "q1", type: "input_text" }] }, profile, null);
  assert.deepEqual(text.answers, [{ name: "q1", value: "Medium" }]);
  const sel = answerQuestion({ label: "Which shift do you prefer?", required: true, fields: [{ name: "q2", type: "multi_value_single_select", values: [{ label: "Day", value: "1" }, { label: "Night shift", value: "2" }] }] }, profile, null);
  assert.deepEqual(sel.answers, [{ name: "q2", value: "2" }]);
  // No option fits: the saved answer is not forced.
  const none = answerQuestion({ label: "What is your T-shirt size?", required: true, fields: [{ name: "q3", type: "multi_value_single_select", values: [{ label: "S", value: "s" }, { label: "XL", value: "xl" }] }] }, profile, null);
  assert.equal(none.answers.length, 0);
});

test("learn: writes saved and missing, never overwrites the person's own answer with the AI's", async () => {
  const writes = [];
  const user = { savedAnswers: { [sa.keyOf("Shirt size")]: { question: "Shirt size", answer: "L", source: "you" } } };
  const ref = { get: async () => ({ exists: true, data: () => user }), update: async (u) => writes.push(u) };
  const db = { collection: () => ({ doc: () => ref }) };
  const FieldValue = { delete: () => "DEL", increment: (n) => `INC${n}` };
  const r = await sa.learn(db, "U", {
    saved: [{ question: "Shirt size", answer: "S", source: "ai" }, { question: "Which school did you attend?", answer: "CSU East Bay", source: "you" }],
    missing: [{ question: "Security clearance number", why: "not in profile", companyName: "Anduril" }, { question: "Resume/CV", why: "x" }],
  }, { FieldValue });
  assert.deepEqual(r, { saved: 1, missing: 1 });
  const u = writes[0];
  const k = sa.keyOf("Which school did you attend?");
  assert.equal(u[`savedAnswers.${k}`].answer, "CSU East Bay");
  assert.equal(u[`missingAnswers.${k}`], "DEL");
  assert.equal(u[`missingAnswers.${sa.keyOf("Security clearance number")}.count`], "INC1");
  assert.ok(u.answersUpdatedAt instanceof Date);
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
