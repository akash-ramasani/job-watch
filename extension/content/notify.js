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

  // The web app's tokens: white rounded-2xl card, ring-1 ring-gray-200,
  // indigo-600 actions, green-600 success, red-600 errors, Heroicons,
  // Plus Jakarta Sans (where the page has it; system font otherwise).
  const CSS = `
    :host { all: initial; }
    .card {
      position: fixed; right: 24px; bottom: 24px; z-index: 2147483647; width: 352px; max-width: calc(100vw - 48px);
      box-sizing: border-box; font-family: 'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      -webkit-font-smoothing: antialiased; background: #fff; color: #111827; border-radius: 16px; line-height: 1.4; text-align: left; letter-spacing: normal;
      box-shadow: 0 0 0 1px #e5e7eb, 0 10px 15px -3px rgba(0,0,0,.1), 0 4px 6px -4px rgba(0,0,0,.1);
      transform: translateY(20px); opacity: 0; transition: transform .3s cubic-bezier(.22,1,.36,1), opacity .2s ease;
    }
    .card.on { transform: translateY(0); opacity: 1; }
    .card * { box-sizing: border-box; }
    .head { display: flex; align-items: center; gap: 10px; padding: 14px 16px 0; }
    .logo { width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
      background: #4f46e5; color: #fff; font-family: inherit; font-size: 14px; font-weight: 800; line-height: 1; }
    .title { flex: 1; font-size: 14px; font-weight: 700; color: #111827; }
    .pill { display: inline-flex; align-items: center; font-size: 11px; line-height: 16px; font-weight: 600; padding: 2px 8px; border-radius: 6px;
      background: #eef2ff; color: #4338ca; box-shadow: inset 0 0 0 1px rgba(79,70,229,.2); white-space: nowrap; }
    .card.success .pill { background: #f0fdf4; color: #15803d; box-shadow: inset 0 0 0 1px rgba(22,163,74,.2); }
    .card.warning .pill { background: #fffbeb; color: #b45309; box-shadow: inset 0 0 0 1px rgba(217,119,6,.2); }
    .card.error .pill { background: #fef2f2; color: #b91c1c; box-shadow: inset 0 0 0 1px rgba(220,38,38,.2); }
    .x { border: 0; background: transparent; color: #9ca3af; cursor: pointer; padding: 4px; border-radius: 6px; display: flex; }
    .x:hover { color: #4b5563; background: #f3f4f6; }
    .x svg { width: 16px; height: 16px; }
    .body { padding: 10px 16px 16px; }
    .row { display: flex; gap: 10px; align-items: flex-start; }
    .ico { width: 20px; height: 20px; flex-shrink: 0; margin-top: 1px; color: #4f46e5; }
    .card.success .ico { color: #16a34a; } .card.warning .ico { color: #d97706; } .card.error .ico { color: #dc2626; }
    .spin { animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .msg { flex: 1; font-size: 13px; line-height: 1.55; color: #374151; margin: 0; word-break: break-word; }
    .items { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; max-height: 168px; overflow: auto; }
    .items li { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; line-height: 1.45; color: #374151;
      background: #fffbeb; border-radius: 8px; padding: 6px 10px; box-shadow: inset 0 0 0 1px rgba(217,119,6,.2); }
    .items li::before { content: ""; width: 6px; height: 6px; border-radius: 999px; background: #f59e0b; flex-shrink: 0; margin-top: 6px; }
    .card.error .items li { background: #fef2f2; box-shadow: inset 0 0 0 1px rgba(220,38,38,.2); }
    .card.error .items li::before { background: #ef4444; }
    .btn { margin-top: 14px; width: 100%; border: 0; border-radius: 8px; padding: 9px 14px; cursor: pointer;
      font-family: inherit; font-size: 13px; font-weight: 600; line-height: 1.25; color: #fff; background: #4f46e5;
      box-shadow: 0 1px 2px rgba(0,0,0,.05); transition: background-color .15s, opacity .15s;
      display: flex; align-items: center; justify-content: center; gap: 8px; }
    .btn:hover:not(:disabled) { background: #6366f1; }
    .btn:focus-visible { outline: 2px solid #4f46e5; outline-offset: 2px; }
    .btn:disabled { opacity: .5; cursor: default; }
    .btn.green { background: #16a34a; } .btn.green:hover:not(:disabled) { background: #22c55e; }
    .btn svg { width: 16px; height: 16px; }
    .progress { height: 3px; margin: 14px -16px -16px; overflow: hidden; border-radius: 0 0 16px 16px; background: #eef2ff; display: none; }
    .card.working .progress { display: block; }
    .progress::after { content: ""; display: block; height: 100%; width: 40%; background: #4f46e5; border-radius: 3px; animation: prog 1.1s ease-in-out infinite; }
    @keyframes prog { from { transform: translateX(-100%); } to { transform: translateX(260%); } }
  `;
  // Heroicons (20 solid / 24 outline paths).
  const ICON = {
    idle: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M15.98 1.804a1 1 0 0 0-1.96 0l-.24 1.192a1 1 0 0 1-.784.785l-1.192.238a1 1 0 0 0 0 1.962l1.192.238a1 1 0 0 1 .785.785l.238 1.192a1 1 0 0 0 1.962 0l.238-1.192a1 1 0 0 1 .785-.785l1.192-.238a1 1 0 0 0 0-1.962l-1.192-.238a1 1 0 0 1-.785-.785l-.238-1.192ZM6.949 5.684a1 1 0 0 0-1.898 0l-.683 2.051a1 1 0 0 1-.633.633l-2.051.683a1 1 0 0 0 0 1.898l2.051.684a1 1 0 0 1 .633.632l.683 2.051a1 1 0 0 0 1.898 0l.683-2.051a1 1 0 0 1 .633-.633l2.051-.683a1 1 0 0 0 0-1.898l-2.051-.683a1 1 0 0 1-.633-.633L6.95 5.684Z"/></svg>',
    working: '<svg class="spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity=".2" stroke-width="3"/><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
    info: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-7-4a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM9 9a.75.75 0 0 0 0 1.5h.253a.25.25 0 0 1 .244.304l-.459 2.066A1.75 1.75 0 0 0 10.747 15H11a.75.75 0 0 0 0-1.5h-.253a.25.25 0 0 1-.244-.304l.459-2.066A1.75 1.75 0 0 0 9.253 9H9Z" clip-rule="evenodd"/></svg>',
    success: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z" clip-rule="evenodd"/></svg>',
    warning: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 5Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clip-rule="evenodd"/></svg>',
    error: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 10 5Zm0 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clip-rule="evenodd"/></svg>',
  };
  const X_ICON = '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z"/></svg>';
  const SEND_ICON = '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M3.105 2.288a.75.75 0 0 0-.826.95l1.414 4.926A1.5 1.5 0 0 0 5.135 9.25h6.115a.75.75 0 0 1 0 1.5H5.135a1.5 1.5 0 0 0-1.442 1.086l-1.414 4.926a.75.75 0 0 0 .826.95 28.897 28.897 0 0 0 15.293-7.155.75.75 0 0 0 0-1.114A28.897 28.897 0 0 0 3.105 2.288Z"/></svg>';
  const PILL = { working: "Working", info: "JobWatch", success: "Done", warning: "Needs you", error: "Error", idle: "Ready" };

  let host = null, root = null, card = null, hideTimer = null;
  function ensure() {
    if (card && host?.isConnected) return;
    host = document.createElement("div");
    host.id = "jw-notify";
    // A board's own rules reach the host element (Ashby sets line-height: 0
    // on it, which collapsed the pill) and win over :host; an inline
    // !important reset does not lose to them.
    host.setAttribute("style", "all: initial !important;");
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${CSS}</style><div class="card">
      <div class="head"><div class="logo">J</div><div class="title">JobWatch</div><span class="pill"></span><button class="x" title="Close" aria-label="Close">${X_ICON}</button></div>
      <div class="body"></div></div>`;
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
    body.innerHTML = `<div class="row"><span class="ico">${ICON[type] || ICON.info}</span><p class="msg"></p></div>`;
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
      b.innerHTML = /submit/i.test(action.label) ? SEND_ICON : /autofill/i.test(action.label) ? ICON.idle : "";
      b.append(action.label);
      b.addEventListener("click", () => { b.disabled = true; action.onClick(b); });
      body.appendChild(b);
    }
    const bar = document.createElement("div");
    bar.className = "progress";
    body.appendChild(bar);
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
