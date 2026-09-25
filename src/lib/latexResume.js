// latexResume.js — parse a resume written in the JobWatch LaTeX template
// (\resumeSubheading / \resumeItem / \resumeProjectHeading …) into the
// structured resume profile. Lossless where the form is: bullets per role,
// grouped skills, locations, project links and the header block all survive,
// and \textbf{…} becomes **…** so bold terms round-trip through the export.
// Pure functions, no DOM: used by the Profile page and by
// scripts/import-latex-resume.mjs.

// Strip one level of wrapping macros: \textit{x} → x, \underline{x} → x; keep \textbf as **x**.
function unbrace(s) {
  let prev;
  do {
    prev = s;
    s = s
      .replace(/\\textbf\s*\{([^{}]*)\}/g, "**$1**")
      .replace(/\\(?:textit|underline|small|scshape|LARGE|emph)\s*\{([^{}]*)\}/g, "$1");
  } while (s !== prev);
  return s;
}

/** LaTeX fragment → plain text (with **bold** markers). */
export function latexToText(s) {
  return unbrace(String(s || ""))
    .replace(/\\href\{[^}]*\}\{([^{}]*)\}/g, "$1")
    .replace(/\\&/g, "&").replace(/\\%/g, "%").replace(/\\\$/g, "$").replace(/\\#/g, "#").replace(/\\_/g, "_")
    .replace(/\\textbackslash\{\}/g, "\\").replace(/\\textasciitilde\{\}/g, "~").replace(/\\textasciicircum\{\}/g, "^")
    .replace(/---/g, "—").replace(/--/g, "–")
    .replace(/\\\\/g, " ").replace(/\\vspace\{[^}]*\}/g, "").replace(/\$\|\$/g, "|")
    .replace(/\\[a-zA-Z]+\s*/g, "")
    .replace(/[{}]/g, "")
    .replace(/\*\*\s*\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Read `count` balanced {…} groups starting at `from`.
function readGroups(src, from, count) {
  const out = [];
  let i = from;
  for (let g = 0; g < count; g++) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== "{") break;
    let depth = 0;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
    }
    out.push(src.slice(start + 1, i - 1));
  }
  return { groups: out, end: i };
}

function itemsIn(block) {
  const bullets = [];
  let q = 0;
  while ((q = block.indexOf("\\resumeItem", q)) !== -1) {
    const r = readGroups(block, q + "\\resumeItem".length, 1);
    q = r.end;
    const b = latexToText(r.groups[0]);
    if (b) bullets.push(b);
  }
  return bullets;
}

function splitDates(s) {
  const [startDate, endDate] = String(s || "").split(/\s*[–—-]+\s*/).map((x) => x.trim());
  return { startDate: startDate || "", endDate: endDate || "" };
}

/** Does this text look like the JobWatch LaTeX template? */
export function looksLikeLatexResume(text) {
  const t = String(text || "");
  return /\\begin\{document\}/.test(t) && /\\resume(?:Subheading|Item|ProjectHeading)/.test(t);
}

/**
 * @param tex  the .tex source
 * @returns profile fields: { header, summary, skills, skillGroups, roles, projects, education, certifications, rawText }
 */
