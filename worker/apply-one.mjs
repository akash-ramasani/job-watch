#!/usr/bin/env node
// apply-one.mjs — apply to ONE Greenhouse job (the supervised test).
//
// DEFAULT: preview only. Prints every answer + the 4-pass result, attaches your
// REAL resume, and generates a tailored cover letter. Nothing is sent.
// Add --submit to actually POST the application (only if all 4 passes clear).
//
// Usage:
//   node apply-one.mjs --token westmonroe4 --id 5801015004 --email akashramasani2705@gmail.com
//   node apply-one.mjs --token westmonroe4 --id 5801015004 --email akashramasani2705@gmail.com --submit
//
// Requires: worker/service-account.json and OPENAI_API_KEY (worker/.env).

import { getProfile, getResume, db, ADMIN_UID } from "./lib/firestore.mjs";
import { fetchForm, submit } from "./lib/greenhouse.mjs";
import { runApplyFlow } from "./lib/apply-flow.mjs";

const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, arr) =>
  a.startsWith("--") ? [[a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]] : []));

const OUT = new URL("./out", import.meta.url).pathname;
const c = { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };

async function main() {
  const { token, id, email } = args;
  if (!token || !id) throw new Error("need --token and --id");

  const profile = await getProfile();
  if (email) profile.email = email; // application email override
  const resume = await getResume();

  const form = await fetchForm(token, id);
  const optLabel = {};
  form.questions.forEach((q) => (q.fields[0].values || []).forEach((v) => (optLabel[v.value] = v.label)));

  console.log(`\n${c.b}${form.title}${c.x}  ${c.d}(${token}/${id})${c.x}`);
  console.log(`${c.d}applying as ${profile.email}${c.x}\n`);

  const job = { title: form.title, companyName: form.title, questions: form.questions, descriptionHtml: form.descriptionHtml };
  const result = await runApplyFlow(profile, resume, job, OUT); // real resume + cover letter

  for (const a of result.mapped.answers) {
    const filled = a.answers.length > 0;
    const val = filled
      ? a.answers.map((x) => (x.isFile ? "<resume.pdf>" : (optLabel[x.value] ?? x.value))).join(" | ")
      : `(${a.note})`;
    const tag = filled ? (a.source === "ai" ? `${c.y}ai${c.x}` : `${c.g}${a.source}${c.x}`) : (a.required ? `${c.r}REVIEW${c.x}` : `${c.d}skip${c.x}`);
    console.log(` ${a.required ? "*" : " "} [${tag}] ${a.label.replace(/\s+/g, " ").slice(0, 56)} ${c.d}=>${c.x} ${String(val).slice(0, 40)}`);
  }
  console.log(`\n${c.b}4-pass:${c.x} ${result.verdict.passes.map((p) => `${p.ok ? c.g : c.r}${p.name}${c.x}`).join("  ")}`);
  console.log(`${c.b}resume:${c.x} ${result.docs?.resumePath || "MISSING"}   ${c.b}cover:${c.x} ${result.docs?.coverPath}`);

  if (!result.ready) {
    console.log(`\n${c.y}NOT submitting — the 4-pass gate found issues:${c.x}`);
    result.verdict.failures.forEach((f) => console.log(`  ${c.d}- ${f}${c.x}`));
    process.exit(2);
  }
  if (!args.submit) {
    console.log(`\n${c.g}READY.${c.x} Preview only — re-run with ${c.b}--submit${c.x} to send it.`);
    process.exit(0);
  }

  // ── Actually submit ────────────────────────────────────────────────────────
  console.log(`\n${c.y}submitting...${c.x}`);
  const res = await submit({ token, id, answers: result.mapped.answers, resumePath: result.docs.resumePath, coverPath: result.docs.coverPath });
  if (res.ok) {
    console.log(`${c.g}SUBMITTED${c.x} (HTTP ${res.status}).`);
    await db().then((d) => d.collection("users").doc(ADMIN_UID).collection("jobs").doc(id).set(
      { lastAppliedAt: new Date(), autoApplied: true }, { merge: true }).catch(() => {}));
  } else {
    console.log(`${c.r}NOT submitted${c.x} (HTTP ${res.status}). This board likely needs the company API key or the browser form.`);
    console.log(`${c.d}response: ${res.body}${c.x}`);
  }
  process.exit(res.ok ? 0 : 3);
}

main().catch((e) => { console.error(`${c.r}error:${c.x} ${e.message}`); process.exit(1); });
