#!/usr/bin/env node
// Quick self-tests for the pure logic modules. Run: node test.mjs
import { sanitizeText, sanitizeBlock } from "./lib/style.mjs";
import { fieldKind, isSelect, isFile } from "./lib/fieldkind.mjs";
import { isEligible, selectEligible, RE_APPLY_HOURS } from "./lib/dedup.mjs";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "\x1b[32m✓" : "\x1b[31m✗"}\x1b[0m ${name}`);
  if (!ok) { console.log(`    got : ${JSON.stringify(got)}`); console.log(`    want: ${JSON.stringify(want)}`); fail++; } else pass++;
};

// ── style: only comma and period survive ─────────────────────────────────────
eq("style: em dash -> comma", sanitizeText("I built the tool — it works"), "I built the tool, it works.");
eq("style: semicolon -> period", sanitizeText("I ship fast; I test more"), "I ship fast. I test more.");
eq("style: colon -> comma", sanitizeText("My goal: help the team"), "My goal, help the team.");
eq("style: strips question/exclaim", sanitizeText("Why me? Because I care!"), "Why me. Because I care.");
eq("style: keeps contraction apostrophe", sanitizeText("I don't quit"), "I don't quit.");
eq("style: removes parens and quotes", sanitizeText('I used React (a library) and "hooks"'), "I used React a library and hooks.");
eq("style: kills AI tell 'leverage'", sanitizeText("I leverage data to delve into problems"), "I use data to look at problems.");
eq("style: block keeps paragraph breaks", sanitizeBlock("Para one; done\n\nPara two — end"), "Para one. done.\n\nPara two, end.");
eq("style: preserves Node.js token", sanitizeText("I use Node.js daily"), "I use Node.js daily.");
eq("style: preserves 3.5 and spaces sentences", sanitizeText("scaled 3.5x. It worked"), "scaled 3.5x. It worked.");

// ── fieldkind: select vs text vs file ────────────────────────────────────────
eq("kind: greenhouse input_text", fieldKind({ type: "input_text" }), "text");
eq("kind: greenhouse select", fieldKind({ type: "multi_value_single_select", values: [{ label: "Yes", value: 1 }] }), "select");
eq("kind: greenhouse textarea", fieldKind({ type: "textarea" }), "longtext");
eq("kind: greenhouse file", fieldKind({ type: "input_file" }), "file");
eq("kind: text-with-options is really select", fieldKind({ type: "input_text", values: [{ label: "A", value: "a" }] }), "select");
eq("kind: ashby ValueSelect", fieldKind({ type: "ValueSelect" }), "select");
eq("kind: ashby Boolean", fieldKind({ type: "Boolean" }), "boolean");
eq("kind: unknown -> unknown", fieldKind({ type: "captcha" }), "unknown");
eq("pred: isSelect(boolean)", isSelect({ type: "Boolean" }), true);
eq("pred: isFile", isFile({ type: "File" }), true);

// ── dedup: re-apply after >1 day, never miss ─────────────────────────────────
const now = 1_000 * 3600 * 24 * 100; // fixed clock
eq("dedup: never applied is eligible", isEligible({}, now), true);
eq("dedup: applied 2h ago not eligible", isEligible({ lastAppliedAt: now - 2 * 3600_000 }, now), false);
eq("dedup: applied 25h ago eligible again", isEligible({ lastAppliedAt: now - 25 * 3600_000 }, now), true);
const jobs = [
  { externalId: "a", companyKey: "x" }, // never applied
  { externalId: "b", companyKey: "x", lastAppliedAt: now - 2 * 3600_000 }, // too recent
  { externalId: "c", companyKey: "x", lastAppliedAt: now - 30 * 3600_000 }, // eligible again
  { externalId: "a", companyKey: "x" }, // duplicate of first in same batch
];
const sel = selectEligible(jobs, { now });
eq("dedup: selects a and c, dedupes duplicate a", sel.eligible.map((j) => j.externalId), ["a", "c"]);
eq("dedup: nothing silently lost (eligible+skipped == unique)", sel.eligible.length + sel.skipped.length, 3);

// ── answer engine: classification traps + semantic option matching ────────────
// Regression tests for real misfires found in the 2026-08-26 form-corpus audit
// (scripts/observations/*). Each of these once produced a WRONG answer.
const { answerQuestion } = await import("./lib/answer-engine.mjs");
const P = {
  firstName: "Ada", lastName: "L", email: "a@x.com", phone: "1", resumePath: "r.pdf",
  addressLine2: "Apt 20", currentCompany: "Runn Technologies",
  workAuthorized: "Yes", requiresSponsorship: "Yes", visaStatus: { student: true, sponsored: false },
  usPersonExportControl: "No", clearanceStatus: "None", clearanceLevel: "None",
  willingToRelocate: "Yes", willingToWorkHybrid: "Yes",
  city: "Hayward", region: "California", country: "United States",
  metroArea: "San Francisco Bay Area", metroAreas: ["San Francisco"],
  heardAboutUs: "Job Board", appliedToCompanyBefore: false,
};
const mkq = (label, opts, extra = {}) => ({
  label, required: true,
  fields: [{ name: "q", type: "multi_value_single_select", values: opts.map((o, i) => ({ label: o, value: String(i) })) }],
  ...extra,
});
const pick = (q) => { const a = answerQuestion(q, P, null); return a.answers.length ? q.fields[0].values.find((v) => v.value === a.answers[0].value).label : `PARKED: ${a.note}`; };

// Substring traps: these labels must NOT hit address/visa/company handlers.
eq("engine: 'opportunity' is not Apt/unit", pick(mkq("How did you hear about this opportunity?", ["LinkedIn", "Other job board (e.g. Glassdoor, Indeed)", "Other"])), "Other job board (e.g. Glassdoor, Indeed)");
eq("engine: 'option' is not OPT visa", pick(mkq("This role is based out of our Austin, TX office and follows a hybrid schedule (3 days a week in office). Please confirm your understanding and select the option that best describes you:", ["I currently live within commuting distance of Austin TX and can be on-site on the required days", "I do not currently live in the area but am able to relocate before my start date at my own arrangement", "I am not able to work on-site in Austin TX on a hybrid schedule"])).startsWith("I do not currently live"), true);
const coi = pick(mkq("Do you have: a) any Personal/Familial Relationships (current Robinhood employees or employees of Robinhood's vendors); b) any Outside Business Activities that you wish to continue?", ["Yes", "No"]));
eq("engine: COI compound is not currentCompany", coi, "No");

// Phrased option lists resolved from BOTH auth fields (OPT student profile).
eq("engine: 3-way work auth picks 'future'", pick(mkq("Are you legally authorised to work full-time in the country where this job is based?", ["Yes, no restriction.", "Yes, but I will need sponsorship in the future.", "No, I need sponsorship now."])), "Yes, but I will need sponsorship in the future.");
eq("engine: visa-category auth picks non-immigrant", pick(mkq("Are you currently authorized to work in the United States?", ["Yes, I have US work authorization as a US Citizen or US Permanent Resident/Green Card Holder", "Yes, I have US Work authorization via a non-immigrant visa (H-1B, L-1, F-1 OPT OR CPT, TN, E-3, O-1, Dependent Visa)", "No, I am not currently authorized to work in the United States"])).includes("non-immigrant"), true);

// Compliance selects with phrased options.
eq("engine: never-worked option matched", pick(mkq("Have you ever worked for Robinhood as an employee, intern or contractor?", ["I currently work at Robinhood as a full-time employee or intern", "I have previously worked at Robinhood in a contractor role", "I have never worked at Robinhood"])), "I have never worked at Robinhood");
eq("engine: export control -> none of the above", pick(mkq("EXPORT CONTROLS - This position requires access to information and technology that is subject to U.S. export controls.", ["A United States citizen or national", "A person lawfully admitted for permanent residence of the United States", "None of the above"])), "None of the above");
eq("engine: clearance -> No", pick(mkq("CLEARANCE ELIGIBILITY - This position requires eligibility to obtain and maintain a U.S. security clearance.", ["Yes, I hold an active U.S. security clearance", "Yes, I am eligible for a U.S. security clearance", "No"])), "No");
eq("engine: privacy acknowledgement -> Yes", pick(mkq("I understand my application will be processed in accordance with the Candidate Privacy Policy.", ["Yes", "No"])), "Yes");
eq("engine: vague label uses description", pick(mkq("HISTORY WITH ANDURIL", ["Yes", "No"], { description: "<div>Have you previously applied to a position at Anduril?</div>" })), "No");

// Location-aware picks.
eq("engine: near-SF picks 'already reside'", pick(mkq("Do you currently reside in commutable proximity to a Lyft Office located in San Francisco or are you open to relocating?", ["I am willing to relocate before starting employment.", "I am not willing to relocate before starting employment.", "I already reside near a Lyft office and I am able to work at a Lyft On-site Office."])).startsWith("I already reside"), true);
eq("engine: far-city relocate picks Yes", pick(mkq("Are you open to relocating to New York City for this hybrid role?", ["Yes, I am open to relocation", "No, I am not interested in relocation", "I am already in NYC or nearby and able to work hybrid"])), "Yes, I am open to relocation");

// Never-guess guardrails: these must PARK, not answer.
eq("engine: AI policy parks for review", pick(mkq("AI Policy for Application", ["Yes", "No"])).startsWith("PARKED"), true);
eq("engine: unknown trivia parks", pick(mkq("Is the following statement True or False? SeatGeek was founded in 2008", ["True", "False"])).startsWith("PARKED"), true);

console.log(`\n${fail ? "\x1b[31m" : "\x1b[32m"}${pass} passed, ${fail} failed\x1b[0m  (re-apply window ${RE_APPLY_HOURS}h)`);
process.exit(fail ? 1 : 0);
