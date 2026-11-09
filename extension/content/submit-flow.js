// submit-flow.js — one Submit flow for Ashby, Greenhouse and Lever.
//
//   await __jwSubmit(board) -> { status: "submitted" | "needs_attention", note }
//
// Press Submit -> watch the page -> submitted? record it. Otherwise read what
// the form says is wrong, put back what the board dropped (board.refill), hand
// every flagged or empty field to the AI with the form's own words
// (__jwRescue, content/rescue.js) and press Submit again. Four presses at
// most, plus one plain extra press when nothing needed fixing (boards
// sometimes take the same form on a second press). It never submits in a
// test run (jwNoSubmit) or without the resume, and stops at a CAPTCHA (never
// solved) or a spam-check refusal.
//
// The board object (content/ashby.js, greenhouse.js, lever.js):
//   name                 "Ashby"
//   prefix               "Auto-apply" | "JobWatch" (the card's first words)
//   say(text, items?)    show the JobWatch card
//   button()             the board's own Submit button, or null
//   submitted()          -> bool: the board confirmed the application
//   errors()             -> [{ label, text, path?, form? }] (form: the whole form's message)
//   empty()              -> [label] required fields still empty
//   resumeMissing()      -> label | null
//   ledger(event, extra) the application record
//   answersLog, meta { jobTitle, companyName }, needs [labels]
// optional:
//   refill()             -> n fields put back from the computed answers
//   sending()            -> bool: the application is still on its way
//   beforeClick()        e.g. mark every field touched
//   afterWatch(round)    trace what the page showed
//   reasons()            extra lines for the record
//   isFile(label)        a file box (never the AI's)
//   code                 { needed(), fetch(since), enter(code) } emailed security code
//   quietMs              no answer for this long (and not sending): look again (default 30 s)
//   noReview             skip the AI check of the whole form before the first press
(function () {
  "use strict";
  if (window.__jwSubmit) return;
  const sleep = (ms) => (window.__jwWait ? window.__jwWait(ms) : new Promise((r) => setTimeout(r, ms)));
  const send = (msg) => new Promise((res) => { try { chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false, error: chrome.runtime.lastError?.message || "no answer" })); } catch (e) { res({ ok: false, error: e.message }); } });
  const safe = async (fn, fallback) => { try { const v = await fn(); return v ?? fallback; } catch { return fallback; } };
  const PRESSES = 4;
  const MAX_WAIT = 90 * 1000;
  const SPAM = /spam|flagged|\bbot\b|suspicious|unusual activity/i;
  const FILE = /^(resume|cv|resume\/cv|cover letter)\b|\battach|upload/i;

  // A challenge counts only when a person could see it (reCAPTCHA keeps a hidden frame on the page).
  function onScreen(el) {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 100 && r.height > 100 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }
  const captchaVisible = () => [...document.querySelectorAll("iframe[src*='recaptcha'][src*='bframe'], iframe[src*='hcaptcha'][src*='challenge'], iframe[title*='challenge' i]")].some(onScreen);

  window.__jwSubmit = async function submitFlow(b) {
    const say = (t, items) => b.say(`${b.prefix || "JobWatch"}: ${t}`, items);
    const log = (...a) => console.log(`[JobWatch/${b.name}] submit:`, ...a);
    const answersLog = b.answersLog || {};
    const meta = b.meta || {};
    const isFile = (l) => (b.isFile && b.isFile(l)) || FILE.test(String(l || ""));
    // Handed to the person: keep watching, and when the board confirms (they
    // pressed Submit), record it, so the card and the "needs you" count do not
    // stay wrong next to a "Success" page. 30 minutes at most.
    let watching = false;
    const watchForHand = () => {
      if (watching) return;
      watching = true;
      const t0 = Date.now();
      const tick = async () => {
        if (Date.now() - t0 > 30 * 60 * 1000) return;
        const codeOpen = b.code ? await safe(() => b.code.needed(), false) : false;
        if (!codeOpen && await safe(() => b.submitted(), false)) { log("submitted by hand"); await recordDone(); return; }
        setTimeout(tick, 3000);
      };
      setTimeout(tick, 3000);
    };
    const recordDone = async () => { await b.ledger("submitted", { answersLog }); say("submitted and recorded."); return { status: "submitted", note: "" }; };

    if ((await safe(() => chrome.storage.local.get("jwNoSubmit"), {})).jwNoSubmit) return { status: "needs_attention", note: "test run: not submitted" };
    // Never without the resume: put it back once, then stop.
    let noResume = await safe(() => b.resumeMissing(), null);
    if (noResume && b.refill) { await safe(() => b.refill(), 0); noResume = await safe(() => b.resumeMissing(), null); }
    if (noResume) { say("the resume would not attach. Attach it and press Submit.", [noResume]); return { status: "needs_attention", note: "resume would not attach" }; }
    // A required field went empty since the fill: put it back before the first press.
    if (b.refill && (await safe(() => b.empty(), [])).length) await safe(() => b.refill(), 0);

    // One look at the whole form before the first press: answers that are
    // wrong next to the rest (a code in a question box, an empty signing date,
    // "details" after a No) are fixed by the AI first. One still wrong stops
    // here for the person rather than going in wrong.
    if (window.__jwReview && !b.noReview) {
      say("checking every answer before Submit…");
      const rv = await safe(() => window.__jwReview(meta, (t) => say(t)), null);
      log("review:", rv);
      for (const f of rv?.fixed || []) answersLog[`review:${f.question}`] = { label: f.question, answer: f.answer || f.fix || "(fixed by review)", type: "ai-review", source: "ai" };
      // Only a required question still wrong holds the application back; an
      // optional one the AI could not fix goes in as it is (Clipboard,
      // 2026-11-09: an empty optional "If you selected Other…" stopped a good form).
      const wrong = (rv?.left || []).filter((i) => i.severity === "wrong" && i.required);
      if (wrong.length) {
        const needsAttention = wrong.map((i) => ({ label: i.question.slice(0, 200), path: "", note: `review before Submit: ${i.problem}${i.fix ? ` (should be: ${i.fix})` : ""}` }));
        b.ledger("filled", { answersLog, needsAttention, reasons: await safe(() => b.reasons?.(), []) }).catch?.(() => {});
        if (window.__jwLearnManual) window.__jwLearnManual(wrong.map((i) => i.question), meta);
        say("these answers look wrong and could not be fixed. Check them, then press Submit:", wrong.map((i) => `${i.question.slice(0, 80)}: ${i.problem}`));
        watchForHand();
        return { status: "needs_attention", note: `review: ${wrong.map((i) => `${i.question.slice(0, 50)}: ${i.problem}`).slice(0, 3).join("; ")}` };
      }
    }

    let codeTries = 0;
    let extraPress = false;
    let last = { errs: [], formSaid: "" };
    const press = async (btn) => { btn.scrollIntoView({ block: "center" }); await safe(() => b.beforeClick?.(), null); btn.click(); };

    /** Watch after a press: { done } | { stop, note } | { errs } */
    async function watch() {
      let t0 = Date.now();
      let clickedAt = Date.now();
      while (Date.now() - t0 < MAX_WAIT) {
        await sleep(2000);
        const codeOpen = b.code ? await safe(() => b.code.needed(), false) : false;
        if (!codeOpen && await safe(() => b.submitted(), false)) return { done: true };
        if (captchaVisible()) return { stop: true, note: "CAPTCHA challenge", say: `${b.name} is showing a CAPTCHA. Solve it and press Submit.` };
        if (codeOpen) {
          if (codeTries >= 2) return { stop: true, note: "security code not accepted", say: "the security code was not accepted. Enter it from your email and press Submit." };
          codeTries++;
          say(`${b.name} emailed a security code. Reading it from Gmail…`);
          const r = await safe(() => b.code.fetch(clickedAt), { ok: false, error: "no answer" });
          if (!r?.ok || !r.code) return { stop: true, note: `security code: ${r?.error || "no email"}`, say: `could not get the security code (${r?.error || "no email yet"}). Enter it from your email and press Submit.` };
          const put = await safe(() => b.code.enter(r.code), { ok: false });
          if (!put?.ok) return { stop: true, note: `security code: ${put?.error || "could not enter it"}`, say: "could not type the security code. Enter it and press Submit." };
          say("security code entered, submitting…");
          await sleep(800);
          const again = b.button();
          if (again) { clickedAt = Date.now(); await press(again); }
          t0 = Date.now();
          continue;
        }
        const waited = Date.now() - t0;
        if (waited < 6000) continue;
        const errs = await safe(() => b.errors(), []);
        const formSaid = errs.filter((e) => e.form).map((e) => e.text).filter(Boolean).join("; ");
        if (SPAM.test(formSaid)) return { stop: true, note: `${b.name} spam check: ${formSaid}`, say: `${b.name}'s spam check turned this one away: "${formSaid}". Press Submit yourself.`, errs };
        if (errs.some((e) => !e.form)) return { errs };
        // No answer yet: keep waiting only while the application is on its way.
        if (waited >= (b.quietMs || 30000) && !(b.sending && await safe(() => b.sending(), false))) return { errs };
      }
      return { errs: await safe(() => b.errors(), []) };
    }

    for (let round = 0; round < PRESSES; round++) {
      const btn = b.button();
      if (!btn) {
        if (await safe(() => b.submitted(), false)) return recordDone();
        say("could not find the Submit button. Scroll down and press it.");
        return { status: "needs_attention", note: `could not find ${b.name}'s Submit button` };
      }
      say(round ? `submitting again (try ${round + 1} of ${PRESSES})…` : "submitting…");
      btn.scrollIntoView({ block: "center" });
      // A person reads the form over before Submit; a shorter look on a retry.
      await sleep(round ? 1500 + Math.random() * 1500 : 3000 + Math.random() * 5000);
      await send({ type: "AUTO_SUBMITTING" }); // the runner watches for the thank-you page
      await press(btn);
      const w = await watch();
      if (w.done || await safe(() => b.submitted(), false)) return recordDone();
      await safe(() => b.afterWatch?.(round), null);
      const errs = w.errs || [];
      last = { errs, formSaid: errs.filter((e) => e.form).map((e) => e.text).filter(Boolean).join("; ") };
      log(`press ${round + 1}:`, errs);
      if (w.stop) return finish(w.note, w.say);
      if (round === PRESSES - 1) break;

      // Repair: what the board dropped first, then the AI on every flagged or empty field.
      let fixed = b.refill ? await safe(() => b.refill(), 0) : 0;
      const targets = new Map(); // label -> the form's words
      for (const e of errs) if (!e.form && e.label && !targets.has(e.label)) targets.set(e.label, e.text || "");
      for (const l of await safe(() => b.empty(), [])) if (l && !targets.has(l)) targets.set(l, "");
      for (const l of [...targets.keys()]) if (isFile(l)) targets.delete(l);
      if (window.__jwRescue) {
        for (const [label, text] of [...targets].slice(0, 10)) {
          say(`asking AI to fix: ${label}`);
          const r = await safe(() => window.__jwRescue(label, { ...meta, error: text || "This field is required.", force: true }), null);
          log("repair:", label, text, r);
          if (r?.ok) { fixed++; answersLog[`rescue:${label}`] = { label, answer: r.answer || "(AI rescue)", type: "ai-rescue", source: "ai" }; }
        }
      }
      if (fixed) { say(`fixed ${fixed} field${fixed === 1 ? "" : "s"}, submitting again…`); continue; }
      // Nothing to fix: one plain extra press (Applied Intuition took the same form on the second).
      if (!extraPress && !targets.size) { extraPress = true; say(`${b.name} did not confirm; trying Submit once more…`); continue; }
      break;
    }
    return finish();

    async function finish(note = "", text = "") {
      const fields = last.errs.filter((e) => !e.form);
      const left = [...new Set([...fields.map((e) => e.label || e.path), ...await safe(() => b.empty(), [])])].filter(Boolean);
      const list = left.length ? left : (b.needs || []);
      const needsAttention = [
        ...list.map((l) => ({ label: l, path: fields.find((e) => (e.label || e.path) === l)?.path || "", note: `after Submit: ${fields.find((e) => (e.label || e.path) === l)?.text || "the form still marks it"}` })),
        ...(last.formSaid ? [{ label: "form", path: "", note: `after Submit: ${last.formSaid}` }] : []),
      ];
      b.ledger("filled", { answersLog, needsAttention, reasons: await safe(() => b.reasons?.(), []) }).catch?.(() => {});
      if (list.length && window.__jwLearnManual) window.__jwLearnManual(list, meta);
      watchForHand();
      if (text) say(text);
      else if (list.length) say(`${b.name} did not accept it. These need you, then press Submit:`, list);
      else say(`${b.name} did not accept the submission${last.formSaid ? `: ${last.formSaid}` : ""}. Check the form and press Submit.`);
      return {
        status: "needs_attention",
        note: note || (list.length ? `${b.name} flagged: ${list.slice(0, 4).join("; ")}` : `${b.name} did not accept the submission${last.formSaid ? `: ${last.formSaid}` : " (no message shown)"}`),
      };
    }
  };
})();
