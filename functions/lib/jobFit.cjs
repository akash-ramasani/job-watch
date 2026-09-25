/**
 * functions/lib/jobFit.cjs
 *
 * How well a candidate's profile covers a job, as a number that can be
 * explained line by line. Replaces the old single-shot "relevance score",
 * which asked the model for a vibe and got bimodal answers (85+ or <30,
 * nothing in between) that often disagreed with the requirement-by-
 * requirement match report.
 *
 *   1. The model lists the job's key requirements (must / nice), and for
 *      each says whether the profile covers it — quoting the profile.
 *   2. Quotes are checked against the profile here; a claim whose quote
 *      isn't in the profile drops a level (yes → partial → no).
 *   3. The score is arithmetic: must-haves weigh 2, nice-to-haves 1;
 *      yes = 1, partial = ½.
 *   4. Role and seniority caps: a sales job can't score 40 because the
 *      candidate "communicates well", an internship can't top the list.
 *
 * The same assessment backs the job card's number and the Resume popup's
 * match report, so they always agree.
 */

const FIT_VERSION = 2;

const STOP = new Set([
  "with", "that", "this", "from", "into", "across", "using", "through", "their", "while", "where", "which", "about",
  "after", "before", "under", "over", "between", "within", "without", "including", "experience", "experienced",
  "years", "year", "team", "teams", "work", "worked", "working", "have", "has", "had", "been", "were", "also",
  "strong", "skilled", "skills", "ability", "abilities", "knowledge", "understanding", "familiar", "familiarity",
  "proficient", "proficiency", "candidate", "role", "roles", "such", "other", "more", "most", "very", "well",
  "built", "build", "building", "develop", "developed", "developing", "design", "designed", "designing",
  "system", "systems", "service", "services", "production", "platform", "platforms", "solutions", "solution",
]);

