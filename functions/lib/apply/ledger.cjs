// ledger.cjs — one record per application form, for every attempt.
//
// users/{uid}/applications/{docId} is the ledger. The extension reports
// events (start, filled, submitted, error); this module turns them into one
// document per form, keyed by `formKey` ("ashby|org|postingId",
// "greenhouse|token|jobId"), so the same form can never be filled twice
// without the record saying so, and whatever still needs the person is kept
// (`needsAttention`) until they resolve it.
//
// Statuses: in_progress -> needs_attention | ready -> submitted
//           error (a fill crashed), dismissed (the person gave up on it)

const SUBMITTED = "submitted";

/** "ashby|org|postingId" (org lower-cased). */
function formKeyOf(source, a, b) {
  return [String(source || "").toLowerCase(), String(a || "").toLowerCase(), String(b || "")].join("|");
}

/** "role|company|title", normalized: the same role at the same company is
 *  the same application even when the board re-posts it under a new id, and
 *  it is the only key the pre-ledger records (no URL saved) can offer. */
function roleKeyOf(companyName, jobTitle) {
  const n = (v) => String(v || "").toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
  const c = n(companyName), t = n(jobTitle);
  return c && t ? `role|${c}|${t}` : "";
}

/** Firestore document id for a form key (no slashes). */
function docIdOf(formKey) {
  return String(formKey).replace(/[^A-Za-z0-9_|.:-]/g, "_").slice(0, 1400);
}

