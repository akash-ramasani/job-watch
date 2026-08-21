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

console.log(`\n${fail ? "\x1b[31m" : "\x1b[32m"}${pass} passed, ${fail} failed\x1b[0m  (re-apply window ${RE_APPLY_HOURS}h)`);
process.exit(fail ? 1 : 0);
