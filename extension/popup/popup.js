const $ = (id) => document.getElementById(id);

function showScreen(name) {
  const login   = $("screen-login");
  const profile = $("screen-profile");
  const current = name === "login" ? login : profile;
  const other   = name === "login" ? profile : login;

  // Exit the current visible screen
  if (other.classList.contains("active")) {
    other.classList.add("exit");
    setTimeout(() => {
      other.classList.remove("active", "exit");
      other.style.display = "none";
    }, 180);
  } else {
    other.classList.remove("active");
    other.style.display = "none";
  }

  // Enter the new screen after a tiny gap
  setTimeout(() => {
    current.style.display = "block";
    // Force reflow so animation restarts cleanly
    void current.offsetWidth;
    current.classList.remove("exit");
    current.classList.add("active");
  }, other.classList.contains("active") ? 100 : 0);
}

function setHeaderSub(text) { $("header-sub").textContent = text; }

// ── Boot: check if already logged in ──────────────────────────────────────────
chrome.runtime.sendMessage({ type: "GET_USER" }, (response) => {
  if (response?.ok && response.userDoc) {
    renderProfile(response.userDoc, response.uid);
  } else {
    showScreen("login");
    setHeaderSub("Sign in to continue");
    $("avatar-initials").style.display = "none";
    document.body.classList.add("loaded");
    // Poll immediately — if the web app tab is open and user is logged in,
    // JW_AUTH will fire and we'll auto-transition without any button click.
    startAuthPolling();
  }
});

// ── Sign-in: open tab + poll until JW_AUTH syncs tokens ─────────────────────
let authPoller = null;

function startAuthPolling() {
  if (authPoller) return;
  let attempts = 0;
  const MAX = 40;

  // Shimmer the button to show active sync state
  const btn = $("btn-login");
  if (btn) btn.classList.add("btn-syncing");

  authPoller = setInterval(() => {
    attempts++;
    chrome.runtime.sendMessage({ type: "GET_USER" }, (response) => {
      if (response?.ok && response.userDoc) {
        clearInterval(authPoller);
        authPoller = null;
        if (btn) btn.classList.remove("btn-syncing");
        renderProfile(response.userDoc, response.uid);
      } else if (attempts >= MAX) {
        clearInterval(authPoller);
        authPoller = null;
        if (btn) { btn.classList.remove("btn-syncing"); btn.innerHTML = BTN_LABEL; btn.disabled = false; }
        setHeaderSub("Sign in to continue");
      }
    });
  }, 1500);
}

const BTN_LABEL = '<svg width="14" height="14" viewBox="0 0 32 32" fill="none"><rect width="32" height="32" rx="7" fill="white" fill-opacity="0.25"/><text x="16" y="23" font-family="Ubuntu,Arial" font-size="18" font-weight="700" fill="white" text-anchor="middle">J</text></svg> Sign in with JobWatch';

$("btn-login").addEventListener("click", () => {
  // Just open the site — if already logged in, JW_AUTH fires and polling picks it up.
  // If not logged in, user logs in on the site and polling catches the sync.
  chrome.tabs.create({ url: "https://jobwatch.akashramasani.com" });
});

// ── Avatar: click → open JobWatch profile page ────────────────────────────────
$("avatar-initials").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://jobwatch.akashramasani.com/profile" });
});

// ── Render profile ─────────────────────────────────────────────────────────────
// Feeds are shared and managed by the admin only.
const ADMIN_UID = "7Tojjo8l5PZIYctPmdwncf7PC133";

function renderProfile(userDoc, uid) {
  showScreen("profile");
  setHeaderSub("Ready to apply");
  const isAdmin = uid === ADMIN_UID;
  $("member-note").style.display = isAdmin ? "none" : "block";

  const name = userDoc.fullName || `${userDoc.firstName || ""} ${userDoc.lastName || ""}`.trim() || "User";

  // Avatar pop-in
  const parts = name.split(" ");
  const av = $("avatar-initials");
  const initials = (parts[0]?.[0] || "") + (parts[1]?.[0] || "");
  av.textContent = initials;
  // The same picture as the web app (users/{uid}.avatarUrl); initials if it won't load.
  if (/^https:\/\//.test(userDoc.avatarUrl || "")) {
    const img = document.createElement("img");
    img.alt = name;
    img.style.cssText = "width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;";
    img.onload = () => { av.textContent = ""; av.appendChild(img); av.style.background = "#eef2ff"; };
    img.onerror = () => { av.textContent = initials; };
    img.src = userDoc.avatarUrl;
  }
  av.classList.remove("avatar-pop");
  void av.offsetWidth; // reflow to restart animation
  av.classList.add("avatar-pop");
  av.style.display = "flex";

  startAuthValidityCheck();
  document.body.classList.add("loaded");
}

