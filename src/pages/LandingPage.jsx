import React, { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

/* ── Data ──────────────────────────────────────────────────── */

const FEATURES = [
  {
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12.75 19.5v-.75a7.5 7.5 0 00-7.5-7.5H4.5m0-6.75h.75c7.87 0 14.25 6.38 14.25 14.25v.75M6 18.75a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" />
      </svg>
    ),
    title: "Auto-Sync Feeds",
    desc: "Connect Greenhouse & AshbyHQ job boards once — JobWatch syncs new postings automatically every hour.",
  },
  {
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
      </svg>
    ),
    title: "Push Notifications",
    desc: "Get instant desktop & mobile alerts the moment a company posts a new role. Be the first to apply.",
  },
  {
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
      </svg>
    ),
    title: "Smart Filters",
    desc: "Filter by company, role title, location, and state. Find exactly the opportunity you're looking for.",
  },
  {
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5m.75-9l3-3 2.148 2.148A12.061 12.061 0 0116.5 7.605" />
      </svg>
    ),
    title: "Sync History",
    desc: "Full transparency — see exactly when each sync ran, how many jobs were found, and if anything failed.",
  },
  {
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
      </svg>
    ),
    title: "Secure by Design",
    desc: "Built on Firebase with per-user data isolation. Your feeds, your jobs, your data — always private.",
  },
  {
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3" />
      </svg>
    ),
    title: "Mobile Ready",
    desc: "Responsive design works beautifully on any device. Track jobs from your phone, tablet, or desktop.",
  },
];

const TESTIMONIALS = [
  {
    name: "Priya Sharma",
    role: "CS Graduate, Stanford",
    quote: "JobWatch completely changed my job search. I saved hours every week by not having to check individual career pages.",
    avatar: "PS",
  },
  {
    name: "Alex Chen",
    role: "SWE Intern, UC Berkeley",
    quote: "The real-time notifications are a game-changer. I was one of the first to apply when Stripe opened new grad positions.",
    avatar: "AC",
  },
  {
    name: "Jordan Williams",
    role: "Data Science, Georgia Tech",
    quote: "Love how clean and fast the interface is. The filtering makes it so easy to find relevant roles across multiple companies.",
    avatar: "JW",
  },
];

const PRICING = [
  {
    name: "Free",
    price: "$0",
    period: "forever",
    desc: "Perfect for getting started",
    features: [
      "Up to 3 job board feeds",
      "Hourly auto-sync",
      "Basic filters (title, company)",
      "Push notifications",
      "Sync history",
    ],
    cta: "Get Started",
    highlight: false,
  },
  {
    name: "Pro",
    price: "$9",
    period: "/month",
    desc: "For serious job seekers",
    features: [
      "Unlimited job board feeds",
      "15-minute sync intervals",
      "Advanced filters & saved searches",
      "Email digest notifications",
      "CSV export",
      "Priority support",
    ],
    cta: "Coming Soon",
    highlight: true,
  },
  {
    name: "Team",
    price: "$29",
    period: "/month",
    desc: "For career centers & groups",
    features: [
      "Everything in Pro",
      "Up to 10 team members",
      "Shared feed library",
      "Admin dashboard",
      "API access",
      "Custom integrations",
    ],
    cta: "Coming Soon",
    highlight: false,
  },
];

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  visible: (i = 0) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.1, duration: 0.5, ease: "easeOut" },
  }),
};

const STATS = [
  { value: "40K+", label: "Jobs Tracked" },
  { value: "650+", label: "Companies" },
  { value: "99.9%", label: "Uptime" },
  { value: "<1min", label: "Alert Speed" },
];

