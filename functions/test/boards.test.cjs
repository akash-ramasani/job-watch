"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const boards = require("../lib/boards.cjs");
const { ldJobPosting, ldLocation, toIsoDay, inlineJson, taleoLocations, neogovAge } = boards.__internals;

const now = { toMillis: () => Date.parse("2026-10-13T00:00:00Z"), toDate: () => new Date("2026-10-13T00:00:00Z") };
const ageDaysFromIsoDate = (iso) => { if (!iso) return null; const t = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`); return Number.isFinite(t) ? Math.max(0, Math.floor((now.toMillis() - t) / 86400000)) : null; };
const h = { now, maxAge: 3, ageDaysFromIsoDate, isUSCountry: (c) => /^(us|usa|united states(?: of america)?)$/i.test(String(c || "").trim()), looksUS: (s) => /\b(US|USA|United States)\b|,\s*[A-Z]{2}\b/.test(String(s || "")), recentEnough: () => true };

test("every supported platform parses its canonical careers URL and rejects foreign ones", () => {
  const ok = {
    peopleadmin: ["https://utah.peopleadmin.com/postings/search", "https://jobs.unm.edu/postings/search"],
    neogov: ["https://www.governmentjobs.com/careers/hawaiiedu", "https://www.schooljobs.com/careers/hawaiiedu/jobs/5512730/x"],
    paycom: ["https://www.paycomonline.net/v4/ats/web.php/jobs?clientkey=895D6B8836F6E4C74A0A43AAB4F8638E", "https://www.paycomonline.net/v4/ats/web.php/portal/895D6B8836F6E4C74A0A43AAB4F8638E/career-page"],
    adp: ["https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=a6d38625-b5ce-451b-b4b6-a889d906111a&ccId=19000101_000001&lang=en_US"],
    pageup: ["https://careers.pageuppeople.com/968/ci/en-us/listing", "https://careers.vt.edu/en-us/listing/"],
    icims: ["https://careersat-ohsu.icims.com/jobs/search?ss=1", "https://externalcareers-ohsu.icims.com/jobs/42099/clinical-research-assistant/job"],
    cornerstone: ["https://arizona.csod.com/ux/ats/careersite/4/home?c=arizona"],
    paylocity: ["https://recruiting.paylocity.com/recruiting/jobs/All/5bf37f63-92e9-4ad2-94ca-ceae3e679330/ATSU-PUBLIC"],
    taleo: ["https://utsw.taleo.net/careersection/2/jobsearch.ftl", "https://lbl.taleo.net"],
    ukg: ["https://recruiting2.ultipro.com/SCR1003TSRI/JobBoard/98759e7d-7ede-4c0b-ac7b-2c6293c7b522/", "https://psionline.rec.pro.ukg.net/PSI1500PSIL/JobBoard/287b933d-50bd-4acb-b709-75def54bf55f/?q="],
    interfolio: ["https://apply.interfolio.com/46259/positions"],
    silkroad: ["https://jobs.silkroad.com/BU/External", "https://jobs.silkroad.com/BU/External/jobs/317044"],
    applicantpro: ["https://pavir.applicantpro.com/jobs/", "https://www.applicantpro.com/openings/meetinghouselane/jobs"],
    avature: ["https://colorado.avature.net/jobs", "https://jobs.colorado.edu/jobs/SearchJobs/"],
    brassring: ["https://sjobs.brassring.com/TGnewUI/Search/Home/Home?partnerid=25898&siteid=5635#home"],
    phenom: ["https://careers.yale.edu/us/en", "https://jobs.virginia.edu/us/en/home"],
    jazzhr: ["https://universityofmary.applytojob.com/apply", "https://easternctstateuniversity.applytojob.com/apply/krbczJTOfQ/x"],
    breezy: ["https://reed-college.breezy.hr/", "https://reed-college.breezy.hr/p/32ec5ceadb28-community-safety-officer"],
    successfactors: ["https://careers.purdue.edu/search/", "https://careers.purdue.edu/default/job/Temporary-Support/30274-en_US"],
  };
  for (const [source, urls] of Object.entries(ok)) {
    for (const u of urls) assert.ok(boards.parse(source, u), `${source} should parse ${u}`);
    assert.equal(boards.parse(source, "https://boards.greenhouse.io/acme/jobs/1"), null, `${source} must not claim a Greenhouse URL`);
    assert.equal(boards.parse(source, ""), null);
  }
  assert.equal(boards.parse("icims", "https://www.icims.com/legal/privacy-notice-website/"), null);
  assert.equal(boards.parse("interfolio", "https://apply.interfolio.com/103851"), null, "a single position page is not a board");
  assert.equal(boards.parse("neogov", "https://www.schooljobs.com/careers/home/index?agency=x"), null);
  assert.ok(boards.parse("paycom", "https://www.paycomonline.net/v4/ats/web.php/jobs?clientkey=abc").key === "ABC");
  assert.equal(boards.parse("cornerstone", "https://arizona.csod.com/ux/ats/careersite/4/home?c=arizona").slug, "arizona-4");
  assert.equal(boards.detect("https://utah.peopleadmin.com/postings/search")?.source, "peopleadmin");
  assert.equal(boards.detect("https://jobs.lever.co/acme"), null);
});

test("every adapter's canonical careerUrl parses back to itself", () => {
  for (const source of boards.SOURCES) {
    const samples = { peopleadmin: "https://utah.peopleadmin.com/postings/123", neogov: "https://www.governmentjobs.com/careers/hawaiiedu/jobs/1/x", paycom: "https://www.paycomonline.net/v4/ats/web.php/portal/ABC123DEF456ABC1/jobs/1", adp: "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=x1&ccId=19000101_000001&jobId=9", pageup: "https://careers.pageuppeople.com/968/ci/en-us/job/538161", icims: "https://x-co.icims.com/jobs/1/t/job", cornerstone: "https://arizona.csod.com/ux/ats/careersite/4/home/requisition/27335?c=arizona", paylocity: "https://recruiting.paylocity.com/recruiting/jobs/All/5bf37f63-92e9-4ad2-94ca-ceae3e679330/ATSU", taleo: "https://utsw.taleo.net/careersection/2/jobdetail.ftl?job=1", ukg: "https://recruiting2.ultipro.com/SCR1003TSRI/JobBoard/98759e7d-7ede-4c0b-ac7b-2c6293c7b522/OpportunityDetail?opportunityId=x", interfolio: "https://apply.interfolio.com/46259/positions?x=1", silkroad: "https://jobs.silkroad.com/BU/External/jobs/1", applicantpro: "https://pavir.applicantpro.com/jobs/4165429", avature: "https://colorado.avature.net/jobs/JobDetail/x/75459", brassring: "https://sjobs.brassring.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=25898&siteid=5635&PageType=JobDetails&jobid=1", phenom: "https://careers.yale.edu/us/en/job/129680WD", jazzhr: "https://universityofmary.applytojob.com/apply/h9g0yeFzvO/x", breezy: "https://reed-college.breezy.hr/p/abc", successfactors: "https://careers.purdue.edu/default/job/x/1-en_US" };
    const p1 = boards.parse(source, samples[source]);
    assert.ok(p1, `${source} parses a job page`);
    const p2 = boards.parse(source, p1.careerUrl);
    assert.ok(p2, `${source} parses its own careerUrl ${p1.careerUrl}`);
    assert.equal(p2.careerUrl, p1.careerUrl, `${source} careerUrl is stable`);
    assert.ok(!/\//.test(p1.slug), `${source} slug "${p1.slug}" has no slash (it becomes a Firestore doc id)`);
  }
});

test("date and JSON-LD helpers", () => {
  assert.equal(toIsoDay("10/12/2026"), "2026-10-12");
  assert.equal(toIsoDay("5/1/24"), "2024-05-01");
  assert.equal(toIsoDay("Aug 03, 2026"), "2026-08-03");
  assert.equal(toIsoDay("12-Oct-2026"), "2026-10-12");
  assert.equal(toIsoDay("2026-10-06T20:33:17-05:00"), "2026-10-06");
  assert.equal(toIsoDay("Posted today"), null);
  assert.equal(neogovAge("Posted today", h), 0);
  assert.equal(neogovAge("Posted 3 days ago", h), 3);
  assert.equal(neogovAge("Posted: October 10, 2026", h), 3);
  assert.deepEqual(taleoLocations('["Texas-Dallas-5323 Harry Hines Blvd"]'), ["Texas, Dallas, 5323 Harry Hines Blvd"]);
  const html = `<html><script type="application/ld+json">{"@context":"https://schema.org/","@type":"JobPosting","title":"Casual Hire","datePosted":"2026-10-12","description":"&lt;p&gt;Duties&lt;/p&gt;","jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"Honolulu, HI","addressRegion":"HI","addressCountry":"US"}}}</script></html>`;
  const ld = ldJobPosting(html);
  assert.equal(ld.title, "Casual Hire");
  assert.deepEqual(ldLocation(ld), { parts: ["Honolulu, HI"], country: "US" });
  const arr = `<script type="application/ld+json">[{"@type":"Organization"},{"@type":"JobPosting","title":"X","jobLocation":[{"address":{"addressLocality":"Lubbock","addressRegion":"Texas","addressCountry":"US"}}]}]</script>`;
  assert.deepEqual(ldLocation(ldJobPosting(arr)), { parts: ["Lubbock, Texas"], country: "US" });
  assert.equal(ldJobPosting("<p>no data</p>"), null);
  assert.deepEqual(inlineJson('x; window.pageData = {"Jobs":[{"JobId":1,"T":"a}b"}],"n":{"k":[1,2]}};', /window\.pageData\s*=\s*/), { Jobs: [{ JobId: 1, T: "a}b" }], n: { k: [1, 2] } });
  assert.equal(inlineJson("nothing here", /window\.pageData\s*=\s*/), null);
});

