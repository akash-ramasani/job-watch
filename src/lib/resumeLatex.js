// resumeLatex.js — render a tailored resume as LaTeX in the user's own resume
// template (the \resumeSubheading / \resumeItem / \resumeProjectHeading
// layout), so the .tex drops straight into Overleaf and compiles to the same
// look as their hand-written resume. Pure functions, no DOM: also used by
// scripts/test-tailored-resume.mjs to compile-check real output.

const PREAMBLE = String.raw`\input{glyphtounicode}
\pdfgentounicode=1

\documentclass[a4paper,11pt]{article}

%-------------------------
% PACKAGES
%-------------------------
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage[empty]{fullpage}
\usepackage{titlesec}
\usepackage[usenames,dvipsnames]{color}
\usepackage{enumitem}
\usepackage{hyperref}
\usepackage{fancyhdr}
\usepackage[a4paper, margin=0.38in]{geometry}

%-------------------------
% PAGE STYLE
%-------------------------
\pagestyle{fancy}
\fancyhf{}
\fancyfoot{}
\renewcommand{\headrulewidth}{0pt}
\renewcommand{\footrulewidth}{0pt}

\urlstyle{rm}
\raggedbottom
\raggedright
\setlength{\tabcolsep}{0in}

\hypersetup{
    colorlinks=false,
    pdfborder={0 0 0}
}

%-------------------------
% SECTION FORMATTING
%-------------------------
\titleformat{\section}{
    \vspace{-8pt}
    \scshape
    \raggedright
    \large
}{}{0em}{}[\color{black}\titlerule \vspace{-5pt}]

%-------------------------
% CUSTOM COMMANDS
%-------------------------
\newcommand{\resumeItem}[1]{
    \item\small{
        #1
        \vspace{-1pt}
    }
}

\newcommand{\resumeSubheading}[4]{
    \vspace{-1pt}\item
    \begin{tabular*}{0.97\textwidth}{l@{\extracolsep{\fill}}r}
        \textbf{#1} & #2 \\
        \textit{#3} & \textit{#4} \\
    \end{tabular*}
    \vspace{-5pt}
}

\newcommand{\resumeProjectHeading}[2]{
    \vspace{-1pt}\item
    \begin{tabular*}{0.97\textwidth}{l@{\extracolsep{\fill}}r}
        \textbf{#1} & #2 \\
    \end{tabular*}
    \vspace{-5pt}
}

\newcommand{\resumeSubHeadingListStart}{
    \begin{itemize}[leftmargin=0in, label={}]
}

\newcommand{\resumeSubHeadingListEnd}{
    \end{itemize}
}

\newcommand{\resumeItemListStart}{
    \begin{itemize}[
        leftmargin=0.18in,
        itemsep=1pt,
        parsep=1pt,
        topsep=3pt
    ]
}

\newcommand{\resumeItemListEnd}{
    \end{itemize}
    \vspace{-5pt}
}
`;

