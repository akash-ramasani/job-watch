const test = require("node:test");
const assert = require("node:assert");
const { companyExcluder } = require("../lib/companyExclude.cjs");

test("names as people type them cover the board's names (Riti, 2026-11-13)", () => {
  const no = companyExcluder(["U.S. Bank", "Costco", "CVS"]);
  for (const c of ["U.S. Bank", "US Bank", "U.S. Bank National Association", "Costco Wholesale", "Costco", "CVS Health", "CVS Pharmacy, Inc.", "cvs"]) assert.ok(no(c), c);
  for (const c of ["USAA", "U.S. Bancorp", "Bank of America", "Costar Group", "CVSL", "Health CVS", "Elevance Health", ""]) assert.ok(!no(c), c);
});
test("an empty list excludes nothing", () => {
  assert.strictEqual(companyExcluder([])("CVS Health"), false);
  assert.strictEqual(companyExcluder(undefined)("CVS Health"), false);
});
