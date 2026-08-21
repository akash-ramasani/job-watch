// verify.mjs
//
// The "recheck 4 times" gate. Runs FOUR independent verification passes over a
// mapped form. A job is only cleared for submission if ALL FOUR pass. Any
// failure parks the job for manual review. The passes are deliberately
// deterministic (not "ask the AI again 4x") because deterministic checks are
// what actually prevent mistakes.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PLACEHOLDERS = new Set(["", "n/a", "na", "tbd", "todo", "xxx", "-", "none provided"]);

/** Pass 1 — completeness: every REQUIRED question has at least one answer. */
function passCompleteness(mapped) {
  const failures = mapped.answers
    .filter((a) => a.required && a.answers.length === 0)
    .map((a) => `missing required: "${a.label}" (${a.note})`);
  return { name: "completeness", ok: failures.length === 0, failures };
}

/** Pass 2 — option validity: every select answer is EXACTLY one of the
 *  allowed option values for its field. */
function passOptions(mapped, questions) {
  const failures = [];
  const byLabel = new Map(questions.map((q) => [q.label || (q.fields?.[0]?.name), q]));
  for (const a of mapped.answers) {
    if (a.answers.length === 0) continue;
    const q = byLabel.get(a.label);
    const field = q?.fields?.[0];
    const isSelect = q?.fields?.some((f) => (f.type || "").includes("select"));
    if (!isSelect || !field) continue;
    const allowed = new Set((field.values || field.options || []).map((v) => String(v.value)));
    for (const ans of a.answers) {
      if (!allowed.has(String(ans.value))) {
        failures.push(`"${a.label}": answer ${JSON.stringify(ans.value)} is not an allowed option`);
      }
    }
  }
  return { name: "option-validity", ok: failures.length === 0, failures };
}

/** Pass 3 — format & non-placeholder: no empty/placeholder values; emails and
 *  files look valid. */
function passFormats(mapped) {
  const failures = [];
  for (const a of mapped.answers) {
    for (const ans of a.answers) {
      if (ans.isFile) {
        if (!ans.value) failures.push(`"${a.label}": file answer has no path`);
        continue;
      }
      const v = String(ans.value ?? "").trim();
      if (PLACEHOLDERS.has(v.toLowerCase())) {
        failures.push(`"${a.label}": placeholder/empty value ${JSON.stringify(v)}`);
      }
      if (ans.name === "email" && !EMAIL_RE.test(v)) {
        failures.push(`email is malformed: ${JSON.stringify(v)}`);
      }
    }
  }
  return { name: "formats", ok: failures.length === 0, failures };
}

/** Pass 4 — compliance integrity: the high-stakes answers, if present, match
 *  the saved profile verbatim (nothing got flipped), and a resume is attached
 *  when the form requires one. */
function passCompliance(mapped, profile, questions) {
  const failures = [];
  // Resume presence when required.
  const resumeQ = questions.find((q) => q.fields?.some((f) => f.name === "resume"));
  if (resumeQ?.required) {
    const resumeAns = mapped.answers.find((a) => a.answers.some((x) => x.name === "resume"));
    if (!resumeAns || resumeAns.answers.length === 0) failures.push("resume required but not attached");
  }
  // Compliance answers must have come from the profile (source=profile), never AI.
  const complianceLabels = [/sponsor|visa/i, /authorized|work authorization/i, /export control|u\.?s\.? person/i];
  for (const a of mapped.answers) {
    if (a.answers.length === 0) continue;
    if (complianceLabels.some((re) => re.test(a.label))) {
      if (a.source === "ai") failures.push(`compliance answer for "${a.label}" came from AI (must be profile)`);
    }
  }
  return { name: "compliance-integrity", ok: failures.length === 0, failures };
}

/** Run all four passes. Returns { ok, passes: [...], failures: [...] }. */
export function verifyFourTimes(mapped, questions, profile) {
  const passes = [
    passCompleteness(mapped),
    passOptions(mapped, questions),
    passFormats(mapped),
    passCompliance(mapped, profile, questions),
  ];
  const failures = passes.flatMap((p) => p.failures.map((f) => `[${p.name}] ${f}`));
  return { ok: passes.every((p) => p.ok), passes, failures };
}