test("normalize shapes a Paylocity row, an ADP requisition and a Phenom hit the way normalizeBoardJob expects", () => {
  const pl = boards.parse("paylocity", "https://recruiting.paylocity.com/recruiting/jobs/All/5bf37f63-92e9-4ad2-94ca-ceae3e679330/ATSU-PUBLIC");
  const n1 = boards.normalize("paylocity", pl, { id: "4533487", list: { JobId: 4533487, JobTitle: "Coordinator", LocationName: "Mesa, AZ", PublishedDate: "2026-10-06T15:33:17-05:00", Description: "short", JobLocation: { City: "Mesa", State: "AZ", Country: "USA" }, IsRemote: false }, detail: { description: "<p>Full</p>", datePosted: "2026-10-06" } }, h);
  assert.equal(n1.title, "Coordinator");
  assert.equal(n1.jobUrl, "https://recruiting.paylocity.com/Recruiting/Jobs/Details/4533487");
  assert.deepEqual(n1.locParts, ["Mesa, AZ"]);
  assert.equal(n1.us, true);
  assert.equal(n1.postedIso, "2026-10-06T15:33:17-05:00");
  assert.equal(n1.html, "<p>Full</p>");

  const adp = boards.parse("adp", "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=a6d38625&ccId=19000101_000001");
  const req = { itemID: "9200638321588_1", requisitionTitle: "Police Officer", postDate: "2026-09-01T16:49:00.000-04:00", requisitionLocations: [{ nameCode: { shortName: " Houston, TX, US" }, address: { cityName: "Houston", countrySubdivisionLevel1: { codeValue: "TX" } } }], payGradeRange: { minimumRate: { amountValue: 33.92, currencyCode: "USD" }, maximumRate: { amountValue: 33.92 } }, clientRequisitionID: "1165" };
  const n2 = boards.normalize("adp", adp, { id: req.itemID, list: req, detail: { ...req, requisitionDescription: "<div>desc</div>" } }, h);
  assert.equal(n2.title, "Police Officer");
  assert.deepEqual(n2.locParts, ["Houston, TX, US"]);
  assert.equal(n2.us, true);
  assert.equal(n2.meta["Req ID"], "1165");
  assert.match(n2.jobUrl, /jobId=9200638321588_1/);
  assert.equal(n2.html, "<div>desc</div>");

  const ph = boards.parse("phenom", "https://careers.yale.edu/us/en");
  const n3 = boards.normalize("phenom", ph, { id: "129680WD", list: { jobId: "129680WD", title: "Teleradiologist", cityState: "New Haven, Connecticut", country: "United States of America", postedDate: "2025-09-26T08:00:00.000+0000", type: "Full time", category: "Other" }, detail: { description: "&lt;p&gt;Working at Yale&lt;/p&gt;" } }, h);
  assert.equal(n3.jobUrl, "https://careers.yale.edu/us/en/job/129680WD");
  assert.equal(n3.us, true);
  assert.equal(n3.html, "<p>Working at Yale</p>");
  assert.equal(n3.meta["Employment Type"], "Full time");
});

test("normalize keeps non-US rows out and marks remote work", () => {
  const uk = boards.parse("ukg", "https://recruiting2.ultipro.com/SCR1003TSRI/JobBoard/98759e7d-7ede-4c0b-ac7b-2c6293c7b522/");
  const row = { Id: "f4f0", Title: "Animal Technician", PostedDate: "2026-10-12T19:43:02.24Z", Locations: [{ Address: { City: "London", Country: { Code: "GBR", Name: "United Kingdom" } } }], JobCategoryName: "Lab", FullTime: true };
  assert.equal(boards.normalize("ukg", uk, { id: row.Id, list: row, detail: null }, h).us, false);
  const row2 = { ...row, Locations: [{ Address: { City: "San Diego", State: { Code: "CA" }, Country: { Code: "USA" } } }], JobLocationType: 2 };
  const n = boards.normalize("ukg", uk, { id: row.Id, list: row2, detail: { ...row2, Description: "<p>x</p>" } }, h);
  assert.equal(n.us, true);
  assert.deepEqual(n.locParts, ["San Diego, CA"]);
  assert.equal(n.remote, true);
  assert.equal(n.html, "<p>x</p>");
});
