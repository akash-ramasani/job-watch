# Production Observability Setup

Step-by-step guide to activate everything that was wired up in the
codebase. **Total time: ~15 minutes.**

After completing all four steps you'll have:

- ✅ Real-time error reports with stack traces and session replay (Sentry)
- ✅ Funnels, retention curves, and session replay of every user flow (PostHog)
- ✅ Web Vitals (LCP / CLS / INP) and per-route page views (Vercel Analytics)
- ✅ 20+ custom product events flowing into Firebase Analytics / GA4

---

## Step 1 — Vercel Analytics & Speed Insights

**Free. No signup. ~2 minutes.**

The packages are already installed and mounted in `src/main.jsx`. You just
need to flip the switches in the Vercel dashboard.

1. Go to <https://vercel.com> → your `job-watch` project.
2. Click the **Analytics** tab → press **Enable Web Analytics**.
3. Click the **Speed Insights** tab → press **Enable**.

That's it. Visit your site once and within ~30 seconds you'll see your
first page view. Gives you:

- Page views per route
- Unique visitors
- Geographic distribution
- Top referrers
- Real-user Web Vitals broken down by route

---

## Step 2 — Firebase Analytics

**Already streaming. Nothing to do.** Just know where to look.

- Console: <https://console.firebase.google.com> → your project → **Analytics** → **Dashboard**
- Custom events (`signup_completed`, `sync_completed`, etc.) appear under
  the **Events** tab. **Note:** GA4 has a ~24 hour processing delay before
  events show up in the standard UI. Use the **Realtime** report to
  confirm events are arriving immediately.

### Optional: link to GA4 for richer reports

Firebase Analytics → Settings → Integrations → **Google Analytics** → Link.
This unlocks the full GA4 console (funnels, retention, audiences,
explorations).

---

## Step 3 — Sentry (error tracking + session replay)

**Free tier: 5,000 errors + 50 replays / month. ~5 minutes. Biggest impact step.**

Without this, when your app crashes in production you have **no way to know**
unless a user tells you. Sentry gives you the exact stack trace + a video
of what the user was doing.

### Get the DSN

1. Go to <https://sentry.io> → **Sign Up** (GitHub login works).
2. **Create Project**:
   - Platform: **React**
   - Project name: `job-watch`
3. Sentry will show a code snippet — **ignore it**, the code is already
   written. Just copy the **DSN** at the top. It looks like:

   ```text
   https://abc123xyz@o123456.ingest.us.sentry.io/789
   ```

### Add the DSN to Vercel

1. Go to <https://vercel.com> → your project → **Settings** → **Environment Variables**.
2. Click **Add New**:
   - **Name:** `VITE_SENTRY_DSN`
   - **Value:** paste the DSN
   - **Environments:** check **Production**, **Preview**, **Development**
3. Click **Save**.

### Redeploy

1. Click the **Deployments** tab.
2. On the latest deployment, click the `⋯` menu → **Redeploy**.
3. **Uncheck** "Use existing Build Cache" so the new env var is picked up.
4. Click **Redeploy**.

### Verify

Within 5 minutes, any error your users hit will appear at
<https://sentry.io> → your project → **Issues**.

You can also test by adding a `throw new Error("test")` somewhere, deploying,
hitting the page, and confirming it shows up.

---

## Step 4 — PostHog (funnels, retention, session replay)

**Free tier: 1M events + 5,000 replays / month. ~5 minutes.**

The killer feature for a small user base: **you can literally watch each
user use your app.** PostHog combines analytics, session replay, funnels,
heatmaps, and feature flags in one tool.

### Get the API key

