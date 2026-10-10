// The writing style every generated answer must have: period-only, short
// simple sentences a ten year old could read, nothing that sounds like a
// machine. The sanitizer is the backstop; readability drives a simpler ask.
const test = require("node:test");
const assert = require("node:assert/strict");
const { answerFreeText } = require("../lib/apply/ai-text.cjs");

let st, engine;
test.before(async () => {
  st = await import("../lib/apply/style.mjs");
  engine = await import("../lib/apply/answer-engine.mjs");
});

test("sanitizeText: the period is the only punctuation left", () => {
  assert.equal(st.sanitizeText("I built billing services in Python, AWS and Terraform — and I liked it; it was fun!"),
    "I built billing services in Python AWS and Terraform. And I liked it. It was fun.");
  assert.equal(st.sanitizeText("Yes, I am a person applying myself."), "Yes I am a person applying myself.");
  assert.equal(st.sanitizeText("I leverage robust tools (like Kubernetes) to optimize: speed & cost, which is 10,000% better."),
    "I use strong tools like Kubernetes to improve. Speed and cost. Which is 10000 percent better.");
  assert.equal(st.sanitizeText("- First point\n- Second point"), "First point. Second point.");
  assert.equal(st.sanitizeText("I use Node.js and Python 3.5, which is nice."), "I use Node.js and Python 3.5 which is nice.");
  assert.equal(st.sanitizeText("I'm \"really\" good... at this?"), "I'm really good. At this.");
  assert.equal(st.sanitizeText("October 13, 2026"), "October 13 2026.");
  for (const bad of ["—", "–", ";", ":", "!", "?", "(", ")", "\"", ",", "&", "/", "*"]) {
    assert.ok(!st.sanitizeText(`a ${bad} b, c — d; e: f!`).includes(bad), `still contains ${bad}`);
  }
  // Idempotent.
  const once = st.sanitizeText("Hello, world — again; and again: done!");
  assert.equal(st.sanitizeText(once), once);
});

test("readability: short plain sentences pass, long wordy ones do not", () => {
  assert.equal(st.readability("I like to build things. I use Python and AWS. The work is fun.").simple, true);
  const hard = st.readability("Throughout my professional journey I have consistently demonstrated an exceptional capability to orchestrate multifaceted initiatives across heterogeneous organizational environments.");
  assert.equal(hard.simple, false);
  assert.ok(hard.avgWords > 14 && hard.longShare > 0.1);
  assert.equal(st.readability("").simple, true);
});

test("STYLE_PROMPT asks for period-only kid-simple English", () => {
  assert.match(st.STYLE_PROMPT, /ten year old/);
  assert.match(st.STYLE_PROMPT, /period is the only punctuation/);
  assert.match(st.STYLE_PROMPT, /Do not use commas/);
});

test("answerFreeText asks again for simpler words when the draft reads too hard", async () => {
  const calls = [];
  const openai = { chat: { completions: { create: async (req) => { calls.push(req); return { choices: [{ message: { content: calls.length === 1
    ? "Throughout my professional journey I have consistently demonstrated an exceptional capability to orchestrate multifaceted initiatives across heterogeneous organizational environments and stakeholders."
    : "I like to build things that work. I did that at Runn. I want to do it here too." } }] }; } } } };
  const deps = { openai, model: "t", sanitizeText: st.sanitizeText, STYLE_PROMPT: st.STYLE_PROMPT, aiTrapIn: engine.aiTrapIn, readability: st.readability };
  const ctx = { name: "Ada", currentTitle: "Engineer", skills: "Python", summary: "", roles: [], projects: [], education: [], jobTitle: "SWE", companyName: "Acme", jobDescription: "" };
  const r = await answerFreeText({ label: "Why do you want to work here?", ashbyType: "LongText" }, ctx, deps);
  assert.equal(r.answer, "I like to build things that work. I did that at Runn. I want to do it here too.");
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[0].content, /ten year old/);
  // The simpler draft is only taken when it actually reads easier.
  calls.length = 0;
  const openai2 = { chat: { completions: { create: async (req) => { calls.push(req); return { choices: [{ message: { content: "Throughout my professional journey I have consistently demonstrated an exceptional capability to orchestrate multifaceted initiatives across heterogeneous organizational environments and stakeholders." } }] }; } } } };
  const r2 = await answerFreeText({ label: "Why do you want to work here?", ashbyType: "LongText" }, ctx, { ...deps, openai: openai2 });
  assert.equal(calls.length, 2);
  assert.ok(r2.answer.startsWith("Throughout my professional journey"));
});