const FEATURED_COMPANIES = [
  { name: "Morgan Stanley", domain: "morganstanley.com" },
  { name: "BNY Mellon", domain: "bnymellon.com" },
  { name: "NVIDIA", domain: "nvidia.com" },
  { name: "Google DeepMind", domain: "deepmind.com" },
  { name: "Anthropic", domain: "anthropic.com" },
  { name: "xAI", domain: "x.ai" },
  { name: "Airbnb", domain: "airbnb.com" },
  { name: "Stripe", domain: "stripe.com" },
  { name: "Dropbox", domain: "dropbox.com" },
  { name: "Figma", domain: "figma.com" },
  { name: "Asana", domain: "asana.com" },
  { name: "Coinbase", domain: "coinbase.com" },
  { name: "Robinhood", domain: "robinhood.com" },
  { name: "Databricks", domain: "databricks.com" },
  { name: "Cloudflare", domain: "cloudflare.com" },
  { name: "Airtable", domain: "airtable.com" },
  { name: "Lyft", domain: "lyft.com" },
  { name: "DoorDash", domain: "doordash.com" },
  { name: "Pinterest", domain: "pinterest.com" },
  { name: "Roblox", domain: "roblox.com" },
  { name: "Epic Games", domain: "epicgames.com" },
  { name: "Nintendo", domain: "nintendo.com" },
  { name: "GoDaddy", domain: "godaddy.com" },
  { name: "Elastic", domain: "elastic.co" },
  { name: "HubSpot", domain: "hubspot.com" },
  { name: "MongoDB", domain: "mongodb.com" },
  { name: "Qualtrics", domain: "qualtrics.com" },
  { name: "Datadog", domain: "datadoghq.com" },
  { name: "Celonis", domain: "celonis.com" },
  { name: "Fastly", domain: "fastly.com" },
  { name: "Checkr", domain: "checkr.com" },
  { name: "PagerDuty", domain: "pagerduty.com" },
  { name: "Intercom", domain: "intercom.com" },
  { name: "Affirm", domain: "affirm.com" },
  { name: "Roku", domain: "roku.com" },
  { name: "Netlify", domain: "netlify.com" },
  { name: "Docker", domain: "docker.com" },
  { name: "CoreWeave", domain: "coreweave.com" },
  { name: "Neuralink", domain: "neuralink.com" },
  { name: "Notion", domain: "notion.so" },
  { name: "Ramp", domain: "ramp.com" },
  { name: "Brex", domain: "brex.com" },
  { name: "Zapier", domain: "zapier.com" },
  { name: "ElevenLabs", domain: "elevenlabs.io" },
  { name: "Cohere", domain: "cohere.com" },
  { name: "Harvey", domain: "harvey.ai" },
  { name: "Fivetran", domain: "fivetran.com" },
  { name: "Klaviyo", domain: "klaviyo.com" },
  { name: "Verkada", domain: "verkada.com" },
  { name: "Rubrik", domain: "rubrik.com" },
  { name: "Samsara", domain: "samsara.com" },
  { name: "Snowflake", domain: "snowflake.com" },
  { name: "Supabase", domain: "supabase.com" },
  { name: "Replit", domain: "replit.com" },
  { name: "Cursor", domain: "cursor.com" },
  { name: "Perplexity", domain: "perplexity.ai" },
];

const LOGO_DEV_KEY = import.meta.env.VITE_LOGO_DEV_KEY;

const DEMO_CHART_DATA = [
  { label: "Mon 08:00", written: 12 },
  { label: "Mon 14:00", written: 28 },
  { label: "Tue 08:00", written: 8 },
  { label: "Tue 14:00", written: 42 },
  { label: "Wed 08:00", written: 15 },
  { label: "Wed 14:00", written: 35 },
  { label: "Thu 08:00", written: 22 },
  { label: "Thu 14:00", written: 51 },
  { label: "Fri 08:00", written: 18 },
  { label: "Fri 14:00", written: 44 },
  { label: "Sat 08:00", written: 9 },
  { label: "Sat 14:00", written: 31 },
];

function DemoTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg bg-gray-900 px-3 py-2 shadow-lg">
      <p className="text-[10px] font-bold text-gray-400 mb-1">{label}</p>
      <p className="text-xs font-semibold text-white">
        Jobs: <span style={{ color: "#6366f1" }}>{payload[0].value}</span>
      </p>
    </div>
  );
}

/* ── Interactive Components ───────────────────────────────────────── */

