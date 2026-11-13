const test = require("node:test");
const assert = require("node:assert");
const { bestSchool, otherSchool } = require("../lib/apply/prepare.cjs");

// IMC's list has no Cal State East Bay: School falls back to its "Other" (2026-11-13).
const LIST = [
  { id: 1, text: "California State University - Monterey Bay" },
  { id: 2, text: "California State University - Fullerton" },
  { id: 3, text: "Christian Brothers University" },
  { id: 4, text: "Other" },
];
const search = async (t) => LIST.filter((i) => i.text.toLowerCase().includes(String(t).toLowerCase().split(",")[0]));

test("a school missing from the board's list gets its Other option", async () => {
  assert.strictEqual(await bestSchool("California State University, East Bay", search), null);
  assert.strictEqual((await otherSchool(search)).text, "Other");
});
test("no Other option on the board: nothing", async () => {
  assert.strictEqual(await otherSchool(async () => [{ id: 3, text: "Christian Brothers University" }]), null);
});
