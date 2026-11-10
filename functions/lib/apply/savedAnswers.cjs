// savedAnswers.cjs — the answer bank behind "learn from answers".
//
// Two maps on the user document, keyed by a hash of the normalized question:
//   savedAnswers.<key>   = { question, answer, source: "you"|"ai", at }
//   missingAnswers.<key> = { question, why, companyName, jobTitle, at, count }
// The extension reports what the AI rescue finished ("ai"), what the person
// filled by hand before submitting ("you") and what nobody could answer
// (missing). The Profile page lists the missing ones to answer once and lets
// the person edit or delete any saved answer ("you"). The answer engine
// (answer-engine.mjs answerQuestion) reads savedAnswers through
// buildProfileForJob: the person's own answers come first, learned ones fill
// gaps. answersUpdatedAt moves when the person adds an answer, so the
// auto-apply runner retries the jobs that were waiting on them.

const crypto = require("node:crypto");

/** Must equal answer-engine.mjs normQuestion (test/savedAnswers.test.cjs). */
function normQuestion(s) {
  return String(s || "").replace(/[*✱]/g, " ").replace(/\s+/g, " ").trim().toLowerCase().replace(/[\s:?.]+$/, "");
}
const keyOf = (question) => `q${crypto.createHash("sha1").update(normQuestion(question)).digest("hex").slice(0, 16)}`;

// Questions whose answer belongs to one company or one job, or is prose the
// writer makes per job: never reused.
const JOB_SPECIFIC = /\bwhy\b|cover letter|tell us|describe|explain|in your own words|what (excites|interests|draws)|interest(ed)? in (this|the) (role|position|company|team)|about (this|the) (role|company)|anything else/i;

const FILE_FIELD = /\b(resume|cv|curriculum vitae|upload|attach(ment)?)\b|cover letter|transcript/i;

/** Whether an answer is safe to reuse on other forms. */
function learnable({ question, answer, companyName = "" }) {
  const q = normQuestion(question);
  const a = String(answer || "").trim();
  if (q.length < 3 || q.length > 600 || !a || a.length > 300) return false;
  if (/\.(pdf|docx?)$/i.test(a) || /^\(ai rescue\)$/i.test(a)) return false;
  if (JOB_SPECIFIC.test(q)) return false;
  // Contact details come from the Profile only: a phone read off the page
  // took the Country picker's "+1" with it ("5109356846+1") and then filled
  // every form after it (2026-11-09).
  if (/^((legal |preferred |full )?(first |last )?name|(your )?(phone|mobile|cell|telephone)( number)?|e-?mail( address)?|country)$/.test(q)) return false;
  const co = normQuestion(companyName);
  if (co.length >= 3 && q.includes(co)) return false;
  return true;
}

/** savedAnswers as the engine reads it: normalized question -> { answer, source }. */
function savedIndex(user) {
  // One source of truth (2026-11-09): forms are answered from the Profile and
  // the "Questions only you can answer" (applicantNotes.cjs) only. Answers
  // learned from pages, one per wording of a question, piled up as duplicates
  // and one of them put "5109356846+1" in every phone box. They are no longer used.
  return {};
}
/**
 * Write what the extension learned. saved: [{ question, answer, source,
 * companyName }]; missing: [{ question, why, companyName, jobTitle }].
 * Returns { saved, missing } counts actually written.
 */
async function learn(db, uid, { saved = [], missing = [] } = {}, { FieldValue }) {
  // Nothing is learned from pages any more (see savedIndex): no saved answers,
  // no waiting questions. The Profile is the one place answers come from.
  return { saved: 0, missing: 0 };
}
module.exports = { normQuestion, keyOf, learnable, savedIndex, learn };
