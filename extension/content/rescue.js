// rescue.js — the AI rescue for a field the fill could not finish.
//
// Shared by content/ashby.js, greenhouse.js, lever.js and universal.js (listed
// before them in the manifest, same isolated world):
//   await __jwRescue(question, { jobTitle, companyName })
//     -> { ok, filled, answer?, why? }
// Each round: snapshot the field (lib/rescue-dom.js, MAIN world), send its HTML
// to rescueField (Claude picks the steps from the person's profile), run the
// steps, look again. Three rounds at most; optional fields (no "*") are left
// alone.
(function () {
  "use strict";
  if (window.__jwRescue) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (msg) => new Promise((res) => { try { chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false, error: chrome.runtime.lastError?.message || "no answer" })); } catch (e) { res({ ok: false, error: e.message }); } });
  const dom = async (action, ...args) => { const r = await send({ type: "EXEC_RESCUE", action, args }); return r?.ok ? r.result : null; };

  window.__jwRescue = async function rescue(question, { jobTitle = "", companyName = "", force = false } = {}) {
    const history = [];
    let answer = "";
    for (let round = 1; round <= 3; round++) {
      const snap = await dom("snapshot", question);
      if (!snap?.ok) return { ok: false, filled: false, why: snap?.error || "field not found" };
      if (!snap.required && !force) return { ok: false, filled: snap.filled, why: "optional (no *)" };
      if (round > 1 && snap.filled && history[history.length - 1]?.done) return { ok: true, filled: true, answer };
      const r = await send({ type: "RESCUE_FIELD", question, html: snap.html, required: snap.required, round, history, jobTitle, companyName });
      if (!r?.ok) return { ok: false, filled: snap.filled, why: r?.error || "rescue failed" };
      const plan = r.plan || {};
      if (plan.cannot) return { ok: false, filled: snap.filled, why: plan.cannot };
      answer = plan.answer || answer;
      if (!plan.steps?.length) return { ok: snap.filled, filled: snap.filled, answer, why: snap.filled ? "" : "no steps" };
      const done = await dom("act", plan.steps);
      history.push({ round, steps: plan.steps, log: done?.log || [], done: !!plan.done });
      console.log("[JobWatch/Rescue]", question, "round", round, plan.steps, done?.log);
      await sleep(700);
    }
    const last = await dom("snapshot", question);
    return { ok: !!last?.filled, filled: !!last?.filled, answer, why: last?.filled ? "" : "still empty after three rounds" };
  };
})();
