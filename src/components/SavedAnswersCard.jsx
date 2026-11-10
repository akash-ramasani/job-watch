// SavedAnswersCard — the one place JobWatch's answers come from (Profile page).
//
// users/{uid}.applicantFacts (+ the free note users/{uid}.answerContext): a few
// grouped questions only the person can answer. Every AI step reads them
// (functions/lib/apply/applicantNotes.cjs): written answers, dropdown picks,
// the field rescue, the review before Submit.
//
// One source of truth (2026-11-09): answers learned from pages
// (users/{uid}.savedAnswers) and the per-wording waiting list
// (users/{uid}.missingAnswers) piled up as duplicates, and a learned phone put
// "5109356846+1" in every phone box. Forms no longer use them; the button
// below deletes what is left of them.
import React, { useEffect, useState } from "react";
import { doc, onSnapshot, updateDoc, deleteField, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";

// Prefilled once; what you write here is saved with your account.
const DEFAULT_ABOUT = "I am an F-1 OPT student from India, currently in the USA. I completed my Master's in Computer Science (MS CS) at California State University, East Bay (CSU East Bay).";
const DEFAULT_FACTS = {
  status: "F-1 OPT, starting 2026, STEM OPT eligible, so authorized to work in the U.S. through August 2029. I will need H-1B sponsorship to keep working after that.",
};

// Same list as functions/lib/apply/applicantNotes.cjs.
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

export default function SavedAnswersCard({ uid, notify }) {
  const [about, setAbout] = useState(null); // null until the account loads
  const [facts, setFacts] = useState(null);
  const [old, setOld] = useState({ saved: 0, missing: 0 });
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (!uid) return undefined;
    return onSnapshot(doc(db, "users", uid), (snap) => {
      const d = snap.data() || {};
      setAbout((a) => (a === null ? (d.answerContext || DEFAULT_ABOUT) : a));
      setFacts((f) => (f === null ? { ...DEFAULT_FACTS, ...(d.applicantFacts || {}) } : f));
      setOld({ saved: Object.keys(d.savedAnswers || {}).length, missing: Object.keys(d.missingAnswers || {}).length });
    });
  }, [uid]);

  async function save() {
    setSaving(true);
    try {
      const clean = Object.fromEntries(APPLICANT_QUESTIONS.map((q) => [q.key, String(facts?.[q.key] || "").trim()]));
      await updateDoc(doc(db, "users", uid), { applicantFacts: clean, answerContext: String(about || "").trim(), answersUpdatedAt: serverTimestamp() });
      notify?.("Saved. Every application answers from these from now on, and jobs that waited on you are retried.", "success");
    } catch (e) {
      notify?.(`Could not save: ${e.message}`, "error");
    } finally {
      setSaving(false);
    }
  }

  async function clearOld() {
    setClearing(true);
    try {
      await updateDoc(doc(db, "users", uid), { savedAnswers: deleteField(), missingAnswers: deleteField() });
      notify?.("Old saved and waiting questions deleted.", "success");
    } catch (e) {
      notify?.(`Could not delete: ${e.message}`, "error");
    } finally {
      setClearing(false);
    }
  }

  const answered = APPLICANT_QUESTIONS.filter((q) => String(facts?.[q.key] || "").trim()).length;

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-4">
        <p className="text-sm font-semibold text-gray-900">
          Questions only you can answer
          <span className="ml-2 text-xs font-medium text-gray-500">{answered} of {APPLICANT_QUESTIONS.length} answered</span>
        </p>
        <p className="mt-0.5 text-xs text-gray-500">The one place JobWatch's answers come from, with your Profile and resume. Each answer here covers every way a form asks it (export control, relatives at the company, weekend hours, salary, "why this company", "proudest accomplishment"…). Nothing a form shows is saved or reused.</p>
        <div className="mt-3 space-y-3">
          <div>
            <label className="text-sm font-semibold text-gray-800" htmlFor="answer-context">About you</label>
            <textarea id="answer-context" rows={2} className="input-standard mt-1 w-full" value={about ?? ""} onChange={(e) => setAbout(e.target.value)} />
          </div>
          {APPLICANT_QUESTIONS.map((q) => (
            <div key={q.key}>
              <label className="text-sm font-semibold text-gray-800" htmlFor={`fact-${q.key}`}>{q.title}</label>
              <p className="text-xs text-gray-500">{q.hint}</p>
              <textarea
                id={`fact-${q.key}`} rows={3} className="input-standard mt-1 w-full"
                value={facts?.[q.key] ?? ""} onChange={(e) => setFacts((f) => ({ ...(f || {}), [q.key]: e.target.value }))}
              />
            </div>
          ))}
        </div>
        <button type="button" className="btn-primary mt-3" disabled={saving || facts === null || about === null} onClick={save}>
          {saving ? "Saving…" : "Save answers"}
        </button>
      </div>

      {old.saved + old.missing > 0 && (
        <div className="rounded-xl border border-amber-100 bg-amber-50/40 p-4">
          <p className="text-sm font-semibold text-gray-900">Old saved and waiting questions</p>
          <p className="mt-0.5 text-xs text-gray-500">
            {old.saved} answers learned from forms and {old.missing} waiting questions, one per wording, with many duplicates. Forms no longer use them; your answers above replace them.
          </p>
          <button type="button" className="btn-secondary mt-3" disabled={clearing} onClick={clearOld}>
            {clearing ? "Deleting…" : `Delete all ${old.saved + old.missing}`}
          </button>
        </div>
      )}
    </div>
  );
}
