// resumeDownloads.js — turn a resume into a file the user can download.
// Shared by the Profile page (your resume) and the Jobs page (a resume
// tailored to one job), so both produce identical files.
//
//   PDF   — drawn with jsPDF in the same layout as the LaTeX template
//   .tex  — the LaTeX template itself (src/lib/resumeLatex.js), for Overleaf
import { jsPDF } from "jspdf";
import { buildResumeLatex, emphasisRuns } from "./resumeLatex.js";

/** Contact details from the signed-in account, used when the resume has no header of its own. */
export function contactFromUser(user, userMeta) {
  return {
    name: userMeta?.fullName || user?.displayName || "",
    location: userMeta?.city || "",
    phone: userMeta?.phone || "",
    email: userMeta?.email || user?.email || "",
    github: userMeta?.github || "",
    linkedin: userMeta?.linkedin || "",
  };
}

/** Saved profile (descriptions as text, one bullet per line) → resume shape (bullet arrays). */
export function profileToResume(profile) {
  const toBullets = (text) => String(text || "").split("\n").map((b) => b.trim()).filter(Boolean);
  return {
    ...profile,
    roles: (profile?.roles || []).map((r) => ({ ...r, bullets: r.bullets || toBullets(r.description) })),
    projects: (profile?.projects || []).map((p) => ({ ...p, technologies: p.technologies || p.techStack || "", bullets: p.bullets || toBullets(p.description) })),
  };
}

export function safeFileName(s) {
  return String(s || "Resume").replace(/[<>:"/\\|?*]/g, "_").replace(/\s+/g, " ").trim();
}

function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadResumeTex(resume, contact, fileBase) {
  const tex = buildResumeLatex(resume, contact);
  saveBlob(new Blob([tex], { type: "application/x-tex;charset=utf-8" }), `${safeFileName(fileBase)}.tex`);
}

export function downloadResumePdf(resume, contact, fileBase) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 0.38 * 72; // matches the template's geometry margin=0.38in
  const width = pageW - margin * 2;
  const FONT = "times";
  let y = margin + 4;

  const ensure = (h) => {
    if (y + h > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  };
  const setStyle = (size, style = "normal") => {
    doc.setFont(FONT, style);
    doc.setFontSize(size);
  };
  // Word-wrap runs of {text, bold} and draw them, advancing y.
  const drawRich = (input, x, maxWidth, size, baseStyle = "normal") => {
    const runs = typeof input === "string" ? emphasisRuns(input) : input;
    const words = [];
    for (const r of runs) {
      const style = r.bold ? "bold" : baseStyle;
      r.text.split(/(\s+)/).forEach((w) => { if (w) words.push({ w, style }); });
    }
    const lh = size * 1.22;
    let line = [];
    let lineW = 0;
    const flush = () => {
      ensure(lh);
      let cx = x;
      for (const t of line) {
        setStyle(size, t.style);
        doc.text(t.w, cx, y);
        cx += doc.getTextWidth(t.w);
      }
      y += lh;
      line = [];
      lineW = 0;
    };
    for (const t of words) {
      setStyle(size, t.style);
      const ww = doc.getTextWidth(t.w);
      if (lineW + ww > maxWidth && line.length && !/^\s+$/.test(t.w)) flush();
      if (line.length === 0 && /^\s+$/.test(t.w)) continue;
      line.push(t);
      lineW += ww;
    }
    if (line.length) flush();
  };
  const section = (title) => {
    y += 6;
    ensure(22);
    setStyle(12.5, "normal");
    doc.text(title.toUpperCase(), margin, y);
    y += 3;
    doc.setLineWidth(0.6);
    doc.line(margin, y, pageW - margin, y);
    y += 12;
  };
  const twoCol = (leftText, rightText, size, leftStyle, rightStyle) => {
    ensure(size * 1.3);
    setStyle(size, leftStyle);
    doc.text(leftText || "", margin, y);
    if (rightText) {
      setStyle(size, rightStyle);
      doc.text(rightText, pageW - margin, y, { align: "right" });
    }
    y += size * 1.3;
  };
  const bullets = (items) => {
    for (const b of items || []) {
      ensure(13);
      setStyle(9.5, "normal");
      doc.text("•", margin + 6, y);
      drawRich(b, margin + 18, width - 18, 9.5);
      y += 1;
    }
  };
  const strip = (u) => String(u || "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");

  const h = { ...(contact || {}), ...(resume.header || {}) };
  setStyle(19, "bold");
  ensure(30);
  doc.text(String(h.name || "").toUpperCase(), pageW / 2, y, { align: "center" });
  y += 16;
  const contactLine = [h.location, h.phone, h.email, h.github ? strip(h.github) : null, h.linkedin ? strip(h.linkedin) : null].filter(Boolean).join("  |  ");
  if (contactLine) {
    setStyle(9.5, "normal");
    doc.text(contactLine, pageW / 2, y, { align: "center" });
    y += 10;
  }

  if (resume.summary) {
    section("Profile");
    drawRich(resume.summary, margin, width, 9.5);
  }
  const groups = resume.skillGroups?.length ? resume.skillGroups : (resume.skills?.length ? [{ label: "Skills", skills: resume.skills }] : []);
  if (groups.length) {
    section("Skills");
    for (const g of groups) {
      if (!g?.skills?.length) continue;
      drawRich([{ text: `${g.label}: `, bold: true }, { text: g.skills.join(", "), bold: false }], margin, width, 9.5);
    }
  }
  if (resume.roles?.length) {
    section("Professional Experience");
    for (const r of resume.roles) {
      twoCol(r.company, [r.startDate, r.endDate].filter(Boolean).join(" – "), 10.5, "bold", "normal");
      twoCol(r.title, r.location, 9.5, "italic", "italic");
      y += 1;
      bullets(r.bullets);
      y += 3;
    }
  }
  if (resume.projects?.length) {
    section("Selected Projects");
    for (const p of resume.projects) {
      twoCol(p.name, p.link ? strip(p.link) : "", 10.5, "bold", "normal");
      bullets(p.bullets);
      y += 3;
    }
  }
  if (resume.education?.length) {
    section("Education");
    for (const e of resume.education) {
      twoCol(e.institution, [e.startDate, e.endDate].filter(Boolean).join(" – "), 10.5, "bold", "normal");
      twoCol(e.degree, e.location, 9.5, "italic", "italic");
      y += 2;
    }
  }
  if (resume.certifications?.length) {
    section("Certifications");
    bullets(resume.certifications);
  }

  doc.save(`${safeFileName(fileBase)}.pdf`);
}
