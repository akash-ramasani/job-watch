// Signing dates and "details" follow-ups after a No (CannonDesign, 2026-11-09):
// "Application Date Signed" is today's date; "Please provide details…" after
// "No" to outside employment is "N/A", not a summary of the resume.
const test = require("node:test");
const assert = require("node:assert/strict");

let engine;
test.before(async () => { engine = await import("../lib/apply/answer-engine.mjs"); });

const profile = { firstName: "Ada", lastName: "Lovelace", todayISO: "2026-11-09" };
const yesNo = [{ label: "Yes", value: 1 }, { label: "No", value: 2 }];

test("Application Date Signed is today's date as MM/DD/YYYY", () => {
  const m = engine.mapForm([{ label: "Application Date Signed", required: true, fields: [{ name: "question_9", type: "input_text" }] }], profile, null);
  assert.equal(m.answers[0].answers[0].value, "11/09/2026");
  assert.equal(m.review.length, 0);
});

test("details follow-up after No is N/A; after Yes it is left to the writer", () => {
  const qs = (pick) => [
    { label: "If selected for this role, do you intend to begin or continue any outside employment, self-employment, freelance work, board position, or other business affiliation while employed by CannonDesign?", required: true, fields: [{ name: "question_10", type: "multi_value_single_select", values: yesNo }] },
    { label: "Please provide details, including name of the organization if applicable, nature of the work, position, or affiliation, estimated hours spent per week, and any other details that you think may be relevant.", required: true, fields: [{ name: "question_11", type: "textarea" }] },
  ];
  const profileNo = { ...profile, savedAnswers: { [engine.normQuestion(qs()[0].label)]: { answer: "No", source: "you" } } };
  const m = engine.mapForm(qs(), profileNo, null);
  assert.equal(m.answers[0].answers[0].value, 2);
  assert.equal(m.answers[1].answers[0].value, "N/A");
  const profileYes = { ...profile, savedAnswers: { [engine.normQuestion(qs()[0].label)]: { answer: "Yes", source: "you" } } };
  assert.notEqual(engine.mapForm(qs(), profileYes, null).answers[1].answers[0]?.value, "N/A");
});
