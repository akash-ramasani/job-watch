// rescue.js — the AI rescue for a field the fill could not finish.
//
// Shared by content/ashby.js, greenhouse.js, lever.js and universal.js (listed
// before them in the manifest, same isolated world):
//   await __jwRescue(question, { jobTitle, companyName })
//     -> { ok, filled, answer?, why? }
// Each round: snapshot the field (lib/rescue-dom.js, MAIN world), send its HTML
// to rescueField (Claude picks the steps from the Profile and the person's own
// answers on it), run the steps, look again. Three rounds at most; optional
// fields (no "*") are left alone. Nothing is saved for reuse: the Profile is
// the one source of truth (2026-11-09).
(function () {
  "use strict";
  if (window.__jwRescue) return;
  const sleep = (ms) => (window.__jwWait ? window.__jwWait(ms) : new Promise((r) => setTimeout(r, ms)));
  const send = (msg) => new Promise((res) => { try { chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false, error: chrome.runtime.lastError?.message || "no answer" })); } catch (e) { res({ ok: false, error: e.message }); } });
  const dom = async (action, ...args) => { const r = await send({ type: "EXEC_RESCUE", action, args }); return r?.ok ? r.result : null; };

  // Steps remembered from earlier forms are gone (one source of truth): clear any stored ones.
  try { chrome.storage.local.remove("jwRescueMemo"); } catch { /* nothing stored */ }

  // One source of truth: every rescue asks the AI with the Profile's answers;
  // no steps remembered from earlier forms are replayed (they could carry an
  // old wrong value, as the learned phone answer did, 2026-11-09).
  async function rescueOnce(question, opts = {}) {
    return rescueAi(question, opts);
  }

  async function rescueAi(question, { jobTitle = "", companyName = "", force = false, error = "" } = {}) {
    // The board's own complaint ("Enter a valid URL") rides in history, which
    // the background passes to rescueField untouched.
    const history = error ? [{ round: 0, boardError: String(error).slice(0, 300) }] : [];
    let answer = "";
    let required = false;
    for (let round = 1; round <= 3; round++) {
      const snap = await dom("snapshot", question);
      if (!snap?.ok) return { ok: false, filled: false, why: snap?.error || "field not found" };
      required = snap.required;
      if (!snap.required && !force) return { ok: false, filled: snap.filled, why: "optional (no *)" };
      if (round > 1 && snap.filled && history[history.length - 1]?.done) return { ok: true, filled: true, answer, required, steps: history.flatMap((h) => h.steps || []) };
      const r = await send({ type: "RESCUE_FIELD", question, html: snap.html, required: snap.required, round, history, jobTitle, companyName });
      if (!r?.ok) return { ok: false, filled: snap.filled, why: r?.error || "rescue failed", required };
      const plan = r.plan || {};
      if (plan.cannot) return { ok: false, filled: snap.filled, why: plan.cannot, required, missing: true };
      // What was typed is the answer on record (the pre-check reads it); the
      // model's own few-word summary ("Brief honest note on closest related
      // work…") is not an answer and got Workiva held back, 2026-11-11.
      const typedText = [...(plan.steps || [])].reverse().find((st) => st.op === "type" && String(st.text || "").trim())?.text;
      answer = typedText || plan.answer || answer;
      if (!plan.steps?.length) return { ok: snap.filled, filled: snap.filled, answer, why: snap.filled ? "" : "no steps", required };
      const done = await dom("act", plan.steps);
      history.push({ round, steps: plan.steps, log: done?.log || [], done: !!plan.done });
      console.log("[JobWatch/Rescue]", question, "round", round, plan.steps, done?.log);
      await sleep(700);
    }
    const last = await dom("snapshot", question);
    // A field with a board error counts as done once the AI's last plan said so.
    const fixed = error ? !!last?.filled && !!history[history.length - 1]?.done : !!last?.filled;
    return { ok: fixed, filled: !!last?.filled, answer, why: fixed ? "" : error ? `the form still says: ${error}` : "still empty after three rounds", required, steps: fixed ? history.flatMap((h) => h.steps || []) : [] };
  }

  window.__jwRescue = async function rescue(question, opts = {}) {
    return rescueOnce(question, opts);
  };

  // The check of the whole form before Submit (functions/lib/apply/review.cjs):
  // every question with its answer goes to Claude once; each answer it calls
  // wrong goes to the rescue above with the problem as the field's error.
  //   await __jwReview(meta, say) -> { ok, issues, fixed: [issue], left: [issue] }
  window.__jwReview = async function review(meta = {}, say = () => {}) {
    let items = [];
    try { items = window.__jwRescueDom?.formAnswers() || []; } catch (e) { console.warn("[JobWatch/Review] read failed:", e.message); }
    if (!items.length) return { ok: true, issues: [], fixed: [], left: [] };
    const r = await send({ type: "REVIEW_FORM", items, jobTitle: meta.jobTitle || "", companyName: meta.companyName || "" });
    if (!r?.ok) return { ok: false, error: r?.error || "review failed", issues: [], fixed: [], left: [] };
    const req = new Map(items.map((x) => [x.question, x.required]));
    const issues = (Array.isArray(r.issues) ? r.issues : []).map((i) => ({ ...i, required: !!req.get(i.question) }));
    const fixed = [];
    const left = [];
    for (const i of issues) {
      say(`fixing before Submit: ${String(i.question).slice(0, 90)}`);
      const res = await window.__jwRescue(i.question, { ...meta, force: true, error: `${i.problem}${i.fix ? ` The right answer: ${i.fix}` : ""}` });
      console.log("[JobWatch/Review]", i, res);
      (res?.ok ? fixed : left).push({ ...i, answer: res?.answer || "", why: res?.why || "" });
    }
    return { ok: true, issues, fixed, left };
  };

  // Nothing typed on a form is saved for reuse: answers come from the Profile only.
  window.__jwLearnManual = function learnManual() {};
})();
