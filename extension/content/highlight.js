// highlight.js — the moving outline that follows JobWatch down a form.
//
// One floating frame, drawn around the whole question (label, help text and
// control) that is being filled right now. It glides from question to
// question top to bottom on a spring, pulses while the answer is going in, turns green
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
  // Position and size move together on one spring, stepped every display frame
  // (2026-11-12: CSS transitions re-aimed by a 120 ms timer restarted mid-glide
  // and stuttered). The pulse is an opacity change on a layer, so the GPU
  // draws it without repainting the page.
  const CSS_TEXT = `
    #jw-hl {
      position: absolute; top: 0; left: 0; z-index: 2147483646; pointer-events: none;
      box-sizing: border-box; border-radius: 12px; opacity: 0;
      border: 2px solid rgba(79, 70, 229, 0.95);
      background: rgba(79, 70, 229, 0.045);
      box-shadow: 0 0 0 4px rgba(79, 70, 229, 0.16), 0 12px 32px rgba(79, 70, 229, 0.18);
      transition: border-color 0.35s ease, background-color 0.35s ease, box-shadow 0.35s ease, opacity 0.3s ease;
      will-change: transform, width, height, opacity;
      contain: layout style;
    }
    #jw-hl::after {
      content: ""; position: absolute; inset: -2px; border-radius: inherit; pointer-events: none;
      box-shadow: 0 0 0 7px rgba(79, 70, 229, 0.14), 0 14px 36px rgba(79, 70, 229, 0.22);
      opacity: 0; will-change: opacity;
    }
    #jw-hl.jw-hl-on { opacity: 1; }
    #jw-hl.jw-hl-active::after { animation: jw-hl-pulse 1.4s ease-in-out infinite; }
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
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18); transition: background-color 0.35s ease;
    }
    #jw-hl.jw-hl-ok #jw-hl-tag { background: #059669; }
    #jw-hl.jw-hl-bad #jw-hl-tag { background: #d97706; }
    @keyframes jw-hl-pulse { 0%, 100% { opacity: 0; } 50% { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) {
      #jw-hl::after { animation: none !important; }
    }
  `;
  const REDUCED = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  // Spring: stiff enough to arrive in about 0.4 s, damped so it settles
  // without overshoot.
  const STIFF = 190, DAMP = 2 * Math.sqrt(190) * 1.0;

  let box = null;
  let tag = null;
  let current = null;
  let hideTimer = null;
  let raf = 0, idle = 0, last = 0;
  const pos = { x: 0, y: 0, w: 0, h: 0 };
  const vel = { x: 0, y: 0, w: 0, h: 0 };

  function ensure() {
    if (box && box.isConnected) return true;
    // On <html>: a board that re-renders its <body> would wipe the frame.
    const host = document.documentElement;
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

  /** Where the frame should be: document coordinates, so scrolling never moves it. */
  function target(el) {
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { x: r.left + window.scrollX - PAD, y: r.top + window.scrollY - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 };
  }
  function paint() {
    box.style.transform = `translate3d(${pos.x.toFixed(2)}px, ${pos.y.toFixed(2)}px, 0)`;
    box.style.width = `${pos.w.toFixed(2)}px`;
    box.style.height = `${pos.h.toFixed(2)}px`;
  }
  function jump(t) { Object.assign(pos, t); vel.x = vel.y = vel.w = vel.h = 0; paint(); }

  /** One display frame: step the spring toward the current field. */
  function tick(now) {
    raf = 0;
    if (!box || !current) return;
    const t = target(current);
    if (!t) { schedule(); return; }
    // A background tab gets no frames worth animating: go straight there.
    if (REDUCED || document.hidden) { jump(t); return settle(); }
    const dt = Math.min(0.034, Math.max(0.001, (now - (last || now)) / 1000)) || 0.016;
    last = now;
    let moving = false;
    for (const k of ["x", "y", "w", "h"]) {
      const a = STIFF * (t[k] - pos[k]) - DAMP * vel[k];
      vel[k] += a * dt;
      pos[k] += vel[k] * dt;
      if (Math.abs(t[k] - pos[k]) > 0.3 || Math.abs(vel[k]) > 2) moving = true;
    }
    if (!moving) { jump(t); return settle(); }
    paint();
    raf = requestAnimationFrame(tick);
  }
  /** Settled: look again a few times a second (the page may shift under it). */
  function settle() {
    last = 0;
    clearTimeout(idle);
    idle = setTimeout(() => {
      const t = current && target(current);
      if (!t) return settle();
      if (Math.abs(t.x - pos.x) + Math.abs(t.y - pos.y) + Math.abs(t.w - pos.w) + Math.abs(t.h - pos.h) > 1) schedule();
      else settle();
    }, 150);
  }
  function schedule() {
    clearTimeout(idle);
    if (!raf) raf = requestAnimationFrame(tick);
  }
  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0; last = 0;
    clearTimeout(idle);
  }

  /** Keep the question on screen, gliding only when it is out of view. */
  function reveal(el) {
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (r.top >= 60 && r.bottom <= vh - 60) return;
    try { el.scrollIntoView({ behavior: REDUCED || document.hidden ? "auto" : "smooth", block: "center" }); } catch (_) { /* old pages */ }
  }

  /** Move the frame to `el` (the whole question block) and start pulsing. */
  function focus(el, text) {
    if (!el || !ensure()) return;
    clearTimeout(hideTimer);
    const first = !current || !box.classList.contains("jw-hl-on");
    current = el;
    reveal(el);
    const t = target(el);
    // The first frame appears in place instead of sliding in from the corner.
    if (first && t) jump(t);
    box.classList.remove("jw-hl-ok", "jw-hl-bad");
    box.classList.add("jw-hl-on", "jw-hl-active");
    tag.textContent = text || "Filling";
    schedule();
  }

  /** Colour the current frame by how the fill went. */
  function mark(ok, text) {
    if (!box || !current) return;
    box.classList.remove("jw-hl-active");
    box.classList.add(ok ? "jw-hl-ok" : "jw-hl-bad");
    // A miss here is mid-fill: every form retries it (up to 3 passes, then the
    // check before Submit). What truly needs the person is reported at the end,
    // so this never says "Needs you" (Affirm, Veteran Status, 2026-11-12).
    tag.textContent = text || (ok ? "Filled" : "Trying again");
    schedule();
  }

  /** Fade the frame out (after `delay` ms) and forget the current field. */
  function hide(delay = 350) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      stop();
      current = null;
      if (box) box.classList.remove("jw-hl-on", "jw-hl-active", "jw-hl-ok", "jw-hl-bad");
    }, delay);
  }

  window.__jwHL = { focus, mark, hide };
})();
