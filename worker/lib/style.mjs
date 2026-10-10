// style.mjs
//
// Enforces the applicant's writing style on EVERY generated word (tailored
// resume bullets, cover letter, free-text answers):
//   - the period is the only punctuation mark (no commas, dashes, semicolons,
//     colons, exclamation or question marks, parentheses, brackets, quotes,
//     ellipses, bullets)
//   - short sentences, one idea each, the words a ten year old knows
//   - plain, human wording, no polished "AI" phrasing
//   - small grammatical imperfections are fine (do not over-correct)
//
// The generation PROMPT (STYLE_PROMPT) asks the model to write this way. The
// SANITIZER is the deterministic backstop: whatever the model returns, we strip
// it down to the allowed punctuation so a stray colon or em dash can never slip
// into a submitted application. The READABILITY check tells the caller when an
// answer still reads too hard so it can ask for a simpler one.

// Phrases that read as machine-written, or words a ten year old would not use.
// Replaced with plainer wording.
const AI_TELLS = [
  [/\bI am (excited|thrilled|delighted|eager) to\b/gi, "I want to"],
  [/\b(leverage|utilize|utilise)\b/gi, "use"],
  [/\b(leveraged|utilized|utilised)\b/gi, "used"],
  [/\b(delve into|dive deep into)\b/gi, "look at"],
  [/\b(furthermore|moreover|additionally)\b/gi, "also"],
  [/\b(in conclusion|to conclude)\b/gi, "so"],
  [/\ba testament to\b/gi, "a sign of"],
  [/\bseamlessly\b/gi, "easily"],
  [/\brobust\b/gi, "strong"],
  [/\bspearheaded\b/gi, "led"],
  [/\bfacilitate\b/gi, "help"],
  [/\bfacilitated\b/gi, "helped"],
  [/\b(implement|implemented|implementing)\b/gi, (m) => ({ implement: "build", implemented: "built", implementing: "building" })[m.toLowerCase()]],
  [/\b(optimize|optimise)\b/gi, "improve"],
  [/\b(optimized|optimised)\b/gi, "improved"],
  [/\bcollaborate(d)?\b/gi, (m, d) => (d ? "worked" : "work") + " together"],
  [/\bcommunicate(d)?\b/gi, (m, d) => (d ? "talked" : "talk")],
  [/\bprioritize(d)?\b/gi, (m, d) => (d ? "put first" : "put first")],
  [/\bdemonstrate(d)?\b/gi, (m, d) => (d ? "showed" : "show")],
  [/\bsubsequently\b/gi, "then"],
  [/\bapproximately\b/gi, "about"],
  [/\bnumerous\b/gi, "many"],
  [/\bsufficient\b/gi, "enough"],
  [/\bobtain(ed)?\b/gi, (m, d) => (d ? "got" : "get")],
  [/\bcommence(d)?\b/gi, (m, d) => (d ? "started" : "start")],
  [/\bassist(ed)?\b/gi, (m, d) => (d ? "helped" : "help")],
  [/\bpassionate about\b/gi, "really into"],
  [/\bin order to\b/gi, "to"],
];

/** Strip text down to the allowed style. Deterministic and idempotent.
 *  Keeps letters, numbers, spaces, the period, and the apostrophe inside
 *  contractions (removing it turns "don't" into "dont", which reads as broken
 *  rather than casual). A comma between two real clauses becomes a period; a
 *  comma inside a list or a date is simply dropped. Everything else becomes a
 *  period or nothing. */
