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
let statusPoller = null;

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

  // Resume polling if a run was already active
  pollAutoApplyStatus();
}

// ── Auto Apply ────────────────────────────────────────────────────────────────
function setProgressUI(active, done, total) {
  const wrap = $("progress-wrap");
  const btn  = $("btn-auto-apply");
  if (active && total > 0) {
    wrap.style.display = "block";
    btn.disabled = true;
    btn.textContent = "⚡ Running…";
    const pct = Math.round((done / total) * 100);
    $("progress-fill").style.width = pct + "%";
    $("progress-count").textContent = `${done} / ${total}`;
    $("progress-jobs").textContent = done < total ? `Applying to job ${done + 1} of ${total}…` : "✅ All done!";
  } else {
    wrap.style.display = total > 0 ? "block" : "none";
    btn.disabled = false;
    btn.textContent = "⚡ Auto Apply All (score > 60)";
    if (total > 0) {
      $("progress-fill").style.width = "100%";
      $("progress-count").textContent = `${done} / ${total}`;
      $("progress-jobs").textContent = `✅ Applied to ${done} job${done !== 1 ? "s" : ""}`;
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
  $("btn-auto-apply").textContent = "⚡ Starting…";
  chrome.runtime.sendMessage({ type: "START_AUTO_APPLY" }, (res) => {
    if (!res?.ok || res.total === 0) {
      $("btn-auto-apply").disabled = false;
      $("btn-auto-apply").textContent = "⚡ Auto Apply All (score > 60)";
      $("status-text").textContent = res?.total === 0
        ? "No eligible Ashby jobs found (score > 60, not yet applied)."
        : "Failed to start. Please try again.";
      return;
    }
    setProgressUI(true, 0, res.total);
    pollAutoApplyStatus();
  });
});

// ── Audit Fields ──────────────────────────────────────────────────────────────
let auditPoller = null;

function downloadAuditResults(results) {
  const blob = new Blob([JSON.stringify(results, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "jobwatch-audit.json"; a.click();
  URL.revokeObjectURL(url);
}

$("btn-audit").addEventListener("click", () => {
  $("btn-audit").disabled = true;
  $("btn-audit").textContent = "🔍 Starting audit…";
  $("audit-progress").style.display = "block";
  $("audit-progress").textContent = "Querying jobs…";

  chrome.runtime.sendMessage({ type: "START_AUDIT" }, (res) => {
    if (!res?.ok || res.total === 0) {
      $("btn-audit").disabled = false;
      $("btn-audit").textContent = "🔍 Audit Fields (score > 60)";
      $("audit-progress").textContent = res?.total === 0 ? "No Ashby jobs found with score > 60." : "Failed to start audit.";
      return;
    }
    $("audit-progress").textContent = `Auditing 0 / ${res.total}…`;

    if (auditPoller) clearInterval(auditPoller);
    auditPoller = setInterval(() => {
      chrome.runtime.sendMessage({ type: "GET_AUDIT_STATUS" }, (s) => {
        if (!s?.ok) return;
        if (s.active) {
          $("audit-progress").textContent = `Auditing ${s.done} / ${s.total}…`;
        } else {
          clearInterval(auditPoller); auditPoller = null;
          $("btn-audit").disabled = false;
          $("btn-audit").textContent = "🔍 Audit Fields (score > 60)";
          if (s.results?.length) {
            $("audit-progress").textContent = `✅ Done! ${s.results.length} job(s) audited. Downloading…`;
            downloadAuditResults(s.results);
          } else {
            $("audit-progress").textContent = "✅ Audit complete (no results).";
          }
        }
      });
    }, 1500);
  });
});
  chrome.runtime.sendMessage({ type: "STOP_AUTO_APPLY" }, () => {
    if (statusPoller) { clearInterval(statusPoller); statusPoller = null; }
    chrome.runtime.sendMessage({ type: "GET_AUTO_APPLY_STATUS" }, (res) => {
      if (res?.ok) setProgressUI(false, res.done, res.total);
    });
  });
});
