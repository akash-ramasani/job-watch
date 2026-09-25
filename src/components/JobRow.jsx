// JobRow — one job in the Matched Roles list.
//
// Layout: title and match score on the first line; company, location and when
// it was posted on the second; the one-line reason for the score on the third
// (always visible, not hover-only, so it works on phones). The whole row opens
// the job; the two actions are separate buttons on the right.
import React from "react";

const TIERS = [
  { min: 80, label: "Strong match", pill: "bg-indigo-600 text-white ring-indigo-600", text: "text-indigo-600" },
  { min: 60, label: "Good match", pill: "bg-indigo-50 text-indigo-700 ring-indigo-200", text: "text-indigo-600" },
  { min: 40, label: "Partial match", pill: "bg-gray-50 text-gray-700 ring-gray-200", text: "text-gray-500" },
  { min: -1, label: "Weak match", pill: "bg-white text-gray-400 ring-gray-200", text: "text-gray-400" },
];
const tierFor = (score) => TIERS.find((t) => score >= t.min);

function relativeTime(date) {
  if (!date) return null;
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

const toDate = (ts) => (ts?.toDate ? ts.toDate() : ts ? new Date(ts) : null);

export default function JobRow({ job, showScore, showActions, onOpen, onResume, onCoverLetter }) {
  const score = job.relevanceScore;
  const hasScore = showScore && typeof score === "number" && score >= 0;
  const tier = hasScore ? tierFor(score) : null;
  const estimate = job.scoreMethod === "rule";

  const posted = toDate(job.sourceUpdatedTs) || toDate(job.firstSeenAt);
  const postedAgo = relativeTime(posted);
  const location = (job.locationName || "").trim();
  const remoteChip = job.isRemote && !/remote/i.test(location);
  const url = job.absolute_url && job.absolute_url !== "#" ? job.absolute_url : null;

  const stop = (fn) => (e) => { e.preventDefault(); e.stopPropagation(); fn?.(e, job); };
  const actions = (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={stop(onResume)}
        className="rounded-lg bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 shadow-sm ring-1 ring-inset ring-gray-200 transition-colors hover:bg-indigo-50 hover:text-indigo-700 hover:ring-indigo-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        title="Make a version of your resume for this job"
      >
        Tailor resume
      </button>
      <button
        type="button"
        onClick={stop(onCoverLetter)}
        className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        Cover letter
      </button>
    </div>
  );

  return (
    <li className="group relative transition-colors hover:bg-gray-50/70 focus-within:bg-gray-50/70">
      <div className="flex items-start gap-4 px-5 py-4 sm:px-6">
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold leading-snug text-gray-900">
            <a
              href={url || undefined}
              target="_blank"
              rel="noreferrer"
              onClick={() => onOpen?.(job)}
              className="outline-none after:absolute after:inset-0 after:content-[''] group-hover:text-indigo-600 focus-visible:text-indigo-600"
            >
              <span className="line-clamp-2">{job.title}</span>
            </a>
          </h3>

          <p className="mt-1 flex min-w-0 items-center gap-x-1.5 text-[13px] text-gray-500">
            <span className="shrink-0 font-medium text-gray-700">{job.companyName || "Unknown company"}</span>
            <span aria-hidden="true" className="shrink-0 text-gray-300">·</span>
            <span className="min-w-0 truncate" title={location || undefined}>{location || "Location not listed"}</span>
            {remoteChip && (
              <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 py-px text-[11px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">Remote</span>
            )}
            {postedAgo && (
              <span className="hidden shrink-0 sm:inline">
                <span aria-hidden="true" className="mr-1.5 text-gray-300">·</span>
                <time dateTime={posted.toISOString()} title={posted.toLocaleString()}>{postedAgo}</time>
              </span>
            )}
          </p>

          {hasScore && job.scoreReason && (
            <p className="mt-1.5 line-clamp-1 text-xs text-gray-500" title={job.scoreReason}>
              {job.scoreReason}
            </p>
          )}
        </div>

        <div className="relative z-10 flex flex-shrink-0 flex-col items-end gap-2">
          {hasScore && (
            <div
              className="flex items-center gap-2"
              title={estimate ? "Quick estimate from the job's listed skills. The AI refines it." : "AI match score against your resume"}
            >
              <span className={`text-[11px] font-medium ${tier.text} hidden sm:inline`}>
                {tier.label}{estimate ? " · est." : ""}
              </span>
              <span className={`inline-flex min-w-[2.75rem] items-baseline justify-center rounded-lg px-2 py-1 text-sm font-bold tabular-nums ring-1 ring-inset ${tier.pill}`}>
                {score}
              </span>
            </div>
          )}
          {postedAgo && (
            <time className="text-[11px] text-gray-400 sm:hidden" dateTime={posted.toISOString()} title={posted.toLocaleString()}>{postedAgo}</time>
          )}
          {showActions && <div className="hidden sm:flex">{actions}</div>}
        </div>
      </div>
      {showActions && <div className="relative z-10 -mt-1 px-5 pb-4 sm:hidden">{actions}</div>}
    </li>
  );
}

export function JobRowSkeleton() {
  return (
    <div className="flex items-start gap-4 px-5 py-4 sm:px-6 animate-pulse">
      <div className="min-w-0 flex-1">
        <div className="h-4 w-2/3 rounded bg-gray-200" />
        <div className="mt-2.5 h-3 w-1/2 rounded bg-gray-100" />
        <div className="mt-2 h-3 w-1/3 rounded bg-gray-100" />
      </div>
      <div className="flex flex-col items-end gap-2">
        <div className="h-7 w-11 rounded-lg bg-gray-100" />
        <div className="hidden h-7 w-40 rounded-lg bg-gray-100 sm:block" />
      </div>
    </div>
  );
}