/** Escape text for LaTeX. Unicode dashes become TeX ligatures. */
export function escapeLatex(input) {
  return String(input ?? "")
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([{}&%$#_])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/—/g, "---")
    .replace(/–/g, "--")
    .replace(/[“”]/g, "''")
    .replace(/[‘’]/g, "'");
}

/** Escape, then turn **emphasis** markers into \textbf{}. */
export function richLatex(input) {
  const parts = String(input ?? "").split("**");
  return parts.map((seg, i) => (i % 2 === 1 ? `\\textbf{${escapeLatex(seg)}}` : escapeLatex(seg))).join("");
}

function stripUrlScheme(u) {
  return String(u || "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}

function hrefUnderline(url, display) {
  const u = String(url || "").trim();
  if (!u) return "";
  const full = /^https?:\/\//i.test(u) || /^mailto:/i.test(u) ? u : `https://${u}`;
  return `\\href{${full}}{\\underline{${escapeLatex(display || stripUrlScheme(u))}}}`;
}

function dateRange(start, end) {
  return [start, end].map((s) => String(s || "").trim()).filter(Boolean).map(escapeLatex).join(" -- ");
}

/**
 * @param resume  { header?, summary, skillGroups|skills, roles, projects, education, certifications }
 * @param contact fallback contact block when resume.header is missing:
 *                { name, location, phone, email, github, linkedin }
 */
export function buildResumeLatex(resume, contact = {}) {
  const h = { ...(contact || {}), ...(resume?.header || {}) };
  const name = h.name || contact.name || "";

  const contactBits = [
    h.location ? escapeLatex(h.location) : null,
    h.phone ? escapeLatex(h.phone) : null,
    h.email ? hrefUnderline(`mailto:${h.email}`, h.email) : null,
    h.github ? hrefUnderline(h.github, stripUrlScheme(h.github)) : null,
    h.linkedin ? hrefUnderline(h.linkedin, stripUrlScheme(h.linkedin)) : null,
  ].filter(Boolean);

  const out = [];
  out.push(PREAMBLE);
  out.push(String.raw`%-------------------------
% DOCUMENT
%-------------------------
\begin{document}

%=========================================================
% HEADER
%=========================================================
\begin{center}
    \textbf{\LARGE \scshape ${escapeLatex(name)}} \\ \vspace{3pt}

    \small
    ${contactBits.join("\n    $|$\n    ")}
\end{center}

\vspace{-7pt}
`);

  if (resume?.summary) {
    out.push(String.raw`
%=========================================================
% PROFILE
%=========================================================
\section{Profile}

\small{
${richLatex(resume.summary)}
}

\vspace{1pt}
`);
  }

  const groups = Array.isArray(resume?.skillGroups) && resume.skillGroups.length
    ? resume.skillGroups
    : (resume?.skills?.length ? [{ label: "Skills", skills: resume.skills }] : []);
  if (groups.length) {
    out.push(String.raw`
%=========================================================
% SKILLS
%=========================================================
\section{Skills}

\resumeSubHeadingListStart
`);
    for (const g of groups) {
      if (!g?.skills?.length) continue;
      out.push(`\n\\resumeItem{\\textbf{${escapeLatex(g.label)}:} ${g.skills.map(escapeLatex).join(", ")}}\n`);
    }
    out.push(`\n\\resumeSubHeadingListEnd\n`);
  }

  if (resume?.roles?.length) {
    out.push(String.raw`
%=========================================================
% PROFESSIONAL EXPERIENCE
%=========================================================
\section{Professional Experience}

\resumeSubHeadingListStart
`);
    for (const r of resume.roles) {
      out.push(`
%---------------------------------------------------------
% ${escapeLatex(String(r.company || "").toUpperCase())}
%---------------------------------------------------------
\\resumeSubheading
    {${escapeLatex(r.company)}}
    {${dateRange(r.startDate, r.endDate)}}
    {${escapeLatex(r.title)}}
    {${escapeLatex(r.location)}}
`);
      if (r.bullets?.length) {
        out.push(`\n\\resumeItemListStart\n`);
        for (const b of r.bullets) out.push(`\n\\resumeItem{\n    ${richLatex(b)}\n}\n`);
        out.push(`\n\\resumeItemListEnd\n`);
      }
    }
    out.push(`\n\\resumeSubHeadingListEnd\n`);
  }

  if (resume?.projects?.length) {
    out.push(String.raw`
%=========================================================
% SELECTED PROJECTS
%=========================================================
\section{Selected Projects}

\resumeSubHeadingListStart
`);
    for (const p of resume.projects) {
      out.push(`
%---------------------------------------------------------
% ${escapeLatex(String(p.name || "").toUpperCase())}
%---------------------------------------------------------
\\resumeProjectHeading
    {${escapeLatex(p.name)}}
    {${p.link ? hrefUnderline(p.link) : ""}}
`);
      if (p.bullets?.length) {
        out.push(`\n\\resumeItemListStart\n`);
        for (const b of p.bullets) out.push(`\n\\resumeItem{\n    ${richLatex(b)}\n}\n`);
        out.push(`\n\\resumeItemListEnd\n`);
      }
    }
    out.push(`\n\\resumeSubHeadingListEnd\n`);
  }

  if (resume?.education?.length) {
    out.push(String.raw`
%=========================================================
% EDUCATION
%=========================================================
\section{Education}

\resumeSubHeadingListStart
`);
    for (const e of resume.education) {
      out.push(`
\\resumeSubheading
    {${escapeLatex(e.institution)}}
    {${dateRange(e.startDate, e.endDate)}}
    {${escapeLatex(e.degree)}}
    {${escapeLatex(e.location)}}
`);
    }
    out.push(`\n\\resumeSubHeadingListEnd\n`);
  }

  if (resume?.certifications?.length) {
    out.push(String.raw`
%=========================================================
% CERTIFICATIONS
%=========================================================
\section{Certifications}

\resumeSubHeadingListStart
`);
    for (const c of resume.certifications) out.push(`\n\\resumeItem{${escapeLatex(c)}}\n`);
    out.push(`\n\\resumeSubHeadingListEnd\n`);
  }

  out.push(String.raw`
%=========================================================
% END DOCUMENT
%=========================================================
\end{document}
`);
  return out.join("");
}

/** Split "a **b** c" into [{ text, bold }] runs for the preview and the PDF. */
export function emphasisRuns(input) {
  return String(input ?? "")
    .split("**")
    .map((text, i) => ({ text, bold: i % 2 === 1 }))
    .filter((r) => r.text.length > 0);
}