/** Derive { source, formKey, org, postingId } from an apply URL, or null. */
function formKeyFromUrl(url) {
  const u = String(url || "");
  let m = u.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (m) return { source: "ashby", org: decodeURIComponent(m[1]), postingId: m[2].toLowerCase(), formKey: formKeyOf("ashby", decodeURIComponent(m[1]), m[2].toLowerCase()) };
  m = u.match(/greenhouse\.io\/(?:embed\/job_app\?|[^?#]*\?)[^#]*\bfor=([^&#]+)[^#]*\btoken=(\d+)/i) || u.match(/greenhouse\.io\/[^?#]*\?[^#]*\btoken=(\d+)[^#]*\bfor=([^&#]+)/i);
  if (m) {
    const [token, id] = /\bfor=/.test(m[0]) && m[0].indexOf("for=") < m[0].indexOf("token=") ? [m[1], m[2]] : [m[2], m[1]];
    return { source: "greenhouse", org: token, postingId: id, formKey: formKeyOf("greenhouse", token, id) };
  }
  m = u.match(/greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i);
  if (m) return { source: "greenhouse", org: m[1], postingId: m[2], formKey: formKeyOf("greenhouse", m[1], m[2]) };
  m = u.match(/jobs\.(?:eu\.)?lever\.co\/([^/?#]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (m) return { source: "lever", org: decodeURIComponent(m[1]), postingId: m[2].toLowerCase(), formKey: formKeyOf("lever", decodeURIComponent(m[1]), m[2].toLowerCase()) };
  return null;
}

const str = (v, n = 500) => (v == null ? "" : String(v).slice(0, n));
const int = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0);

/** Keep the answers log small and uniform: { path: { label, answer, type, source } }. */
function cleanAnswers(log) {
  const out = {};
  if (!log || typeof log !== "object") return out;
  for (const [k, v] of Object.entries(log).slice(0, 150)) {
    if (!v || typeof v !== "object") continue;
    out[str(k, 200)] = { label: str(v.label, 300), answer: str(v.answer, 4000), type: str(v.type, 30), ...(v.source ? { source: str(v.source, 20) } : {}) };
  }
  return out;
}

/** [{ path, label, note }] for what the person still has to do. */
function cleanAttention(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 60).map((x) => ({ path: str(x?.path, 200), label: str(x?.label, 300), note: str(x?.note, 400) })).filter((x) => x.label);
}

/**
 * Pure state transition. `existing` is the current document (or null),
 * `ev` the reported event, `nowISO` the time. Returns
 * { duplicate: true, doc } when the form was already submitted and the
 * event is a new start (nothing is written in that case), else
 * { duplicate: false, patch } with the fields to merge.
 */
function applyEvent(existing, ev, nowISO) {
  const cur = existing || {};
  const event = String(ev.event || "");
  const meta = {
    formKey: ev.formKey, source: str(ev.source, 20), org: str(ev.org, 120), postingId: str(ev.postingId, 120),
    jobUrl: str(ev.applyUrl || cur.jobUrl, 1000),
    ...(ev.jobId ? { jobId: str(ev.jobId, 200) } : {}),
    ...(ev.jobTitle ? { jobTitle: str(ev.jobTitle, 300) } : {}),
    ...(ev.companyName ? { companyName: str(ev.companyName, 200) } : {}),
    ...(ev.extensionVersion ? { extensionVersion: str(ev.extensionVersion, 20) } : {}),
    updatedAt: nowISO,
  };
  const rk = roleKeyOf(ev.companyName || cur.companyName, ev.jobTitle || cur.jobTitle);
  if (rk) meta.roleKey = rk;
  // Old records have jobUrl but no formKey; never lose their fields.
  if (!meta.jobTitle && cur.jobTitle) delete meta.jobTitle;

  if (event === "start") {
    if (cur.status === SUBMITTED && !ev.force) return { duplicate: true, doc: cur, reason: "same form" };
    return {
      duplicate: false,
      patch: {
        ...meta,
        status: cur.status === SUBMITTED ? SUBMITTED : "in_progress",
        attempts: int(cur.attempts) + 1,
        startedAt: cur.startedAt || nowISO,
        lastStartedAt: nowISO,
        lastError: null,
        ...(ev.force ? { forcedAt: nowISO } : {}),
      },
    };
  }
  if (event === "filled") {
    const attention = cleanAttention(ev.needsAttention);
    const answers = cleanAnswers(ev.answersLog);
    return {
      duplicate: false,
      patch: {
        ...meta,
        status: cur.status === SUBMITTED ? SUBMITTED : (attention.length ? "needs_attention" : "ready"),
        answersLog: answers,
        needsAttention: attention,
        filledCount: int(ev.filledCount ?? Object.keys(answers).length),
        totalFields: int(ev.totalFields),
        requiredTotal: int(ev.requiredTotal),
        flow: str(ev.flow, 20) || "engine",
        schemaSource: str(ev.schemaSource, 30),
        gateReasons: Array.isArray(ev.reasons) ? ev.reasons.slice(0, 20).map((r) => str(r, 300)) : [],
        filledAt: nowISO,
        attempts: int(cur.attempts) || 1,
      },
    };
  }
  if (event === "submitted") {
    const patch = {
      ...meta,
      status: SUBMITTED,
      submittedAt: cur.submittedAt || nowISO,
      appliedAt: cur.appliedAt || nowISO, // back-compat with the pre-ledger records
      attempts: int(cur.attempts) || 1,
    };
    if (ev.answersLog && Object.keys(ev.answersLog).length) patch.answersLog = cleanAnswers(ev.answersLog);
    if (Array.isArray(cur.needsAttention) && cur.needsAttention.length) patch.attentionResolvedAt = nowISO;
    return { duplicate: false, patch };
  }
  if (event === "error") {
    return { duplicate: false, patch: { ...meta, status: cur.status === SUBMITTED ? SUBMITTED : "error", lastError: str(ev.error, 500), erroredAt: nowISO } };
  }
  if (event === "dismiss") {
    return { duplicate: false, patch: { ...meta, status: cur.status === SUBMITTED ? SUBMITTED : "dismissed", dismissedAt: nowISO } };
  }
  throw new Error(`unknown application event: ${event}`);
}

/** The ledger record for a form key, or null. */
async function findApplication(db, uid, formKey) {
  const byId = await db.collection("users").doc(uid).collection("applications").doc(docIdOf(formKey)).get();
  if (byId.exists) return { id: byId.id, ...byId.data() };
  const q = await db.collection("users").doc(uid).collection("applications").where("formKey", "==", formKey).limit(1).get();
  return q.empty ? null : { id: q.docs[0].id, ...q.docs[0].data() };
}

/** Already submitted? Returns { alreadyApplied, submittedAt, docId } . */
async function alreadyApplied(db, uid, formKey) {
  const rec = await findApplication(db, uid, formKey);
  return rec && rec.status === SUBMITTED ? { alreadyApplied: true, submittedAt: rec.submittedAt || rec.appliedAt || null, docId: rec.id } : { alreadyApplied: false };
}

/**
 * Record one event in a transaction. Returns
 * { ok: true, duplicate, status, docId, submittedAt?, attempts? }.
 */
async function recordEvent(db, uid, ev, now = new Date()) {
  if (!ev || !ev.formKey) throw new Error("formKey is required");
  const col = db.collection("users").doc(uid).collection("applications");
  const nowISO = now.toISOString();
  return db.runTransaction(async (tx) => {
    // Prefer the deterministic id; fall back to a legacy record for this form.
    let ref = col.doc(docIdOf(ev.formKey));
    let snap = await tx.get(ref);
    if (!snap.exists) {
      const q = await tx.get(col.where("formKey", "==", ev.formKey).limit(1));
      if (!q.empty) { ref = q.docs[0].ref; snap = q.docs[0]; }
    }
    const cur = snap.exists ? snap.data() : null;
    // No record for this form yet: the same role at the same company may have
    // been submitted under another posting id (or before URLs were saved).
    if (!cur && ev.event === "start" && !ev.force) {
      const rk = roleKeyOf(ev.companyName, ev.jobTitle);
      if (rk) {
        const q = await tx.get(col.where("roleKey", "==", rk).limit(5));
        const prior = q.docs.map((d) => d.data()).find((d) => d.status === SUBMITTED);
        if (prior) return { ok: true, duplicate: true, reason: "same role", status: SUBMITTED, docId: q.docs.find((d) => d.data() === prior).id, submittedAt: prior.submittedAt || prior.appliedAt || null, attempts: int(prior.attempts) };
      }
    }
    const r = applyEvent(cur, ev, nowISO);
    if (r.duplicate) return { ok: true, duplicate: true, reason: r.reason, status: SUBMITTED, docId: ref.id, submittedAt: r.doc.submittedAt || r.doc.appliedAt || null, attempts: int(r.doc.attempts) };
    tx.set(ref, r.patch, { merge: true });
    if (ev.event === "submitted" && ev.jobId) {
      tx.set(db.collection("users").doc(uid).collection("jobs").doc(String(ev.jobId)), { autoApplied: true, appliedAt: nowISO }, { merge: true });
    }
    return { ok: true, duplicate: false, status: r.patch.status, docId: ref.id, attempts: r.patch.attempts };
  });
}

module.exports = { formKeyOf, roleKeyOf, docIdOf, formKeyFromUrl, applyEvent, findApplication, alreadyApplied, recordEvent, cleanAnswers, cleanAttention };
