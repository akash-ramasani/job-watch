// pdf.mjs — render a tailored resume and a cover letter to clean one-page PDFs
// using pdfkit (no headless browser). Plain, readable, ATS-friendly layout
// (single column, standard fonts, real text so parsers can read it).

import PDFDocument from "pdfkit";
import { createWriteStream } from "node:fs";

function done(doc, path) {
  return new Promise((resolve, reject) => {
    const stream = createWriteStream(path);
    doc.pipe(stream);
    stream.on("finish", () => resolve(path));
    stream.on("error", reject);
    doc.end();
  });
}

const HEAD = "#111111";
const BODY = "#222222";
const MUTE = "#555555";

/** Contact line from the profile, using only plain separators. */
function contactLine(p) {
  return [p.email, p.phone, p.linkedin, p.github, p.portfolio, p.country]
    .filter(Boolean)
    .join("  .  ");
}

/** Render a tailored resume.
 *  data = { name, contact, summary, skills[], roles[{title,company,dates,bullets[]}] } */
export async function renderResume(data, path) {
  const doc = new PDFDocument({ size: "LETTER", margins: { top: 54, bottom: 54, left: 54, right: 54 } });

  doc.fillColor(HEAD).font("Helvetica-Bold").fontSize(20).text(data.name || "");
  if (data.contact) doc.moveDown(0.2).fillColor(MUTE).font("Helvetica").fontSize(9).text(data.contact);
  doc.moveDown(0.6);

  const section = (title) => {
    doc.moveDown(0.5).fillColor(HEAD).font("Helvetica-Bold").fontSize(11).text(title.toUpperCase());
    doc.moveTo(doc.x, doc.y + 1).lineTo(558, doc.y + 1).strokeColor("#cccccc").stroke();
    doc.moveDown(0.4);
  };

  if (data.summary) {
    section("Summary");
    doc.fillColor(BODY).font("Helvetica").fontSize(10).text(data.summary, { lineGap: 1.5 });
  }

  if (data.skills?.length) {
    section("Skills");
    doc.fillColor(BODY).font("Helvetica").fontSize(10).text(data.skills.join(", "), { lineGap: 1.5 });
  }

  if (data.roles?.length) {
    section("Experience");
    for (const r of data.roles) {
      doc.fillColor(HEAD).font("Helvetica-Bold").fontSize(10.5).text(`${r.title || ""}`, { continued: !!r.company });
      if (r.company) doc.font("Helvetica").fillColor(MUTE).text(`   ${r.company}${r.dates ? "  .  " + r.dates : ""}`);
      doc.moveDown(0.15);
      for (const b of r.bullets || []) {
        doc.fillColor(BODY).font("Helvetica").fontSize(9.5).text(`.  ${b}`, { indent: 8, lineGap: 1 });
      }
      doc.moveDown(0.4);
    }
  }

  return done(doc, path);
}

/** Render a cover letter. text is the plain body; header is the candidate block. */
export async function renderCoverLetter(text, header, path) {
  const doc = new PDFDocument({ size: "LETTER", margins: { top: 60, bottom: 60, left: 60, right: 60 } });

  doc.fillColor(HEAD).font("Helvetica-Bold").fontSize(14).text(header.name || "");
  if (header.contact) doc.moveDown(0.15).fillColor(MUTE).font("Helvetica").fontSize(9).text(header.contact);
  doc.moveDown(1);

  if (header.companyName) {
    doc.fillColor(BODY).font("Helvetica").fontSize(10).text(header.companyName);
    if (header.jobTitle) doc.fillColor(MUTE).text(header.jobTitle);
    doc.moveDown(1);
  }

  for (const para of String(text).split(/\n{2,}/)) {
    doc.fillColor(BODY).font("Helvetica").fontSize(10.5).text(para.trim(), { lineGap: 2, align: "left" });
    doc.moveDown(0.8);
  }

  return done(doc, path);
}
