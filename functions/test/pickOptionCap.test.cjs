// The AI option picker sees options past the 80th (Canonical's 314 countries, 2026-11-26).
const test = require("node:test");
const assert = require("node:assert/strict");
const { pickOption } = require("../lib/apply/ai-text.cjs");

test("pickOption sends every option of a long list and accepts a late pick", async () => {
  const labels = [...Array.from({ length: 250 }, (_, i) => `Country ${String(i).padStart(3, "0")}`), "United States of America - California", "United States of America - Texas"];
  let sent = "";
  const openai = { chat: { completions: { create: async (req) => { sent = req.messages[1].content; return { choices: [{ message: { content: JSON.stringify({ picks: ["United States of America - California"], why: "lives in CA" }) } }] }; } } } };
  const q = { label: "In which country do you currently work?", fields: [{ type: "multi_value_single_select", values: labels.map((l) => ({ label: l, value: l })) }] };
  const r = await pickOption(q, { jobTitle: "SRE", companyName: "Canonical" }, { country: "United States", region: "California" }, { openai, model: "x" });
  assert.match(sent, /United States of America - California/);
  assert.match(sent, /Country 249/);
  assert.deepEqual(r.values, ["United States of America - California"]);
});
