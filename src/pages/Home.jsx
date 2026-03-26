
import React from "react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";

/* ── Feature & testimonial data ────────────────────────────── */

const FEATURES = [
  {
    icon: (
      <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
      </svg>
    ),
    title: "Smart Tracking",
    description: "Automatically sync job listings from Greenhouse & AshbyHQ boards. Never miss a new posting again.",
    color: "text-indigo-600",
    bg: "bg-indigo-50",
  },
  {
    icon: (
      <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
      </svg>
    ),
    title: "Real-Time Alerts",
    description: "Get instant push notifications on desktop & mobile the moment new jobs match your tracked companies.",
    color: "text-amber-600",
    bg: "bg-amber-50",
  },
  {
    icon: (
      <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
      </svg>
    ),
    title: "Powerful Filters",
    description: "Filter and sort by company, title keywords, and location. Find exactly the role you're looking for.",
    color: "text-emerald-600",
    bg: "bg-emerald-50",
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

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  visible: (i = 0) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.1, duration: 0.5, ease: "easeOut" },
  }),
};

/* ── Component ─────────────────────────────────────────────── */

export default function Home({ user, userMeta }) {
  const firstName = userMeta?.firstName || user?.displayName?.split(" ")[0] || "there";

  return (
    <div className="page-wrapper !space-y-16">

      {/* ═══ HERO SECTION ═══ */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="hero-gradient relative overflow-hidden rounded-3xl px-8 py-14 sm:px-12 sm:py-20 text-white"
      >
        {/* Decorative circles */}
        <div className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full bg-white/5" />
        <div className="pointer-events-none absolute -left-10 -bottom-10 h-48 w-48 rounded-full bg-white/5" />

        <div className="relative z-10 max-w-2xl">
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="text-[11px] font-black uppercase tracking-[0.25em] text-white/70 mb-3"
          >
            Dashboard
          </motion.p>
          <motion.h1
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.5 }}
            className="text-3xl sm:text-4xl font-bold tracking-tight"
          >
            Welcome back, {firstName}! 👋
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4, duration: 0.5 }}
            className="mt-3 text-base sm:text-lg text-white/80 leading-relaxed"
          >
            Your intelligent job tracking dashboard — stay ahead of every opportunity.
          </motion.p>

          {/* Quick actions */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.55, duration: 0.5 }}
            className="mt-8 flex flex-wrap gap-3"
          >
            <Link
              to="/jobs"
              className="inline-flex items-center gap-2 rounded-full bg-white/20 backdrop-blur-sm px-5 py-2.5 text-sm font-semibold hover:bg-white/30 transition-colors"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 14.15v4.25c0 1.094-.787 2.036-1.872 2.18-2.087.277-4.216.42-6.378.42s-4.291-.143-6.378-.42c-1.085-.144-1.872-1.086-1.872-2.18v-4.25m16.5 0a2.18 2.18 0 00.75-1.661V8.706c0-1.081-.768-2.015-1.837-2.175a48.114 48.114 0 00-3.413-.387m4.5 8.006c-.194.165-.42.295-.673.38A23.978 23.978 0 0112 15.75c-2.648 0-5.195-.429-7.577-1.22a2.016 2.016 0 01-.673-.38m0 0A2.18 2.18 0 013 12.489V8.706c0-1.081.768-2.015 1.837-2.175a48.111 48.111 0 013.413-.387m7.5 0V5.25A2.25 2.25 0 0013.5 3h-3a2.25 2.25 0 00-2.25 2.25v.894m7.5 0a48.667 48.667 0 00-7.5 0" />
              </svg>
              Browse Jobs
            </Link>
            <Link
              to="/feeds"
              className="inline-flex items-center gap-2 rounded-full bg-white/20 backdrop-blur-sm px-5 py-2.5 text-sm font-semibold hover:bg-white/30 transition-colors"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12.75 19.5v-.75a7.5 7.5 0 00-7.5-7.5H4.5m0-6.75h.75c7.87 0 14.25 6.38 14.25 14.25v.75M6 18.75a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" />
              </svg>
              Manage Feeds
            </Link>
            <Link
              to="/history"
              className="inline-flex items-center gap-2 rounded-full bg-white/20 backdrop-blur-sm px-5 py-2.5 text-sm font-semibold hover:bg-white/30 transition-colors"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Sync History
            </Link>
          </motion.div>
        </div>
      </motion.div>

      {/* ═══ FEATURE HIGHLIGHTS ═══ */}
      <div>
        <div className="text-center mb-10">
          <h2 className="text-[10px] font-black uppercase tracking-[0.25em] text-gray-400">
            Why JobWatch?
          </h2>
          <p className="mt-2 text-2xl font-bold text-gray-900">
            Everything you need to land your next role
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          {FEATURES.map((f, i) => (
            <motion.div
              key={f.title}
              custom={i}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-40px" }}
              variants={fadeUp}
              className="feature-card"
            >
              <div className={`inline-flex items-center justify-center rounded-xl ${f.bg} p-3 mb-4`}>
                <span className={f.color}>{f.icon}</span>
              </div>
              <h3 className="text-base font-bold text-gray-900">{f.title}</h3>
              <p className="mt-2 text-sm text-gray-500 leading-relaxed">{f.description}</p>
            </motion.div>
          ))}
        </div>
      </div>

      {/* ═══ TESTIMONIALS ═══ */}
      <div>
        <div className="text-center mb-10">
          <h2 className="text-[10px] font-black uppercase tracking-[0.25em] text-gray-400">
            Trusted by students
          </h2>
          <p className="mt-2 text-2xl font-bold text-gray-900">
            What our users say
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          {TESTIMONIALS.map((t, i) => (
            <motion.div
              key={t.name}
              custom={i}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-40px" }}
              variants={fadeUp}
              className="testimonial-card"
            >
              <svg className="h-6 w-6 text-indigo-300 mb-3" viewBox="0 0 24 24" fill="currentColor">
                <path d="M11.3 2.1C6 3.2 2 7.7 2 13c0 3 1.3 5 3.5 5 1.8 0 3-1.2 3-3 0-1.7-1.2-3-2.8-3h-.3c.4-2.8 2.6-5.3 5.5-6.3L11.3 2.1zm10 0C16 3.2 12 7.7 12 13c0 3 1.3 5 3.5 5 1.8 0 3-1.2 3-3 0-1.7-1.2-3-2.8-3h-.3c.4-2.8 2.6-5.3 5.5-6.3L21.3 2.1z" />
              </svg>
              <p className="text-sm text-gray-600 leading-relaxed italic">
                "{t.quote}"
              </p>
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
    </div>
  );
}
