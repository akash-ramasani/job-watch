// notify.js — the JobWatch card in the bottom-right corner of an application.
//
// One card, styled like the JobWatch app and popup (white, indigo accents,
// rounded), inside a shadow root so the board's CSS never touches it. It
// starts as the Autofill launcher; nothing fills until the person presses it.
// After that it shows progress, what still needs the person, errors, and the
// optional Submit button (which the person presses too).
//
// Shared by content/ashby.js, greenhouse.js, lever.js and universal.js (listed
// before them in the manifest, same isolated world):
//   __jwNotify.launcher({ text, label, onClick })   the Autofill button
//   __jwNotify.show(text, type?, { action?, items?, sticky? })
//        type: working | info | success | warning | error (guessed from the text)
//        action: { label, onClick(button) }   items: ["Field label", ...]
//   __jwNotify.hide()
(function () {
  "use strict";
  if (window.__jwNotify) return;

  const CSS = `
    :host { all: initial; }
    .card {
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; width: 340px; max-width: calc(100vw - 40px);
      box-sizing: border-box; font-family: 'Plus Jakarta Sans', 'Inter', system-ui, -apple-system, sans-serif;
      background: #fff; color: #111827; border: 1px solid #e5e7eb; border-radius: 16px; overflow: hidden;
      box-shadow: 0 18px 48px rgba(17, 24, 39, 0.16), 0 2px 6px rgba(17, 24, 39, 0.06);
      transform: translateY(14px); opacity: 0;
      transition: transform .32s cubic-bezier(.34,1.56,.64,1), opacity .22s ease;
    }
    .card.on { transform: translateY(0); opacity: 1; }
    .card * { box-sizing: border-box; }
    .bar { height: 3px; background: linear-gradient(90deg, #4f46e5, #7c3aed); }
    .card.working .bar { background: linear-gradient(90deg, #e0e7ff 0%, #4f46e5 40%, #7c3aed 60%, #e0e7ff 100%); background-size: 200% 100%; animation: slide 1.2s linear infinite; }
    .card.success .bar { background: linear-gradient(90deg, #10b981, #34d399); }
    .card.warning .bar { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
    .card.error .bar { background: linear-gradient(90deg, #ef4444, #f87171); }
    @keyframes slide { from { background-position: 200% 0; } to { background-position: 0 0; } }
    .head { display: flex; align-items: center; gap: 10px; padding: 12px 14px 0; }
    .logo { width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
      background: linear-gradient(135deg, #4f46e5, #7c3aed); color: #fff; font: 800 14px/1 system-ui; box-shadow: 0 3px 10px rgba(79,70,229,.3); }
    .title { flex: 1; font-size: 13px; font-weight: 700; letter-spacing: .01em; }
    .pill { font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 999px; background: #eef2ff; color: #4338ca; border: 1px solid #c7d2fe; white-space: nowrap; }
    .card.success .pill { background: #ecfdf5; color: #065f46; border-color: #a7f3d0; }
    .card.warning .pill { background: #fffbeb; color: #92400e; border-color: #fde68a; }
    .card.error .pill { background: #fef2f2; color: #b91c1c; border-color: #fecaca; }
    .x { border: 0; background: transparent; color: #9ca3af; cursor: pointer; font-size: 18px; line-height: 1; padding: 2px 4px; border-radius: 6px; }
    .x:hover { color: #374151; background: #f3f4f6; }
    .body { padding: 8px 14px 14px; }
    .msg { font-size: 12.5px; line-height: 1.55; color: #374151; margin: 0; word-break: break-word; }
    .items { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; max-height: 150px; overflow: auto; }
    .items li { font-size: 11.5px; line-height: 1.4; color: #92400e; background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 5px 8px; }
    .card.error .items li { color: #b91c1c; background: #fef2f2; border-color: #fecaca; }
    .btn { margin-top: 12px; width: 100%; border: 0; border-radius: 10px; padding: 10px 14px; cursor: pointer;
      font: 700 12.5px/1 'Plus Jakarta Sans', system-ui, sans-serif; letter-spacing: .02em; color: #fff;
      background: linear-gradient(135deg, #4f46e5, #7c3aed); box-shadow: 0 4px 14px rgba(79,70,229,.3);
      transition: transform .1s, box-shadow .2s, opacity .2s; display: flex; align-items: center; justify-content: center; gap: 8px; }
    .btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(79,70,229,.38); }
    .btn:disabled { opacity: .55; cursor: default; }
    .btn.green { background: linear-gradient(135deg, #10b981, #059669); box-shadow: 0 4px 14px rgba(16,185,129,.3); }
  `;
  const PILL = { working: "Working", info: "JobWatch", success: "Done", warning: "Needs you", error: "Error", idle: "Ready" };

  let host = null, root = null, card = null, hideTimer = null;
  function ensure() {
    if (card && host?.isConnected) return;
    host = document.createElement("div");
    host.id = "jw-notify";
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${CSS}</style><div class="card"><div class="bar"></div>
      <div class="head"><div class="logo">J</div><div class="title">JobWatch</div><span class="pill"></span><button class="x" title="Close" aria-label="Close">×</button></div>
      <div class="body"><p class="msg"></p></div></div>`;
    card = root.querySelector(".card");
    root.querySelector(".x").addEventListener("click", hide);
    (document.body || document.documentElement).appendChild(host);
    requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add("on")));
  }

  /** Drop the emoji and "JobWatch:" prefixes the scripts' messages carry. */
  function tidy(text) {
    return String(text || "")
      .replace(/^(\p{Extended_Pictographic}|\p{Emoji_Presentation}|️|\s)+/u, "")
      .replace(/^JobWatch:?\s*/i, "")
      .replace(/^./, (c) => c.toUpperCase());
  }
  function guess(text) {
    const t = String(text || "");
    if (/^❌|failed|could not|couldn't|error/i.test(t)) return "error";
    if (/^(⚠️|🛑)|complete manually|needs you|already applied|did not accept|sign in/i.test(t)) return "warning";
    if (/^✅|filled all|recorded|review, then|submitted/i.test(t)) return "success";
    if (/^(⏳|🤖|✍️|🔍|🔄)|…$|\.\.\.$|is (reading|working|filling|checking|adding)|computing|reading|fetching|filling \d|checking/i.test(t)) return "working";
    return "info";
  }

  function render(text, type, { action = null, items = null, label = null } = {}) {
    ensure();
    clearTimeout(hideTimer);
    card.className = `card on ${type}`;
    root.querySelector(".pill").textContent = label || PILL[type] || "JobWatch";
    const body = root.querySelector(".body");
    body.innerHTML = `<p class="msg"></p>`;
    body.querySelector(".msg").textContent = tidy(text);
    if (items?.length) {
      const ul = document.createElement("ul");
      ul.className = "items";
      for (const it of items.slice(0, 12)) { const li = document.createElement("li"); li.textContent = it; ul.appendChild(li); }
      if (items.length > 12) { const li = document.createElement("li"); li.textContent = `+${items.length - 12} more`; ul.appendChild(li); }
      body.appendChild(ul);
    }
    if (action) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `btn${/submit/i.test(action.label) ? " green" : ""}`;
      b.textContent = action.label;
      b.addEventListener("click", () => { b.disabled = true; action.onClick(b); });
      body.appendChild(b);
    }
  }

  function show(text, type, opts = {}) {
    let t = !type || type === "info" ? guess(text) : type;
    if (opts.items?.length && (t === "info" || t === "success")) t = "warning"; // fields left for the person
    render(text, t, opts);
    if (opts.autoHideMs) hideTimer = setTimeout(hide, opts.autoHideMs);
  }
  function launcher({ text = "Fill this application from your JobWatch profile. You review and submit.", label = "Autofill", onClick }) {
    // Already showing this launcher: leave it (no flicker on repeated calls).
    if (card?.isConnected && card.classList.contains("idle") && root.querySelector(".btn")?.textContent === label && root.querySelector(".msg")?.textContent === tidy(text)) return;
    render(text, "idle", { action: { label, onClick } });
  }
  function hide() {
    if (!card) return;
    card.classList.remove("on");
    const h = host;
    setTimeout(() => h?.remove(), 300);
    card = null; host = null; root = null;
  }

  window.__jwNotify = { show, launcher, hide };
})();
