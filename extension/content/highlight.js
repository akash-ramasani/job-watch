// highlight.js — the moving outline that follows JobWatch down a form.
//
// One floating frame, drawn around the whole question (label, help text and
// control) that is being filled right now. It glides from question to
// question top to bottom, pulses while the answer is going in, turns green
// when the answer took and amber when the field is left for the person, then
// fades out when the pass is done. Pointer events pass through it, so it never
// gets in the way of the form.
//
// Shared by content/ashby.js, content/greenhouse.js and content/lever.js
// (listed before them in the manifest, same isolated world):
//   __jwHL.focus(el, "Filling: Email")   move the frame to el
//   __jwHL.mark(true | false, text?)     colour the current frame
//   __jwHL.hide()                        fade out
(function () {
  "use strict";
  if (window.__jwHL) return;

  const PAD = 8;
  const STYLE_ID = "jw-hl-style";
  const CSS_TEXT = `
    #jw-hl {
      position: absolute; top: 0; left: 0; z-index: 2147483646; pointer-events: none;
      box-sizing: border-box; border-radius: 12px; opacity: 0;
      border: 2px solid rgba(79, 70, 229, 0.95);
      background: rgba(79, 70, 229, 0.045);
      box-shadow: 0 0 0 4px rgba(79, 70, 229, 0.16), 0 12px 32px rgba(79, 70, 229, 0.18);
      transition: transform 0.45s cubic-bezier(0.22, 1, 0.36, 1), width 0.45s cubic-bezier(0.22, 1, 0.36, 1),
                  height 0.45s cubic-bezier(0.22, 1, 0.36, 1), border-color 0.3s ease, background-color 0.3s ease,
                  box-shadow 0.3s ease, opacity 0.25s ease;
      will-change: transform, width, height;
    }
    #jw-hl.jw-hl-on { opacity: 1; }
    #jw-hl.jw-hl-active { animation: jw-hl-pulse 1.3s ease-in-out infinite; }
    #jw-hl.jw-hl-ok {
      border-color: rgba(5, 150, 105, 0.95); background: rgba(5, 150, 105, 0.05);
      box-shadow: 0 0 0 4px rgba(5, 150, 105, 0.16), 0 12px 32px rgba(5, 150, 105, 0.16);
    }
    #jw-hl.jw-hl-bad {
      border-color: rgba(217, 119, 6, 0.95); background: rgba(217, 119, 6, 0.05);
      box-shadow: 0 0 0 4px rgba(217, 119, 6, 0.16), 0 12px 32px rgba(217, 119, 6, 0.16);
    }
    #jw-hl-tag {
      position: absolute; right: 10px; top: -12px; max-width: 70%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
      padding: 3px 9px; border-radius: 999px; background: #4f46e5; color: #fff;
      font: 700 10px/16px system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: 0.04em; text-transform: uppercase;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18); transition: background-color 0.3s ease;
    }
    #jw-hl.jw-hl-ok #jw-hl-tag { background: #059669; }
    #jw-hl.jw-hl-bad #jw-hl-tag { background: #d97706; }
    @keyframes jw-hl-pulse {
      0%, 100% { box-shadow: 0 0 0 4px rgba(79, 70, 229, 0.16), 0 12px 32px rgba(79, 70, 229, 0.18); }
      50%      { box-shadow: 0 0 0 7px rgba(79, 70, 229, 0.10), 0 12px 32px rgba(79, 70, 229, 0.26); }
    }
    @media (prefers-reduced-motion: reduce) {
      #jw-hl { transition: opacity 0.2s ease; animation: none !important; }
    }
  `;

  let box = null;
  let tag = null;
  let current = null;
  let hideTimer = null;
  let follow = null; // interval that keeps the frame glued through layout shifts
  let observer = null;

  function ensure() {
    if (box && box.isConnected) return true;
    const host = document.body || document.documentElement;
    if (!host) return false;
    if (!document.getElementById(STYLE_ID)) {
      const s = document.createElement("style");
      s.id = STYLE_ID;
      s.textContent = CSS_TEXT;
      (document.head || host).appendChild(s);
    }
    box = document.createElement("div");
    box.id = "jw-hl";
    tag = document.createElement("span");
    tag.id = "jw-hl-tag";
    box.appendChild(tag);
    host.appendChild(box);
    return true;
  }

  /** Document coordinates of the element, so scrolling never moves the frame. */
  function place(el) {
    if (!box || !el || !el.isConnected) return;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    const left = r.left + window.scrollX - PAD;
    const top = r.top + window.scrollY - PAD;
    box.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    box.style.width = `${Math.round(r.width + PAD * 2)}px`;
    box.style.height = `${Math.round(r.height + PAD * 2)}px`;
  }

  function startFollowing() {
    stopFollowing();
    follow = setInterval(() => place(current), 120);
    if (window.ResizeObserver && current) {
      observer = new ResizeObserver(() => place(current));
      observer.observe(current);
      if (document.body) observer.observe(document.body);
    }
  }
  function stopFollowing() {
    if (follow) clearInterval(follow);
    follow = null;
    if (observer) observer.disconnect();
    observer = null;
  }

  /** Move the frame to `el` (the whole question block) and start pulsing. */
  function focus(el, text) {
    if (!el || !ensure()) return;
    clearTimeout(hideTimer);
    const first = !current;
    current = el;
    if (first) {
      // The first frame appears in place instead of sliding in from the corner.
      box.style.transition = "none";
      place(el);
      void box.offsetWidth; // flush so the next change animates
      box.style.transition = "";
    } else {
      place(el);
    }
    box.classList.remove("jw-hl-ok", "jw-hl-bad");
    box.classList.add("jw-hl-on", "jw-hl-active");
    tag.textContent = text || "Filling";
    startFollowing();
  }

  /** Colour the current frame by how the fill went. */
  function mark(ok, text) {
    if (!box || !current) return;
    box.classList.remove("jw-hl-active");
    box.classList.add(ok ? "jw-hl-ok" : "jw-hl-bad");
    tag.textContent = text || (ok ? "Filled" : "Needs you");
    place(current);
  }

  /** Fade the frame out (after `delay` ms) and forget the current field. */
  function hide(delay = 350) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      stopFollowing();
      current = null;
      if (box) box.classList.remove("jw-hl-on", "jw-hl-active", "jw-hl-ok", "jw-hl-bad");
    }, delay);
  }

  window.__jwHL = { focus, mark, hide };
})();
