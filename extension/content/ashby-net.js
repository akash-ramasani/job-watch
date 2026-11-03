// ashby-net.js — Ashby's own answer to Submit (MAIN world, document_start).
//
// Ashby posts the application to its GraphQL API. When it turns one away
// without a word on the page (a spam score, a duplicate, a server error), the
// reply still says why. This records the reply to every submit-like request
// in window.__jwNet (read by lib/ashby-dom.js: errors(), afterSubmit()).
// Nothing is changed: requests and replies pass through untouched.
(function () {
  "use strict";
  if (window.__jwNet) return;
  // pending: submit requests sent and not yet answered (no second press while one is on its way).
  const net = (window.__jwNet = { submits: [], pending: 0 });
  const isSubmit = (url, body) => /submit/i.test(String(url || "")) || /"operationName"\s*:\s*"[^"]*submit/i.test(String(body || ""));
  const record = (url, status, text) => {
    let errors = [];
    let ok = status >= 200 && status < 300;
    try {
      const j = JSON.parse(text);
      errors = (j.errors || []).map((e) => e.message).filter(Boolean);
      // Ashby's mutations answer { data: { <op>: { errorMessages: [...] } } } on a 200.
      const walk = (o, d = 0) => {
        if (!o || typeof o !== "object" || d > 4) return;
        for (const [k, v] of Object.entries(o)) {
          if (/error/i.test(k) && v) (Array.isArray(v) ? v : [v]).forEach((x) => errors.push(typeof x === "string" ? x : x?.message || JSON.stringify(x).slice(0, 200)));
          else walk(v, d + 1);
        }
      };
      walk(j.data);
    } catch (_) { if (!ok) errors.push(String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)); }
    if (errors.length) ok = false;
    const op = (String(url || "").match(/[?&]op=([^&]+)/) || [])[1] || "";
    net.submits.push({ at: Date.now(), url: String(url).slice(0, 160), op, status, ok, errors: errors.slice(0, 5).map((e) => String(e).slice(0, 240)), snippet: String(text || "").replace(/\s+/g, " ").slice(0, 300) });
    if (net.submits.length > 10) net.submits.shift();
  };
  const ofetch = window.fetch;
  if (ofetch) {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input?.url;
      const body = init?.body;
      const p = ofetch.apply(this, arguments);
      if (isSubmit(url, typeof body === "string" ? body : "")) {
        net.pending++;
        p.then((r) => r.clone().text().then((t) => record(url, r.status, t))).catch((e) => record(url, 0, String(e?.message || e))).finally(() => { net.pending = Math.max(0, net.pending - 1); });
      }
      return p;
    };
  }
  const oopen = XMLHttpRequest.prototype.open;
  const osend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) { this.__jwUrl = url; return oopen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    if (isSubmit(this.__jwUrl, typeof body === "string" ? body : "")) {
      net.pending++;
      this.addEventListener("loadend", () => { net.pending = Math.max(0, net.pending - 1); try { record(this.__jwUrl, this.status, this.responseText || ""); } catch (_) { /* binary */ } });
    }
    return osend.apply(this, arguments);
  };
})();
