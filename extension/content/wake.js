// wake.js — pauses that keep their length in a background tab.
//
// Auto-apply fills forms in tabs the person is not looking at. The browser
// lets a hidden tab's timers fire about once a second, and after five minutes
// about once a minute, so a fill made of many short pauses (typing, waiting
// for a dropdown) crawled past the 15-minute job timeout. While the tab is
// hidden, pauses are timed by the extension's service worker instead (its
// reply is a message, which the browser does not hold back).
//   await __jwWait(ms)                       this (isolated) world
//   window.__jwMainWait(ms)                  page world, lib/wait-main.js,
//                                            asks here through postMessage
(function () {
  "use strict";
  if (window.__jwWait) return;
  const native = (ms) => new Promise((r) => setTimeout(r, ms));
  const viaWorker = (ms) => new Promise((r) => {
    try { chrome.runtime.sendMessage({ type: "JW_WAIT", ms }, () => { void chrome.runtime.lastError; r(); }); }
    catch (_) { native(ms).then(r); }
  });
  window.__jwWait = (ms) => (document.visibilityState === "hidden" && ms > 0 ? viaWorker(ms) : native(ms));
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || typeof e.data.jwWaitReq !== "string") return;
    const id = e.data.jwWaitReq;
    window.__jwWait(Math.min(Number(e.data.ms) || 0, 60000)).then(() => window.postMessage({ jwWaitDone: id }, "*"));
  });
})();
