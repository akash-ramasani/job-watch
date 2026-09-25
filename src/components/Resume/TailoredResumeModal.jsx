// TailoredResumeModal — the popup behind "Resume" on a job card.
//
// Reads top to bottom: how well you match → what's missing → the resume
// itself → Download. The fine print (every requirement, what was left out
// and why, how the city was picked) is one click away, not in the way.
import React, { useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { emphasisRuns } from "../../lib/resumeLatex.js";
import DownloadMenu from "./DownloadMenu.jsx";

const strip = (u) => String(u || "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
const dates = (a, b) => [a, b].filter(Boolean).join(" – ");

function Rich({ text }) {
  return emphasisRuns(text).map((r, i) =>
    r.bold ? <strong key={i} className="font-semibold text-gray-900">{r.text}</strong> : <span key={i}>{r.text}</span>
  );
}

function tone(pct) {
  if (pct == null) return { text: "text-gray-700", bar: "bg-gray-400", bg: "bg-gray-50", word: "" };
  if (pct >= 75) return { text: "text-emerald-700", bar: "bg-emerald-500", bg: "bg-emerald-50", word: "Strong match" };
  if (pct >= 50) return { text: "text-amber-700", bar: "bg-amber-500", bg: "bg-amber-50", word: "Partial match" };
  return { text: "text-red-700", bar: "bg-red-500", bg: "bg-red-50", word: "Weak match" };
}

function listPhrase(items, max = 3) {
  const shown = items.slice(0, max);
  const more = items.length - shown.length;
  return shown.join(", ") + (more > 0 ? `, and ${more} more` : "");
}

// ─── The resume, drawn like the paper version ────────────────────────────────
function H({ children }) {
  return <h4 className="mt-4 mb-1 text-[12px] uppercase tracking-[0.08em] text-gray-800 border-b border-gray-400 pb-0.5">{children}</h4>;
}

function ResumePreview({ resume, contact }) {
  const h = { ...(contact || {}), ...(resume.header || {}) };
  const groups = resume.skillGroups?.length ? resume.skillGroups : (resume.skills?.length ? [{ label: "Skills", skills: resume.skills }] : []);
  return (
    <div className="font-serif text-[12px] leading-snug text-gray-800">
      <p className="text-center text-lg font-bold text-gray-900">{h.name}</p>
      <p className="text-center text-[11px] text-gray-600">
        {[h.location, h.phone, h.email, h.github && strip(h.github), h.linkedin && strip(h.linkedin)].filter(Boolean).join("  |  ")}
      </p>
      {resume.summary && (<><H>Profile</H><p><Rich text={resume.summary} /></p></>)}
      {groups.length > 0 && (
        <>
          <H>Skills</H>
          {groups.map((g, i) => (g?.skills?.length ? <p key={i}><strong className="font-semibold text-gray-900">{g.label}:</strong> {g.skills.join(", ")}</p> : null))}
        </>
      )}
      {resume.roles?.length > 0 && (
        <>
          <H>Professional Experience</H>
          {resume.roles.map((r, i) => (
            <div key={i} className="mb-2">
              <div className="flex justify-between gap-3"><p className="font-bold text-gray-900">{r.company}</p><p className="whitespace-nowrap">{dates(r.startDate, r.endDate)}</p></div>
              <div className="flex justify-between gap-3 italic"><p>{r.title}</p><p className="whitespace-nowrap">{r.location}</p></div>
              <ul className="mt-0.5 list-disc pl-5">{(r.bullets || []).map((b, j) => <li key={j}><Rich text={b} /></li>)}</ul>
            </div>
          ))}
        </>
      )}
      {resume.projects?.length > 0 && (
        <>
          <H>Selected Projects</H>
          {resume.projects.map((p, i) => (
            <div key={i} className="mb-2">
              <div className="flex justify-between gap-3"><p className="font-bold text-gray-900">{p.name}</p>{p.link && <p className="underline whitespace-nowrap">{strip(p.link)}</p>}</div>
              <ul className="mt-0.5 list-disc pl-5">{(p.bullets || []).map((b, j) => <li key={j}><Rich text={b} /></li>)}</ul>
            </div>
          ))}
        </>
      )}
      {resume.education?.length > 0 && (
        <>
          <H>Education</H>
          {resume.education.map((e, i) => (
            <div key={i} className="mb-1">
              <div className="flex justify-between gap-3"><p className="font-bold text-gray-900">{e.institution}</p><p className="whitespace-nowrap">{dates(e.startDate, e.endDate)}</p></div>
              <div className="flex justify-between gap-3 italic"><p>{e.degree}</p><p className="whitespace-nowrap">{e.location}</p></div>
            </div>
          ))}
        </>
      )}
      {resume.certifications?.length > 0 && (<><H>Certifications</H><ul className="list-disc pl-5">{resume.certifications.map((c, i) => <li key={i}>{c}</li>)}</ul></>)}
    </div>
  );
}

// ─── Match summary + the details behind it ───────────────────────────────────
function MatchSummary({ report }) {
  const [open, setOpen] = useState(false);
  const reqs = report?.requirements || [];
  const yes = reqs.filter((q) => q.covered === "yes").length;
  const partial = reqs.filter((q) => q.covered === "partial").length;
  const gaps = reqs.filter((q) => q.covered === "no").map((q) => q.requirement);
  const pct = report?.coveragePct ?? null;
  const t = tone(pct);
  const leftOut = [...(report?.removedBullets || []), ...(report?.trimmedBullets || [])];

  return (
    <div className={`rounded-2xl ${t.bg} p-5`}>
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className={`text-3xl font-black ${t.text}`}>{pct == null ? "—" : `${pct}%`}</span>
        <span className={`text-sm font-bold ${t.text}`}>{t.word}</span>
      </div>
      <div className="mt-2 h-1.5 w-full rounded-full bg-white/70 overflow-hidden">
        <div className={`h-full ${t.bar}`} style={{ width: `${pct || 0}%` }} />
      </div>
      <p className="mt-3 text-sm text-gray-800">
        Your resume covers <strong>{yes}</strong>{partial ? <> (and partly <strong>{partial}</strong>)</> : null} of the <strong>{reqs.length}</strong> things this job asks for.
      </p>
      {gaps.length > 0 && (
        <p className="mt-1 text-sm text-gray-700">
          Not on your resume: {listPhrase(gaps)}.
        </p>
      )}
      <button type="button" onClick={() => setOpen((v) => !v)} className="mt-3 text-xs font-bold text-gray-700 hover:text-gray-900 underline underline-offset-2">
        {open ? "Hide details" : "See details"}
      </button>

      {open && (
        <div className="mt-4 space-y-4 text-sm">
          <ul className="space-y-1.5">
            {reqs.map((q, i) => (
              <li key={i} className="flex gap-2">
                <span className={`flex-shrink-0 w-4 text-center ${q.covered === "yes" ? "text-emerald-600" : q.covered === "partial" ? "text-amber-600" : "text-red-500"}`}>
                  {q.covered === "yes" ? "✓" : q.covered === "partial" ? "~" : "✗"}
                </span>
                <span className="text-gray-800">
                  {q.requirement}
                  {q.evidence && <span className="block text-xs text-gray-500">{q.evidence}</span>}
                </span>
              </li>
            ))}
          </ul>
          {report?.location && (
            <p className="text-xs text-gray-600">
              <span className="font-semibold">City on this resume:</span> {report.location.display}
              {report.location.jobLocation ? ` — the job lists "${report.location.jobLocation}"` : ""}
            </p>
          )}
          {leftOut.length > 0 && (
            <div className="text-xs text-gray-600">
              <p className="font-semibold">Left out because your resume doesn't say it ({leftOut.length})</p>
              <ul className="mt-1 space-y-1 list-disc pl-5">
                {leftOut.map((b, i) => <li key={i}>{b.reason}</li>)}
              </ul>
              <p className="mt-1">If any of these are true, add them to your resume on the Profile page and try again.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Modal ───────────────────────────────────────────────────────────────────
export default function TailoredResumeModal({ state, contact, onClose, onRetry, onDownloadPdf, onDownloadTex }) {
  const { isOpen, job, loading, data, error } = state || {};
  const needsProfile = /no resume profile|no work experience/i.test(error || "");

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/40 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.96, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={`Resume for ${job?.companyName || "this job"}`}
            className="bg-white rounded-2xl shadow-xl w-full max-w-3xl overflow-hidden flex flex-col max-h-[90vh]"
          >
            <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-gray-100">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-gray-900 truncate">Your resume for {job?.companyName}</h3>
                <p className="text-xs text-gray-500 truncate">{job?.title}</p>
              </div>
              <button type="button" onClick={onClose} className="p-1.5 -mr-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg" aria-label="Close">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              {loading ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <svg className="w-8 h-8 animate-spin text-indigo-500 mb-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
                    <path d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" fill="currentColor" className="opacity-75" />
                  </svg>
                  <p className="text-sm font-semibold text-gray-900">Tailoring your resume for this job…</p>
                  <p className="text-xs text-gray-500 mt-1">Takes about 15 seconds. Only things already on your resume are used.</p>
                </div>
              ) : error ? (
                <div className="py-10 text-center">
                  {needsProfile ? (
                    <>
                      <p className="text-sm font-semibold text-gray-900">Add your resume first</p>
                      <p className="text-sm text-gray-500 mt-1">We tailor it to each job, so we need it on your Profile page.</p>
                      <Link to="/profile" onClick={onClose} className="btn-primary inline-block mt-4">Go to Profile</Link>
                    </>
                  ) : (
                    <>
                      <p className="text-sm font-semibold text-gray-900">Something went wrong</p>
                      <p className="text-sm text-gray-500 mt-1">{error}</p>
                      <button type="button" onClick={onRetry} className="btn-primary mt-4">Try again</button>
                    </>
                  )}
                </div>
              ) : data?.resume ? (
                <div className="space-y-5">
                  <MatchSummary report={data.matchReport} />
                  <div className="rounded-xl ring-1 ring-gray-200 bg-white px-6 py-5 shadow-sm">
                    <ResumePreview resume={data.resume} contact={contact} />
                  </div>
                </div>
              ) : null}
            </div>

            {!loading && !error && data?.resume && (
              <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between gap-3">
                <button type="button" onClick={onRetry} className="text-xs font-semibold text-gray-500 hover:text-gray-800">
                  Make a new version
                </button>
                <div className="flex items-center gap-3">
                  <button type="button" onClick={onClose} className="btn-secondary">Close</button>
                  <DownloadMenu primary up onPdf={onDownloadPdf} onTex={onDownloadTex} />
                </div>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
