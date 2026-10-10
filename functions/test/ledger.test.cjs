// The application ledger: one record per form, every attempt counted, never
// filled twice after a submit, and what still needs the person kept.
const test = require("node:test");
const assert = require("node:assert/strict");
const { formKeyOf, roleKeyOf, docIdOf, formKeyFromUrl, applyEvent, recordEvent, alreadyApplied } = require("../lib/apply/ledger.cjs");

const T0 = "2026-10-10T10:00:00.000Z", T1 = "2026-10-10T10:03:00.000Z", T2 = "2026-10-10T10:20:00.000Z";

test("form keys: stable per form, derived from apply URLs, safe as doc ids", () => {
  assert.equal(formKeyOf("ashby", "OpenAI", "8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3"), "ashby|openai|8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3");
  assert.deepEqual(formKeyFromUrl("https://jobs.ashbyhq.com/poshmark/89b69b74-19d8-4f60-b38c-fd59af96abd2/application"),
    { source: "ashby", org: "poshmark", postingId: "89b69b74-19d8-4f60-b38c-fd59af96abd2", formKey: "ashby|poshmark|89b69b74-19d8-4f60-b38c-fd59af96abd2" });
  assert.equal(formKeyFromUrl("https://job-boards.greenhouse.io/westmonroe4/jobs/5801015004").formKey, "greenhouse|westmonroe4|5801015004");
  assert.equal(formKeyFromUrl("https://boards.greenhouse.io/embed/job_app?for=westmonroe4&token=5801015004").formKey, "greenhouse|westmonroe4|5801015004");
  assert.equal(formKeyFromUrl("https://boards.greenhouse.io/embed/job_app?token=5801015004&for=westmonroe4").formKey, "greenhouse|westmonroe4|5801015004");
  assert.equal(formKeyFromUrl("https://example.com/careers"), null);
  assert.equal(docIdOf("ashby|a b/c|x"), "ashby|a_b_c|x");
});

test("events: start counts attempts, filled keeps what needs the person, submitted closes it", () => {
  const base = { event: "start", formKey: "ashby|acme|p1", source: "ashby", org: "acme", postingId: "p1", applyUrl: "https://jobs.ashbyhq.com/acme/p1/application", jobTitle: "SWE", companyName: "Acme", extensionVersion: "1.2.0" };
  let r = applyEvent(null, base, T0);
  assert.equal(r.duplicate, false);
  assert.equal(r.patch.status, "in_progress");
  assert.equal(r.patch.attempts, 1);
  assert.equal(r.patch.startedAt, T0);
  let doc = r.patch;

  r = applyEvent(doc, { ...base, event: "filled", answersLog: { a: { label: "Name", answer: "Ada", type: "text", source: "profile" }, junk: null }, needsAttention: [{ path: "x", label: "Take-home link", note: "needs a link only you can provide" }], totalFields: 12, requiredTotal: 9 }, T1);
  assert.equal(r.patch.status, "needs_attention");
  assert.equal(r.patch.filledCount, 1);
  assert.deepEqual(r.patch.answersLog, { a: { label: "Name", answer: "Ada", type: "text", source: "profile" } });
  assert.equal(r.patch.needsAttention[0].label, "Take-home link");
  doc = { ...doc, ...r.patch };

  // A second visit to the same unfinished form is another attempt, not a duplicate.
  r = applyEvent(doc, base, T1);
  assert.equal(r.duplicate, false);
  assert.equal(r.patch.attempts, 2);
  doc = { ...doc, ...r.patch };

  r = applyEvent(doc, { ...base, event: "filled", answersLog: { a: { label: "Name", answer: "Ada", type: "text" } }, needsAttention: [], totalFields: 12, requiredTotal: 9 }, T1);
  assert.equal(r.patch.status, "ready");
  doc = { ...doc, ...r.patch };

  r = applyEvent(doc, { ...base, event: "submitted", jobId: "job1" }, T2);
  assert.equal(r.patch.status, "submitted");
  assert.equal(r.patch.submittedAt, T2);
  assert.equal(r.patch.appliedAt, T2);
  assert.equal(r.patch.attentionResolvedAt, undefined); // nothing was pending at submit time
  doc = { ...doc, ...r.patch };

  // Never twice: a new start on a submitted form writes nothing.
  r = applyEvent(doc, base, T2);
  assert.equal(r.duplicate, true);
  assert.equal(r.doc.submittedAt, T2);
  // ...and a late "filled" or "error" cannot reopen it.
  assert.equal(applyEvent(doc, { ...base, event: "filled", needsAttention: [{ label: "x" }] }, T2).patch.status, "submitted");
  assert.equal(applyEvent(doc, { ...base, event: "error", error: "boom" }, T2).patch.status, "submitted");
  // Submitting with open items records when they were resolved.
  assert.equal(applyEvent({ status: "needs_attention", needsAttention: [{ label: "x" }] }, { ...base, event: "submitted" }, T2).patch.attentionResolvedAt, T2);
});