// ── Auth validity check: auto-logout when web app session ends ──────────────
let authValidityPoller = null;

function startAuthValidityCheck() {
  if (authValidityPoller) clearInterval(authValidityPoller);
  authValidityPoller = setInterval(() => {
    chrome.runtime.sendMessage({ type: "GET_USER" }, (response) => {
      if (!response?.ok) {
        // Tokens gone (JW_LOGOUT was received) — switch back to login
        clearInterval(authValidityPoller);
        authValidityPoller = null;
        showScreen("login");
        setHeaderSub("Sign in to continue");
        $("avatar-initials").style.display = "none";
        startAuthPolling();
      }
    });
  }, 10_000); // check every 10 seconds
}

// ── Fill this page: run the universal filler in the active tab ───────────────
$("btn-fill-page").addEventListener("click", () => {
  const status = $("fill-status");
  status.style.color = "#6b7280";
  status.textContent = "Starting…";
  chrome.runtime.sendMessage({ type: "FILL_THIS_PAGE" }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) {
      status.style.color = "#dc2626";
      status.textContent = chrome.runtime.lastError?.message || res?.error || "Could not start on this page.";
      return;
    }
    status.style.color = "#065f46";
    status.textContent = "JobWatch is filling the form. Watch the banner at the top of the page.";
  });
});

// ── Auto-apply: start / stop and live status ─────────────────────────────────
function renderAuto(st) {
  if (!st) return;
  const pill = $("auto-pill");
  pill.textContent = st.on ? (st.aiDownSince && !st.current ? "Paused" : st.current ? "Applying" : st.idle ? "Waiting" : "On") : "Off";
  pill.className = `auto-pill${st.on ? " on" : ""}`;
  const running = st.running || (st.current ? [st.current] : []);
  $("auto-line").textContent = st.aiDownSince && !running.length
    ? `Paused since ${new Date(st.aiDownSince).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}: the AI is out of credits, so there are no tailored resumes or AI answers. Add credits at console.anthropic.com; JobWatch checks every 15 minutes and carries on by itself.`
    : running.length
    ? `Now applying to ${running.length}: ${running.map((j) => j.companyName).join(", ")}`
    : st.on && st.idle ? `All caught up. Watching for new jobs: each one starts within a minute of appearing.${st.retrying ? ` ${st.retrying} failed job${st.retrying === 1 ? "" : "s"} will retry on ${st.retrying === 1 ? "its" : "their"} own.` : ""}`
    : st.on ? "Waiting a moment before the next job…" : "Applies to every Ashby, Greenhouse, Lever and Workday job on your Jobs page, newest first and best match first, with a resume tailored to each role. Always on while the browser is open: it keeps the computer awake and starts on a new job within a minute of it appearing on your Jobs page.";
  const failed = (st.needs || 0) + (st.errors || 0);
  $("btn-auto-retry").style.display = failed ? "block" : "none";
  $("btn-auto-retry").textContent = `Retry ${failed} failed job${failed === 1 ? "" : "s"}`;
  $("auto-reasons").style.display = st.reasons ? "block" : "none";
  $("auto-reasons").textContent = st.reasons ? `Stopped today by: ${st.reasons}.` : "";
  // The same counts as the Applications page (Needs attention = Needs you + Errors).
  const cells = [["Submitted (24 h)", st.submitted], ...(st.review ? [["Ready to submit", st.review]] : []), ...(st.ledgerRetrying ? [["Retrying", st.ledgerRetrying]] : []), ["Needs you", st.needs], ["Errors", st.errors], ["Left", st.left ?? "–"]];
  $("auto-stats").style.gridTemplateColumns = `repeat(${cells.length}, 1fr)`;
  $("auto-stats").innerHTML = cells
    .map(([k, v]) => `<div><b>${v ?? 0}</b><span>${k}</span></div>`).join("");
}
function refreshAuto() { chrome.runtime.sendMessage({ type: "AUTO_STATUS" }, (res) => renderAuto(res?.status)); }
refreshAuto();
setInterval(refreshAuto, 3000);

