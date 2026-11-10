// SavedAnswersCard — the answer bank on the Profile page.
//
// users/{uid}.missingAnswers: questions an application asked that nobody could
// answer (the AI rescue said the profile does not have it). Answer one here and
// every form asking it fills itself; jobs that waited on it are retried by the
// extension's auto-apply.
// users/{uid}.savedAnswers: answers learned from the AI rescue ("learned") and
// from what you typed on a form ("yours"); edit or delete any of them.
// "Answer with AI" (draftMissingAnswers, functions/lib/apply/draftAnswers.cjs):
// merges the questions that ask the same thing, answers what the background
// note, Profile and resume say, and leaves the rest here for you.
// Written by functions/lib/apply/savedAnswers.cjs; read by the answer engine.
import React, { useEffect, useMemo, useState } from "react";
import { doc, onSnapshot, updateDoc, deleteField, serverTimestamp } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";

// Prefilled once; what you write here is saved with your account (users/{uid}.answerContext).
const DEFAULT_ABOUT = "I am an F-1 OPT student from India, currently in the USA. I completed my Master's in Computer Science (MS CS) at California State University, East Bay (CSU East Bay).";

// The few things only you can say, answered once (users/{uid}.applicantFacts).
// Every AI step reads them: written answers, dropdown picks, the field rescue,
// the review before Submit. Same list as functions/lib/apply/applicantNotes.cjs.
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

const toMs = (v) => (v?.toMillis ? v.toMillis() : v ? Date.parse(v) || 0 : 0);

