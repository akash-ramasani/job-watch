// Runs in the page's MAIN world (via manifest "world": "MAIN").
// Sets the flag so the JobWatch web app can detect the extension
// without needing inline script injection (which violates strict CSP).
window.__JW_EXTENSION_INSTALLED__ = true;
