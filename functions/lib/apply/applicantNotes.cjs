// applicantNotes.cjs — the few things only the applicant can say, answered
// once on the Profile page (users/{uid}.applicantFacts, plus the older free
// note users/{uid}.answerContext), turned into one block of notes that every
// AI step reads: the answer writer and option picker (ai-text.cjs), the field
// rescue (rescue.cjs), the review before Submit (review.cjs) and "Answer with
// AI" (draftAnswers.cjs).
//
// The questions are grouped by what forms keep asking, so one answer covers
// many form questions (the stuck-field stats, 2026-11-09): export control and
// citizenship, relatives at the company, short tenures, Saturday and late
// hours, office hubs, "why this company", "proudest accomplishment",
// "exceptional work"... src/components/SavedAnswersCard.jsx shows the same list.

const APPLICANT_QUESTIONS = [
  { key: "status", title: "Work authorization and citizenship", hint: "Your visa (F-1 OPT, STEM OPT end date), whether you need H-1B sponsorship now or later, your citizenship, and whether you are a \"U.S. person\" for export control (citizen, green card, refugee or asylee). Can you access export-controlled information?" },
  { key: "logistics", title: "Where and when you can work", hint: "Where you live, cities you would move to, how many office days a week are fine, travel (how much), evenings, weekends or Saturdays, early or late hours (for example 9am to 7pm)." },
  { key: "startAndPay", title: "Start date and pay", hint: "When you can start, notice period at your current job, and the base salary (or hourly rate) you ask for. Say if a range is fine." },
  { key: "career", title: "Your career story", hint: "Why you are looking now, and the honest reason for any short tenure, gap or layoff. Anything about your current employer a form might ask." },
  { key: "ties", title: "Connections and past history", hint: "Relatives or close friends at companies you apply to (or \"none\"), companies you worked at or applied to before, side work or outside business, non-compete or other agreements, anything for a background check." },
  { key: "stories", title: "Your best work, in your words", hint: "Two or three things you are proudest of: what you built, your part, the result (numbers if you have them). Used for \"proudest accomplishment\", \"exceptional work\" and \"a time you…\" questions." },
  { key: "motivation", title: "What you want next", hint: "The problems, products and teams that excite you and why. Used for \"Why this company / this role / now?\"." },
  { key: "other", title: "Anything else forms ask you", hint: "Languages, certifications, clearances, preferred name or pronouns, how you heard about jobs, or any answer you always want given." },
];

/** One block of notes from the Profile page answers, or "". */
function applicantNotes(user) {
  const u = user || {};
  const facts = u.applicantFacts && typeof u.applicantFacts === "object" ? u.applicantFacts : {};
  const lines = [];
  const about = String(u.answerContext || "").trim();
  if (about) lines.push(`About me: ${about}`);
  for (const q of APPLICANT_QUESTIONS) {
    const a = String(facts[q.key] || "").replace(/\s+/g, " ").trim();
    if (a) lines.push(`${q.title}: ${a}`);
  }
  return lines.join("\n").slice(0, 6000);
}

module.exports = { APPLICANT_QUESTIONS, applicantNotes };
