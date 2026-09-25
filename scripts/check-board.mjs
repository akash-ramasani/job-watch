#!/usr/bin/env node
/**
 * Check a Lever / Workable / SmartRecruiters / BambooHR careers page before or
 * after adding it as a feed. Read-only: fetches the board as the sync would
 * (last N days, US only, with descriptions) and prints what it would write.
 *
 *   node scripts/check-board.mjs lever https://jobs.lever.co/palantir
 *   node scripts/check-board.mjs smartrecruiters ServiceNow --days 2 --show 5
 */
import { createRequire } from "node:module";

const [source, url] = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
if (!source || !url) {
  console.error("usage: node scripts/check-board.mjs <lever|workable|smartrecruiters|bamboohr> <careers url or slug> [--days 3] [--show 3]");
  process.exit(1);
}

process.env.GOOGLE_APPLICATION_CREDENTIALS ||= new URL("../worker/service-account.json", import.meta.url).pathname;
process.env.GCLOUD_PROJECT ||= "greenhouse-jobs-scrapper";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const { parseBoardFeedUrl, fetchBoardNewJobs, normalizeJobMinimal, jobMatchesLocationFilter } = require("./index.js").__internals;
const admin = require("firebase-admin");

const parsed = parseBoardFeedUrl(source, url);
if (!parsed) {
  console.error(`Not a ${source} careers page: ${url}`);
  process.exit(1);
}
console.log(`${source} ${parsed.slug} → ${parsed.careerUrl}`);

const now = admin.firestore.Timestamp.now();
const days = arg("days", 3);
// Harvest mode: ignores seen IDs, never writes feed state.
const harvest = { maxAgeDays: days, dryRun: true, wantRow: () => true };
const raw = await fetchBoardNewJobs(source, { userId: "check-board", feedId: `check-${source}-${parsed.slug}`, url: parsed.careerUrl, now, runBudget: { remaining: Infinity }, harvest });
const jobs = raw.map((j) => normalizeJobMinimal(j, { source, companyName: parsed.slug, companyKey: "check", now, url: parsed.careerUrl })).filter(Boolean);
const us = jobs.filter(jobMatchesLocationFilter);
const withDesc = us.filter((j) => (j.fullDescription || "").length > 200);
console.log(`posted in the last ${days} days: ${raw.length} | normalized: ${jobs.length} | US: ${us.length} | with description: ${withDesc.length}`);
for (const j of us.slice(0, arg("show", 3))) {
  console.log(`\n• ${j.title}\n  ${j.locationName} | ${j.workplaceType || "-"} | ${j.sourceUpdatedIso}\n  ${j.jobUrl}\n  ${JSON.stringify(j.meta)}\n  ${(j.fullDescription || "").slice(0, 160).replace(/\s+/g, " ")}…`);
}
const dropped = jobs.filter((j) => !jobMatchesLocationFilter(j)).slice(0, 5);
if (dropped.length) console.log(`\nnot US (sample): ${dropped.map((j) => j.locationName).join(" | ")}`);
process.exit(0);
