/**
 * content/jobwatch-bridge.js
 * Injected into the JobWatch web app.
 * Bridges window.postMessage from the web app to the extension background.
 */

// Inject flag into the page's main JS world (content scripts run in an
// isolated world so direct window assignment isn't visible to page JS)
const __jw_flag = document.createElement("script");
__jw_flag.textContent = "window.__JW_EXTENSION_INSTALLED__ = true;";
(document.head || document.documentElement).appendChild(__jw_flag);
__jw_flag.remove();

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!chrome.runtime?.id) return;

  const { type } = event.data || {};

  // ── Auto-apply trigger ────────────────────────────────────────────────────
  if (type === "JOBWATCH_AUTO_APPLY") {
    try {
      chrome.runtime.sendMessage({ type: "AUTO_APPLY", job: event.data.job }, (response) => {
        if (chrome.runtime.lastError) return;
        window.postMessage(
          { type: "JOBWATCH_AUTO_APPLY_ACK", ok: response?.ok ?? false },
          window.location.origin
        );
      });
    } catch (e) {
      console.warn("[JobWatch] Extension was reloaded — please refresh the page.", e.message);
    }
    return;
  }

  // ── Auth sync: web app logged in → sync to extension ─────────────────────
  if (type === "JW_AUTH") {
    try {
      chrome.runtime.sendMessage(
        { type: "JW_AUTH", idToken: event.data.idToken, refreshToken: event.data.refreshToken, uid: event.data.uid, expiresIn: event.data.expiresIn },
        () => { if (chrome.runtime.lastError) {} }
      );
    } catch (e) {}
    return;
  }

  // ── Auth sync: web app logged out → clear extension session ───────────────
  if (type === "JW_LOGOUT") {
    try {
      chrome.runtime.sendMessage({ type: "JW_LOGOUT" }, () => { if (chrome.runtime.lastError) {} });
    } catch (e) {}
    return;
  }

  // ── Ping: web app checks if extension is logged in ────────────────────────
  if (type === "JW_PING") {
    try {
      chrome.runtime.sendMessage({ type: "JW_PING" }, (response) => {
        if (chrome.runtime.lastError) return;
        window.postMessage({ type: "JW_PONG", loggedIn: response?.loggedIn ?? false }, window.location.origin);
      });
    } catch (e) {}
    return;
  }
});
