// claudeClient.cjs — every text feature on Claude through the Anthropic SDK.
//
// The functions call `client.chat.completions.create({ model, messages,
// max_tokens, response_format, tools, ... })` in many places (the assistant,
// resume parsing, tailored resumes, Autofill's free-text answers). This object
// keeps that call shape and runs each request on the Messages API:
//   - system/developer messages -> `system`; tool results -> `tool_result`
//     blocks; tool calls -> `tool_use` blocks (Claude's own assistant blocks,
//     thinking included, are replayed unchanged on the next tool turn);
//   - response_format json_object/json_schema -> a JSON-only instruction plus
//     fence stripping (Claude 5 models take no prefill);
//   - temperature/top_p/seed are dropped (Claude 5 models reject non-default
//     sampling values);
//   - the fast tier (Haiku) runs with thinking off at low effort; the smart
//     tier (Opus) thinks adaptively at low or medium effort, with extra
//     max_tokens so thinking never starves the answer.
// The reply comes back as { choices: [{ message: { content, tool_calls },
// finish_reason }], usage } so callers stay unchanged.

const MAX_TOKENS_CAP = 16000; // non-streaming requests stay well under the SDK's 10-minute guard
const rawToolTurns = new Map(); // tool_use id -> Claude's assistant content blocks, replayed verbatim

function remember(id, blocks) {
  rawToolTurns.set(id, blocks);
  if (rawToolTurns.size > 500) rawToolTurns.delete(rawToolTurns.keys().next().value);
}

const textOf = (content) => (typeof content === "string" ? content
  : Array.isArray(content) ? content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("") : "");

function parseArgs(s) {
  if (s && typeof s === "object") return s;
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}

/** OpenAI-style request -> Messages API params (without model/effort). */
function toMessagesParams(req) {
  const system = [];
  const messages = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content = [...last.content, ...blocks];
    else messages.push({ role, content: [...blocks] });
  };
  for (const m of req.messages || []) {
    const text = textOf(m.content);
    if (m.role === "system" || m.role === "developer") { if (text.trim()) system.push(text); continue; }
    if (m.role === "tool") { push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: text || "(no output)" }]); continue; }
    if (m.role === "assistant") {
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      const raw = calls.length ? rawToolTurns.get(calls[0].id) : null;
      if (raw) { push("assistant", raw); continue; }
      const blocks = [];
      if (text.trim()) blocks.push({ type: "text", text });
      for (const c of calls) blocks.push({ type: "tool_use", id: c.id, name: c.function?.name, input: parseArgs(c.function?.arguments) });
      push("assistant", blocks);
      continue;
    }
    if (text.trim()) push("user", [{ type: "text", text }]);
  }
  const wantsJson = ["json_object", "json_schema"].includes(req.response_format?.type);
  if (wantsJson) system.push("Respond with only a valid JSON object: no markdown fences, no text before or after it.");
  const params = { messages };
  if (system.length) params.system = system.join("\n\n");
  if (Array.isArray(req.tools) && req.tools.length) {
    params.tools = req.tools.filter((t) => t?.type === "function" && t.function?.name).map((t) => ({
      name: t.function.name,
      description: t.function.description || "",
      input_schema: t.function.parameters || { type: "object", properties: {} },
    }));
    params.tool_choice = req.tool_choice === "none" ? { type: "none" } : { type: "auto" };
  }
  return { params, wantsJson };
}

const stripFences = (s) => String(s || "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

/** Messages API reply -> OpenAI-style reply. */
function toCompletion(res, wantsJson) {
  const blocks = Array.isArray(res?.content) ? res.content : [];
  let text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  if (wantsJson) text = stripFences(text);
  const uses = blocks.filter((b) => b.type === "tool_use");
  for (const u of uses) remember(u.id, blocks);
  const finish = { end_turn: "stop", stop_sequence: "stop", tool_use: "tool_calls", max_tokens: "length", refusal: "content_filter" }[res?.stop_reason] || "stop";
  const message = { role: "assistant", content: text || (uses.length ? "" : null) };
  if (uses.length) message.tool_calls = uses.map((u) => ({ id: u.id, type: "function", function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) } }));
  const inTok = res?.usage?.input_tokens || 0, outTok = res?.usage?.output_tokens || 0;
  return { id: res?.id, model: res?.model, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok } };
}

/**
 * The client. `anthropic` is an @anthropic-ai/sdk instance; `models` maps the
 * names the code passes (anything not starting with "claude-") to a tier.
 */
function claudeChatClient(anthropic, { fastModel = "claude-haiku-5-5", smartModel = "claude-opus-5-5" } = {}) {
  const pick = (name) => {
    const n = String(name || "");
    if (n.startsWith("claude-")) return n;
    return /mini|nano|haiku|fast/i.test(n) ? fastModel : smartModel;
  };
  async function create(req, opts) {
    const model = pick(req.model);
    const { params, wantsJson } = toMessagesParams(req);
    const asked = Number(req.max_tokens || req.max_completion_tokens) || 4096;
    const fast = /haiku/.test(model);
    const body = { model, ...params };
    if (fast) {
      body.max_tokens = Math.min(Math.max(asked, 512), MAX_TOKENS_CAP);
      body.thinking = { type: "disabled" };
      body.output_config = { effort: "low" };
    } else {
      // Thinking shares max_tokens with the answer: leave it room.
      body.max_tokens = Math.min(Math.max(asked * 2, 8000), MAX_TOKENS_CAP);
      body.output_config = { effort: asked <= 1500 && !params.tools ? "low" : "medium" };
    }
    const res = await anthropic.messages.create(body, opts);
    return toCompletion(res, wantsJson);
  }
  return { chat: { completions: { create } }, provider: "anthropic" };
}

module.exports = { claudeChatClient, toMessagesParams, toCompletion, stripFences };
