// The whole-form review before Submit: what reaches Claude, and only issues
// about questions on the form come back.
const test = require("node:test");
const assert = require("node:assert/strict");
const { reviewForm, cleanItems } = require("../lib/apply/review.cjs");

const items = [
  { question: "First Name", answer: "Ada", required: true },
  { question: "I certify that the information … my electronic signature is as valid as an original signature", answer: "32666462", required: true },
  { question: "Application Date Signed", answer: "", required: true },
];

function fakeAnthropic(reply, seen) {
  return { messages: { create: async (body) => { seen.push(body); return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(reply) }] }; } } };
}

test("sends every question with its answer and today's date; keeps issues on real questions", async () => {
  const seen = [];
  const reply = { issues: [
    { question: items[1].question, problem: "A number, not the applicant's name", fix: "Ada Lovelace", severity: "wrong" },
    { question: "Application Date Signed", problem: "Required and empty", fix: "11/09/2026", severity: "wrong" },
    { question: "A question not on the form", problem: "x", fix: "y", severity: "wrong" },
  ] };
  const r = await reviewForm({ anthropic: fakeAnthropic(reply, seen), model: "m" }, { items, companyName: "CannonDesign" }, { firstName: "Ada", lastName: "Lovelace", timezone: "UTC" }, {});
  assert.deepEqual(r.issues.map((i) => i.question), [items[1].question, "Application Date Signed"]);
  const text = seen[0].messages[0].content;
  assert.match(text, /Today's date: \d{4}-\d{2}-\d{2}/);
  assert.match(text, /\* Application Date Signed\n {3}-> ""/);
  assert.match(text, /-> "32666462"/);
  assert.equal(seen[0].output_config.format.type, "json_schema");
});

test("an empty form makes no call; a bad reply is no issues", async () => {
  const seen = [];
  assert.deepEqual(await reviewForm({ anthropic: fakeAnthropic({}, seen), model: "m" }, { items: [] }, {}, {}), { issues: [] });
  assert.equal(seen.length, 0);
  const bad = { messages: { create: async () => ({ content: [{ type: "text", text: "not json" }] }) } };
  assert.deepEqual(await reviewForm({ anthropic: bad, model: "m" }, { items }, {}, {}), { issues: [] });
  assert.equal(cleanItems([{ question: "  " }, null, { question: "Q", answer: 5 }]).length, 1);
});

test("a 'How did you hear about us' choice never blocks Submit (xAI)", () => {
  const { cleanIssues } = require("../lib/apply/review.cjs");
  const items = [{ question: "How did you hear about us?", answer: "Other" }, { question: "Are you located in the US?", answer: "No" }];
  const out = cleanIssues({ issues: [
    { question: "How did you hear about us?", problem: "profile says Job Board", fix: "Job Board", severity: "wrong" },
    { question: "Are you located in the US?", problem: "profile says San Francisco", fix: "Yes", severity: "wrong" },
  ] }, items);
  assert.deepEqual(out.map((i) => i.question), ["Are you located in the US?"]);
});

test("the pre-submit check knows a fixed list's closest option is not a mistake (Cisco, NVIDIA)", () => {
  const { SYSTEM } = require("../lib/apply/review.cjs");
  assert.match(SYSTEM, /closest option the form offers/);
});
