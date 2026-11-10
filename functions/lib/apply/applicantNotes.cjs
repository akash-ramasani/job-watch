// applicantNotes.cjs — the few things only the applicant can say in their own
// words, answered once on the Profile page (users/{uid}.applicantFacts),
// turned into one block of notes that every AI step reads: the answer writer
// and option picker (ai-text.cjs), the field rescue (rescue.cjs), the review
// before Submit (review.cjs).
//
// Only what Personal Information, Application Defaults and the resume cannot
// hold. Name, contact, Yes/No work authorization, sponsorship, citizenship,
// start date, pay, relocation, pronouns, clearance, education and
// certifications each have their own box there and are not asked again here.
// src/components/SavedAnswersCard.jsx shows the same list.

const APPLICANT_QUESTIONS = [
  { key: "status", title: "Visa timeline", hint: "What the Yes/No answers can't say: your visa and its dates, for example F-1 OPT from 2026, STEM OPT eligible through August 2029." },
  { key: "logistics", title: "Where and when you can work", hint: "Cities you would move to, office days a week, travel, evenings, weekends, early or late hours." },
  { key: "career", title: "Your career story", hint: "Why you are looking now, and the honest reason for any short job, gap or layoff." },
  { key: "ties", title: "Connections and past history", hint: "Relatives or friends at companies you apply to (or \"none\"), companies you applied to before, side work, non-compete or other agreements." },
  { key: "stories", title: "Your best work, in your words", hint: "Two or three things you are proudest of: what you built, your part, the result. Used for \"proudest accomplishment\" and \"a time you…\" questions." },
  { key: "motivation", title: "What you want next", hint: "The problems, products and teams that excite you and why. Used for \"Why this company?\"." },
  { key: "other", title: "Anything else forms ask you", hint: "Languages, how you heard about jobs, or any answer you always want given." },
];

/** One block of notes from the Profile page answers, or "". */
function applicantNotes(user) {
  const facts = user?.applicantFacts && typeof user.applicantFacts === "object" ? user.applicantFacts : {};
  const lines = [];
  for (const q of APPLICANT_QUESTIONS) {
    const a = String(facts[q.key] || "").replace(/\s+/g, " ").trim();
    if (a) lines.push(`${q.title}: ${a}`);
  }
  return lines.join("\n").slice(0, 6000);
}

module.exports = { APPLICANT_QUESTIONS, applicantNotes };