const norm = (s) => String(s || "").toLowerCase().replace(/\*\*/g, "").replace(/[^a-z0-9+#.]+/g, " ").replace(/\s+/g, " ").trim();
const contentWords = (s) => norm(s).split(" ").map((w) => w.replace(/^\.+|\.+$/g, "")).filter((w) => (w.length >= 3 || /[+#]/.test(w)) && !STOP.has(w));

/** Everything the candidate has written about themselves, for the prompt. */
function buildProfileText(profile, maxChars = 7000) {
  const p = profile || {};
  const plain = (s) => String(s || "").replace(/\*\*/g, "");
  const groups = Array.isArray(p.skillGroups) && p.skillGroups.length
    ? p.skillGroups
    : (p.skills?.length ? [{ label: "Skills", skills: p.skills }] : []);
  const parts = [];
  if (p.summary) parts.push(`SUMMARY\n${plain(p.summary)}`);
  if (groups.length) parts.push(`SKILLS\n${groups.map((g) => `${g.label}: ${(g.skills || []).join(", ")}`).join("\n")}`);
  if (p.roles?.length) {
    parts.push(`EXPERIENCE\n${p.roles.map((r) => {
      const head = `${r.title || ""} at ${r.company || ""} (${[r.startDate, r.endDate].filter(Boolean).join(" - ")})`;
      const bullets = plain(r.description).split("\n").map((b) => b.trim()).filter(Boolean).map((b) => `- ${b}`).join("\n");
      return `${head}\n${bullets}`;
    }).join("\n\n")}`);
  }
  if (p.projects?.length) {
    parts.push(`PROJECTS\n${p.projects.map((x) => `${x.name || ""}${x.techStack ? ` (${x.techStack})` : ""}\n${plain(x.description).split("\n").filter(Boolean).map((b) => `- ${b.trim()}`).join("\n")}`).join("\n\n")}`);
  }
  if (p.education?.length) parts.push(`EDUCATION\n${p.education.map((e) => `${e.degree || ""}, ${e.institution || ""}`).join("\n")}`);
  if (p.certifications?.length) parts.push(`CERTIFICATIONS\n${p.certifications.join("\n")}`);
  if (p.extraExperience) parts.push(`ALSO DONE (not on resume)\n${plain(p.extraExperience)}`);
  let text = parts.join("\n\n");
  if (text.length < 200 && p.rawText) text = `${text}\n\n${p.rawText}`;
  return text.slice(0, maxChars);
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
function parseMonth(s, now = new Date()) {
  const t = String(s || "").trim().toLowerCase();
  if (!t) return null;
  if (/present|current|now|today/.test(t)) return now.getFullYear() * 12 + now.getMonth();
  const y = t.match(/(19|20)\d{2}/);
  if (!y) return null;
  const m = t.match(/[a-z]{3,4}/);
  const month = m && MONTHS[m[0]] != null ? MONTHS[m[0]] : 0;
  return Number(y[0]) * 12 + month;
}

/** Years of professional experience from the profile's role dates (overlaps merged). */
function candidateYearsOf(profile, now = new Date()) {
  const spans = (profile?.roles || [])
    .map((r) => [parseMonth(r.startDate, now), parseMonth(r.endDate || "present", now)])
    .filter(([a, b]) => a != null && b != null && b >= a)
    .sort((x, y) => x[0] - y[0]);
  let months = 0;
  let cur = null;
  for (const [a, b] of spans) {
    if (!cur || a > cur[1]) { if (cur) months += cur[1] - cur[0]; cur = [a, b]; } else cur[1] = Math.max(cur[1], b);
  }
  if (cur) months += cur[1] - cur[0];
  return Math.round((months / 12) * 10) / 10;
}

// Titles decide the clear cases; the model only supplies the job's minimum years.
const ENTRY_TITLE_RE = /\b(intern|internship|co-?op|new grad|new college grad|university grad|recent grad|graduate program|early career|apprentice|entry[- ]level|campus)\b/i;
const ABOVE_TITLE_RE = /\b(principal|distinguished|fellow|director|vp|vice president|head of|chief|cto)\b/i;
const SOFTWARE_TITLE_RE = /\b(software (engineer|developer|development engineer)|sde|swe|back-?end (engineer|developer)|full[- ]?stack|forward[- ]deployed|platform engineer|web developer|front-?end (engineer|developer)|mobile (engineer|developer)|ios (engineer|developer)|android (engineer|developer))\b/i;
const ADJACENT_TITLE_RE = /\b(data engineer|devops|site reliability|sre|(ml|machine learning|ai) engineer|solutions? architect|cloud engineer|infrastructure engineer|security engineer|qa automation|test automation|sdet|data scientist|analytics engineer)\b/i;

/** Change stamp for a profile: assessments made against an older profile are stale. */
function profileStampOf(profile) {
  const t = profile?.updatedAt;
  if (t && typeof t.toMillis === "function") return t.toMillis();
  if (t && typeof t._seconds === "number") return t._seconds * 1000;
  return 0;
}

/**
 * Is a quoted piece of evidence really in the profile? Allows paraphrase at
 * the edges: at least 60% of its content words (and at least 2, or the
 * single word for a one-word quote) must appear in the profile.
 */
function evidenceSupported(evidence, profileWords) {
  const words = contentWords(evidence);
  if (words.length === 0) return false;
  const hits = words.filter((w) => profileWords.has(w)).length;
  if (words.length === 1) return hits === 1;
  return hits >= 2 && hits / words.length >= 0.6;
}

// Personality and vague qualities aren't checkable against a resume; the prompt
// says to skip them, but the model doesn't always, so they're dropped here.
const SOFT_REQ_RE = /\b(ambiguit|exceptional|first[- ]principles|passion|curio|communicat|collaborat|team player|teamwork|self[- ]starter|ownership|owner mindset|talk to users|fast[- ]paced|growth mindset|attention to detail|detail[- ]oriented|problem[- ]solv|work ethic|motivat|thrive|hungry|humble|interpersonal|proactive|adaptab|flexib|energetic|enthusias|evidence of|sense of urgency|bias (for|to) action|customer[- ]obsess|entrepreneurial|scrappy|comfortable with)/i;

const COVER_VALUE = { yes: 1, partial: 0.5, no: 0 };

/** Pure: turn the model's raw answer into a checked, scored assessment. */
function scoreAssessment(raw, profileText, { jobTitle = "", candidateYears = null } = {}) {
  const profileWords = new Set(contentWords(profileText));
  const reqs = (Array.isArray(raw?.requirements) ? raw.requirements : [])
    .map((q) => ({
      requirement: String(q.requirement || q.r || "").trim(),
      need: /nice|prefer|bonus|plus/i.test(String(q.need || q.n || "")) ? "nice" : "must",
      covered: ["yes", "partial", "no"].includes(String(q.covered || q.c || "").toLowerCase()) ? String(q.covered || q.c).toLowerCase() : "no",
      evidence: String(q.evidence || q.e || "").trim(),
    }))
    .filter((q) => q.requirement && !SOFT_REQ_RE.test(q.requirement))
    .slice(0, 14);

  let downgraded = 0;
  for (const q of reqs) {
    if (q.covered === "no") { q.evidence = ""; continue; }
    if (!evidenceSupported(q.evidence, profileWords)) {
      q.covered = q.covered === "yes" ? "partial" : "no";
      if (q.covered === "no") q.evidence = "";
      downgraded++;
    }
  }

  const weight = (q) => (q.need === "must" ? 2 : 1);
  const total = reqs.reduce((a, q) => a + weight(q), 0);
  const got = reqs.reduce((a, q) => a + weight(q) * COVER_VALUE[q.covered], 0);
  const coverage = total ? Math.round((got / total) * 100) : 0;

  // Role: the model judges the kind of work; titles overrule it for software
  // jobs, where a different domain (BCI, pathology, ads) is not a different field.
  let roleFit = ["same", "adjacent", "different"].includes(raw?.roleFit) ? raw.roleFit : "same";
  if (SOFTWARE_TITLE_RE.test(jobTitle)) roleFit = "same";
  else if (roleFit === "different" && ADJACENT_TITLE_RE.test(jobTitle)) roleFit = "adjacent";

  // Level: decided here, not by the model — titles for the clear cases,
  // the job's minimum years against the candidate's for the rest.
  const minYears = Number.isFinite(Number(raw?.minYears)) && raw?.minYears !== null && raw?.minYears !== "" ? Number(raw.minYears) : null;
  let level = "fits";
  if (ENTRY_TITLE_RE.test(jobTitle)) level = "entry";
  else if (ABOVE_TITLE_RE.test(jobTitle)) level = "above";
  else if (minYears != null && candidateYears != null && minYears > candidateYears + 2) level = "above";

  let score = coverage;
  let capNote = null;
  if (roleFit === "different" && score > 15) { score = 15; capNote = raw?.roleNote || "Different kind of role from yours"; }
  else if (roleFit === "adjacent" && score > 60) { score = 60; capNote = raw?.roleNote || "Related role, not quite yours"; }
  if (level === "entry" && score > 20) { score = 20; capNote = "Internship or entry-level role"; }
  if (level === "above" && score > 35) {
    score = 35;
    capNote = minYears != null && candidateYears != null && minYears > candidateYears + 2
      ? `Asks for ${minYears}+ years; your resume shows about ${Math.floor(candidateYears)}`
      : "More senior than your experience";
  }
  const seniorityFit = level === "entry" ? "too_junior" : level === "above" ? "too_senior" : "ok";

  return {
    version: FIT_VERSION,
    score,
    coverage,
    roleFit,
    seniorityFit,
    minYears,
    candidateYears,
    capNote,
    requirements: reqs,
    downgraded,
    reason: reasonFor({ score, requirements: reqs, capNote }),
  };
}

/** One line for the job card: what's covered and what isn't. */
function reasonFor({ requirements, capNote }) {
  const reqs = requirements || [];
  const must = reqs.filter((q) => q.need === "must");
  const base = must.length ? must : reqs;
  const yes = base.filter((q) => q.covered === "yes").length;
  const partly = base.filter((q) => q.covered === "partial").length;
  const missing = base.filter((q) => q.covered === "no").map((q) => shortReq(q.requirement));
  const head = `Covers ${yes} of ${base.length} ${must.length ? "must-haves" : "requirements"}${partly ? `, ${partly} partly` : ""}`;
  const tail = missing.length ? ` · missing ${missing.slice(0, 2).join(", ")}${missing.length > 2 ? ` +${missing.length - 2}` : ""}` : "";
  return capNote ? `${capNote} · ${head.toLowerCase()}` : `${head}${tail}`;
}
const QUALIFIER_RE = /^(?:proven|demonstrated|hands-on|strong|solid|deep|extensive|practical|working|professional|excellent|good|advanced|expert|prior|significant|some)\s+/i;
const LEAD_RE = /^(?:experience|expertise|knowledge|familiarity|proficiency|understanding|background|track record)(?:\s+(?:with|in|of|using|on))?\s+/i;
function shortReq(s) {
  let t = String(s || "").replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim();
  // "Hands-on experience with Kubernetes" → "Kubernetes"; years stay ("5+ years backend").
  for (let prev = ""; prev !== t; ) { prev = t; t = t.replace(QUALIFIER_RE, "").replace(LEAD_RE, ""); }
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (t.length <= 38) return t;
  const cut = t.slice(0, 37);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : 37).replace(/[\s,;:/-]+$/, "")}…`;
}

const SYSTEM_PROMPT = `You compare one job description with one candidate's profile. You are strict and literal.

1. List the job's 6-12 most important requirements, in the job's own words, shortest form (e.g. "Kubernetes", "5+ years backend development", "Go or Java", "Security+ certification"). Mark each "must" (required / minimum qualifications) or "nice" (preferred / bonus).
   Only concrete, checkable things: technologies, tools, languages, domains, years of experience, degrees, certifications, clearances, specific responsibilities. NEVER list personality traits or vague qualities (comfortable with ambiguity, exceptional ability, first-principles thinking, passion, curiosity, communication, teamwork, ownership mindset).
2. For each requirement decide if the PROFILE shows it:
   - "yes": the profile states it or a direct equivalent.
   - "partial": the profile shows part of it (fewer years, a closely related tool, used once in a project).
   - "no": the profile does not show it. Plausible or learnable is still "no".
   For "yes" and "partial", "e" MUST be a short exact quote copied from the PROFILE (5-15 words). Never quote the job description. If you can't quote the profile, answer "no".
   For a years requirement, compare with the candidate's total professional experience given at the top of the profile.
3. minYears: the minimum years of professional experience the job requires, as a number (null if not stated).
4. roleFit — the kind of WORK only, ignoring industry, domain, product area and platform:
   "same" = the same function as the candidate's recent titles (any kind of software engineering counts as the same function for a software engineer, whatever the domain);
   "adjacent" = related technical function (data engineering, DevOps/SRE, ML research, solutions architecture, QA automation for a software engineer);
   "different" = another field (sales, marketing, recruiting, HR, finance, nursing, manufacturing/mechanical/electrical/materials engineering, product or program management for a software engineer).
   roleNote: a few words when not "same", e.g. "Sales role, not engineering".

Return ONLY JSON:
{"roleFit":"same|adjacent|different","roleNote":"...","minYears":null,"requirements":[{"r":"...","n":"must|nice","c":"yes|partial|no","e":"exact quote from profile or empty"}]}`;

/**
 * Ask the model and score its answer.
 * @param {{ client, model, profileText, jobTitle, jobDescription, timeoutMs? }} args
 */
async function assessJobFit({ client, model, profileText, jobTitle, jobDescription, candidateYears = null, timeoutMs = 45000 }) {
  const completion = await client.chat.completions.create(
    {
      model,
      temperature: 0,
      max_tokens: 900,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `## PROFILE${candidateYears != null ? ` (total professional experience: about ${candidateYears} years)` : ""}\n${profileText}\n\n## JOB: ${jobTitle || ""}\n${String(jobDescription || "").slice(0, 6000)}` },
      ],
    },
    { timeout: timeoutMs }
  );
  const text = completion.choices?.[0]?.message?.content || "";
  let raw;
  try {
    raw = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""));
  } catch {
    return null;
  }
  if (!Array.isArray(raw?.requirements) || raw.requirements.length === 0) return null;
  return scoreAssessment(raw, profileText, { jobTitle, candidateYears });
}

module.exports = {
  FIT_VERSION,
  assessJobFit,
  scoreAssessment,
  buildProfileText,
  profileStampOf,
  candidateYearsOf,
  evidenceSupported,
  reasonFor,
  contentWords,
};