1. Go to <https://posthog.com> → **Get started — free**.
2. Sign up (GitHub login works).
3. When asked for region: pick **US Cloud** (or **EU Cloud** — just remember
   which, you'll need it below).
4. After login → click the gear icon (top-left) → **Project Settings**.
5. Copy the **Project API Key** (starts with `phc_...`).

### Add the key to Vercel

1. <https://vercel.com> → your project → **Settings** → **Environment Variables**.
2. **Add New:**
   - **Name:** `VITE_POSTHOG_KEY`
   - **Value:** paste the key
   - **Environments:** all three
   - **Save**.
3. **If you picked the EU region**, add a second variable:
   - **Name:** `VITE_POSTHOG_HOST`
   - **Value:** `https://eu.i.posthog.com`
   - **Save**.

### Redeploy

Same as Sentry: **Deployments** → latest → `⋯` → **Redeploy** (uncheck
build cache).

### Verify

Within 2 minutes, open your site, click around, then go to PostHog →
**Activity** tab. You should see events streaming in real time.

### What to build first in PostHog

Once events have been flowing for a few days, set these up:

1. **Activation funnel** (Insights → New Insight → Funnel):
   - Step 1: `signup_completed`
   - Step 2: `sync_completed`
   - Step 3: `job_opened`
   - Step 4: `cover_letter_generated`

   This tells you exactly where users drop off in onboarding.

2. **Retention curve** (Insights → New Insight → Retention):
   - Performed event: `signup_completed`
   - Returning event: `$pageview`
   - Period: Weekly

   Tells you what % of users come back week 1, week 2, etc. This is the
   single most important number for a SaaS.

3. **Session replays** (Session Replay tab in left nav):
   - Filter by recent sessions
   - Watch the videos to find UX confusion you can't catch from analytics

---

## Verification checklist

After completing all four steps and redeploying:

1. Open your site in **incognito** (so you're a fresh user).
2. Sign up with a test invite, run a sync, open a job, send an assistant
   message, generate a cover letter.
3. Within 5 minutes, check that the same events show up in **all four**
   dashboards:

   - [ ] Vercel Analytics — page view recorded
   - [ ] Firebase Analytics → Realtime — events visible
   - [ ] Sentry → Issues — empty (good!) or any errors you triggered
   - [ ] PostHog → Activity — all events streaming live

If anything is missing, the most likely cause is the env var wasn't picked
up — confirm the variable name matches exactly (`VITE_SENTRY_DSN`,
`VITE_POSTHOG_KEY`) and that you redeployed *without* build cache.

---

## What's tracked

All events are automatically tagged with `user_id` and `is_admin: true/false`
so you can segment "real users" vs. yourself. PII (emails, passwords,
resume text, cover letter content, raw chat messages) is stripped from
event payloads before sending.

| Event                          | Fired from                            |
| ------------------------------ | ------------------------------------- |
| `page_view`                    | every SPA route change                |
| `signup_completed`             | Signup form success                   |
| `signup_failed`                | Signup form error                     |
| `invite_redeemed`              | Signup form success                   |
| `login_completed`              | Login form success                    |
| `login_failed`                 | Login form error                      |
| `ai_scoring_toggled`           | Profile AI switch                     |
| `resume_parsed`                | Profile resume upload (parse OK)      |
| `resume_parse_failed`          | Profile resume upload (parse error)   |
| `resume_saved`                 | Profile resume save                   |
| `sync_triggered`               | Feeds "Run sync now"                  |
| `sync_completed`               | Sync success (incl. counts + ms)      |
| `sync_failed`                  | Sync error                            |
| `cover_letter_requested`       | Jobs cover letter button              |
| `cover_letter_generated`       | Cover letter success                  |
| `cover_letter_failed`          | Cover letter error                    |
| `auto_apply_clicked`           | Jobs auto-apply button                |
| `job_opened`                   | Jobs page job click                   |
| `assistant_message_sent`       | ChatAssistant user message            |
| `assistant_message_received`   | ChatAssistant assistant reply         |
| `assistant_message_failed`     | ChatAssistant error                   |

---

## Cost expectations

All four services have generous free tiers. Rough usage:

- **Vercel Analytics**: 2,500 events/mo on Hobby plan, included.
- **Firebase Analytics**: free, unlimited.
- **Sentry**: free 5k errors/mo. You'll likely use < 100/mo with a healthy app.
- **PostHog**: free 1M events/mo + 5k replays. A 50-user beta typically
  burns ~50k events/mo — well within free tier.

You won't pay anything until you have hundreds of active users. When you
do, the first paid tier is usually $20-30/mo each.