test("events: error and dismiss, legacy records keep their title", () => {
  const ev = { formKey: "greenhouse|t|1", source: "greenhouse", org: "t", postingId: "1" };
  const r = applyEvent({ status: "in_progress", attempts: 1 }, { ...ev, event: "error", error: "x".repeat(900) }, T0);
  assert.equal(r.patch.status, "error");
  assert.equal(r.patch.lastError.length, 500);
  assert.equal(applyEvent({ status: "needs_attention" }, { ...ev, event: "dismiss" }, T0).patch.status, "dismissed");
  const legacy = { status: "submitted", jobTitle: "Old title", jobUrl: "https://jobs.ashbyhq.com/t/1", appliedAt: "2026-08-26T00:00:00.000Z" };
  assert.equal(applyEvent(legacy, { ...ev, event: "start" }, T0).duplicate, true);
  const upd = applyEvent({ ...legacy, status: "ready" }, { ...ev, event: "submitted" }, T0).patch;
  assert.equal(upd.jobTitle, undefined); // not overwritten with ""
  assert.equal(upd.appliedAt, "2026-08-26T00:00:00.000Z");
  assert.throws(() => applyEvent(null, { ...ev, event: "nope" }, T0), /unknown application event/);
});

// A tiny in-memory Firestore: doc get/set, where==/limit, transactions.
function fakeDb() {
  const store = new Map();
  const docRef = (path) => ({
    id: path.split("/").pop(), path,
    get: async () => ({ exists: store.has(path), id: path.split("/").pop(), data: () => store.get(path), ref: docRef(path) }),
    set: (data, opts) => { store.set(path, opts?.merge ? { ...(store.get(path) || {}), ...data } : data); },
  });
  const runQuery = (q) => {
    const depth = q.path.split("/").length + 1;
    const docs = [...store.entries()].filter(([k, d]) => k.startsWith(q.path + "/") && k.split("/").length === depth && d[q.f] === q.v)
      .map(([k, d]) => ({ id: k.split("/").pop(), data: () => d, ref: docRef(k), exists: true }));
    return { empty: docs.length === 0, docs };
  };
  const colRef = (path) => ({
    doc: (id) => Object.assign(docRef(`${path}/${id}`), { collection: (sub) => colRef(`${path}/${id}/${sub}`) }),
    where: (f, op, v) => ({ limit: () => ({ _q: { path, f, v }, get: async () => runQuery({ path, f, v }) }) }),
  });
  return {
    collection: (name) => colRef(name),
    runTransaction: async (fn) => fn({ get: async (x) => (x._q ? runQuery(x._q) : x.get()), set: (ref, data, opts) => ref.set(data, opts) }),
    _store: store,
  };
}