export default function SavedAnswersCard({ uid, notify }) {
  const [data, setData] = useState({ saved: {}, missing: {} });
  const [drafts, setDrafts] = useState({});
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState("");
  const [about, setAbout] = useState(null); // null until the account's note loads
  const [drafting, setDrafting] = useState(false);
  const [facts, setFacts] = useState(null); // null until the account's answers load
  const [savingFacts, setSavingFacts] = useState(false);

  useEffect(() => {
    if (!uid) return undefined;
    return onSnapshot(doc(db, "users", uid), (snap) => {
      const d = snap.data() || {};
      setData({ saved: d.savedAnswers || {}, missing: d.missingAnswers || {} });
      setAbout((a) => (a === null ? (d.answerContext || DEFAULT_ABOUT) : a));
      setFacts((f) => (f === null ? { ...(d.applicantFacts || {}) } : f));
    });
  }, [uid]);

  const missing = useMemo(() => Object.entries(data.missing).filter(([, v]) => v?.question).sort((a, b) => (b[1].count || 0) - (a[1].count || 0) || toMs(b[1].at) - toMs(a[1].at)), [data.missing]);
  const saved = useMemo(() => Object.entries(data.saved).filter(([, v]) => v?.question).sort((a, b) => toMs(b[1].at) - toMs(a[1].at)), [data.saved]);

  async function save(key, question) {
    const answer = String(drafts[key] ?? "").trim();
    if (!answer) return;
    setBusy(key);
    try {
      await updateDoc(doc(db, "users", uid), {
        [`savedAnswers.${key}`]: { question, answer, source: "you", at: new Date() },
        [`missingAnswers.${key}`]: deleteField(),
        answersUpdatedAt: serverTimestamp(),
      });
      setDrafts((d) => ({ ...d, [key]: undefined }));
      setEditing(null);
      notify?.("Saved. Forms asking this fill it from now on.", "success");
    } catch (e) {
      notify?.(`Could not save: ${e.message}`, "error");
    } finally {
      setBusy("");
    }
  }
  async function saveFacts() {
    setSavingFacts(true);
    try {
      const clean = Object.fromEntries(APPLICANT_QUESTIONS.map((q) => [q.key, String(facts?.[q.key] || "").trim()]));
      await updateDoc(doc(db, "users", uid), { applicantFacts: clean, answerContext: String(about || "").trim(), answersUpdatedAt: serverTimestamp() });
      notify?.("Saved. Every application uses these answers from now on, and jobs that waited on you are retried.", "success");
    } catch (e) {
      notify?.(`Could not save: ${e.message}`, "error");
    } finally {
      setSavingFacts(false);
    }
  }
  async function answerWithAi() {
    setDrafting(true);
    try {
      const draft = httpsCallable(functions, "draftMissingAnswers", { timeout: 180000 });
      const { data: r } = await draft({ about: String(about || "").trim() });
      const parts = [`${r.answered} answered`, r.merged ? `${r.merged} duplicates merged` : "", r.waiting ? `${r.waiting} still need you` : ""].filter(Boolean);
      notify?.(`${parts.join(", ")}. Check the answers under Saved answers.`, "success");
    } catch (e) {
      notify?.(`Could not answer with AI: ${e.message}`, "error");
    } finally {
      setDrafting(false);
    }
  }
  async function remove(field, key) {
    setBusy(key);
    try { await updateDoc(doc(db, "users", uid), { [`${field}.${key}`]: deleteField() }); }
    catch (e) { notify?.(`Could not remove: ${e.message}`, "error"); }
    finally { setBusy(""); }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-4">
        <p className="text-sm font-semibold text-gray-900">
          Questions only you can answer
          <span className="ml-2 text-xs font-medium text-gray-500">{APPLICANT_QUESTIONS.filter((q) => String(facts?.[q.key] || "").trim()).length} of {APPLICANT_QUESTIONS.length} answered</span>
        </p>
        <p className="mt-0.5 text-xs text-gray-500">Answer once, in your own words. JobWatch uses these on every form: one answer here covers many questions (export control, relatives at the company, weekend hours, salary, "why this company", "proudest accomplishment"…).</p>
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
        <button type="button" className="btn-primary mt-3" disabled={savingFacts || facts === null || about === null} onClick={saveFacts}>
          {savingFacts ? "Saving…" : "Save answers"}
        </button>
      </div>

      <div>
        <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-3">
          Needs your answer {missing.length > 0 && <span className="ml-1 rounded-full bg-amber-50 px-2 py-0.5 text-amber-700">{missing.length}</span>}
        </p>
        {missing.length > 0 && (
          <div className="mb-4 rounded-xl border border-indigo-100 bg-indigo-50/40 p-4">
            <p className="text-xs text-gray-500">The AI answers these from your answers above, your Profile and your resume, and merges questions that ask the same thing. Any it can't answer honestly stay here for you.</p>
            <button type="button" className="btn-primary mt-2" disabled={drafting || about === null} onClick={answerWithAi}>
              {drafting ? "Answering…" : `Answer ${missing.length} with AI`}
            </button>
          </div>
        )}
        {missing.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing waiting. Questions no one could answer show up here.</p>
        ) : (
          <ul className="space-y-3">
            {missing.map(([key, v]) => (
              <li key={key} className="rounded-xl border border-amber-100 bg-amber-50/40 p-4">
                <p className="text-sm font-semibold text-gray-900">{v.question}</p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {[v.companyName, v.jobTitle].filter(Boolean).join(" · ")}{v.count > 1 ? ` · asked ${v.count} times` : ""}{v.why ? ` · ${v.why}` : ""}
                </p>
                <div className="mt-3 flex gap-2">
                  <input
                    className="input-standard flex-1" placeholder="Your answer"
                    value={drafts[key] ?? ""} onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(key, v.question); } }}
                  />
                  <button type="button" className="btn-primary" disabled={busy === key || !String(drafts[key] ?? "").trim()} onClick={() => save(key, v.question)}>Save</button>
                  <button type="button" className="btn-secondary" disabled={busy === key} onClick={() => remove("missingAnswers", key)}>Dismiss</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="pt-2 border-t border-gray-100">
        <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-3">Saved answers {saved.length > 0 && <span className="ml-1 text-gray-500">{saved.length}</span>}</p>
        {saved.length === 0 ? (
          <p className="text-sm text-gray-500">None yet. Answers the AI finishes on a form, and answers you type into fields JobWatch could not fill, are saved here and reused.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {saved.map(([key, v]) => (
              <li key={key} className="py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-900">{v.question}</p>
                    {editing === key ? (
                      <div className="mt-2 flex gap-2">
                        <input
                          className="input-standard flex-1" autoFocus
                          value={drafts[key] ?? v.answer} onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(key, v.question); } if (e.key === "Escape") setEditing(null); }}
                        />
                        <button type="button" className="btn-primary" disabled={busy === key} onClick={() => save(key, v.question)}>Save</button>
                      </div>
                    ) : (
                      <p className="mt-0.5 text-sm font-semibold text-indigo-600 break-words">
                        {v.answer}
                        <span className="ml-2 text-[10px] font-black uppercase tracking-widest text-gray-400">{v.source === "you" ? "yours" : "learned"}</span>
                      </p>
                    )}
                  </div>
                  {editing !== key && (
                    <div className="flex shrink-0 gap-2">
                      <button type="button" className="text-xs font-semibold text-gray-500 hover:text-indigo-600" onClick={() => { setDrafts((d) => ({ ...d, [key]: v.answer })); setEditing(key); }}>Edit</button>
                      <button type="button" className="text-xs font-semibold text-gray-500 hover:text-red-600" disabled={busy === key} onClick={() => remove("savedAnswers", key)}>Delete</button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
