// SavedAnswersCard — the answer bank on the Profile page.
//
// users/{uid}.missingAnswers: questions an application asked that nobody could
// answer (the AI rescue said the profile does not have it). Answer one here and
// every form asking it fills itself; jobs that waited on it are retried by the
// extension's auto-apply.
// users/{uid}.savedAnswers: answers learned from the AI rescue ("learned") and
// from what you typed on a form ("yours"); edit or delete any of them.
// Written by functions/lib/apply/savedAnswers.cjs; read by the answer engine.
import React, { useEffect, useMemo, useState } from "react";
import { doc, onSnapshot, updateDoc, deleteField, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";

const toMs = (v) => (v?.toMillis ? v.toMillis() : v ? Date.parse(v) || 0 : 0);

export default function SavedAnswersCard({ uid, notify }) {
  const [data, setData] = useState({ saved: {}, missing: {} });
  const [drafts, setDrafts] = useState({});
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState("");

  useEffect(() => {
    if (!uid) return undefined;
    return onSnapshot(doc(db, "users", uid), (snap) => {
      const d = snap.data() || {};
      setData({ saved: d.savedAnswers || {}, missing: d.missingAnswers || {} });
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
  async function remove(field, key) {
    setBusy(key);
    try { await updateDoc(doc(db, "users", uid), { [`${field}.${key}`]: deleteField() }); }
    catch (e) { notify?.(`Could not remove: ${e.message}`, "error"); }
    finally { setBusy(""); }
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-3">
          Needs your answer {missing.length > 0 && <span className="ml-1 rounded-full bg-amber-50 px-2 py-0.5 text-amber-700">{missing.length}</span>}
        </p>
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
