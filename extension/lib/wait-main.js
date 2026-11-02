// wait-main.js — the page-world side of content/wake.js: a pause that keeps
// its length while the tab is hidden (timed by the extension, not the page's
// throttled timers). Injected before every MAIN-world helper.
(function () {
  if (window.__jwMainWait) return;
  window.__jwMainWait = (ms) => new Promise((resolve) => {
    if (document.visibilityState !== "hidden" || !(ms > 0)) { setTimeout(resolve, ms); return; }
    const id = `jw${Date.now()}${Math.random()}`;
    let done = false;
    const finish = () => { if (done) return; done = true; window.removeEventListener("message", on); resolve(); };
    const on = (e) => { if (e.source === window && e.data && e.data.jwWaitDone === id) finish(); };
    window.addEventListener("message", on);
    window.postMessage({ jwWaitReq: id, ms }, "*");
    setTimeout(finish, ms + 3000); // no wake.js in this frame: the page's own (slower) timer
  });
})();
