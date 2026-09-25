// JobTypesCard — which kinds of jobs get an AI match score for this user.
// Jobs are shared by everyone; each job's type is read from its title, and
// only jobs of the types picked here are scored against this user's resume.
// Defaults come from the resume (settings/scoring.autoJobTypes, written by the
// scorer); a custom pick is saved to settings/preferences.jobTypes.
import React, { useEffect, useMemo, useState } from "react";
import { deleteField, doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "../firebase";
import { useToast } from "./Toast/ToastProvider.jsx";
import { JOB_TYPES } from "../lib/jobTypes.js";
import { track } from "../lib/analytics.js";

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

export default function JobTypesCard({ user }) {
  const { showToast } = useToast();
  const [auto, setAuto] = useState(null); // from the resume, null = not known yet
  const [saved, setSaved] = useState(null); // user's own pick, null = follow the resume
  const [draft, setDraft] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user?.uid) return;
    Promise.all([
      getDoc(doc(db, "users", user.uid, "settings", "scoring")),
      getDoc(doc(db, "users", user.uid, "settings", "preferences")),
    ]).then(([scoring, prefs]) => {
      const a = scoring.data()?.autoJobTypes;
      const s = prefs.data()?.jobTypes;
      setAuto(Array.isArray(a) ? a : []);
      setSaved(Array.isArray(s) && s.length ? s : null);
    }).catch(() => setAuto([]));
  }, [user?.uid]);

  const current = saved || auto || [];
  const selected = draft || current;
  const dirty = draft && !sameSet(draft, current);
  const visible = useMemo(
    () => (showAll ? JOB_TYPES : JOB_TYPES.filter((t) => selected.includes(t.id))),
    [showAll, selected]
  );

  const toggle = (id) => {
    const base = draft || current;
    setDraft(base.includes(id) ? base.filter((x) => x !== id) : [...base, id]);
  };

  const save = async (next) => {
    setSaving(true);
    try {
      // Matching the resume's default means "follow the resume" — store nothing.
      const followResume = !next || (auto && sameSet(next, auto));
      await setDoc(doc(db, "users", user.uid, "settings", "preferences"), { jobTypes: followResume ? deleteField() : next }, { merge: true });
      setSaved(followResume ? null : next);
      setDraft(null);
      track("job_types_saved", { count: (next || auto || []).length, custom: !followResume });
      showToast("Saved. Scores update over the next few syncs.", "success");
    } catch {
      showToast("Couldn't save job types", "error");
    } finally {
      setSaving(false);
    }
  };

  if (auto === null) return null;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-gray-900">Job types to score</p>
          <p className="text-xs text-gray-400 mt-0.5">
            {current.length === 0
              ? "Add your resume and these fill in from your experience. Until then every job is scored."
              : saved
                ? "Your own pick. Other job types show as not your field and aren't scored."
                : "Picked from your resume. Other job types show as not your field and aren't scored."}
          </p>
        </div>
        <button type="button" onClick={() => setShowAll((v) => !v)} className="text-xs font-semibold text-indigo-600 hover:text-indigo-700 whitespace-nowrap">
          {showAll ? "Show selected" : "Edit"}
        </button>
      </div>

      {visible.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {visible.map((t) => {
            const on = selected.includes(t.id);
            return (
              <button
                key={t.id}
                type="button"
                disabled={!showAll}
                onClick={() => toggle(t.id)}
                aria-pressed={on}
                className={`rounded-full px-3 py-1 text-xs font-medium ring-1 transition-colors ${
                  on ? "bg-indigo-50 text-indigo-700 ring-indigo-200" : "bg-white text-gray-500 ring-gray-200 hover:ring-gray-300"
                } ${showAll ? "cursor-pointer" : "cursor-default"}`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      )}

      {(dirty || (showAll && saved)) && (
        <div className="mt-4 flex items-center gap-3">
          {dirty && (
            <button type="button" disabled={saving || selected.length === 0} onClick={() => save(selected)} className="btn-primary !py-1.5 !px-3 text-xs disabled:opacity-50">
              {saving ? "Saving…" : "Save"}
            </button>
          )}
          {dirty && <button type="button" onClick={() => setDraft(null)} className="text-xs text-gray-500 hover:text-gray-700">Cancel</button>}
          {saved && auto.length > 0 && (
            <button type="button" disabled={saving} onClick={() => save(null)} className="text-xs text-gray-500 hover:text-gray-700 ml-auto">
              Match my resume again
            </button>
          )}
        </div>
      )}
    </div>
  );
}
