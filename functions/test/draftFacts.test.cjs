// "Fill from my resume": every question gets a field back, and the prompt
// carries the resume and profile.
const test = require("node:test");
const assert = require("node:assert/strict");
const { draftFacts } = require("../lib/apply/draftFacts.cjs");

test("drafts every question from the resume; missing keys come back empty", async () => {
  const seen = [];
  const anthropic = { messages: { create: async (b) => { seen.push(b); return { content: [{ type: "text", text: JSON.stringify({ status: "F-1 OPT through August 2029.", stories: "Built X." }) }] }; } } };
  const r = await draftFacts({ anthropic, model: "m" }, { firstName: "Ada", visaType: "F-1 OPT" }, { roles: [{ title: "SWE", company: "Runn", description: "Built billing" }] });
  assert.equal(r.facts.status, "F-1 OPT through August 2029.");
  assert.equal(r.facts.logistics, "");
  assert.equal(Object.keys(r.facts).length, 8);
  assert.match(seen[0].messages[0].content, /Runn/);
  assert.equal(seen[0].output_config.format.type, "json_schema");
});
