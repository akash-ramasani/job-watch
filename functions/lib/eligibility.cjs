/**
 * functions/lib/eligibility.cjs
 *
 * Does a job description rule out someone who needs visa sponsorship?
 * Three explicit statements count, and only when stated as a requirement:
 *   - citizen:        US citizenship required ("must be a U.S. citizen",
 *                     "U.S. citizens only", "U.S. citizenship is contractually required")
 *   - clearance:      a security clearance required ("active TS/SCI required",
 *                     "Clearance Required: Secret", "Secret clearance post-start is required")
 *   - no_sponsorship: the employer won't sponsor ("unable to sponsor", "no visa
 *                     sponsorship", "without the need for current or future sponsorship")
 *
 * Built to never flag a legitimate job:
 *   - checked sentence by sentence ("U.S." no longer splits a sentence);
 *   - each kind has its own softeners: "preferred", "a plus", "not required"
 *     for all; "ability to obtain" only softens a clearance line; "we do
 *     sponsor", "sponsorship available" only soften a sponsorship line;
 *   - hedged or partial lines don't count ("may support federal work", "for
 *     certain roles", "not for every role", "unless");
 *   - a citizenship line that also accepts visa holders doesn't count;
 *   - questions from application forms don't count.
 * Boilerplate like "without regard to citizenship status" or "must be
 * authorized to work in the US" never matches. Tests: test/eligibility.test.cjs.
 */

const US = "(?:u\\.?\\s?s\\.?|united states|american)";
const re = (s) => new RegExp(s, "i");

const PHRASES = {
  citizen: [
    re(`\\bmust (?:be|hold|have|possess|maintain)(?: a| an)? (?:\\(i\\) )?${US} citizen(?:ship)?\\b`),
    re(`\\b${US} citizenship\\b[^.;]{0,25}\\b(?:required|mandatory|a requirement|needed|a must|is a condition)\\b`),
    re(`\\b(?:requires?|requiring|required:?) (?:active |current )?${US} citizenship\\b`),
    re(`\\b(?:requires?|requiring) (?:you|candidates|applicants|the candidate) to be (?:a )?${US} citizens?\\b`),
    re(`\\b${US} citizens? only\\b`),
    re(`\\bonly ${US} citizens\\b`),
    re(`\\b(?:open|available|limited|restricted) (?:only )?to ${US} citizens\\b`),
    re(`\\b(?:applicants|candidates|you) must be ${US} citizens?\\b`),
    re(`\\bcitizenship:?\\s*${US}(?: citizen)?(?: is)? required\\b`),
    re(`\\b${US} citizen\\s*\\(?\\s*(?:required|only)\\b`),
    re(`\\b${US} citizen(?:ship)? (?:or|and) (?:lawful )?permanent resident(?:s| status)? (?:only|required)\\b`),
    re(`\\b${US} citizenship (?:and|&) [^.;]{0,90}\\b(?:are|is) required\\b`),
  ],
  clearance: [
    re(`\\b(?:active|current|existing)\\b[^.;]{0,40}\\b(?:ts\\/sci|top secret|secret|security|dod|doe|q|l)\\b[^.;]{0,20}\\bclearance\\b[^.;]{0,30}\\b(?:required|needed|must)\\b`),
    re(`\\bmust (?:currently )?(?:have|hold|possess|maintain)(?: an?)? (?:active|current)\\b[^.;]{0,40}\\bclearance\\b`),
    re(`\\b(?:requires?|required:?|requiring) (?:an? )?(?:active|current)\\b[^.;]{0,40}\\bclearance\\b`),
    re(`\\bclearance(?: level)?(?: requirement| required)?:\\s*(?:active |current )?(?:ts\\/sci|top secret|secret)\\b`),
    re(`\\b(?:ts\\/sci|top secret|secret)(?: security)? clearance(?: with [^.;]{0,30})?(?: post[- ]?start)? (?:is )?required\\b`),
    re(`\\b(?:active|current) (?:ts\\/sci|top secret)(?: clearance)?(?: with (?:a )?(?:full[- ]scope |ci )?poly(?:graph)?)? (?:is )?required\\b`),
    re(`\\b(?:will )?requires? an? (?:active |current )?(?:security|secret|top secret|ts\\/sci|government) (?:security )?clearance\\b`),
  ],
  no_sponsorship: [
    re(`\\b(?:unable|not able|cannot|can ?not|can't|won't|will not|do not|does not|don't|doesn't|is not|are not|aren't|isn't|must not|should not)\\b[^.;]{0,70}\\bsponsor(?:ship|ing)?\\b`),
    re(`\\bnot (?:currently )?sponsoring\\b`),
    re(`\\bno (?:visa |immigration |h-?1b |employment |employer )?sponsorship\\b`),
    re(`\\b(?:visa |immigration |h-?1b |employment |work )?sponsorship (?:is |will )?(?:not|n't) (?:be )?(?:available|offered|provided|possible|supported|an option)\\b`),
    re(`\\bnot (?:be )?(?:eligible|considered) for (?:u\\.s\\. |us )?(?:employer |visa |immigration |employment |work )*sponsorship\\b`),
    re(`\\bwithout (?:the )?(?:need|requirement|requiring|needing)(?: for)?(?: of)? (?:current or future |now or in the future |any )?(?:employer |visa |immigration |company )?sponsorship\\b`),
    re(`\\b(?:visa |work )?sponsorship:?\\s*(?:no|none|not (?:available|provided|offered))\\b`),
    re(`\\b(?:take over|transfer) (?:visa |h-?1b )?sponsorship\\b`),
    re(`\\brequire\\w*[^.;]{0,60}\\bsponsorship\\b[^.;]{0,60}\\b(?:should not apply|not eligible|will not be considered)\\b`),
  ],
};

