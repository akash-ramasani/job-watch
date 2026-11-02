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

  async function rescueOnce(question, { jobTitle = "", companyName = "", force = false } = {}) {
    const history = [];
    let answer = "";
    let required = false;
    for (let round = 1; round <= 3; round++) {
      const snap = await dom("snapshot", question);
      if (!snap?.ok) return { ok: false, filled: false, why: snap?.error || "field not found" };
      required = snap.required;
      if (!snap.required && !force) return { ok: false, filled: snap.filled, why: "optional (no *)" };
      if (round > 1 && snap.filled && history[history.length - 1]?.done) return { ok: true, filled: true, answer, required };
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
    return { ok: !!last?.filled, filled: !!last?.filled, answer, why: last?.filled ? "" : "still empty after three rounds", required };
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
