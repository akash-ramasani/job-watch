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
    renderProfile(response.userDoc);
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
        renderProfile(response.userDoc);
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
function renderProfile(userDoc) {
  showScreen("profile");
  setHeaderSub("Ready to apply");

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

// ── Add feed ──────────────────────────────────────────────────────────────────
function companyToSlug(name) {
  return (name || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function buildFeedUrl(source, slug) {
  if (source === "ashby") return `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
  return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
}

function selectedSource() {
  return document.querySelector('input[name="feed-source"]:checked')?.value || "greenhouse";
}

function updateUrlPreview() {
  const slug = companyToSlug($("feed-company").value);
  $("feed-url-preview").textContent = slug
    ? buildFeedUrl(selectedSource(), slug)
    : "The API endpoint is built from the company name.";
}

$("feed-company").addEventListener("input", updateUrlPreview);
document.querySelectorAll('input[name="feed-source"]').forEach((r) =>
  r.addEventListener("change", updateUrlPreview)
);
updateUrlPreview();

function setFeedStatus(text, kind) {
  const st = $("feed-status");
  st.style.display = "block";
  st.textContent = text;
  st.style.color = kind === "error" ? "#dc2626" : "#065f46";
}

const ADD_LABEL = "Add Feed";

function submitFeed() {
  const company = $("feed-company").value.trim();
  const source = selectedSource();
  if (!company) {
    setFeedStatus("Please enter a company name.", "error");
    return;
  }

  const btn = $("btn-add-feed");
  btn.disabled = true;
  btn.textContent = "Adding…";
  $("feed-status").style.display = "none";

  chrome.runtime.sendMessage({ type: "ADD_FEED", company, source }, (res) => {
    btn.disabled = false;
    btn.textContent = ADD_LABEL;
    if (chrome.runtime.lastError || !res?.ok) {
      setFeedStatus(chrome.runtime.lastError?.message || res?.error || "Failed to add feed.", "error");
      return;
    }
    const label = source === "ashby" ? "AshbyHQ" : "Greenhouse";
    setFeedStatus(`✅ ${company} (${label}) feed added`, "ok");
    $("feed-company").value = "";
    updateUrlPreview();
  });
}

$("btn-add-feed").addEventListener("click", submitFeed);
$("feed-company").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitFeed();
});
