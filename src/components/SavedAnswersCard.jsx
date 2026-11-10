// SavedAnswersCard — the one place JobWatch's answers come from (Profile page).
//
// users/{uid}.applicantFacts: a few
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
const DEFAULT_FACTS = {
  status: "F-1 OPT from 2026, STEM OPT eligible, so authorized to work in the U.S. through August 2029. I will need H-1B sponsorship to keep working after that.",
};

// Same list as functions/lib/apply/applicantNotes.cjs. Only what Personal
// Information, Application Defaults and the resume have no box for.
const APPLICANT_QUESTIONS = [
  { key: "status", title: "Visa timeline", hint: "What the Yes/No answers can't say: your visa and its dates, for example F-1 OPT from 2026, STEM OPT eligible through August 2029." },
  { key: "logistics", title: "Where and when you can work", hint: "Cities you would move to, office days a week, travel, evenings, weekends, early or late hours." },
  { key: "career", title: "Your career story", hint: "Why you are looking now, and the honest reason for any short job, gap or layoff." },
  { key: "ties", title: "Connections and past history", hint: "Relatives or friends at companies you apply to (or \"none\"), companies you applied to before, side work, non-compete or other agreements." },
  { key: "stories", title: "Your best work, in your words", hint: "Two or three things you are proudest of: what you built, your part, the result. Used for \"proudest accomplishment\" and \"a time you…\" questions." },
  { key: "motivation", title: "What you want next", hint: "The problems, products and teams that excite you and why. Used for \"Why this company?\"." },
  { key: "other", title: "Anything else forms ask you", hint: "Languages, how you heard about jobs, or any answer you always want given." },
];

export default function SavedAnswersCard({ uid, notify }) {
  const [facts, setFacts] = useState(null);
  const [old, setOld] = useState({ saved: 0, missing: 0 });
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (!uid) return undefined;
    return onSnapshot(doc(db, "users", uid), (snap) => {
      const d = snap.data() || {};
      setFacts((f) => (f === null ? { ...DEFAULT_FACTS, ...(d.applicantFacts || {}) } : f));
      setOld({ saved: Object.keys(d.savedAnswers || {}).length, missing: Object.keys(d.missingAnswers || {}).length });
    });
  }, [uid]);

  async function save() {
    setSaving(true);
    try {
      const clean = Object.fromEntries(APPLICANT_QUESTIONS.map((q) => [q.key, String(facts?.[q.key] || "").trim()]));
      // Older keys this list no longer asks (the "About you" note, start date and pay) are dropped.
      await updateDoc(doc(db, "users", uid), { applicantFacts: clean, answerContext: deleteField(), answersUpdatedAt: serverTimestamp() });
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
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <p className="text-sm font-semibold text-gray-900">
          Questions only you can answer
          <span className="ml-2 text-xs font-medium text-gray-400">{answered} of {APPLICANT_QUESTIONS.length} answered</span>
        </p>
        <p className="text-xs text-gray-400 mt-0.5">Only what the sections above have no box for. The AI reads these, with your details and resume, for written answers and anything a form asks that has no fixed answer.</p>
        <div className="mt-4 space-y-4">
          {APPLICANT_QUESTIONS.map((q) => (
            <div key={q.key}>
              <label className="text-sm font-semibold text-gray-800" htmlFor={`fact-${q.key}`}>{q.title}</label>
              <p className="text-xs text-gray-400">{q.hint}</p>
              <textarea
                id={`fact-${q.key}`} rows={3} className="input-standard mt-1 w-full"
                value={facts?.[q.key] ?? ""} onChange={(e) => setFacts((f) => ({ ...(f || {}), [q.key]: e.target.value }))}
              />
            </div>
          ))}
        </div>
        <button type="button" className="btn-primary mt-4" disabled={saving || facts === null} onClick={save}>
          {saving ? "Saving…" : "Save answers"}
        </button>
      </div>

      {old.saved + old.missing > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-gray-900">Old saved and waiting questions</p>
            <p className="text-xs text-gray-400 mt-0.5">
              {old.saved} answers learned from forms and {old.missing} waiting questions, one per wording, with many duplicates. Forms no longer use them; your answers above replace them.
            </p>
          </div>
          <button type="button" className="btn-secondary flex-shrink-0" disabled={clearing} onClick={clearOld}>
            {clearing ? "Deleting…" : `Delete all ${old.saved + old.missing}`}
          </button>
        </div>
      )}
    </div>
  );
}
