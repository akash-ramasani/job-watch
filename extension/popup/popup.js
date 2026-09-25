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
  document.querySelectorAll("#screen-profile > .field, #screen-profile > .url-preview, #btn-add-feed, #feed-status")
    .forEach((el) => { if (!isAdmin) el.style.display = "none"; });
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

// ── Add feed ──────────────────────────────────────────────────────────────────
function companyToSlug(name) {
  return (name || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function buildFeedUrl(source, slug) {
  if (source === "ashby") return `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
  return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
}

// Lightweight URL used only for live validation — Greenhouse without
// ?content=true skips the full job descriptions (much smaller payload).
function buildCheckUrl(source, slug) {
  if (source === "ashby") return `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
  return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
}

function selectedSource() {
  return document.querySelector('input[name="feed-source"]:checked')?.value || "greenhouse";
}

// Workday feeds are keyed by the career-site URL, not a company slug. Same
// parsing as parseWorkdayFeedUrl in functions/index.js.
function parseWorkdayCareerUrl(raw) {
  let u;
  try {
    u = new URL((raw || "").trim());
  } catch {
    return null;
  }
  const host = u.hostname.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/i);
  if (!host) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length && /^[a-z]{2}-[A-Z]{2}$/.test(parts[0])) parts.shift();
  const site = parts[0];
  if (!site || site === "wday") return null;
  return {
    careerUrl: `https://${u.hostname}/${site}`,
    apiUrl: `https://${u.hostname}/wday/cxs/${host[1]}/${site}/jobs`,
  };
}

