// Fetch-time US location filter (Greenhouse/Ashby). Run: npm test (in functions/)
const test = require("node:test");
const assert = require("node:assert/strict");
const { jobMatchesLocationFilter, extractLocationTokens } = require("../index.js").__internals;

const keeps = (loc) => jobMatchesLocationFilter({ locationTokens: extractLocationTokens(loc) });

test("US and remote wording is kept", () => {
  for (const loc of ["Remote - US", "Remote - US ", "US - Remote", "U.S. (Remote)", "USA (Remote)", "United States of America", "Remote - United States",
    "North America", "Remote", "Remote - SF Bay Area", "U.S. Remote; Travelling", "Remote - US or Canada", "San Francisco, CA", "New York, NY", "Austin, Texas", "Remote - Global"]) {
    assert.equal(keeps(loc), true, loc);
  }
});

test("other countries are dropped, including their remote roles", () => {
  for (const loc of ["Remote - Canada", "Remote - Czech Republic", "Remote - Germany", "Remote - Mexico", "Hybrid - London", "London, UK", "Bengaluru, India",
    "Remote - EMEA", "Remote - Latin America", "Toronto, Canada", ""]) {
    assert.equal(keeps(loc), false, loc);
  }
});
