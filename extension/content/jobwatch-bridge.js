/**
 * content/jobwatch-bridge.js
 * Injected into the JobWatch web app.
 * Bridges window.postMessage from the web app to the extension background.
 */
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== "JOBWATCH_AUTO_APPLY") return;

  // Guard against extension being reloaded mid-session
  if (!chrome.runtime?.id) return;

  try {
    chrome.runtime.sendMessage({ type: "AUTO_APPLY", job: event.data.job }, (response) => {
      if (chrome.runtime.lastError) return; // extension reloaded — ignore
      window.postMessage(
        { type: "JOBWATCH_AUTO_APPLY_ACK", ok: response?.ok ?? false },
        window.location.origin
      );
    });
  } catch (e) {
    // Extension context invalidated (reloaded/updated) — user just needs to refresh
    console.warn("[JobWatch] Extension was reloaded — please refresh the page.", e.message);
  }
});