// Oracle Recruiting Cloud sites: https://<pod>.fa.<region>.oraclecloud.com/
// hcmUI/CandidateExperience/<locale>/sites/<site>. Same parsing as
// parseOracleFeedUrl in functions/index.js.
function parseOracleCareerUrl(raw) {
  let u;
  try {
    u = new URL((raw || "").trim());
  } catch {
    return null;
  }
  if (!/\.oraclecloud\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/\/hcmUI\/CandidateExperience\/([a-z]{2}(?:-[A-Z]{2})?)\/sites\/([^/?#]+)/i);
  if (!m) return null;
  return {
    careerUrl: `https://${u.hostname}/hcmUI/CandidateExperience/en/sites/${m[2]}`,
    apiUrl: `https://${u.hostname}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?finder=findReqs;siteNumber=${m[2]}`,
  };
}

// Sources keyed by a pasted career-site URL rather than a company slug.
const URL_SOURCES = {
  workday: {
    label: "Workday Career Site URL",
    placeholder: "https://<company>.wd5.myworkdayjobs.com/<SiteName>",
    pretty: "Workday",
    parse: parseWorkdayCareerUrl,
  },
  oracle: {
    label: "Oracle Cloud Career Site URL",
    placeholder: "https://<pod>.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/<Site>",
    pretty: "Oracle Cloud",
    parse: parseOracleCareerUrl,
  },
};

// ── Live endpoint check: runs on every company/radio change ──────────────────
// green = endpoint returns real job data, red = 404 / empty / unreachable.
let endpointStatus = "idle"; // idle | checking | valid | invalid
let checkTimer = null;
let checkController = null;
let checkSeq = 0;

function paintPreview(text, color) {
  const el = $("feed-url-preview");
  el.textContent = text;
  el.style.color = color;
}

function updateUrlPreview() {
  const slug = companyToSlug($("feed-company").value);
  const source = selectedSource();

  clearTimeout(checkTimer);
  if (checkController) checkController.abort();

  // Workday's and Oracle's endpoints send no CORS headers, so they can't be
  // probed from here. Validate the URL shape; the first backend sync verifies it.
  const urlSource = URL_SOURCES[source];
  $("feed-workday-field").style.display = urlSource ? "" : "none";
  if (urlSource) {
    $("feed-site-url-label").textContent = urlSource.label;
    $("feed-workday-url").placeholder = urlSource.placeholder;
    const raw = $("feed-workday-url").value;
    const parsed = urlSource.parse(raw);
    if (!raw.trim()) {
      endpointStatus = "idle";
      paintPreview(`Paste the company's ${urlSource.pretty} career page; the endpoint is derived from it.`, "#9ca3af");
    } else if (parsed) {
      endpointStatus = "valid";
      paintPreview(`${parsed.apiUrl} — verified on first sync`, "#059669");
    } else {
      endpointStatus = "invalid";
      paintPreview(`Not a ${urlSource.pretty} career site URL — expected ${urlSource.placeholder}`, "#dc2626");
    }
    return;
  }

  if (!slug) {
    endpointStatus = "idle";
    paintPreview("The API endpoint is built from the company name.", "#9ca3af");
    return;
  }

  const url = buildFeedUrl(source, slug);
  endpointStatus = "checking";
  paintPreview(`${url} — checking…`, "#9ca3af");

  const seq = ++checkSeq;
  checkTimer = setTimeout(async () => {
    checkController = new AbortController();
    try {
      const resp = await fetch(buildCheckUrl(source, slug), { signal: checkController.signal });
      const data = resp.ok ? await resp.json().catch(() => null) : null;
      const jobCount = Array.isArray(data?.jobs) ? data.jobs.length : 0;
      if (seq !== checkSeq) return; // a newer check superseded this one
      if (jobCount > 0) {
        endpointStatus = "valid";
        paintPreview(`${url} — ${jobCount} jobs live`, "#059669");
      } else {
        endpointStatus = "invalid";
        paintPreview(`${url} — no data at this endpoint`, "#dc2626");
      }
    } catch (err) {
      if (err.name === "AbortError" || seq !== checkSeq) return;
      endpointStatus = "invalid";
      paintPreview(`${url} — no data at this endpoint`, "#dc2626");
    }
  }, 500);
}

$("feed-company").addEventListener("input", updateUrlPreview);
$("feed-workday-url").addEventListener("input", updateUrlPreview);
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
  if (endpointStatus === "checking" || endpointStatus === "idle") {
    setFeedStatus("Still verifying the endpoint — one moment.", "error");
    return;
  }
  if (endpointStatus !== "valid") {
    setFeedStatus(
      URL_SOURCES[source]
        ? `Paste the company's ${URL_SOURCES[source].pretty} career site URL (${URL_SOURCES[source].placeholder}).`
        : "This endpoint has no job data. Check the company name and job board.",
      "error"
    );
    return;
  }
  const workdayUrl = URL_SOURCES[source] ? URL_SOURCES[source].parse($("feed-workday-url").value)?.careerUrl : undefined;

  const btn = $("btn-add-feed");
  btn.disabled = true;
  btn.textContent = "Adding…";
  $("feed-status").style.display = "none";

  // Never leave the button stuck on "Adding…" — a stale service worker that
  // doesn't know ADD_FEED would otherwise hold the message channel open forever.
  let settled = false;
  const finish = (fn) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    btn.disabled = false;
    btn.textContent = ADD_LABEL;
    fn();
  };
  const watchdog = setTimeout(() => {
    finish(() =>
      setFeedStatus("No response from the extension. Reload it in chrome://extensions and try again.", "error")
    );
  }, 15000);

  chrome.runtime.sendMessage({ type: "ADD_FEED", company, source, url: workdayUrl }, (res) => {
    finish(() => {
      if (chrome.runtime.lastError || !res?.ok) {
        setFeedStatus(chrome.runtime.lastError?.message || res?.error || "Failed to add feed.", "error");
        return;
      }
      const label = source === "ashby" ? "AshbyHQ" : URL_SOURCES[source]?.pretty || "Greenhouse";
      setFeedStatus(`✅ ${company} (${label}) feed added`, "ok");
      $("feed-company").value = "";
      $("feed-workday-url").value = "";
      updateUrlPreview();
    });
  });
}

$("btn-add-feed").addEventListener("click", submitFeed);
$("feed-company").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitFeed();
});
