const $ = (id) => document.getElementById(id);

function showScreen(name) {
  $("screen-login").style.display  = name === "login"   ? "block" : "none";
  $("screen-profile").style.display = name === "profile" ? "block" : "none";
}

function setHeaderSub(text) { $("header-sub").textContent = text; }

function setStatusPill(state) {
  // Pill replaced with dynamic Header Avatar. 
}

// ── Boot: check if already logged in ──────────────────────────────────────────
chrome.runtime.sendMessage({ type: "GET_USER" }, (response) => {
  if (response?.ok && response.userDoc) {
    renderProfile(response.userDoc);
  } else {
    showScreen("login");
    setHeaderSub("Sign in to auto-apply");
    $("avatar-initials").style.display = "none";
    setStatusPill("offline");
    document.body.classList.add("loaded");
  }
});

// ── Enterprise Sign-in (web auth flow) ────────────────────────────────────────
$("btn-login").addEventListener("click", () => {
  const errEl = $("login-error");
  errEl.style.display = "none";

  $("btn-login").innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:spin 0.8s linear infinite"><path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"/></svg> Opening…';
  $("btn-login").disabled = true;

  chrome.runtime.sendMessage({ type: "SIGN_IN_WITH_WEB" }, (response) => {
    $("btn-login").innerHTML = '<svg width="14" height="14" viewBox="0 0 32 32" fill="none"><rect width="32" height="32" rx="7" fill="white" fill-opacity="0.25"/><text x="16" y="23" font-family="Ubuntu,Arial" font-size="18" font-weight="700" fill="white" text-anchor="middle">J</text></svg> Sign in with JobWatch';
    $("btn-login").disabled = false;

    if (!response?.ok) {
      errEl.textContent = response?.error || "Sign-in was cancelled or failed. Please try again.";
      errEl.style.display = "block";
      return;
    }

    chrome.runtime.sendMessage({ type: "GET_USER" }, (r) => {
      if (r?.ok) renderProfile(r.userDoc);
    });
  });
});


// ── Sign out ───────────────────────────────────────────────────────────────────
$("btn-signout").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "SIGN_OUT" }, () => {
    showScreen("login");
    setHeaderSub("Sign in to auto-apply");
    $("avatar-initials").style.display = "none";
    setStatusPill("offline");
  });
});

// ── Render profile ─────────────────────────────────────────────────────────────
let statusPoller = null;

function renderProfile(userDoc) {
  showScreen("profile");
  setHeaderSub("Ready to apply");
  setStatusPill("online");

  // Profile info
  const name = userDoc.fullName || `${userDoc.firstName || ""} ${userDoc.lastName || ""}`.trim() || "User";


  // Avatar initials
  const parts = name.split(" ");
  $("avatar-initials").textContent = (parts[0]?.[0] || "") + (parts[1]?.[0] || "");
  $("avatar-initials").style.display = "flex";



  // Detect Ashby application page
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const url = tabs[0]?.url || "";
    const noticeEl = $("status-text");
    if (url.includes("ashbyhq.com") && url.includes("/application")) {
      noticeEl.innerHTML = '<span>🚀</span><span>Ashby application detected! Auto-fill is active.</span>';
      noticeEl.className = "status-notice detected";
    } else {
      noticeEl.innerHTML = '<span>ℹ️</span><span>Open a job application page from JobWatch to auto-fill.</span>';
      noticeEl.className = "status-notice";
    }
  });

  // Load stats
  chrome.runtime.sendMessage({ type: "GET_AUTO_APPLY_STATUS" }, (res) => {
    if (res?.ok && res.total > 0) {
      $("stat-applied").textContent = res.done;
      $("stat-jobs").textContent    = res.total;
    } else {
      $("stat-applied").textContent = "0";
      $("stat-jobs").textContent    = "—";
    }
  });

  pollAutoApplyStatus();
  document.body.classList.add("loaded");
}

// ── Auto Apply progress ────────────────────────────────────────────────────────
function setProgressUI(active, done, total) {
  const wrap = $("progress-wrap");
  const btn  = $("btn-auto-apply");
  const stop = $("btn-stop");

  if (active && total > 0) {
    wrap.style.display = "block";
    stop.style.display = "flex";
    btn.disabled = true;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:spin 0.8s linear infinite"><path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"/></svg> Running…';
    const pct = Math.round((done / total) * 100);
    $("progress-fill").style.width  = pct + "%";
    $("progress-count").textContent = `${done} / ${total}`;
    $("progress-label").textContent = "Applying…";
    $("progress-jobs").textContent  = done < total ? `Working on job ${done + 1} of ${total}` : "✅ All done!";
    $("stat-applied").textContent   = done;
    $("stat-jobs").textContent      = total;
  } else {
    stop.style.display = "none";
    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Auto Apply All <span style="opacity:0.6;font-weight:500">(score &gt; 60)</span>';
    if (total > 0) {
      wrap.style.display = "block";
      $("progress-fill").style.width  = "100%";
      $("progress-count").textContent = `${done} / ${total}`;
      $("progress-label").textContent = "Completed";
      $("progress-jobs").textContent  = `✅ Applied to ${done} job${done !== 1 ? "s" : ""}`;
      $("stat-applied").textContent   = done;
      $("stat-jobs").textContent      = total;
    }
  }
}

function pollAutoApplyStatus() {
  if (statusPoller) clearInterval(statusPoller);
  statusPoller = setInterval(() => {
    chrome.runtime.sendMessage({ type: "GET_AUTO_APPLY_STATUS" }, (res) => {
      if (!res?.ok) return;
      setProgressUI(res.active, res.done, res.total);
      if (!res.active && res.total > 0) {
        clearInterval(statusPoller);
        statusPoller = null;
      }
    });
  }, 1500);
}

$("btn-auto-apply").addEventListener("click", () => {
  $("btn-auto-apply").disabled = true;
  $("btn-auto-apply").innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:spin 0.8s linear infinite"><path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"/></svg> Starting…';
  chrome.runtime.sendMessage({ type: "START_AUTO_APPLY" }, (res) => {
    if (!res?.ok || res.total === 0) {
      $("btn-auto-apply").disabled = false;
      $("btn-auto-apply").innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Auto Apply All <span style="opacity:0.6;font-weight:500">(score &gt; 60)</span>';
      const noticeEl = $("status-text");
      noticeEl.innerHTML = res?.total === 0
        ? '<span>⚠️</span><span>No eligible Ashby jobs found (score &gt; 60, not yet applied).</span>'
        : '<span>❌</span><span>Failed to start. Please try again.</span>';
      return;
    }
    setProgressUI(true, 0, res.total);
    pollAutoApplyStatus();
  });
});

$("btn-stop").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "STOP_AUTO_APPLY" }, () => {
    if (statusPoller) { clearInterval(statusPoller); statusPoller = null; }
    chrome.runtime.sendMessage({ type: "GET_AUTO_APPLY_STATUS" }, (res) => {
      if (res?.ok) setProgressUI(false, res.done, res.total);
    });
  });
});

// ── CSS keyframe for spinner ───────────────────────────────────────────────────
const style = document.createElement("style");
style.textContent = `@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`;
document.head.appendChild(style);
