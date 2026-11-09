// rescue.js — the AI rescue for a field the fill could not finish, and the
// answer bank it feeds.
//
// Shared by content/ashby.js, greenhouse.js, lever.js and universal.js (listed
// before them in the manifest, same isolated world):
//   await __jwRescue(question, { jobTitle, companyName })
//     -> { ok, filled, answer?, why? }
// Each round: snapshot the field (lib/rescue-dom.js, MAIN world), send its HTML
// to rescueField (Claude picks the steps from the person's profile), run the
// steps, look again. Three rounds at most; optional fields (no "*") are left
// alone. A finished field's answer is saved (source "ai"); a mandatory one
// nobody could answer is listed on the Profile page as missing.
//   __jwLearnManual(questions, { jobTitle, companyName })
// When the person presses Submit, the answers they typed into the fields that
// needed them are saved (source "you"), so the next form fills them itself.
(function () {
  "use strict";
  if (window.__jwRescue) return;
  const sleep = (ms) => (window.__jwWait ? window.__jwWait(ms) : new Promise((r) => setTimeout(r, ms)));
  const send = (msg) => new Promise((res) => { try { chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false, error: chrome.runtime.lastError?.message || "no answer" })); } catch (e) { res({ ok: false, error: e.message }); } });
  const dom = async (action, ...args) => { const r = await send({ type: "EXEC_RESCUE", action, args }); return r?.ok ? r.result : null; };
  // lib/rescue-dom.js is loaded in this world too: it reads values without a round trip.
  const valueHere = (q) => { try { return window.__jwRescueDom?.valueOf(q) || ""; } catch { return ""; } };
  const learn = (saved, missing) => send({ type: "LEARN_ANSWERS", saved, missing }).then((r) => { if (!r?.ok) console.warn("[JobWatch/Rescue] learn failed:", r?.error); });

  // Steps that finished a question before, per board and question: tried
  // first next time (no AI call); the AI only when they no longer work.
  const MEMO_KEY = "jwRescueMemo";
  const memoId = (q) => `${location.host}|${String(q || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 160)}`;
  async function memoGet(q) { try { return (await chrome.storage.local.get(MEMO_KEY))[MEMO_KEY]?.[memoId(q)] || null; } catch { return null; } }
  async function memoPut(q, entry) {
    try {
      const all = (await chrome.storage.local.get(MEMO_KEY))[MEMO_KEY] || {};
      all[memoId(q)] = { ...entry, at: Date.now() };
      const keys = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
      for (const k of keys.slice(400)) delete all[k];
      await chrome.storage.local.set({ [MEMO_KEY]: all });
    } catch { /* memory is a nicety */ }
  }
  async function memoDrop(q) {
    try { const all = (await chrome.storage.local.get(MEMO_KEY))[MEMO_KEY] || {}; delete all[memoId(q)]; await chrome.storage.local.set({ [MEMO_KEY]: all }); } catch { /* nicety */ }
  }

  async function rescueOnce(question, opts = {}) {
    const { force = false } = opts;
    // A remembered fix first: same board, same question, same steps.
    const memo = await memoGet(question);
    if (memo?.steps?.length) {
      const snap = await dom("snapshot", question);
      if (snap?.ok && (snap.required || force) && !snap.filled) {
        const done = await dom("act", memo.steps);
        await sleep(500);
        const after = await dom("snapshot", question);
        if (after?.filled) { console.log("[JobWatch/Rescue]", question, "remembered steps", memo.steps, done?.log); return { ok: true, filled: true, answer: memo.answer || "", required: !!snap.required, remembered: true }; }
        await memoDrop(question); // the page changed: ask the AI
      }
    }
    const r = await rescueAi(question, opts);
    // Remember only fixes that carry over: picks and clicks, or a short typed
    // value; never written prose or a question naming this company.
    const company = String(opts.companyName || "").trim().toLowerCase();
    const reusable = r.ok && r.steps?.length && r.steps.every((st) => st.op !== "type" || String(st.text || "").length <= 40)
      && !(company && String(question).toLowerCase().includes(company));
    if (reusable) memoPut(question, { steps: r.steps, answer: r.answer || "" });
    return r;
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
      answer = plan.answer || answer;
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
    const r = await rescueOnce(question, opts);
    const meta = { companyName: opts.companyName || "", jobTitle: opts.jobTitle || "" };
    if (r.ok) {
      const value = valueHere(question) || r.answer || "";
      if (value) learn([{ question, answer: value, source: "ai", ...meta }], []);
    } else if (r.missing || (r.required && r.why && r.why !== "optional (no *)")) {
      learn([], [{ question, why: r.why, ...meta }]);
    }
    return r;
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

  window.__jwLearnManual = function learnManual(questions, meta = {}) {
    const list = [...new Set((questions || []).filter(Boolean))].slice(0, 30);
    if (!list.length) return;
    let sent = false;
    const capture = () => {
      if (sent) return;
      const saved = list.map((q) => ({ question: q, answer: valueHere(q), source: "you", companyName: meta.companyName || "", jobTitle: meta.jobTitle || "" })).filter((x) => x.answer);
      if (!saved.length) return;
      sent = true;
      learn(saved, []);
    };
    document.addEventListener("click", (e) => {
      const b = e.target?.closest?.("button, input[type=submit], [role=button]");
      if (b && /submit|apply|send application|save and continue|^\s*(next|continue)\b/i.test(`${b.textContent || ""} ${b.value || ""} ${b.getAttribute("aria-label") || ""}`)) capture();
    }, true);
    document.addEventListener("submit", capture, true);
  };
})();
