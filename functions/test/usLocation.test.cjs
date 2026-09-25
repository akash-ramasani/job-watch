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

test("foreign cities aren't rescued by a state-code look-alike; US namesakes stay", () => {
  for (const loc of ["IN-Bangalore-MSO", "Bengaluru, IN", "Hyderabad, Telangana, IN", "Pune, IN", "Tel Aviv, IL", "Sydney, AU", "Singapore"]) {
    assert.equal(keeps(loc), false, loc);
  }
  for (const loc of ["Vancouver, WA", "Dublin, OH", "Paris, TX", "Athens, GA", "London, KY", "Indianapolis, IN", "Chicago, IL", "Bangalore or Remote - US",
    "Portland, OR", "Portland, ME", "Wilmington, DE", "Honolulu, HI", "Anchorage, AK", "Charleston, SC; Remote"]) {
    assert.equal(keeps(loc), true, loc);
  }
});

test("mixed US + foreign location lists are kept", () => {
  for (const loc of ["Mountain View, California | Munich, Germany | Singapore", "New York, London, Singapore", "Seoul; San Francisco; Buenos Aires",
    "Houston, London, Madrid, Montreal, New York, Paris, Singapore", "London; Stockholm; New York City"]) {
    assert.equal(keeps(loc), true, loc);
  }
});