function MagneticButton({ children, className = "" }) {
  const ref = useRef(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  const handleMouse = (e) => {
    const { clientX, clientY } = e;
    const { height, width, left, top } = ref.current.getBoundingClientRect();
    const middleX = clientX - (left + width / 2);
    const middleY = clientY - (top + height / 2);
    setPosition({ x: middleX * 0.15, y: middleY * 0.15 });
  };

  const reset = () => {
    setPosition({ x: 0, y: 0 });
  };

  return (
    <motion.div
      ref={ref}
      onMouseMove={handleMouse}
      onMouseLeave={reset}
      animate={{ x: position.x, y: position.y }}
      transition={{ type: "spring", stiffness: 150, damping: 15, mass: 0.1 }}
      className={`inline-block ${className}`}
    >
      {children}
    </motion.div>
  );
}

/* ── Component ─────────────────────────────────────────────── */

export default function LandingPage() {
  return (
    <div style={{ fontFamily: "Ubuntu, sans-serif" }}>

      {/* ═══ PUBLIC NAVBAR ═══ */}
      <nav className="sticky top-0 z-50 w-full border-b border-gray-100 bg-white/80 backdrop-blur-md">
        <div className="absolute inset-0 hero-gradient opacity-[0.03] -z-10" />
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <Link to="/" className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-indigo-600 flex items-center justify-center">
                <span className="text-white font-bold text-lg">J</span>
              </div>
              <span className="text-xl font-bold tracking-tight text-gray-900">JobWatch</span>
            </Link>

            <div className="hidden sm:flex items-center gap-6">
              <a href="#features" className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors">Features</a>
              <a href="#pricing" className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors">Pricing</a>
              <a href="#testimonials" className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors">Testimonials</a>
            </div>

            <div className="flex items-center gap-3">
              <Link
                to="/login"
                className="text-sm font-semibold text-gray-700 hover:text-indigo-600 transition-colors"
              >
                Sign in
              </Link>
              <MagneticButton>
                <Link
                  to="/signup"
                  className="block rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 transition-colors"
                >
                  Get Started
                </Link>
              </MagneticButton>
            </div>
          </div>
        </div>
      </nav>

      {/* ═══ HERO ═══ */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 hero-gradient opacity-[0.03]" />
        <div className="pointer-events-none absolute -right-40 top-0 h-[500px] w-[500px] rounded-full bg-indigo-100/50 blur-3xl" />
        <div className="pointer-events-none absolute -left-40 bottom-0 h-[400px] w-[400px] rounded-full bg-violet-100/50 blur-3xl" />

        <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-24 sm:py-36">
          <div className="text-center max-w-3xl mx-auto">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
            >
              <span className="inline-flex items-center gap-2 rounded-full bg-indigo-50 px-4 py-1.5 text-xs font-bold text-indigo-700 uppercase tracking-widest mb-6">
                <span className="inline-flex h-2 w-2 rounded-full bg-indigo-500 animate-pulse" />
                Now tracking Greenhouse, AshbyHQ & Eightfold.ai
              </span>
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15, duration: 0.6 }}
              className="text-4xl sm:text-6xl font-bold tracking-tight text-gray-900 leading-[1.1]"
            >
              Never miss a
              <span className="bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent"> job opportunity </span>
              again
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3, duration: 0.6 }}
              className="mt-6 text-lg sm:text-xl text-gray-500 leading-relaxed max-w-2xl mx-auto"
            >
              JobWatch monitors company job boards in real time and notifies you the instant new positions are posted. Stop refreshing career pages — start applying faster.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.45, duration: 0.6 }}
              className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4"
            >
              <MagneticButton className="w-full sm:w-auto">
                <Link
                  to="/signup"
                  className="block w-full text-center rounded-xl bg-indigo-600 px-8 py-3.5 text-sm font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700 hover:shadow-xl hover:shadow-indigo-300 transition-all"
                >
                  Start Tracking for Free →
                </Link>
              </MagneticButton>
              <MagneticButton className="w-full sm:w-auto">
                <a
                  href="#features"
                  className="block w-full text-center rounded-xl border border-gray-200 bg-white px-8 py-3.5 text-sm font-bold text-gray-700 shadow-sm hover:bg-gray-50 transition-all"
                >
                  See How It Works
                </a>
              </MagneticButton>
            </motion.div>
          </div>

          {/* Stats */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6, duration: 0.6 }}
            className="mt-20 grid grid-cols-2 sm:grid-cols-4 gap-6 max-w-2xl mx-auto"
          >
            {STATS.map((s) => (
              <div key={s.label} className="text-center">
                <div className="text-2xl sm:text-3xl font-bold text-gray-900">{s.value}</div>
                <div className="mt-1 text-xs font-semibold text-gray-400 uppercase tracking-widest">{s.label}</div>
              </div>
            ))}
          </motion.div>
        </div>
      </section>

      {/* ═══ TRUSTED COMPANIES (Marquee) ═══ */}
      <section className="relative py-24 bg-gray-50/50 overflow-hidden border-y border-gray-100">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-6 mb-12">
            <div>
              <h2 className="text-[10px] font-black uppercase tracking-[0.25em] text-indigo-600 mb-3">
                Tracking Top Companies
              </h2>
              <p className="text-3xl font-bold text-gray-900 tracking-tight">
                Your pipeline, automated
              </p>
            </div>
            <p className="text-sm text-gray-500 max-w-sm sm:text-right">
              Currently monitoring {FEATURED_COMPANIES.length}+ industry leaders for new opportunities every hour.
            </p>
          </div>
        </div>

        {/* Marquee Track 1 (Left) */}
        <div className="relative mt-10 w-full overflow-hidden flex group">
          <div className="absolute left-0 top-0 bottom-0 w-16 sm:w-32 bg-gradient-to-r from-gray-50/50 to-transparent z-10 pointer-events-none" />
          <div className="absolute right-0 top-0 bottom-0 w-16 sm:w-32 bg-gradient-to-l from-gray-50/50 to-transparent z-10 pointer-events-none" />

          <div className="flex gap-4 sm:gap-6 px-4 animate-marquee min-w-max transition-transform duration-[2000ms] ease-out">
            {[...FEATURED_COMPANIES.slice(0, Math.ceil(FEATURED_COMPANIES.length / 2)), ...FEATURED_COMPANIES.slice(0, Math.ceil(FEATURED_COMPANIES.length / 2))].map((company, i) => (
              <div
                key={`${company.domain}-row1-${i}`}
                className="group/card flex items-center gap-4 h-20 w-48 sm:h-24 sm:w-56 rounded-2xl bg-white border border-gray-100 shadow-[0_2px_8px_-4px_rgba(0,0,0,0.05)] hover:shadow-[0_8px_20px_-8px_rgba(79,70,229,0.15)] hover:border-indigo-100 transition-all duration-300 px-6 cursor-default"
              >
                <img
                  src={`https://img.logo.dev/${company.domain}?token=${LOGO_DEV_KEY}&size=128`}
                  alt={`${company.name} logo`}
                  className="max-h-8 w-8 object-contain grayscale opacity-50 group-hover/card:grayscale-0 group-hover/card:opacity-100 transition-all duration-500"
                  loading="lazy"
                />
                <span className="text-sm font-semibold text-gray-500 group-hover/card:text-gray-900 transition-colors duration-300 truncate">
                  {company.name}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Marquee Track 2 (Right) */}
        <div className="relative mt-4 sm:mt-6 w-full overflow-hidden flex group">
          <div className="absolute left-0 top-0 bottom-0 w-16 sm:w-32 bg-gradient-to-r from-gray-50/50 to-transparent z-10 pointer-events-none" />
          <div className="absolute right-0 top-0 bottom-0 w-16 sm:w-32 bg-gradient-to-l from-gray-50/50 to-transparent z-10 pointer-events-none" />

          <div className="flex gap-4 sm:gap-6 px-4 animate-marquee-reverse min-w-max transition-transform duration-[2000ms] ease-out">
            {[...FEATURED_COMPANIES.slice(Math.ceil(FEATURED_COMPANIES.length / 2)), ...FEATURED_COMPANIES.slice(Math.ceil(FEATURED_COMPANIES.length / 2))].map((company, i) => (
              <div
                key={`${company.domain}-row2-${i}`}
                className="group/card flex items-center gap-4 h-20 w-48 sm:h-24 sm:w-56 rounded-2xl bg-white border border-gray-100 shadow-[0_2px_8px_-4px_rgba(0,0,0,0.05)] hover:shadow-[0_8px_20px_-8px_rgba(79,70,229,0.15)] hover:border-indigo-100 transition-all duration-300 px-6 cursor-default"
              >
                <img
                  src={`https://img.logo.dev/${company.domain}?token=${LOGO_DEV_KEY}&size=128`}
                  alt={`${company.name} logo`}
                  className="max-h-8 w-8 object-contain grayscale opacity-50 group-hover/card:grayscale-0 group-hover/card:opacity-100 transition-all duration-500"
                  loading="lazy"
                />
                <span className="text-sm font-semibold text-gray-500 group-hover/card:text-gray-900 transition-colors duration-300 truncate">
                  {company.name}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ FEATURES ═══ */}
      <section id="features" className="py-24 bg-gray-50/50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-[10px] font-black uppercase tracking-[0.25em] text-indigo-600 mb-3">
              Features
            </h2>
            <p className="text-3xl sm:text-4xl font-bold text-gray-900 tracking-tight">
              Everything you need to land your dream role
            </p>
            <p className="mt-4 text-base text-gray-500 max-w-xl mx-auto">
              From automatic job syncing to instant notifications, JobWatch handles the tedious parts so you can focus on what matters.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <motion.div
                key={f.title}
                custom={i}
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true, margin: "-60px" }}
                variants={fadeUp}
                className="relative rounded-2xl border border-gray-100 bg-white p-8 shadow-sm hover:shadow-lg hover:border-indigo-100 hover:-translate-y-1 transition-all duration-300"
              >
                <div className="inline-flex items-center justify-center rounded-xl bg-indigo-50 p-3 text-indigo-600 mb-5">
                  {f.icon}
                </div>
                <h3 className="text-lg font-bold text-gray-900">{f.title}</h3>
                <p className="mt-2 text-sm text-gray-500 leading-relaxed">{f.desc}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ HOW IT WORKS ═══ */}
      <section className="py-24">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-[10px] font-black uppercase tracking-[0.25em] text-indigo-600 mb-3">
              How It Works
            </h2>
            <p className="text-3xl sm:text-4xl font-bold text-gray-900 tracking-tight">
              Three steps to stay ahead
            </p>
          </div>

          <div className="grid grid-cols-1 gap-12 sm:grid-cols-3">
            {[
              {
                step: "01",
                title: "Add Your Feeds",
                desc: "Paste a Greenhouse or AshbyHQ job board URL and we'll start watching it immediately.",
              },
              {
                step: "02",
                title: "We Monitor 24/7",
                desc: "Our backend checks for new postings every hour and sends you a push notification instantly.",
              },
              {
                step: "03",
                title: "Apply First",
                desc: "Filter, sort, and click through to apply — before the role even hits LinkedIn.",
              },
            ].map((item, i) => (
              <motion.div
                key={item.step}
                custom={i}
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true, margin: "-60px" }}
                variants={fadeUp}
                className="text-center"
              >
                <div className="inline-flex items-center justify-center h-14 w-14 rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white text-lg font-bold mb-5 shadow-lg shadow-indigo-200">
                  {item.step}
                </div>
                <h3 className="text-lg font-bold text-gray-900">{item.title}</h3>
                <p className="mt-2 text-sm text-gray-500 leading-relaxed max-w-xs mx-auto">{item.desc}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ HOW IT WORKS (Terminal UI) ═══ */}
      <section className="py-32 bg-white relative overflow-hidden">
        {/* Subtle background glow */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-indigo-50/50 blur-[120px] rounded-full pointer-events-none" />

        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="text-center mb-16">
            <h2 className="text-[10px] font-black uppercase tracking-[0.25em] text-indigo-600 mb-3">
              Under the Hood
            </h2>
            <p className="text-3xl sm:text-4xl font-bold text-gray-900 tracking-tight">
              Scraping at the speed of code
            </p>
            <p className="mt-4 text-base text-gray-500 max-w-xl mx-auto">
              Our automated crawlers sync with ATS APIs every hour, normalizing job schemas so you get clean, instantly filterable data.
            </p>
          </div>

          {/* Terminal Window */}
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.8 }}
            className="w-full max-w-4xl mx-auto rounded-xl bg-[#0d1117] ring-1 ring-gray-900/5 shadow-2xl overflow-hidden"
          >
            {/* Terminal Header */}
            <div className="flex items-center px-4 py-3 bg-[#161b22] border-b border-white/5">
              <div className="flex gap-2">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
              </div>
              <div className="flex-1 text-center text-[11px] font-medium text-gray-400 font-mono tracking-wider opacity-60">
                job-watch — node sync.js
              </div>
            </div>

            {/* Terminal Content */}
            <div className="p-6 font-mono text-xs sm:text-sm text-gray-300 leading-relaxed overflow-x-auto">
              <div className="flex flex-col gap-1 w-max min-w-full">
                <p className="text-indigo-400">➜ <span className="text-emerald-400">job-watch</span> <span className="text-white">sync --all</span></p>
                <p className="opacity-60 text-gray-500">[10:42:01] Starting global sync cycle...</p>

                <motion.div initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} transition={{ delay: 0.5 }}>
                  <p className="opacity-90">› Syncing <span className="text-blue-400">Greenhouse API</span> (340 companies)...</p>
                  <p className="text-emerald-400 ml-4 font-semibold">✔ Successfully extracted 1,240 new positions</p>
                </motion.div>

                <motion.div initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} transition={{ delay: 1.2 }}>
                  <p className="opacity-90 mt-2">› Syncing <span className="text-purple-400">AshbyHQ API</span> (215 companies)...</p>
                  <p className="text-emerald-400 ml-4 font-semibold">✔ Successfully extracted 892 new positions</p>
                </motion.div>

                <motion.div initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} transition={{ delay: 1.8 }}>
                  <p className="opacity-90 mt-2">› Syncing <span className="text-cyan-400">Microsoft Careers</span>...</p>
                  <p className="text-emerald-400 ml-4 font-semibold">✔ Smart pagination complete (stopped at cutoff)</p>
                  <p className="text-emerald-400 ml-4 font-semibold">✔ Extracted 42 new roles</p>
                </motion.div>

                <motion.div initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} transition={{ delay: 2.2 }}>
                  <p className="opacity-90 mt-2">› Syncing <span className="text-indigo-400">PayPal Careers</span>...</p>
                  <p className="text-emerald-400 ml-4 font-semibold">✔ Eightfold API sync successful</p>
                  <p className="text-emerald-400 ml-4 font-semibold">✔ Extracted 19 new roles</p>
                </motion.div>

                <motion.div initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} transition={{ delay: 2.6 }}>
                  <p className="opacity-90 mt-2">› Syncing <span className="text-green-400">NVIDIA Careers</span>...</p>
                  <p className="text-emerald-400 ml-4 font-semibold">✔ Smart pagination complete</p>
                  <p className="text-emerald-400 ml-4 font-semibold">✔ Extracted 31 new roles</p>
                </motion.div>

                <motion.div initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} transition={{ delay: 2.5 }}>
                  <p className="opacity-60 text-gray-500 mt-3">[10:42:04] Normalizing schemas...</p>
                  <p className="opacity-60 text-gray-500">[10:42:05] Applying text-embedding semantics...</p>
                </motion.div>

                <motion.div initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} transition={{ delay: 3.2 }}>
                  <p className="text-yellow-300 font-semibold mt-3">⚡ 15 roles matched active user alerts</p>
                  <p className="opacity-90">› Dispatching FCM Push Notifications...</p>
                  <p className="text-emerald-400 ml-4 font-semibold">✔ 15 notifications sent successfully</p>
                </motion.div>

                <motion.div initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} transition={{ delay: 3.8 }}>
                  <div className="mt-4 flex items-center gap-2">
                    <span className="text-indigo-400">➜</span>
                    <span className="w-2 h-4 bg-emerald-400 animate-pulse" />
                  </div>
                </motion.div>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ═══ LIVE CHART DEMO ═══ */}
      <section className="py-24 bg-gray-50/50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-[10px] font-black uppercase tracking-[0.25em] text-indigo-600 mb-3">
              Live Analytics
            </h2>
            <p className="text-3xl sm:text-4xl font-bold text-gray-900 tracking-tight">
              Watch your pipeline grow
            </p>
            <p className="mt-4 text-base text-gray-500 max-w-xl mx-auto">
              Every sync adds new jobs to your dashboard. Here's what a typical week looks like.
            </p>
          </div>

          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="bg-white rounded-2xl ring-1 ring-gray-200 shadow-sm p-6 sm:p-8 max-w-3xl mx-auto"
          >
            <div className="flex items-center justify-between mb-6">
              <div>
                <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400">Jobs Added per Sync</h3>
                <p className="text-2xl font-bold text-gray-900 mt-1">315</p>
                <p className="text-xs text-gray-400">new jobs this week</p>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50">
                <svg className="h-5 w-5 text-indigo-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
                </svg>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={DEMO_CHART_DATA} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                <defs>
                  <linearGradient id="colorDemo" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip content={<DemoTooltip />} />
                <Area type="monotone" dataKey="written" stroke="#6366f1" strokeWidth={2} fill="url(#colorDemo)" />
              </AreaChart>
            </ResponsiveContainer>
          </motion.div>
        </div>
      </section>

      {/* ═══ PRICING ═══ */}
      <section id="pricing" className="py-24 bg-gray-50/50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-[10px] font-black uppercase tracking-[0.25em] text-indigo-600 mb-3">
              Pricing
            </h2>
            <p className="text-3xl sm:text-4xl font-bold text-gray-900 tracking-tight">
              Start free, scale when ready
            </p>
            <p className="mt-4 text-base text-gray-500">
              No credit card required. Upgrade or cancel anytime.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-8 sm:grid-cols-3 max-w-5xl mx-auto">
            {PRICING.map((plan, i) => (
              <motion.div
                key={plan.name}
                custom={i}
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true, margin: "-60px" }}
                variants={fadeUp}
                className={`relative rounded-2xl p-8 transition-all duration-300 ${plan.highlight
                  ? "bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-xl shadow-indigo-200 scale-[1.03]"
                  : "bg-white border border-gray-200 shadow-sm hover:shadow-lg hover:border-indigo-100"
                  }`}
              >
                {plan.highlight && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="rounded-full bg-amber-400 px-4 py-1 text-[10px] font-black uppercase tracking-widest text-amber-900">
                      Popular
                    </span>
                  </div>
                )}

                <h3 className={`text-lg font-bold ${plan.highlight ? "text-white" : "text-gray-900"}`}>
                  {plan.name}
                </h3>
                <p className={`mt-1 text-sm ${plan.highlight ? "text-indigo-100" : "text-gray-500"}`}>
                  {plan.desc}
                </p>

                <div className="mt-6 flex items-baseline gap-1">
                  <span className={`text-4xl font-bold ${plan.highlight ? "text-white" : "text-gray-900"}`}>
                    {plan.price}
                  </span>
                  <span className={`text-sm font-medium ${plan.highlight ? "text-indigo-200" : "text-gray-400"}`}>
                    {plan.period}
                  </span>
                </div>

                <ul className="mt-8 space-y-3">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-center gap-3 text-sm">
                      <svg className={`h-4 w-4 flex-shrink-0 ${plan.highlight ? "text-indigo-200" : "text-indigo-500"}`} fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                      <span className={plan.highlight ? "text-indigo-50" : "text-gray-600"}>{f}</span>
                    </li>
                  ))}
                </ul>

                <div className="mt-8">
                  {plan.name === "Free" ? (
                    <MagneticButton className="w-full">
                      <Link
                        to="/signup"
                        className={`block w-full text-center rounded-xl py-3 text-sm font-bold transition-all ${plan.highlight
                          ? "bg-white text-indigo-600 hover:bg-indigo-50"
                          : "bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm shadow-indigo-100"
                          }`}
                      >
                        {plan.cta}
                      </Link>
                    </MagneticButton>
                  ) : (
                    <MagneticButton className="w-full opacity-60">
                      <button
                        disabled
                        className={`block w-full text-center rounded-xl py-3 text-sm font-bold transition-all cursor-not-allowed ${plan.highlight
                          ? "bg-white/20 text-white/70"
                          : "bg-gray-100 text-gray-400"
                          }`}
                      >
                        {plan.cta}
                      </button>
                    </MagneticButton>
                  )}
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ TESTIMONIALS ═══ */}
      <section id="testimonials" className="py-24">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-[10px] font-black uppercase tracking-[0.25em] text-indigo-600 mb-3">
              Testimonials
            </h2>
            <p className="text-3xl sm:text-4xl font-bold text-gray-900 tracking-tight">
              Loved by students everywhere
            </p>
          </div>

          <div className="grid grid-cols-1 gap-8 sm:grid-cols-3 max-w-4xl mx-auto">
            {TESTIMONIALS.map((t, i) => (
              <motion.div
                key={t.name}
                custom={i}
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true, margin: "-60px" }}
                variants={fadeUp}
                className="rounded-2xl bg-gray-50 p-7 hover:bg-indigo-50/50 transition-all duration-300"
              >
                <svg className="h-6 w-6 text-indigo-300 mb-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M11.3 2.1C6 3.2 2 7.7 2 13c0 3 1.3 5 3.5 5 1.8 0 3-1.2 3-3 0-1.7-1.2-3-2.8-3h-.3c.4-2.8 2.6-5.3 5.5-6.3L11.3 2.1zm10 0C16 3.2 12 7.7 12 13c0 3 1.3 5 3.5 5 1.8 0 3-1.2 3-3 0-1.7-1.2-3-2.8-3h-.3c.4-2.8 2.6-5.3 5.5-6.3L21.3 2.1z" />
                </svg>
                <p className="text-sm text-gray-600 leading-relaxed italic">"{t.quote}"</p>
                <div className="mt-5 flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-100 text-xs font-black text-indigo-600">
                    {t.avatar}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{t.name}</p>
                    <p className="text-xs text-gray-400">{t.role}</p>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ CTA ═══ */}
      <section className="py-24">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="hero-gradient relative overflow-hidden rounded-3xl px-8 py-16 sm:px-16 sm:py-24 text-center text-white"
          >
            <div className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full bg-white/5" />
            <div className="pointer-events-none absolute -left-10 -bottom-10 h-48 w-48 rounded-full bg-white/5" />

            <div className="relative z-10">
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
                Ready to supercharge your job search?
              </h2>
              <p className="mt-4 text-base sm:text-lg text-white/80 max-w-xl mx-auto">
                Join hundreds of students who are already tracking opportunities with JobWatch. It's free to start.
              </p>
              <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
                <MagneticButton className="w-full sm:w-auto">
                  <Link
                    to="/signup"
                    className="block w-full text-center rounded-xl bg-white px-8 py-3.5 text-sm font-bold text-indigo-600 shadow-lg hover:bg-indigo-50 transition-all"
                  >
                    Create Free Account →
                  </Link>
                </MagneticButton>
                <MagneticButton className="w-full sm:w-auto">
                  <Link
                    to="/login"
                    className="block w-full text-center rounded-xl border border-white/30 px-8 py-3.5 text-sm font-bold text-white hover:bg-white/10 transition-all"
                  >
                    Sign In
                  </Link>
                </MagneticButton>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ═══ FOOTER ═══ */}
      <footer className="border-t border-gray-100 bg-gray-50/50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="py-10 grid grid-cols-1 gap-8 sm:grid-cols-3">
            <div>
              <div className="flex items-center gap-2 mb-3">
                <div className="h-7 w-7 rounded-lg bg-indigo-600 flex items-center justify-center">
                  <span className="text-white font-bold text-sm">J</span>
                </div>
                <span className="text-lg font-bold tracking-tight text-gray-900">JobWatch</span>
              </div>
              <p className="text-sm text-gray-500 leading-relaxed max-w-xs">
                Your intelligent job tracking dashboard. Never miss an opportunity again.
              </p>
            </div>

            <div>
              <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-4">Product</h3>
              <ul className="space-y-2.5">
                <li><a href="#features" className="text-sm text-gray-600 hover:text-indigo-600 transition-colors">Features</a></li>
                <li><a href="#pricing" className="text-sm text-gray-600 hover:text-indigo-600 transition-colors">Pricing</a></li>
                <li><a href="#testimonials" className="text-sm text-gray-600 hover:text-indigo-600 transition-colors">Testimonials</a></li>
              </ul>
            </div>

            <div>
              <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-4">Resources</h3>
              <ul className="space-y-2.5">
                <li><a href="https://boards-api.greenhouse.io" target="_blank" rel="noreferrer" className="text-sm text-gray-600 hover:text-indigo-600 transition-colors">Greenhouse API</a></li>
                <li><a href="https://developers.ashbyhq.com" target="_blank" rel="noreferrer" className="text-sm text-gray-600 hover:text-indigo-600 transition-colors">AshbyHQ Docs</a></li>
                <li><a href="https://firebase.google.com" target="_blank" rel="noreferrer" className="text-sm text-gray-600 hover:text-indigo-600 transition-colors">Firebase</a></li>
              </ul>
            </div>
          </div>

          <div className="border-t border-gray-200 py-6 flex flex-col sm:flex-row items-center justify-between gap-3">
            <p className="text-xs text-gray-400">
              &copy; {new Date().getFullYear()} JobWatch. All rights reserved.
            </p>
            <div className="flex items-center gap-4">
              <span className="text-xs text-gray-400">Built with React + Firebase</span>
              <span className="inline-flex h-2 w-2 rounded-full bg-emerald-400" title="All systems operational" />
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
