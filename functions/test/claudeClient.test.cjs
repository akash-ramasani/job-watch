// The Claude client keeps the chat.completions call shape the functions use
// and sends Messages API requests: system, JSON mode, no sampling params,
// tiers, and tool calls with Claude's own blocks replayed unchanged.
const test = require("node:test");
const assert = require("node:assert/strict");
const { claudeChatClient } = require("../lib/claudeClient.cjs");

function fake(replies) {
  const sent = [];
  return { sent, messages: { create: async (body) => { sent.push(body); return replies.shift(); } } };
}

test("JSON request on the smart tier: system, no temperature, fences stripped", async () => {
  const a = fake([{ id: "m1", model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "```json\n{\"ok\":true}\n```" }], usage: { input_tokens: 10, output_tokens: 5 } }]);
  const client = claudeChatClient(a);
  const out = await client.chat.completions.create({ model: "gpt-4o", temperature: 0.2, max_tokens: 3000, response_format: { type: "json_object" }, messages: [{ role: "system", content: "You parse resumes." }, { role: "user", content: "Parse this" }] });
  const body = a.sent[0];
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.temperature, undefined);
  assert.match(body.system, /You parse resumes\.[\s\S]*only a valid JSON object/);
  assert.equal(body.thinking, undefined, "Opus 5.5 thinks adaptively; disabling it is a 400");
  assert.equal(body.output_config.effort, "medium");
  assert.ok(body.max_tokens >= 6000 && body.max_tokens <= 16000);
  assert.deepEqual(body.messages, [{ role: "user", content: [{ type: "text", text: "Parse this" }] }]);
  assert.equal(out.choices[0].message.content, "{\"ok\":true}");
  assert.equal(out.usage.total_tokens, 15);
});

test("fast tier: Haiku, thinking off, low effort", async () => {
  const a = fake([{ stop_reason: "end_turn", content: [{ type: "text", text: "Short answer." }], usage: {} }]);
  const out = await claudeChatClient(a).chat.completions.create({ model: "claude-haiku-5-5", max_tokens: 300, messages: [{ role: "user", content: "Q" }] });
  assert.equal(a.sent[0].model, "claude-haiku-5-5");
  assert.deepEqual(a.sent[0].thinking, { type: "disabled" });
  assert.equal(a.sent[0].output_config.effort, "low");
  assert.equal(out.choices[0].message.content, "Short answer.");
  // gpt-4o-mini style names land on the fast tier too.
  const b = fake([{ stop_reason: "end_turn", content: [{ type: "text", text: "x" }], usage: {} }]);
  await claudeChatClient(b).chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "user", content: "Q" }] });
  assert.equal(b.sent[0].model, "claude-haiku-5-5");
});

test("tool calls: tool_use out, tool_result back, Claude's blocks replayed verbatim", async () => {
  const turn1 = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "Checking." }, { type: "tool_use", id: "tu_1", name: "search_jobs", input: { q: "python" } }];
  const a = fake([
    { stop_reason: "tool_use", content: turn1, usage: {} },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Found 3 jobs." }], usage: {} },
  ]);
  const client = claudeChatClient(a);
  const tools = [{ type: "function", function: { name: "search_jobs", description: "Search", parameters: { type: "object", properties: { q: { type: "string" } } } } }];
  const msgs = [{ role: "system", content: "Assistant." }, { role: "user", content: "python jobs?" }];
  const r1 = await client.chat.completions.create({ model: "gpt-4o", tools, messages: msgs });
  assert.equal(r1.choices[0].finish_reason, "tool_calls");
  const call = r1.choices[0].message.tool_calls[0];
  assert.equal(call.function.name, "search_jobs");
  assert.deepEqual(JSON.parse(call.function.arguments), { q: "python" });
  assert.deepEqual(a.sent[0].tools[0], { name: "search_jobs", description: "Search", input_schema: tools[0].function.parameters });
  msgs.push({ role: "assistant", content: r1.choices[0].message.content, tool_calls: r1.choices[0].message.tool_calls });
  msgs.push({ role: "tool", tool_call_id: call.id, content: "[3 jobs]" });
  const r2 = await client.chat.completions.create({ model: "gpt-4o", tools, messages: msgs });
  assert.equal(r2.choices[0].message.content, "Found 3 jobs.");
  const sent = a.sent[1].messages;
  assert.deepEqual(sent[1], { role: "assistant", content: turn1 }, "thinking + tool_use replayed unchanged");
  assert.deepEqual(sent[2], { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "[3 jobs]" }] });
});

test("cache_system: the system part goes as one cached block; without it, a plain string", () => {
  const { toMessagesParams } = require("../lib/claudeClient.cjs");
  const cached = toMessagesParams({ cache_system: true, messages: [{ role: "system", content: "Rules" }, { role: "system", content: "Profile" }, { role: "user", content: "Job" }] }).params;
  assert.deepEqual(cached.system, [{ type: "text", text: "Rules\n\nProfile", cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(cached.messages, [{ role: "user", content: [{ type: "text", text: "Job" }] }]);
  assert.equal(toMessagesParams({ messages: [{ role: "system", content: "Rules" }, { role: "user", content: "Job" }] }).params.system, "Rules");
});
