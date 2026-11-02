// AI rescue of a stuck field: the request Claude gets, steps limited to refs
// that exist in the field's HTML, the fallback retry, and the yes/no guard.
const test = require("node:test");
const assert = require("node:assert/strict");
const { rescueField, cleanPlan } = require("../lib/apply/rescue.cjs");

const HTML = '<div><label data-jw-ref="r0">School*</label><input role="combobox" data-jw-ref="r1"><div role="option" data-jw-ref="r2">California State University - East Bay</div></div>';
const USER = { firstName: "Ada", requiresSponsorship: "Yes", sessionToken: "secret", fcmTokens: ["x"] };
const RESUME = { summary: "Engineer", roles: [{ title: "SWE", company: "Runn", startDate: "2023", description: "Python" }], education: [{ degree: "MS CS", institution: "CSU East Bay" }] };

function fake(reply, { failFallback = false } = {}) {
  const sent = [];
  const create = async (body) => { sent.push(body); return reply; };
  return {
    sent,
    messages: { create },
    beta: { messages: { create: async (body) => { if (failFallback) { const e = new Error("fallbacks: unknown parameter"); e.status = 400; throw e; } return create(body); } } },
  };
}

test("rescue: request carries the field, the profile and a strict schema; only known refs come back", async () => {
  const a = fake({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ steps: [{ op: "click", ref: "r2", text: "" }, { op: "click", ref: "r99", text: "" }, { op: "eval", ref: "r1", text: "" }], done: true, answer: "CSU East Bay", cannot: "" }) }] });
  const plan = await rescueField({ anthropic: a, model: "claude-opus-5-5" }, { question: "School", html: HTML, required: true, round: 2, jobTitle: "SWE", companyName: "Stripe" }, USER, RESUME);
  assert.deepEqual(plan.steps, [{ op: "click", ref: "r2", text: "" }]);
  assert.equal(plan.done, true);
  const body = a.sent[0];
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.output_config.format.type, "json_schema");
  assert.equal(body.fallbacks, "default");
  assert.match(body.messages[0].content, /School \(required\)/);
  assert.match(body.messages[0].content, /CSU East Bay/);
  assert.doesNotMatch(body.messages[0].content, /secret|fcmTokens/, "only profile answers are sent, never tokens");
  assert.equal(body.temperature, undefined);
});

test("rescue: retries without server-side fallback when the API rejects it; refusals and junk become 'cannot'", async () => {
  const a = fake({ stop_reason: "end_turn", content: [{ type: "text", text: '{"steps":[],"done":false,"answer":"","cannot":"no GPA on the profile"}' }] }, { failFallback: true });
  const plan = await rescueField({ anthropic: a, model: "m" }, { question: "GPA", html: HTML }, USER, RESUME);
  assert.equal(plan.cannot, "no GPA on the profile");
  assert.equal(a.sent[0].fallbacks, undefined);
  const r = await rescueField({ anthropic: fake({ stop_reason: "refusal", content: [] }), model: "m" }, { question: "x", html: HTML }, USER, RESUME);
  assert.match(r.cannot, /declined/);
  assert.match(cleanPlan(null, HTML).cannot, /^$/);
});

test("engine: a typed box never gets a bare Yes/No for a what/which/where question", async () => {
  const e = await import("../lib/apply/answer-engine.mjs");
  const P = { city: "San Francisco", region: "California", country: "United States", resumeText: "", roles: [] };
  const q = (label) => ({ label, required: true, fields: [{ name: "x", type: "input_text", values: [] }] });
  assert.deepEqual(e.answerQuestion(q("If located in the US, in what city and state do you reside?"), P, null).answers.map((a) => a.value), ["San Francisco, California"]);
  assert.deepEqual(e.answerQuestion(q("Are you currently based in the US?"), P, null).answers.map((a) => a.value), ["Yes"]);
});

test("rescue: the board's error for the field reaches Claude (from history, as rescue.js sends it)", async () => {
  const a = fake({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ steps: [{ op: "type", ref: "r1", text: "https://linkedin.com/in/ada" }], done: true, answer: "LinkedIn URL", cannot: "" }) }] });
  await rescueField({ anthropic: a, model: "m" }, { question: "LinkedIn", html: HTML, required: false, round: 1, history: [{ round: 0, boardError: "Enter a valid URL" }] }, USER, RESUME);
  assert.match(a.sent[0].messages[0].content, /The form shows this error on the field: "Enter a valid URL"/);
  const b = fake({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ steps: [], done: false, answer: "", cannot: "x" }) }] });
  await rescueField({ anthropic: b, model: "m" }, { question: "School", html: HTML }, USER, RESUME);
  assert.doesNotMatch(b.sent[0].messages[0].content, /error on the field/);
});
