// The sweep's choice of stopped applications and the popup's counts (2026-11-13).
const test = require("node:test");
const assert = require("node:assert/strict");
const { stoppedRecords, tabCounts, applyUrlOf } = require("../lib/apply/sweep.cjs");

const NOW = Date.parse("2026-11-13T12:00:00Z");
const ago = (h) => new Date(NOW - h * 3600e3).toISOString();

test("stopped records: needs_attention, error, ready, and in_progress over two hours; not those waiting on a retry", () => {
  const apps = [
    { id: "a", status: "needs_attention", lastStartedAt: ago(1) },
    { id: "b", status: "error", lastStartedAt: ago(1) },
    { id: "c", status: "ready", lastStartedAt: ago(5) },
    { id: "d", status: "in_progress", lastStartedAt: ago(3) },
    { id: "e", status: "in_progress", lastStartedAt: ago(1) },
    { id: "f", status: "needs_attention", lastStartedAt: ago(3), retryRequested: ago(1) },
    { id: "g", status: "submitted", lastStartedAt: ago(1) },
    { id: "h", status: "dismissed", lastStartedAt: ago(1) },
  ];
  assert.deepEqual(stoppedRecords(apps, NOW).map((a) => a.id), ["a", "b", "c", "d"]);
});

test("tab counts match the Applications page", () => {
  const apps = [
    { status: "needs_attention", lastStartedAt: ago(1) },
    { status: "in_progress", lastStartedAt: ago(1) },
    { status: "error", lastStartedAt: ago(1) },
    { status: "ready", lastStartedAt: ago(1) },
    { status: "needs_attention", lastStartedAt: ago(3), retryRequested: ago(1) },
    { status: "submitted", submittedAt: ago(2) },
    { status: "submitted", submittedAt: ago(30) },
  ];
  assert.deepEqual(tabCounts(apps, NOW), { needsYou: 2, errors: 1, ready: 1, retrying: 1, submitted24h: 1 });
});

test("apply links rebuilt from a ledger record", () => {
  assert.equal(applyUrlOf({ formKey: "greenhouse|ooma|5154201007" }), "https://job-boards.greenhouse.io/embed/job_app?for=ooma&token=5154201007");
  assert.equal(applyUrlOf({ formKey: "workday|statestreet|R-800933", jobUrl: "https://statestreet.wd1.myworkdayjobs.com/Global/job/Quincy-Massachusetts/Junior-Platform-Engineer--Officer_R-800933/apply" }), "https://statestreet.wd1.myworkdayjobs.com/Global/job/Quincy-Massachusetts/Junior-Platform-Engineer--Officer_R-800933/apply/applyManually");
  assert.equal(applyUrlOf({ formKey: "rippling|x|y" }), "");
});

test("a location box asking for the state you live in gets your state on every board; a plain Location does not", () => {
  const { stateFill } = require("../lib/apply/ashby.cjs");
  const p = { city: "San Francisco", region: "California", country: "United States" };
  const f = stateFill("loc", "Which state, province, or region do you currently live in?", "", p);
  assert.equal(f.value, "California");
  assert.equal(f.match, "California, United States");
  assert.equal(stateFill("loc", "Location", "", p), null);
  assert.equal(stateFill("loc", "Which city and state do you live in?", "", p), null);
});

test("company careers-site redirects stay with the person; everything else is retried", () => {
  const fs = require("node:fs");
  assert.match(fs.readFileSync(require.resolve("../lib/apply/sweep.cjs"), "utf8"), /the company's own careers site/);
});
