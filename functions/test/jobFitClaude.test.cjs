// assessJobFit against a Claude (Messages API) client and an OpenAI one — no network.
// Run: npm test (in functions/)
const test = require("node:test");
const assert = require("node:assert/strict");
const { assessJobFit, isClaudeClient, buildProfileText, PROMPT_VERSION } = require("../lib/jobFit.cjs");

const profileText = buildProfileText({
  summary: "Software engineer with 5+ years of experience shipping production backend systems.",
  skillGroups: [{ label: "Languages", skills: ["Python", "TypeScript", "Java"] }, { label: "Cloud", skills: ["AWS", "Kubernetes", "Terraform"] }],
  roles: [{ title: "Senior Software Engineer", company: "Compass Group", startDate: "Aug 2024", endDate: "May 2026", description: "Led a zero-downtime DB2 to PostgreSQL migration. Designed high-volume REST APIs." }],
});
const ANSWER = JSON.stringify({
  roleFit: "same", roleNote: "", minYears: 3,
  requirements: [
    { r: "PostgreSQL", n: "must", c: "yes", e: "zero-downtime DB2 to PostgreSQL migration" },
    { r: "Kubernetes", n: "must", c: "yes", e: "Kubernetes" },
    { r: "Kafka", n: "nice", c: "no", e: "" },
  ],
});

function claudeClient(reply) {
  const calls = [];
  return { calls, messages: { create: async (body, opts) => { calls.push({ body, opts }); return { content: [{ type: "text", text: reply }], usage: { input_tokens: 10, output_tokens: 5 } }; } } };
}
function openaiClient(reply) {
  const calls = [];
  return { calls, chat: { completions: { create: async (body, opts) => { calls.push({ body, opts }); return { choices: [{ message: { content: reply } }] }; } } } };
}

test("isClaudeClient tells the two SDKs apart", () => {
  assert.equal(isClaudeClient(claudeClient("")), true);
  assert.equal(isClaudeClient(openaiClient("")), false);
  assert.equal(isClaudeClient(null), false);
});

test("Claude request: cached candidate prefix, job as a second block, thinking off, no temperature", async () => {
  const client = claudeClient(ANSWER);
  const fit = await assessJobFit({ client, model: "claude-haiku-5-5", profileText, candidateYears: 5, candidateTitles: ["Senior Software Engineer"], jobTitle: "Backend Engineer", jobDescription: "Must: PostgreSQL, Kubernetes. Nice: Kafka." });
  assert.equal(client.calls.length, 1);
  const { body, opts } = client.calls[0];
  assert.equal(body.model, "claude-haiku-5-5");
  assert.equal(body.max_tokens, 900);
  assert.equal(body.temperature, undefined);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.deepEqual(body.output_config, { effort: "low" });
  assert.equal(body.system[0].type, "text");
  assert.match(body.system[0].text, /strict and literal/);
  assert.equal(body.messages.length, 1);
  const [candidate, job] = body.messages[0].content;
  assert.deepEqual(candidate.cache_control, { type: "ephemeral" });
  assert.match(candidate.text, /^## CANDIDATE'S RECENT TITLES: Senior Software Engineer/);
  assert.match(candidate.text, /## PROFILE \(total professional experience: about 5 years\)/);
  assert.match(candidate.text, /DB2 to PostgreSQL migration/);
  assert.equal(job.cache_control, undefined);
  assert.match(job.text, /^## JOB: Backend Engineer\nMust: PostgreSQL/);
  assert.equal(opts.timeout, 45000);
  // Parsed and scored like before, and the model is recorded on the fit.
  assert.equal(fit.prompt, PROMPT_VERSION);
  assert.equal(fit.model, "claude-haiku-5-5");
  assert.equal(fit.roleFit, "same");
  assert.equal(fit.requirements.length, 3);
  assert.ok(fit.score > 0);
});

test("Claude reply wrapped in a code fence or prose still parses", async () => {
  const client = claudeClient("Here is the assessment:\n```json\n" + ANSWER + "\n```\nDone.");
  const fit = await assessJobFit({ client, model: "claude-haiku-5-5", profileText, jobTitle: "Backend Engineer", jobDescription: "x" });
  assert.equal(fit.requirements.length, 3);
});

test("Claude reply that is not JSON returns null instead of throwing", async () => {
  const fit = await assessJobFit({ client: claudeClient("I cannot assess this."), model: "claude-haiku-5-5", profileText, jobTitle: "x", jobDescription: "y" });
  assert.equal(fit, null);
});

test("OpenAI request keeps the chat-completions shape", async () => {
  const client = openaiClient(ANSWER);
  const fit = await assessJobFit({ client, model: "gpt-4o-mini", profileText, candidateYears: 5, jobTitle: "Backend Engineer", jobDescription: "Must: PostgreSQL." });
  const { body } = client.calls[0];
  assert.equal(body.temperature, 0);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[1].content, /## PROFILE \(total professional experience: about 5 years\)[\s\S]*## JOB: Backend Engineer\nMust: PostgreSQL\./);
  assert.equal(fit.model, "gpt-4o-mini");
});

test("the job text is capped at 6000 characters", async () => {
  const client = claudeClient(ANSWER);
  await assessJobFit({ client, model: "m", profileText, jobTitle: "T", jobDescription: "a".repeat(9000) });
  assert.equal(client.calls[0].body.messages[0].content[1].text.length, "## JOB: T\n".length + 6000);
});
