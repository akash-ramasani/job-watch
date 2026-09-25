// Is a job related to this user? Used to hide unrelated jobs everywhere jobs are listed.
//
// Jobs are shared by all users; each user has job types (their pick on the
// Profile page, else read from their resume by the scorer). A job is unrelated when
//   - the scorer said so: skipped as another job type, or judged a different
//     field by the AI or the rule score (rollup flag `o`, or an older skip `t`), or
//   - it has no current score and its title's types (`fam`, on the job lists)
//     include none of the user's types.
// Anything the scorer judged related, and anything we can't tell, is shown.

import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { db } from "../firebase";
import { isRelatedJob } from "./jobRelevanceCore.js";

export { isRelatedJob };

/** Does this user need visa sponsorship? (Profile form: requiresSponsorship.) */
export const needsSponsorship = (userMeta) => /^y(es)?$/i.test(String(userMeta?.requiresSponsorship || "").trim());

/** The user's job types: their own pick, else the ones read from their resume. null while loading or unknown. */
export function useJobTypes(uid) {
  const [types, setTypes] = useState(null);
  useEffect(() => {
    if (!uid) return;
    let alive = true;
    Promise.all([getDoc(doc(db, "users", uid, "settings", "preferences")), getDoc(doc(db, "users", uid, "settings", "scoring"))])
      .then(([prefs, scoring]) => {
        const saved = prefs.data()?.jobTypes;
        const auto = scoring.data()?.autoJobTypes;
        if (alive) setTypes(Array.isArray(saved) && saved.length ? saved : Array.isArray(auto) && auto.length ? auto : []);
      })
      .catch(() => alive && setTypes([]));
    return () => { alive = false; };
  }, [uid]);
  return types;
}