export function parseLatexResume(tex) {
  const src = String(tex || "");
  const docStart = src.indexOf("\\begin{document}");
  // Drop comments (unescaped % to end of line) before parsing.
  const body = (docStart === -1 ? src : src.slice(docStart)).replace(/(^|[^\\])%[^\n]*/g, "$1");

  const sections = [];
  const sectionRe = /\\section\*?\{([^}]*)\}/g;
  let m;
  while ((m = sectionRe.exec(body))) sections.push({ name: latexToText(m[1]).toLowerCase(), start: m.index + m[0].length });
  const endDoc = body.indexOf("\\end{document}");
  const sectionText = (...names) => {
    const i = sections.findIndex((s) => names.some((n) => s.name.includes(n)));
    if (i === -1) return "";
    const end = i + 1 < sections.length ? body.lastIndexOf("\\section", sections[i + 1].start) : (endDoc === -1 ? body.length : endDoc);
    return body.slice(sections[i].start, end);
  };

  // Header: centered name + contact line
  const header = {};
  const cStart = body.indexOf("\\begin{center}");
  const cEnd = body.indexOf("\\end{center}");
  if (cStart !== -1 && cEnd !== -1) {
    const block = body.slice(cStart + "\\begin{center}".length, cEnd);
    const nameMatch = block.match(/\\scshape\s+([^}]*)\}/) || block.match(/\\textbf\{\\LARGE\s+([^}]*)\}/);
    header.name = nameMatch ? latexToText(nameMatch[1]).replace(/\*\*/g, "") : "";
    const rest = latexToText(block.replace(/\\textbf\{\\LARGE[^}]*\}\s*\}?/, "")).replace(/\*\*/g, "").replace(header.name, "");
    const parts = rest.split("|").map((s) => s.trim()).filter(Boolean);
    for (const c of parts) {
      if (/@/.test(c)) header.email = c;
      else if (/^\+?[\d\s()-]{7,}$/.test(c)) header.phone = c;
      else if (/github\.com/i.test(c)) header.github = c;
      else if (/linkedin\.com/i.test(c)) header.linkedin = c;
      else if (/^https?:\/\/|\.[a-z]{2,}(\/|$)/i.test(c)) header.portfolio = c;
      else if (!header.location) header.location = c;
    }
  }

  const summary = latexToText(sectionText("profile", "summary", "about"));

  // Skills: \resumeItem{\textbf{Label:} a, b, c}  (or a plain comma list)
  const skillGroups = [];
  const skillsSrc = sectionText("skills", "technical");
  let pos = 0;
  while ((pos = skillsSrc.indexOf("\\resumeItem", pos)) !== -1) {
    const { groups, end } = readGroups(skillsSrc, pos + "\\resumeItem".length, 1);
    pos = end;
    const raw = groups[0] || "";
    const lm = raw.match(/\\textbf\{([^}]*):\}\s*(.*)$/s);
    const label = lm ? latexToText(lm[1]) : "Skills";
    const list = latexToText(lm ? lm[2] : raw).replace(/\*\*/g, "");
    const skills = list.split(/,\s*(?![^()]*\))/).map((s) => s.trim()).filter(Boolean);
    if (skills.length) skillGroups.push({ label, skills });
  }
  const skills = [...new Set(skillGroups.flatMap((g) => g.skills))];

  // \resumeSubheading{a}{b}{c}{d} + bullets
  function subheadings(srcText, kind) {
    const out = [];
    let p = 0;
    while ((p = srcText.indexOf("\\resumeSubheading", p)) !== -1) {
      const { groups, end } = readGroups(srcText, p + "\\resumeSubheading".length, 4);
      const next = srcText.indexOf("\\resumeSubheading", end);
      const bullets = itemsIn(srcText.slice(end, next === -1 ? srcText.length : next));
      const [g1, g2, g3, g4] = groups.map((g) => latexToText(g).replace(/\*\*/g, ""));
      const dates = splitDates(g2);
      out.push(kind === "role"
        ? { company: g1, ...dates, title: g3, location: g4, description: bullets.join("\n") }
        : { institution: g1, ...dates, degree: g3, location: g4, description: bullets.join("\n") });
      p = end;
    }
    return out;
  }
  const roles = subheadings(sectionText("experience", "employment", "work"), "role");
  const education = subheadings(sectionText("education"), "edu");

  // \resumeProjectHeading{name}{link} + bullets
  const projects = [];
  const projSrc = sectionText("project");
  let p = 0;
  while ((p = projSrc.indexOf("\\resumeProjectHeading", p)) !== -1) {
    const { groups, end } = readGroups(projSrc, p + "\\resumeProjectHeading".length, 2);
    const next = projSrc.indexOf("\\resumeProjectHeading", end);
    const bullets = itemsIn(projSrc.slice(end, next === -1 ? projSrc.length : next));
    const linkMatch = (groups[1] || "").match(/\\href\{([^}]*)\}/);
    const name = latexToText(groups[0]).replace(/\*\*/g, "");
    const tech = name.match(/\(([^)]*)\)\s*$/);
    projects.push({ name, link: linkMatch ? linkMatch[1] : "", techStack: tech ? tech[1] : "", description: bullets.join("\n") });
    p = end;
  }

  const certifications = itemsIn(sectionText("certification")).map((c) => c.replace(/\*\*/g, ""));

  const plain = (s) => String(s || "").replace(/\*\*/g, "");
  const rawText = [
    header.name, [header.location, header.phone, header.email, header.github, header.linkedin].filter(Boolean).join(" | "), "",
    "PROFILE", plain(summary), "",
    "SKILLS", ...skillGroups.map((g) => `${g.label}: ${g.skills.join(", ")}`), "",
    "EXPERIENCE",
    ...roles.flatMap((r) => [`${r.title} — ${r.company} (${r.startDate} – ${r.endDate}${r.location ? `, ${r.location}` : ""})`, ...plain(r.description).split("\n").map((b) => `• ${b}`), ""]),
    "PROJECTS",
    ...projects.flatMap((pr) => [`${pr.name}${pr.link ? ` (${pr.link})` : ""}`, ...plain(pr.description).split("\n").map((b) => `• ${b}`), ""]),
    "EDUCATION",
    ...education.map((e) => `${e.degree} — ${e.institution}${e.location ? ` (${e.location})` : ""}`),
    ...(certifications.length ? ["", "CERTIFICATIONS", ...certifications] : []),
  ].filter((l) => l != null).join("\n");

  return { header, summary, skills, skillGroups, roles, projects, education, certifications, rawText };
}
