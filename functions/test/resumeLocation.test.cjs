// Regression cases for chooseResumeLocation, drawn from real postings in the
// DB across Workday, Oracle, Greenhouse and Ashby feeds. Run: node --test functions/test
const test = require("node:test");
const assert = require("node:assert/strict");
const { chooseResumeLocation } = require("../lib/resumeLocation.cjs");

const CASES = [
  // priority across a list
  ["New York, NY; Boston, MA; Chicago, IL", "New York, NY"],
  ["San Francisco, CA; New York, NY; Los Angeles, CA; Atlanta, GA; Chicago, IL", "San Francisco, CA"],
  ["AMER - United States - Oregon - Portland; AMER - United States - California - San Francisco - One Market", "San Francisco, CA"],
  ["Cambridge, MA; Thousand Oaks, CA; Louisville, KY", "Boston, MA"],
  ["Denver, Colorado, United States; San Francisco, California, United States", "San Francisco, CA"],
  ["NY or SF", "San Francisco, CA"],
  ["NYC or DC", "New York, NY"],
  ["Chicago and NYC", "New York, NY"],
  ["Nashville, TN or Richmond, VA (Hybrid)", "Nashville, TN"],
  ["Austin, Texas & Sunnyvale, California", "San Jose, CA"],
  ["Hybrid - San Francisco, New York City, Austin", "San Francisco, CA"],
  ["Hybrid (NYC / Austin)", "New York, NY"],
  // single cities and suburbs
  ["Boston, MA", "Boston, MA"],
  ["Chantilly, VA", "Washington, DC"],
  ["US, CA, Santa Clara", "San Jose, CA"],
  ["Hybrid- Fremont, CA", "San Francisco, CA"],
  ["Jersey City, NJ, United States", "New York, NY"],
  ["Bronx, New York", "New York, NY"],
  ["Washington - Seattle Campus", "Seattle, WA"],
  ["Washington, District of Columbia, United States", "Washington, DC"],
  ["Washington", "Washington, DC"],
  ["New York", "New York, NY"],
  ["NEW YORK, NY", "New York, NY"],
  ["Betterment HQ - New York City", "New York, NY"],
  ["USA - New York (dbt)", "New York, NY"],
  ["Office - Nassau (East Meadow, NY)", "East Meadow, NY"],
  ["East Palo Alto", "San Francisco, CA"],
  ["Bay Area, CA", "San Francisco, CA"],
  ["San Francisco Bay Area", "San Francisco, CA"],
  ["Greater Chicago Area", "Chicago, IL"],
  ["Dallas-Fort Worth Metroplex", "Dallas, TX"],
  ["Dallas - Ft. Worth, TX", "Dallas, TX"],
  ["Tysons Corner", "Washington, DC"],
  ["Dublin-Ohio-United States of America", "Columbus, OH"],
  ["King of Prussia, Pennsylvania, United States", "Philadelphia, PA"],
  // unlisted cities used as-is
  ["Kenosha, WI", "Kenosha, WI"],
  ["Whitestown, IN", "Whitestown, IN"],
  ["Bend, OR, United States", "Bend, OR"],
  ["Vancouver, WA; Gresham, OR", "Vancouver, WA"],
  ["Winston-Salem, NC", "Winston-Salem, NC"],
  ["Mountain Home, AR", "Mountain Home, AR"],
  ["Melbourne, FL", "Melbourne, FL"],
  ["United States-Florida-Melbourne", "Melbourne, FL"],
  ["Warsaw, Indiana, United States of America", "Warsaw, IN"],
  ["London, KY", "London, KY"],
  ["Lima, OH, United States", "Lima, OH"],
  ["Ontario, California", "Ontario, CA"],
  ["1800 State Hwy 5S, Amsterdam,NY 12010-8174", "Amsterdam, NY"],
  ["Virginia Beach, Va 23455", "Virginia Beach, VA"],
  ["Grand Rapids Metro, MI Home", "Grand Rapids, MI"],
  // odd feed formats
  ["Seattle WA", "Seattle, WA"],
  ["Store0681 Vernon Hills IL", "Chicago, IL"],
  ["Store1363 Schererville IN", "Schererville, IN"],
  ["US-AZ-TUCSON-M13 ~ 3601 E Britannia Dr ~ BRITANNIA M13; US-TX-MCKINNEY-513PW", "Dallas, TX"],
  ["US-FL-MELBOURNE-310 ~ 1100 W Hibiscus Blvd ~ BLDG 310", "Melbourne, FL"],
  ["USA.VA.Reston", "Washington, DC"],
  ["US-VA Richmond", "Richmond, VA"],
  ["USA-TX Plano Legacy Drive Suite 700", "Dallas, TX"],
  ["US > Arizona > Phoenix", "Phoenix, AZ"],
  ["United States > Madison : 1 Exact Lane", "Madison, WI"],
  ["WA Bellevue 205 108th Avenue NE, Suite S200; CA San Francisco 153 Kearny Street", "San Francisco, CA"],
  ["US MN Minneapolis Office", "Minneapolis, MN"],
  ["IN - Fort Wayne, 720 Taylor St", "Fort Wayne, IN"],
  ["OR - Gresham, 291 NE 223rd Ave - Retail XFR3558", "Gresham, OR"],
  ["IL-Wheaton Car Care Plus", "Wheaton, IL"],
  ["NC-Charlotte Headquarters NEW", "Charlotte, NC"],
  ["MN-Shakopee Mart", "Shakopee, MN"],
  ["MN-Coon Rapids New", "Coon Rapids, MN"],
  ["FL-Naples ERS Fleet", "Naples, FL"],
  ["Dallas Infomart Office DAI; Toronto", "Dallas, TX"],
  ["(USA) TX FORT WORTH 07555 ECOMM FULFILLMENT SERVICES", "Dallas, TX"],
  ["(USA) CO ARVADA 06630 SAM'S CLUB", "Arvada, CO"],
  ["USA VA DXC Arlington, Wilson Blvd (CSC location)", "Washington, DC"],
  ["San Antonio Home Office I; Plano Legacy", "Dallas, TX"],
  ["Atlanta Warehouse; Chicago Warehouse; Dallas Warehouse", "Chicago, IL"],
  ["Gemological Institute of America, Inc. (Carlsbad, California); Gemological Institute of America, Inc. (New York, New York)", "New York, NY"],
  // military / federal sites
  ["Edwards AFB, CA", "Edwards, CA"],
  ["United States-Colorado-Schriever AFB", "Denver, CO"],
  ["USA - Kennedy Space Center, FL", "Titusville, FL"],
  ["United States-Ohio-Wright-Patterson AFB", "Dayton, OH"],
  ["United States-West Virginia-Rocket Center", "Rocket Center, WV"],
  // state-only postings
  ["Colorado, United States", "Denver, CO"],
  ["Colorado, Illinois", "Chicago, IL"],
  ["Georgia/Florida, US", "Atlanta, GA"],
  ["Mississippi, Louisiana, Georgia, Wisconsin, Wyoming", "Atlanta, GA"],
  ["Massachusetts (Any City); Rhode Island (Any City)", "Boston, MA"],
  ["All Cities, Georgia, United States of America", "Atlanta, GA"],
  ["NH, United States", "Manchester, NH"],
  ["NY office", "New York, NY"],
  ["US - NJ - Home Office; US - CA - Home Office", "San Francisco, CA"],
  ["Southern California, USA - Remote; Northern California, USA", "San Francisco, CA"],
  ["University of Tennessee", "Nashville, TN"],
  // remote / unparseable / foreign → default
  ["Remote US", "San Francisco, CA"],
  ["Remote - USA", "San Francisco, CA"],
  ["US, Remote", "San Francisco, CA"],
  ["US, TX, Remote; US, CA, Remote", "San Francisco, CA"],
  ["United States", "San Francisco, CA"],
  ["Hybrid, US", "San Francisco, CA"],
  ["San Francisco - remote first in US", "San Francisco, CA"],
  ["Humacao, Puerto Rico, United States of America", "San Francisco, CA"],
  ["Birmingham, United Kingdom", "San Francisco, CA"],
  ["Montréal, Canada", "San Francisco, CA"],
  ["Bangalore, Karnataka, India", "San Francisco, CA"],
  ["IL - Tel Aviv", "San Francisco, CA"],
  ["CA-Toronto", "San Francisco, CA"],
  ["Bangalore, IN", "San Francisco, CA"],
  ["London, New York", "New York, NY"],
  ["New York, London, Singapore", "New York, NY"],
  ["", "San Francisco, CA"],
];

