// coverPdf.cjs — render a short cover letter to a one-page PDF buffer with
// pdfkit (real text, single column, standard fonts, so ATS parsers read it).
// Mirrors worker/lib/pdf.mjs renderCoverLetter, but returns bytes instead of
// writing a file, for the extension to attach to an Ashby File field.

const PDFDocument = require("pdfkit");

const HEAD = "#111111";
const BODY = "#222222";
const MUTE = "#555555";

/** Contact line for the header. Plain separators only. */
function contactLine(p) {
  const linkedin = p.linkedin && !/^https?:/.test(p.linkedin) ? `linkedin.com/in/${p.linkedin}` : p.linkedin;
  const github = p.github && !/^https?:/.test(p.github) ? `github.com/${p.github}` : p.github;
  return [p.email, p.phone, linkedin, github, p.portfolio].filter(Boolean).join("  .  ");
}

/**
 * @param {string} text   plain cover letter body, paragraphs split by blank lines
 * @param {object} header { name, contact?, companyName?, jobTitle? }
 * @returns {Promise<Buffer>}
 */
function renderCoverLetterPdf(text, header) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margins: { top: 60, bottom: 60, left: 60, right: 60 } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fillColor(HEAD).font("Helvetica-Bold").fontSize(14).text(header.name || "");
    if (header.contact) doc.moveDown(0.15).fillColor(MUTE).font("Helvetica").fontSize(9).text(header.contact);
    doc.moveDown(1);

    if (header.companyName) {
      doc.fillColor(BODY).font("Helvetica").fontSize(10).text(header.companyName);
      if (header.jobTitle) doc.fillColor(MUTE).text(header.jobTitle);
      doc.moveDown(1);
    }

    for (const para of String(text || "").split(/\n{2,}/)) {
      const t = para.trim();
      if (!t) continue;
      doc.fillColor(BODY).font("Helvetica").fontSize(10.5).text(t, { lineGap: 2, align: "left" });
      doc.moveDown(0.8);
    }
    doc.end();
  });
}

module.exports = { renderCoverLetterPdf, contactLine };
