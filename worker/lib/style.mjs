// style.mjs
//
// Enforces the applicant's writing style on EVERY generated word (tailored
// resume bullets, cover letter, free-text answers):
//   - only comma and period as punctuation
//   - no em dashes, en dashes, semicolons, colons, exclamation or question marks
//   - no parentheses, brackets, quotes, ellipses
//   - simple, plain, human wording — no polished "AI" phrasing
//   - small grammatical imperfections are fine (do not over-correct)
//
// The generation PROMPT (STYLE_PROMPT) asks the model to write this way. The
// SANITIZER is the deterministic backstop: whatever the model returns, we strip
// it down to the allowed punctuation so a stray colon or em dash can never slip
// into a submitted application.

// Phrases that read as machine-written. Replaced with plainer wording.
const AI_TELLS = [
  [/\bI am (excited|thrilled|delighted|eager) to\b/gi, "I want to"],
  [/\b(leverage|utilize)\b/gi, "use"],
  [/\b(delve into|dive deep into)\b/gi, "look at"],
  [/\b(furthermore|moreover|additionally)\b/gi, "also"],
  [/\b(in conclusion|to conclude)\b/gi, "so"],
  [/\ba testament to\b/gi, "a sign of"],
  [/\bseamlessly\b/gi, "easily"],
  [/\brobust\b/gi, "strong"],
  [/\bspearheaded\b/gi, "led"],
  [/\bfacilitate\b/gi, "help"],
];

/** Strip text down to the allowed style. Deterministic and idempotent.
 *  Keeps letters, numbers, spaces, comma, period, and the apostrophe inside
 *  contractions (removing it turns "don't" into "dont", which reads as broken
 *  rather than casual). Everything else becomes a comma, a period, or nothing. */
export function sanitizeText(input) {
  if (!input) return "";
  let s = String(input);

  // Normalize newlines to spaces for single-line answers happens at the caller;
  // here we preserve paragraph breaks but clean each line.
  for (const [re, rep] of AI_TELLS) s = s.replace(re, rep);

  s = s
    .replace(/[‒–—―]/g, ", ") // figure/en/em dashes, horizontal bar
    .replace(/\s*[;]\s*/g, ". ") // semicolon ends a thought
    .replace(/\s*[:]\s*/g, ", ") // colon becomes a pause
    .replace(/[!?]+/g, ".") // exclamations / questions become periods
    .replace(/…/g, ".") // ellipsis
    .replace(/[()[\]{}<>]/g, "") // brackets removed, content kept
    .replace(/[“”]/g, "") // curly double quotes removed
    .replace(/[‘’]/g, "'") // curly single quotes -> straight apostrophe
    .replace(/"/g, "") // straight double quotes removed
    .replace(/'/g, (m, i, str) => {
      // keep an apostrophe only when it sits inside a word (don't, it's);
      // drop it when used as a quote mark
      const prev = str[i - 1] || "";
      const next = str[i + 1] || "";
      return /[A-Za-z]/.test(prev) && /[A-Za-z]/.test(next) ? "'" : "";
    });

  s = s
    .replace(/\s+([,.])/g, "$1") // no space before comma/period
    .replace(/([,.])(?=[^\s])/g, "$1 ") // one space after
    .replace(/\.\s*\.\s*(\.\s*)+/g, ". ") // collapse repeated periods
    .replace(/,\s*,+/g, ", ") // collapse repeated commas
    .replace(/\s{2,}/g, " ") // collapse runs of spaces
    .replace(/^[\s,.]+/, "") // no leading punctuation
    .trimEnd();

  // Ensure it ends with a single period if it ends mid-sentence.
  if (s && !/[.]$/.test(s)) s += ".";
  return s;
}

/** Sanitize a multi-paragraph block (e.g. a cover letter), keeping paragraph
 *  breaks but cleaning each line. */
export function sanitizeBlock(input) {
  if (!input) return "";
  return String(input)
    .split(/\n{2,}/)
    .map((para) => sanitizeText(para.replace(/\n/g, " ")))
    .filter(Boolean)
    .join("\n\n");
}

/** The style instructions handed to the model. Kept in one place so every
 *  generation function (resume, cover letter, answers) writes the same way. */
export const STYLE_PROMPT = [
  "Write in plain simple English.",
  "Use short sentences and common everyday words.",
  "Use only two punctuation marks, the comma and the period.",
  "Do not use em dashes, en dashes, semicolons, colons, exclamation marks, question marks, parentheses, quotes, or bullets.",
  "Do not write like an AI. Avoid words like leverage, robust, seamless, delve, furthermore, spearheaded, and phrases like I am excited to.",
  "It is fine if the grammar is not perfect. Sound like a normal person typing quickly.",
  "Be specific and honest. Do not invent facts that are not in the resume or profile.",
].join(" ");
