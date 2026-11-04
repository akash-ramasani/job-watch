// "Answer with AI": duplicates grouped, answers saved as learned, the rest
// kept once for the person (lib/apply/draftAnswers.cjs).
const test = require("node:test");
const assert = require("node:assert/strict");
const { draftAnswers, applyDrafts, factsOf } = require("../lib/apply/draftAnswers.cjs");
const { keyOf } = require("../lib/apply/savedAnswers.cjs");

const FV = { delete: () => "DELETE" };
const q = (question, extra = {}) => [keyOf(question), { question, count: 1, ...extra }];
const missing = Object.fromEntries([
  q("Are you currently on F-1 OPT?"),
  q("Are you currently on an F1 visa with OPT"),
  q("What is your GitHub username?", { count: 2 }),
  q("Github handle"),
  q("Country of citizenship"),
]);
const ids = Object.keys(missing);

test("draftAnswers: only real ids, each once; empty answers are null", async () => {
  const reply = { groups: [{ ids: [ids[0], ids[1], "made-up"], answer: "Yes", why: "" }, { ids: [ids[2], ids[3], ids[0]], answer: "", why: "a GitHub username" }, { ids: [ids[4]], answer: "India" }] };
  let sent;
  const client = { chat: { completions: { create: async (req) => { sent = req; return { choices: [{ message: { content: JSON.stringify(reply) } }] }; } } } };
  const { groups } = await draftAnswers({ client, model: "m" }, { missing, user: { firstName: "Akash", gmailToken: "x", requiresSponsorship: "Yes" }, resume: {}, about: "I am an F-1 OPT student from India" });
  assert.deepEqual(groups.map((g) => g.ids), [[ids[0], ids[1]], [ids[2], ids[3]], [ids[4]]]);
  assert.equal(groups[1].answer, null);
  assert.match(sent.messages[1].content, /F-1 OPT student from India/);
  assert.doesNotMatch(sent.messages[1].content, /gmailToken/, "no private fields sent");
});

test("applyDrafts: answers saved as learned, duplicates merged, the rest kept once", () => {
  const groups = [{ ids: [ids[0], ids[1]], answer: "Yes", why: "" }, { ids: [ids[2], ids[3]], answer: null, why: "a GitHub username" }, { ids: [ids[4]], answer: "India", why: "" }];
  const { update, answered, waiting, merged } = applyDrafts(missing, groups, { FieldValue: FV, now: new Date(0) });
  assert.equal(answered, 2); assert.equal(waiting, 1); assert.equal(merged, 1);
  assert.equal(update[`savedAnswers.${ids[0]}`].answer, "Yes");
  assert.equal(update[`savedAnswers.${ids[1]}`].source, "ai");
  assert.equal(update[`missingAnswers.${ids[1]}`], "DELETE");
  assert.equal(update[`missingAnswers.${ids[3]}`], "DELETE");
  assert.equal(update[`missingAnswers.${ids[2]}.count`], 3);
  assert.equal(update[`missingAnswers.${ids[2]}.why`], "needs you: a GitHub username");
  assert.ok(update.answersUpdatedAt);
});

test("factsOf leaves out tokens and the answer bank", () => {
  assert.deepEqual(factsOf({ city: "San Francisco", gmailToken: "t", savedAnswers: { a: 1 }, sessionId: "s", visaType: "F-1 OPT" }), { city: "San Francisco", visaType: "F-1 OPT" });
});
