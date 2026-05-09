const $ = (id) => document.getElementById(id);

function showScreen(name) {
  $("screen-login").style.display = name === "login" ? "block" : "none";
  $("screen-profile").style.display = name === "profile" ? "block" : "none";
}

function setHeaderSub(text) {
  $("header-sub").textContent = text;
}

function setDot(color) {
  $("status-dot").style.background = color;
}

// ── Boot: check if already logged in ─────────────────────────────────────────
chrome.runtime.sendMessage({ type: "GET_USER" }, (response) => {
  if (response?.ok && response.userDoc) {
    renderProfile(response.userDoc);
  } else {
    showScreen("login");
    setHeaderSub("Sign in to enable auto-apply");
    setDot("#9ca3af");
  }
});

// ── Login ─────────────────────────────────────────────────────────────────────
$("btn-login").addEventListener("click", async () => {
  const email = $("email").value.trim();
  const password = $("password").value;
  const errEl = $("login-error");

  errEl.style.display = "none";
  if (!email || !password) { errEl.textContent = "Enter your email and password."; errEl.style.display = "block"; return; }

  $("btn-login").textContent = "Signing in…";
  $("btn-login").disabled = true;

  chrome.runtime.sendMessage({ type: "SIGN_IN", email, password }, (response) => {
    $("btn-login").textContent = "Sign In";
    $("btn-login").disabled = false;

    if (!response?.ok) {
      errEl.textContent = response?.error || "Login failed. Check your credentials.";
      errEl.style.display = "block";
      return;
    }

    // Fetch profile after login
    chrome.runtime.sendMessage({ type: "GET_USER" }, (r) => {
      if (r?.ok) renderProfile(r.userDoc);
    });
  });
});

$("password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-login").click();
});

// ── Sign out ──────────────────────────────────────────────────────────────────
$("btn-signout").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "SIGN_OUT" }, () => {
    showScreen("login");
    setHeaderSub("Sign in to enable auto-apply");
    setDot("#9ca3af");
  });
});

// ── Render profile ────────────────────────────────────────────────────────────
function renderProfile(userDoc) {
  showScreen("profile");
  setHeaderSub("Ready to apply");
  setDot("#34d399");

  const name = userDoc.fullName || `${userDoc.firstName || ""} ${userDoc.lastName || ""}`.trim() || "—";
  $("profile-name").textContent = name;
  $("profile-email").textContent = userDoc.email || "—";

  if (userDoc.resumeUrl) { $("badge-resume").style.display = "inline-flex"; }
  if (userDoc.linkedin) { $("badge-linkedin").style.display = "inline-flex"; }
  if (userDoc.phone) { $("badge-phone").style.display = "inline-flex"; }

  // Check if we're on a job application page
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const url = tabs[0]?.url || "";
    if (url.includes("ashbyhq.com") && url.includes("/application")) {
      $("status-text").textContent = "✅ Ashby application detected. The form is being filled automatically.";
    } else {
      $("status-text").textContent = "Open a job application page from JobWatch to auto-fill.";
    }
  });
}