// Softeners for every kind.
const SOFT = /\b(preferred|a plus|is a plus|nice to have|desired|desirable|bonus|ideally|advantageous|not required|not a requirement|is not necessary|isn't required|no clearance|(?:does|do|will|would) not (?:require|need)|doesn't (?:require|need)|don't (?:require|need)|not needed)\b/i;
// Hedged or partial statements.
const HEDGES = /\b(may|might|could|possibly|(?:for|in|to) certain|certain (?:roles|positions|other|restricted|jobs)|some roles|some positions|positions with|roles with|remote roles|every role|every candidate|all roles|case[- ]by[- ]case|unless|usually|typically|uncleared|are welcome|is welcome)\b/i;
const SOFT_BY_KIND = {
  citizen: /\bnot (?:be )?required to be (?:a )?(?:us|u\.s\.) citizen\b/i,
  clearance: /\b(ability to obtain|able to obtain|eligib\w* (?:to|for)|obtain and maintain|willing(?:ness)? to obtain|or have the ability|clearance required:?\s*none|public trust)\b/i,
  no_sponsorship: /\b(we (?:do|can|will|are able to) (?:offer|provide|sponsor|support)|(?<!no (?:visa |immigration )?)sponsorship (?:is )?(?:available|offered|provided)(?! for this)|visa sponsorship: ?yes|open to sponsor|will consider sponsor|sponsored programs?|sponsor(?:ed|s)? (?:events?|programs?|research|projects?|by)|corporate sponsor|executive sponsor)\b/i,
};
// A citizenship line that also accepts visa holders doesn't rule them out.
const VISA_ALTERNATIVE = /\b(or|and)\b[^.;]{0,80}\b(visa|f-?1|opt|cpt|h-?1b|work authori[sz]ation|authorized to work|eligible to work|employment authori[sz]ation|valid work)\b/i;
// Questions (from application forms pasted into descriptions) aren't statements.
const QUESTION = /\?\s*$/;

function sentencesOf(description) {
  const text = String(description || "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;|&#8217;/g, "'").replace(/&quot;|&#34;/g, '"').replace(/&#xa;/gi, "\n")
    .replace(/<\s*(br|\/p|\/li|\/h\d|\/div)\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ")
    // Abbreviations with periods would split a sentence in two.
    .replace(/\bU\.\s?S\.\s?A\.?/g, "USA").replace(/\bU\.\s?S\.(?=\s|,|\))/g, "US").replace(/\b(e\.g|i\.e|etc|Inc|Corp|Co|No)\./g, "$1");
  return text.split(/\n+|(?<=[.!?])\s+(?=[A-Z(])/).map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s.length > 8);
}

/**
 * @returns {{ flags: string[], evidence: Record<string,string> }}
 *   flags ⊆ ["citizen", "clearance", "no_sponsorship"]; evidence = the sentence that matched.
 */
function eligibilityOf(description) {
  const evidence = {};
  for (const sentence of sentencesOf(description)) {
    if (QUESTION.test(sentence) || SOFT.test(sentence) || HEDGES.test(sentence)) continue;
    for (const [flag, patterns] of Object.entries(PHRASES)) {
      if (evidence[flag] || SOFT_BY_KIND[flag].test(sentence) || !patterns.some((p) => p.test(sentence))) continue;
      if (flag === "citizen" && VISA_ALTERNATIVE.test(sentence)) continue;
      evidence[flag] = sentence.slice(0, 300);
    }
  }
  return { flags: Object.keys(evidence), evidence };
}

const REASONS = {
  citizen: "Requires US citizenship",
  clearance: "Requires a security clearance",
  no_sponsorship: "No visa sponsorship",
};

/** For a user who needs sponsorship: the reason this job is ruled out, or null. */
function blockedReason(flags, needsSponsorship) {
  if (!needsSponsorship || !Array.isArray(flags) || !flags.length) return null;
  const first = ["citizen", "clearance", "no_sponsorship"].find((f) => flags.includes(f));
  return first ? REASONS[first] : null;
}

/** Does this user need sponsorship? From the Profile form (users/{uid}.requiresSponsorship). */
const needsSponsorship = (userDoc) => /^y(es)?$/i.test(String(userDoc?.requiresSponsorship || "").trim());

module.exports = { eligibilityOf, blockedReason, needsSponsorship, sentencesOf, REASONS };
