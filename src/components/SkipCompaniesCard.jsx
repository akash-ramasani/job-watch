// SkipCompaniesCard — companies this person never wants to apply to
// (settings/preferences.excludedCompanies, the same list as "Hide company" on
// the Jobs page). Their jobs leave the Jobs page and auto-apply skips them.
// Matched by name as typed: "CVS" covers "CVS Health" (lib/companyExclude.js).
import React, { useEffect, useState } from "react";
import { arrayRemove, arrayUnion, doc, onSnapshot, setDoc } from "firebase/firestore";
import { db } from "../firebase";
import { useToast } from "./Toast/ToastProvider.jsx";
import { track } from "../lib/analytics.js";

export default function SkipCompaniesCard({ user }) {
  const { showToast } = useToast();
  const [list, setList] = useState([]);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user?.uid) return;
    return onSnapshot(doc(db, "users", user.uid, "settings", "preferences"), (s) => {
      const v = s.data()?.excludedCompanies;
      setList(Array.isArray(v) ? v : []);
    }, () => {});
  }, [user?.uid]);

  const ref = () => doc(db, "users", user.uid, "settings", "preferences");
  const add = async (e) => {
    e?.preventDefault?.();
    // Several at once: "U.S. Bank, Costco, CVS".
    const names = text.split(/[,\n;]/).map((s) => s.trim()).filter(Boolean)
      .filter((n) => !list.some((c) => c.toLowerCase() === n.toLowerCase()));
    if (!names.length) { setText(""); return; }
    setSaving(true);
    try {
      await setDoc(ref(), { excludedCompanies: arrayUnion(...names) }, { merge: true });
      setText("");
      track("company_skipped", { count: names.length });
      showToast(`${names.join(", ")}: never applied to, and hidden on the Jobs page.`, "success");
    } catch {
      showToast("Couldn't save the companies", "error");
    } finally {
      setSaving(false);
    }
  };
  const remove = async (name) => {
    try { await setDoc(ref(), { excludedCompanies: arrayRemove(name) }, { merge: true }); }
    catch { showToast("Couldn't remove it", "error"); }
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
      <p className="text-sm font-semibold text-gray-900">Companies to skip</p>
      <p className="text-xs text-gray-400 mt-0.5">
        Auto-apply never applies to these, and their jobs are hidden on the Jobs page. A name covers its variants: "CVS" also skips CVS Health.
      </p>
      <form onSubmit={add} className="mt-3 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="input-standard flex-1"
          placeholder="Company names, separated by commas"
          aria-label="Companies to skip"
        />
        <button type="submit" disabled={saving || !text.trim()} className="btn-primary !py-1.5 !px-3 text-xs disabled:opacity-50">
          {saving ? "Adding…" : "Add"}
        </button>
      </form>
      {list.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {list.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => remove(c)}
              title={`Apply to ${c} again`}
              className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium ring-1 bg-gray-50 text-gray-700 ring-gray-200 hover:bg-red-50 hover:text-red-700 hover:ring-red-200"
            >
              {c} <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
