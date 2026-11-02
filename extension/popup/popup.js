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
  $("feeds-section").style.display = isAdmin ? "block" : "none";
  if (isAdmin) renderAutoFeeds();
  $("member-note").style.display = isAdmin ? "none" : "block";

  const name = userDoc.fullName || `${userDoc.firstName || ""} ${userDoc.lastName || ""}`.trim() || "User";

  // Avatar pop-in
  const parts = name.split(" ");
  const av = $("avatar-initials");
  av.textContent = (parts[0]?.[0] || "") + (parts[1]?.[0] || "");
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

// ── Feeds: added automatically by the background from the pages you open ─────
function timeAgo(iso) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}
function renderAutoFeeds() {
  chrome.storage.local.get("jwAutoFeeds", ({ jwAutoFeeds = [] }) => {
    const list = $("auto-feeds");
    list.innerHTML = "";
    if (!jwAutoFeeds.length) {
      list.innerHTML = '<li class="auto-empty">None yet. Open any job on Greenhouse, Ashby, Lever, Workday, Oracle, Workable, SmartRecruiters or BambooHR.</li>';
      return;
    }
    for (const f of jwAutoFeeds.slice(0, 6)) {
      const li = document.createElement("li");
      li.innerHTML = '<span class="auto-name"></span><span class="auto-meta"></span>';
      li.querySelector(".auto-name").textContent = f.company;
      li.querySelector(".auto-meta").textContent = `${f.label} · ${timeAgo(f.at)}`;
      list.appendChild(li);
    }
  });
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
const STATUS_LABEL = { submitted: "Submitted", needs_attention: "Needs you", error: "Error", skipped: "Skipped" };
function renderAuto(st) {
  if (!st) return;
  const pill = $("auto-pill");
  pill.textContent = st.on ? (st.current ? "Applying" : "On") : "Off";
  pill.className = `auto-pill${st.on ? " on" : ""}`;
  const btn = $("btn-auto");
  btn.textContent = st.on ? "Stop auto-apply" : "Start auto-apply";
  btn.classList.toggle("btn-stop", !!st.on);
  $("auto-line").textContent = st.current
    ? `Now: ${st.current.companyName} · ${st.current.title}`
    : st.on ? "Waiting a moment before the next job…" : "Applies to every Ashby and Greenhouse job on your Jobs page with a resume tailored to each role. Keep Chrome open.";
  const failed = (st.needs || 0) + (st.errors || 0);
  $("btn-auto-retry").style.display = failed ? "block" : "none";
  $("btn-auto-retry").textContent = `Retry ${failed} failed job${failed === 1 ? "" : "s"}`;
  $("auto-stats").innerHTML = [["Submitted", st.submitted], ["Needs you", st.needs], ["Errors", st.errors], ["Left", st.left ?? "–"]]
    .map(([k, v]) => `<div><b>${v ?? 0}</b><span>${k}</span></div>`).join("");
  const list = $("auto-recent");
  list.innerHTML = "";
  for (const r of st.recent || []) {
    const li = document.createElement("li");
    li.innerHTML = '<span class="auto-name"></span><span class="auto-meta"></span>';
    li.querySelector(".auto-name").textContent = `${r.companyName} · ${r.title}`;
    li.querySelector(".auto-meta").textContent = STATUS_LABEL[r.status] || r.status;
    li.title = r.note || "";
    list.appendChild(li);
  }
}
function refreshAuto() { chrome.runtime.sendMessage({ type: "AUTO_STATUS" }, (res) => renderAuto(res?.status)); }
$("btn-auto").addEventListener("click", () => {
  const on = $("btn-auto").textContent.startsWith("Stop");
  chrome.runtime.sendMessage({ type: on ? "AUTO_STOP" : "AUTO_START" }, () => setTimeout(refreshAuto, 400));
});
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
    $("gmail-status").style.color = mismatch ? "#b45309" : "";
    $("gmail-status").textContent = !res.connected ? "Choose the Gmail account that receives job emails."
      : mismatch ? `Connected to ${res.email}, but applications use ${res.profileEmail}. Reconnect with ${res.profileEmail}, or change the email on your Profile page.`
      : `Reading security codes from ${res.email}.`;
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

$("btn-auto-retry").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "AUTO_RETRY" }, () => setTimeout(refreshAuto, 300));
});
