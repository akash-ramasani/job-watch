"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { parseCache, feedCutoffMs, mergeCache, MARGIN_MS } = require("../lib/feedCache.cjs");

const NOW = Date.parse("2026-11-12T20:00:00Z");
const MIN = 60 * 1000;
const DAY = 86400000;

test("cutoff is the usual 20-minute window when the feed was read moments ago", () => {
  const c = feedCutoffMs({ recentCutoffMs: NOW - 20 * MIN, lastOkMs: NOW - 2 * MIN, nowMs: NOW, maxAgeMs: 3 * DAY });
  assert.strictEqual(c, NOW - 20 * MIN);
});

test("cutoff reaches back to the last good read after a gap (no missed postings)", () => {
  const lastOk = NOW - 90 * MIN; // board failed / runs skipped for 90 minutes
  const c = feedCutoffMs({ recentCutoffMs: NOW - 20 * MIN, lastOkMs: lastOk, nowMs: NOW, maxAgeMs: 3 * DAY });
  assert.strictEqual(c, lastOk - MARGIN_MS);
});

test("cutoff never goes past the job lifetime", () => {
  const c = feedCutoffMs({ recentCutoffMs: NOW - 20 * MIN, lastOkMs: NOW - 10 * DAY, nowMs: NOW, maxAgeMs: 3 * DAY });
  assert.strictEqual(c, NOW - 3 * DAY);
});

test("no previous read: usual window; full-list callers (null cutoff) stay null", () => {
  assert.strictEqual(feedCutoffMs({ recentCutoffMs: NOW - 20 * MIN, lastOkMs: undefined, nowMs: NOW, maxAgeMs: 3 * DAY }), NOW - 20 * MIN);
  assert.strictEqual(feedCutoffMs({ recentCutoffMs: null, lastOkMs: NOW - MIN, nowMs: NOW, maxAgeMs: 3 * DAY }), null);
});

test("cache merge keeps failed feeds' old entries and drops unfollowed feeds", () => {
  const prev = { a: { e: "W/1", ok: 1 }, b: { e: "W/2", ok: 2 }, gone: { e: "W/9", ok: 9 } };
  const out = mergeCache(prev, { a: { e: "W/3", ok: 5 } }, ["a", "b", "new"]);
  assert.deepStrictEqual(out, { a: { e: "W/3", ok: 5 }, b: { e: "W/2", ok: 2 } });
});

test("a corrupt or missing cache reads as empty", () => {
  assert.deepStrictEqual(parseCache(undefined), {});
  assert.deepStrictEqual(parseCache("{bad"), {});
  assert.deepStrictEqual(parseCache("[1]"), {});
  assert.deepStrictEqual(parseCache('{"a":{"ok":1}}'), { a: { ok: 1 } });
});