export function sanitizeText(input) {
  if (!input) return "";
  let s = String(input);

  for (const [re, rep] of AI_TELLS) s = s.replace(re, rep);

  s = s
    .replace(/[‒–—―]/g, ". ") // figure/en/em dashes, horizontal bar end a thought
    .replace(/\s+-\s+/g, ". ") // a spaced hyphen used as a dash
    .replace(/\s*[;:]\s*/g, ". ") // semicolon and colon end a thought
    .replace(/[!?]+/g, ".") // exclamations / questions become periods
    .replace(/…/g, ".") // ellipsis
    .replace(/^\s*[-*•·]\s+/gm, "") // bullet markers at line starts
    .replace(/[()[\]{}<>]/g, "") // brackets removed, content kept
    .replace(/[“”"]/g, "") // double quotes removed
    .replace(/[‘’]/g, "'") // curly single quotes -> straight apostrophe
    .replace(/'/g, (m, i, str) => {
      const prev = str[i - 1] || "";
      const next = str[i + 1] || "";
      return /[A-Za-z]/.test(prev) && /[A-Za-z]/.test(next) ? "'" : "";
    })
    .replace(/[&+/\\|~^#@%$*_=`]/g, (m) => (m === "&" ? " and " : m === "%" ? " percent" : m === "$" ? "" : m === "/" ? " or " : " "))
    .replace(/(\d),(?=\d)/g, "$1"); // 10,000 -> 10000

  // Commas: a period between two real clauses, dropped inside lists and dates.
  s = s.replace(/\s*,\s*/g, (m, i, str) => {
    const before = str.slice(0, i).split(/[.\n]/).pop().trim().split(/\s+/).filter(Boolean);
    const after = str.slice(i + m.length).split(/[.\n]/)[0].trim().split(/\s+/).filter(Boolean);
    const clause = before.length >= 3 && after.length >= 3 && /^(i|we|you|they|it|he|she|this|that|so|but|and|which|because|then|my|our)$/i.test(after[0] || "");
    return clause ? ". " : " ";
  });

  s = s
    .replace(/\s+\./g, ".") // no space before a period
    .replace(/(?<=[a-z0-9])\.(?=[A-Z])/g, ". ") // sentence boundary spacing, keeps Node.js and 3.5
    .replace(/\.\s*\.\s*(\.\s*)*/g, ". ") // collapse repeated periods
    .replace(/\s{2,}/g, " ") // collapse runs of spaces
    .replace(/^[\s.]+/, "") // no leading punctuation
    .replace(/(^|\. )([a-z])/g, (m, p, c) => p + c.toUpperCase()) // a new sentence starts with a capital
    .trimEnd();

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

/** How hard the text reads. avgWords = words per sentence, longShare = share
 *  of words with ten letters or more. simple = both within a ten year old's
 *  range (at most 14 words a sentence, at most one long word in ten). */
export function readability(text) {
  const sentences = String(text || "").split(/[.\n]+/).map((x) => x.trim()).filter(Boolean);
  const words = sentences.flatMap((x) => x.split(/\s+/).filter(Boolean));
  const avgWords = sentences.length ? words.length / sentences.length : 0;
  const long = words.filter((w) => w.replace(/[^A-Za-z]/g, "").length >= 10).length;
  const longShare = words.length ? long / words.length : 0;
  return { sentences: sentences.length, words: words.length, avgWords, longShare, simple: avgWords <= 14 && longShare <= 0.1 };
}

/** The style instructions handed to the model. Kept in one place so every
 *  generation function (resume, cover letter, answers) writes the same way. */
export const STYLE_PROMPT = [
  "Write like a normal person, not like a machine.",
  "Use the words a ten year old knows. Short sentences. One idea in each sentence.",
  "Say things in a simple way so anyone can understand them.",
  "The period is the only punctuation mark you may use. End every sentence with a period.",
  "Do not use commas, dashes, semicolons, colons, exclamation marks, question marks, parentheses, quotes, bullets, or symbols. Join list items with the word and.",
  "Do not use big words like leverage, robust, seamless, delve, furthermore, utilize, implement, optimize, facilitate, or phrases like I am excited to or passionate about.",
  "It is fine if the grammar is not perfect. Sound like a person typing in their own words.",
  "Be specific and honest. Do not invent facts that are not in the resume or profile.",
].join(" ");
