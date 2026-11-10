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
  const out = {};
  const map = user && typeof user.savedAnswers === "object" ? user.savedAnswers : {};
  for (const v of Object.values(map || {})) {
    if (!v || !String(v.answer || "").trim() || !v.question) continue;
    const k = normQuestion(v.question);
    // The person's own answer wins over a learned one for the same question.
    if (!out[k] || (v.source === "you" && out[k].source !== "you")) out[k] = { answer: String(v.answer), source: v.source === "you" ? "you" : "ai" };
  }
  return out;
}

/**
 * Write what the extension learned. saved: [{ question, answer, source,
 * companyName }]; missing: [{ question, why, companyName, jobTitle }].
 * Returns { saved, missing } counts actually written.
 */
async function learn(db, uid, { saved = [], missing = [] } = {}, { FieldValue }) {
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  const user = snap.exists ? snap.data() || {} : {};
  const have = user.savedAnswers || {};
  const update = {};
  let nSaved = 0, nMissing = 0, byYou = false;
  for (const s of (Array.isArray(saved) ? saved : []).slice(0, 40)) {
    const source = s?.source === "you" ? "you" : "ai";
    if (!learnable(s || {})) continue;
    const key = keyOf(s.question);
    const prev = have[key];
    if (prev?.source === "you" && source === "ai") continue; // never overwrite the person's own
    if (prev && prev.answer === String(s.answer).trim() && prev.source === source) continue;
    update[`savedAnswers.${key}`] = { question: String(s.question).trim().slice(0, 600), answer: String(s.answer).trim().slice(0, 300), source, at: new Date() };
    update[`missingAnswers.${key}`] = FieldValue.delete();
    if (source === "you") byYou = true;
    nSaved++;
  }
  for (const m of (Array.isArray(missing) ? missing : []).slice(0, 40)) {
    const q = String(m?.question || "").trim();
    // Uploads are not answers: the resume is attached, a cover letter is written per job.
    if (normQuestion(q).length < 3 || JOB_SPECIFIC.test(normQuestion(q)) || FILE_FIELD.test(normQuestion(q))) continue;
    const key = keyOf(q);
    if (have[key] || update[`savedAnswers.${key}`]) continue;
    update[`missingAnswers.${key}.question`] = q.slice(0, 600);
    update[`missingAnswers.${key}.why`] = String(m.why || "").slice(0, 300);
    update[`missingAnswers.${key}.companyName`] = String(m.companyName || "").slice(0, 120);
    update[`missingAnswers.${key}.jobTitle`] = String(m.jobTitle || "").slice(0, 200);
    update[`missingAnswers.${key}.at`] = new Date();
    update[`missingAnswers.${key}.count`] = FieldValue.increment(1);
    nMissing++;
  }
  if (byYou) update.answersUpdatedAt = new Date();
  if (Object.keys(update).length) {
    if (snap.exists) await ref.update(update);
    else await ref.set({}, { merge: true }).then(() => ref.update(update));
  }
  return { saved: nSaved, missing: nMissing };
}

module.exports = { normQuestion, keyOf, learnable, savedIndex, learn };