test("recordEvent: deterministic id, legacy record found by formKey, duplicate start refused, job marked applied", async () => {
  const db = fakeDb();
  const uid = "u1";
  const ev = { event: "start", formKey: "ashby|acme|p1", source: "ashby", org: "acme", postingId: "p1", applyUrl: "https://jobs.ashbyhq.com/acme/p1" };
  let r = await recordEvent(db, uid, ev, new Date(T0));
  assert.deepEqual([r.duplicate, r.status, r.docId, r.attempts], [false, "in_progress", "ashby|acme|p1", 1]);
  r = await recordEvent(db, uid, { ...ev, event: "filled", answersLog: {}, needsAttention: [{ label: "Video", note: "upload" }] }, new Date(T1));
  assert.equal(r.status, "needs_attention");
  assert.deepEqual(await alreadyApplied(db, uid, "ashby|acme|p1"), { alreadyApplied: false });
  r = await recordEvent(db, uid, { ...ev, event: "submitted", jobId: "job9" }, new Date(T2));
  assert.equal(r.status, "submitted");
  assert.equal(db._store.get("users/u1/jobs/job9").autoApplied, true);
  r = await recordEvent(db, uid, ev, new Date(T2));
  assert.equal(r.duplicate, true);
  assert.equal(r.submittedAt, T2);
  assert.equal(db._store.get("users/u1/applications/ashby|acme|p1").attempts, 1);
  assert.equal((await alreadyApplied(db, uid, "ashby|acme|p1")).alreadyApplied, true);

  // A pre-ledger record (random id) tagged with formKey by the backfill is found and reused.
  db._store.set("users/u1/applications/legacy123", { formKey: "ashby|zed|p2", status: "submitted", appliedAt: "2026-08-26T00:00:00.000Z" });
  r = await recordEvent(db, uid, { ...ev, formKey: "ashby|zed|p2", org: "zed", postingId: "p2" }, new Date(T2));
  assert.equal(r.duplicate, true);
  assert.equal(r.docId, "legacy123");
  assert.equal(r.submittedAt, "2026-08-26T00:00:00.000Z");
  assert.equal((await alreadyApplied(db, uid, "ashby|zed|p2")).docId, "legacy123");
});

test("role key: same company + title under a new posting id is a duplicate, unless forced", async () => {
  assert.equal(roleKeyOf("Acme, Inc.", "Software Engineer II (Remote)"), "role|acme inc|software engineer ii");
  assert.equal(roleKeyOf("", "x"), "");
  const db = fakeDb();
  // A pre-ledger record: no URL, only company + title, tagged by the backfill.
  db._store.set("users/u1/applications/1787763076311", { formKey: "legacy|1787763076311", roleKey: "role|acme|software engineer", status: "submitted", appliedAt: "2026-09-01T00:00:00.000Z", companyName: "Acme", jobTitle: "Software Engineer" });
  const ev = { event: "start", formKey: "ashby|acme|newpost", source: "ashby", org: "acme", postingId: "newpost", companyName: "Acme", jobTitle: "Software Engineer" };
  let r = await recordEvent(db, "u1", ev, new Date(T0));
  assert.equal(r.duplicate, true);
  assert.equal(r.reason, "same role");
  assert.equal(r.submittedAt, "2026-09-01T00:00:00.000Z");
  assert.equal(db._store.has("users/u1/applications/ashby|acme|newpost"), false);
  // A different title at the same company is a new application.
  r = await recordEvent(db, "u1", { ...ev, formKey: "ashby|acme|p3", postingId: "p3", jobTitle: "Staff Engineer" }, new Date(T0));
  assert.equal(r.duplicate, false);
  assert.equal(db._store.get("users/u1/applications/ashby|acme|p3").roleKey, "role|acme|staff engineer");
  // #jwforce: the person insists; the attempt is recorded and marked forced.
  r = await recordEvent(db, "u1", { ...ev, force: true }, new Date(T1));
  assert.equal(r.duplicate, false);
  assert.equal(db._store.get("users/u1/applications/ashby|acme|newpost").forcedAt, T1);
  // Forcing a start on an already-submitted form keeps it submitted but counts the attempt.
  const sub = applyEvent({ status: "submitted", attempts: 1 }, { ...ev, force: true }, T2).patch;
  assert.equal(sub.status, "submitted");
  assert.equal(sub.attempts, 2);
});