// ── Gmail: connect once for Greenhouse security codes ────────────────────────
function refreshGmail() {
  chrome.runtime.sendMessage({ type: "GMAIL_STATUS" }, (res) => {
    if (!res?.ok) return;
    $("gmail-redirect").textContent = res.redirectUrl;
    if (res.clientId && !$("gmail-client").value) $("gmail-client").value = res.clientId;
    $("gmail-pill").textContent = res.connected ? "Connected" : "Not connected";
    $("gmail-pill").className = `auto-pill${res.connected ? " on" : ""}`;
    const mismatch = res.connected && res.profileEmail && res.profileEmail.toLowerCase() !== res.email.toLowerCase();
    // Connected: just the pill and Reconnect (the saved client ID stays in the hidden input).
    $("gmail-setup").style.display = res.connected ? "none" : "";
    $("gmail-status").style.color = mismatch ? "#b45309" : "";
    $("gmail-status").textContent = mismatch ? `Connected to ${res.email}, but applications use ${res.profileEmail}. Reconnect with ${res.profileEmail}, or change the email on your Profile page.` : "";
    $("btn-gmail").textContent = res.connected ? "Reconnect Gmail" : "Connect Gmail";
  });
}
$("btn-gmail").addEventListener("click", () => {
  $("gmail-status").textContent = "Opening Google sign-in…";
  chrome.runtime.sendMessage({ type: "GMAIL_CONNECT", clientId: $("gmail-client").value }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) { $("gmail-status").style.color = "#dc2626"; $("gmail-status").textContent = chrome.runtime.lastError?.message || res?.error || "Could not connect Gmail."; return; }
    $("gmail-status").style.color = "";
    refreshGmail();
  });
});
refreshGmail();

// ── Workday: one password for every company's account ────────────────────────
function refreshWorkday() {
  chrome.runtime.sendMessage({ type: "WORKDAY_STATUS" }, (res) => {
    if (!res?.ok) return;
    $("wd-pill").textContent = res.set ? "On" : "Off";
    $("wd-pill").className = `auto-pill${res.set ? " on" : ""}`;
    $("wd-password").placeholder = res.set ? "Saved. Type a new one to change it" : "Workday password (16+ characters)";
    const email = res.email || res.profileEmail;
    if (!$("wd-email").value && document.activeElement !== $("wd-email")) $("wd-email").value = email;
    if ($("wd-status").dataset.msg) return;
    // Workday's verification and reset emails are read from the connected Gmail.
    const other = res.gmailEmail && email && res.gmailEmail.toLowerCase() !== email.toLowerCase();
    $("wd-status").style.color = other ? "#b45309" : "";
    $("wd-status").textContent = other ? `Gmail is connected to ${res.gmailEmail}, but Workday uses ${email}: its verification and reset emails would not be found. Use the same address for both.`
      : res.set ? `Accounts made or signed in: ${res.accounts}.` : "Off: Workday jobs are skipped until a password is saved.";
  });
}
$("btn-wd-save").addEventListener("click", () => {
  const password = $("wd-password").value;
  const email = $("wd-email").value.trim();
  if (!password && !email) return;
  chrome.runtime.sendMessage({ type: "WORKDAY_SET", password, email }, (res) => {
    const st = $("wd-status");
    st.dataset.msg = "1";
    st.style.color = res?.ok ? "#065f46" : "#dc2626";
    st.textContent = res?.ok ? "Saved. Every Workday account uses this email and password." : (res?.error || chrome.runtime.lastError?.message || "Could not save.");
    if (res?.ok) $("wd-password").value = "";
    setTimeout(() => { delete st.dataset.msg; st.style.color = ""; refreshWorkday(); }, 4000);
  });
});
refreshWorkday();

$("btn-auto-retry").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "AUTO_RETRY" }, () => setTimeout(refreshAuto, 300));
});

// A newer version is on disk but Edge still runs the old one (background.js selfUpdate).
(async () => {
  try {
    const disk = (await (await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" })).json())?.version;
    const running = chrome.runtime.getManifest().version;
    if (!disk || disk === running) return;
    $("update-text").textContent = `JobWatch ${disk} is ready (running ${running}).`;
    $("update-bar").style.display = "block";
    $("update-btn").addEventListener("click", () => {
      const scheme = /Edg\//.test(navigator.userAgent) ? "edge" : "chrome";
      chrome.tabs.create({ url: `${scheme}://extensions/?id=${chrome.runtime.id}` });
    });
  } catch (_) { /* no bar */ }
})();