for (const [input, expected] of CASES) {
  test(`${JSON.stringify(input)} → ${expected}`, () => {
    const r = chooseResumeLocation({ locationName: input });
    assert.equal(r.display, expected);
    assert.match(r.displayWithZip, /^[^,]+, [A-Z]{2}( \d{5})?$/);
  });
}

test("metro results always carry a ZIP; remote default is 94114", () => {
  assert.equal(chooseResumeLocation({ locationName: "Remote US" }).zip, "94114");
  assert.equal(chooseResumeLocation({ locationName: "Boston, MA" }).zip, "02116");
  assert.equal(chooseResumeLocation({ locationName: "Kenosha, WI" }).zip, "53140");
});

test("codes, acronyms and state words never become cities", () => {
  assert.equal(chooseResumeLocation({ locationName: "Remote-WA State" }).display, "Seattle, WA");
  assert.equal(chooseResumeLocation({ locationName: "US-TX-OTHER TEXAS" }).display, "Austin, TX");
  assert.equal(chooseResumeLocation({ locationName: "PLS - Remote (OH)" }).display, "Columbus, OH");
  assert.equal(chooseResumeLocation({ locationName: "State of Missouri, United States of America; State of Kansas" }).display, "Kansas City, MO");
  assert.equal(chooseResumeLocation({ locationName: "University of  Georgia (UGA)" }).display, "Atlanta, GA");
  assert.equal(chooseResumeLocation({ locationName: "MI-Admin Office Building (AOB)" }).display, "Detroit, MI");
  assert.equal(chooseResumeLocation({ locationName: "Space Coast, FL" }).display, "Melbourne, FL");
});
