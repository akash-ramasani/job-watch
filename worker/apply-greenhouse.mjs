#!/usr/bin/env node
// apply-greenhouse.mjs
//
// Greenhouse auto-apply worker (runs on the headless Linux box — NO browser).
// DRY-RUN by default: it fetches a real job's form, maps answers from your
// profile, runs the 4-pass verification, and prints a READY / NEEDS_REVIEW
// decision. It never submits (submission is a later, explicitly-gated phase).
//
// Usage:
//   node apply-greenhouse.mjs --url "https://job-boards.greenhouse.io/gitlab/jobs/8503792002"
//   node apply-greenhouse.mjs --token gitlab --id 8503792002 --profile ./profile.json
//   node apply-greenhouse.mjs --token gitlab            # sample the first open job
//
// Exit code 0 = READY, 2 = NEEDS_REVIEW, 1 = error.

import { readFile } from "node:fs/promises";
import { parseGreenhouseUrl, listJobs, fetchForm } from "./lib/greenhouse.mjs";
import { mapForm, SOURCE } from "./lib/answer-engine.mjs";
import { verifyFourTimes } from "./lib/verify.mjs";

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith("--")) a[k.slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i];
  }
  return a;
}

async function loadProfile(path) {
  const p = path || new URL("./profile.example.json", import.meta.url).pathname;
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch (e) {
    throw new Error(`could not read profile ${p}: ${e.message}`);
  }
}

const c = { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };

async function main() {
  const args = parseArgs(process.argv);
  let token = args.token;
  let id = args.id;

  if (args.url) {
    const p = parseGreenhouseUrl(args.url);
    if (!p) throw new Error(`not a Greenhouse job URL: ${args.url}`);
    ({ token, id } = p);
  }
  if (!token) throw new Error("provide --url, or --token (+ optional --id)");
  if (!id) {
    const jobs = await listJobs(token);
    if (!jobs.length) throw new Error(`no open jobs on board '${token}'`);
    id = jobs[0].id;
    console.log(`${c.d}(no --id given; sampling first open job ${id})${c.x}`);
  }

  const profile = await loadProfile(args.profile);
  const form = await fetchForm(token, id);

  // AI is stubbed for the dry-run: no free-text answers yet, so free-text
  // required questions correctly fall to review. (OpenAI wiring is next phase.)
  const ai = null;

  const mapped = mapForm(form.questions, profile, ai);
  const verdict = verifyFourTimes(mapped, form.questions, profile);

  // ── Report ─────────────────────────────────────────────────────────────────
  console.log(`\n${c.b}${form.title}${c.x}  ${c.d}${form.location}${c.x}`);
  console.log(`${c.d}${form.url}${c.x}\n`);
  console.log(`${c.b}Answers (${mapped.answers.length} questions):${c.x}`);
  for (const a of mapped.answers) {
    const filled = a.answers.length > 0;
    const tag = filled
      ? (a.source === SOURCE.PROFILE ? `${c.g}profile${c.x}` : a.source === SOURCE.RULE ? `${c.g}rule${c.x}` : a.source === SOURCE.AI ? `${c.y}ai${c.x}` : `${c.g}${a.source}${c.x}`)
      : (a.required ? `${c.r}REVIEW${c.x}` : `${c.d}skip${c.x}`);
    const val = filled ? a.answers.map((x) => (x.isFile ? `<file:${x.value || "none"}>` : x.value)).join(" | ") : (a.note || "");
    const req = a.required ? "*" : " ";
    console.log(`  ${req} [${tag}] ${a.label}${c.d}  →  ${String(val).slice(0, 70)}${c.x}`);
  }

  console.log(`\n${c.b}4-pass verification:${c.x}`);
  for (const p of verdict.passes) {
    console.log(`  ${p.ok ? c.g + "✓" : c.r + "✗"} ${p.name}${c.x}${p.ok ? "" : "  " + c.r + p.failures.length + " issue(s)" + c.x}`);
  }
  if (verdict.failures.length) {
    console.log(`\n${c.y}Why it can't auto-submit:${c.x}`);
    for (const f of verdict.failures.slice(0, 20)) console.log(`  ${c.d}- ${f}${c.x}`);
  }

  const ready = verdict.ok;
  console.log(`\n${c.b}Decision:${c.x} ${ready ? c.g + "READY (would submit)" : c.y + "NEEDS_REVIEW (parked)"}${c.x}`);
  console.log(`${c.d}(dry-run — nothing was submitted)${c.x}\n`);
  process.exit(ready ? 0 : 2);
}

main().catch((e) => {
  console.error(`${c.r}error:${c.x} ${e.message}`);
  process.exit(1);
});
