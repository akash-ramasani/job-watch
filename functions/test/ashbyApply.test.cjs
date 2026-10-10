// Ashby auto-apply: the schema adapter, the per-job profile, location fills,
// and the answer engine on the question shapes seen across real Ashby forms
// (30 live boards sampled 2026-10-09 + the 38-form observation corpus).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ashbyToQuestions, domFieldsToSections, buildProfileForJob, locationFill, parsePlace, metroTerms, fillsFrom } = require("../lib/apply/ashby.cjs");

let engine;
test.before(async () => {
  const [ae, fk, vf] = await Promise.all([import("../lib/apply/answer-engine.mjs"), import("../lib/apply/fieldkind.mjs"), import("../lib/apply/verify.mjs")]);
  engine = { ...ae, fieldKind: fk.fieldKind, verifyFourTimes: vf.verifyFourTimes };
});

// A software engineer in Hayward on OPT: authorized now, needs sponsorship later.
const USER = {
  firstName: "Ada", lastName: "Lovelace", email: "ada@example.com", phone: "415-555-0100",
  city: "Hayward", region: "California", country: "United States", linkedin: "https://linkedin.com/in/ada", github: "https://github.com/ada",
  portfolio: "https://ada.dev", pronouns: "He/Him", university: "", workAuthorized: "Yes", requiresSponsorship: "Yes",
  visaStatus: { student: true, sponsored: false }, usPersonExportControl: "No", willingToRelocate: "Yes", willingToWorkHybrid: "Yes",
  clearanceStatus: "None", eeoGender: "Male", eeoEthnicity: "Asian", eeoVeteran: "I am not a protected veteran", eeoDisability: "No, I don't have a disability",
};
const RESUME = {
  summary: "Backend engineer who ships Python services on AWS.",
  skills: ["Python", "AWS", "Terraform", "Kubernetes", "PostgreSQL"],
  roles: [
    { title: "Software Engineer", company: "Runn Technologies", startDate: "Jan 2024", endDate: "Present", description: "Built billing services in Python on AWS with Terraform and Kubernetes." },
    { title: "Software Engineer Intern", company: "Acme", startDate: "Jun 2022", endDate: "Dec 2023", description: "Wrote data pipelines." },
  ],
  education: [{ degree: "Master of Science, Computer Science", institution: "California State University, East Bay", endDate: "2023" }],
  projects: [],
};
const NOW = new Date("2026-10-09T00:00:00Z");
const job = (over = {}) => ({ title: "Software Engineer", companyName: "Halter", locationName: "San Francisco", descriptionHtml: "<p>Build things.</p>", ...over });

function qs(entries) { return ashbyToQuestions([{ fieldEntries: entries }]); }
const F = (title, type, { required = true, options = null, path = null, description = null } = {}) => ({
  isRequired: required, descriptionHtml: description,
  field: { path: path || title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), title, type, selectableValues: options ? options.map((o) => ({ label: o, value: o })) : undefined },
});
const AI = { get: (label) => `AI answer for ${label}` };

/** Map one Ashby field and return the chosen option label / typed value, or
 *  "PARKED: <note>" / "BLANK: <note>". */
function answer(entry, { profile = null, ai = null, jobOver = {} } = {}) {
  const p = profile || buildProfileForJob(USER, RESUME, job(jobOver), { now: NOW });
  const [q] = qs([entry]);
  const m = engine.mapForm([q], p, ai);
  const a = m.answers[0];
  if (!a.answers.length) return (q.required ? "PARKED: " : "BLANK: ") + a.note;
  const fills = fillsFrom([q], m, engine.fieldKind);
  const f = fills[0];
  return f.kind === "multiselect" ? f.values : (f.file ? `FILE:${f.file}` : f.value);
}

test("adapter: Boolean becomes a Yes/No select, titles lose the trailing *", () => {
  const [q] = qs([F("In what cities are you available to work?*", "MultiValueSelect", { options: ["Chicago", "San Francisco"] })]);
  assert.equal(q.label, "In what cities are you available to work?");
  assert.equal(engine.fieldKind(q.fields[0]), "multiselect");
  const [b] = qs([F("Are you authorized?", "Boolean")]);
  assert.deepEqual(b.fields[0].values.map((v) => v.label), ["Yes", "No"]);
  assert.equal(engine.fieldKind(b.fields[0]), "boolean");
});

test("adapter: DOM-scraped fields fall back to the same shape", () => {
  const [q] = ashbyToQuestions(domFieldsToSections([{ id: "abc", label: "Phone", type: "tel", required: true }]));
  assert.equal(q.path, "abc");
  assert.equal(q.ashbyType, "Phone");
});

test("profile: years from resume dates, defaults for low-stakes, none for compliance", () => {
  const p = buildProfileForJob({ firstName: "A", lastName: "B", city: "Hayward" }, RESUME, job(), { now: NOW });
  assert.ok(p.yearsOfExperience > 4 && p.yearsOfExperience < 4.6, `years ${p.yearsOfExperience}`);
  assert.equal(p.currentCompany, "Runn Technologies");
  assert.equal(p.university, "California State University, East Bay");
  assert.equal(p.heardAboutUs, "LinkedIn");
  assert.equal(p.noticePeriod, "2 weeks");
  assert.equal(p.requiresSponsorship, undefined);
  assert.equal(p.workAuthorized, undefined);
  assert.equal(p.metroArea, "San Francisco");
  assert.ok(p.metroAreas.includes("san francisco bay area"));
  assert.ok(p.resumeText.includes("terraform"));
});

test("location: job city when posted, applicant city for remote, state spelled out", () => {
  const p = buildProfileForJob(USER, RESUME, job(), { now: NOW });
  assert.deepEqual(parsePlace("San Francisco, CA"), { city: "San Francisco", state: "California", abbr: "CA" });
  assert.equal(parsePlace("Remote - US"), null);
  assert.equal(locationFill("_systemfield_location", "New York", p).match, "New York, New York");
  assert.equal(locationFill("_systemfield_location", "Remote - US", p).match, "Hayward, California");
  assert.equal(locationFill("_systemfield_location", "", p).value, "Hayward");
  const own = buildProfileForJob({ ...USER, locationStrategy: "profile" }, RESUME, job(), { now: NOW });
  assert.equal(locationFill("_systemfield_location", "New York", own).match, "Hayward, California");
  assert.ok(metroTerms("Hayward").includes("San Francisco"));
});

test("identity and contact text boxes come from the profile", () => {
  assert.equal(answer(F("Legal First Name", "String")), "Ada");
  assert.equal(answer(F("Preferred Last Name", "String")), "Lovelace");
  assert.equal(answer(F("Phone Number", "Phone")), "415-555-0100");
  assert.equal(answer(F("LinkedIn", "String")), "https://linkedin.com/in/ada");
  assert.equal(answer(F("University or School Attended", "String", { required: false })), "California State University, East Bay");
  assert.equal(answer(F("Current or Most Recent Employer", "String")), "Runn Technologies");
  assert.equal(answer(F("Where have you most recently worked?", "String")), "Runn Technologies");
  assert.equal(answer(F("Pronouns", "String", { required: false })), "He/Him");
  assert.equal(answer(F("What country are you based in?", "String")), "United States");
  assert.equal(answer(F("To help us with scheduling and time zones: where are you based?", "String")), "Hayward, California, United States");
});

test("compliance from the profile only, with phrased option lists", () => {
  assert.equal(answer(F("Are you legally authorized to work in the country where this role is located, for any employer?", "Boolean")), "Yes");
  assert.equal(answer(F("Will you now or in the future require employer sponsorship for employment authorization?", "Boolean")), "Yes");
  assert.equal(answer(F("Will you now or will you in the future require employment visa sponsorship?", "ValueSelect", { options: ["Yes, I will require Harvey to sponsor my employment", "No, I do not require sponsorship to work in the United States"] })), "Yes, I will require Harvey to sponsor my employment");
  assert.equal(answer(F("U.S. Work Authorization Status", "ValueSelect", { options: ["Can work for any employer", "Can work for current employer", "Seeking work authorization"] })), "Can work for any employer");
  assert.equal(answer(F("A “U.S. person” is a citizen, legal permanent resident, or legal temporary resident. Please select:", "ValueSelect", { options: ["I am a U.S. person", "I am a citizen of Cuba, Iran, North Korea, or Syria AND I am NOT a U.S. person", "None of the above; I am a citizen of another country"] })), "None of the above; I am a citizen of another country");
  // No profile value -> parks, never defaults to Yes.
  const silent = buildProfileForJob({ firstName: "A", lastName: "B" }, RESUME, job(), { now: NOW });
  assert.match(answer(F("Are you authorized to work lawfully in the United States?", "Boolean"), { profile: silent }), /^PARKED/);
});

test("US residency and time zone from the profile country", () => {
  assert.equal(answer(F("Are you based in a US or equivalent timezone?", "Boolean")), "Yes");
  assert.equal(answer(F("Are you currently based in the United States?", "Boolean")), "Yes");
  const abroad = buildProfileForJob({ ...USER, country: "Canada" }, RESUME, job(), { now: NOW });
  assert.equal(answer(F("Are you currently based in the United States?", "Boolean"), { profile: abroad }), "No");
});

test("experience gates: years from the resume, technologies only when the resume shows them", () => {
  assert.equal(answer(F("Do you have a minimum of 7 years of experience building software?", "Boolean")), "No");
  assert.match(answer(F("Do you have a minimum of 2 years of mobile engineering experience, not including internships?", "Boolean")), /^PARKED: resume does not show that kind/);
  assert.equal(answer(F("Do you have a minimum of 2 years of professional software experience?", "Boolean")), "Yes");
  assert.equal(answer(F("Do you have at least 2 years of experience building in AWS (with Terraform)?", "Boolean")), "Yes");
  assert.equal(answer(F("Do you have more than three years deploying solutions at customers ?", "Boolean")), "Yes");
  assert.equal(answer(F("Do you have experience with Kubernetes?", "Boolean")), "Yes");
  assert.match(answer(F("Do you have experience with Kotlin?", "Boolean")), /^PARKED: resume does not show/);
  assert.match(answer(F("Have you worked in-house at a technology company?", "Boolean")), /^PARKED/);
  assert.match(answer(F("Have you led US Government Affairs teams or functions in the past?", "Boolean")), /^PARKED/);
  assert.equal(answer(F("Are you familiar with or open to using AI tools (such as Github Copilot, ChatGPT, Claude) in your work?", "Boolean")), "Yes");
  assert.equal(answer(F("How many years of relevant experience do you have outside internships/academia?", "ValueSelect", { options: ["7+", "5-7", "2-4", "0-1"] })), "2-4");
  assert.equal(answer(F("Are you a Student or New Grad?", "ValueSelect", { options: ["Yes", "No"] })), "No");
  assert.equal(answer(F("What is your current job level", "ValueSelect", { options: ["Entry Level IC", "Mid Level IC", "Senior Level IC", "Staff Level IC", "Entry Level Manager"] })), "Mid Level IC");
  // Prose wanted -> AI, not a bare number.
  assert.match(answer(F("Please indicate your years of experience with Go and briefly describe the types of projects you’ve worked on.", "String"), { ai: AI }), /^AI answer/);
});

test("blank-on-purpose boxes: follow-ups, referrals, passwords, take-homes", () => {
  assert.match(answer(F("If you selected “Other,” please provide additional details.", "String", { required: false })), /^BLANK/);
  assert.match(answer(F("If Yes, please share their name here", "String", { required: false })), /^BLANK/);
  assert.match(answer(F("If you answered ‘Yes’ to requiring sponsorship now or in the future, please feel free to provide details", "LongText", { required: false })), /^BLANK/);
  assert.match(answer(F("Has someone at Cursor or Graphite referred you for this role? If so, please include their email here", "Email", { required: false })), /^BLANK: left blank: no referral/);
  assert.match(answer(F("Portfolio/Website password if applicable", "String", { required: false })), /^BLANK/);
  assert.match(answer(F("Twitter", "String", { required: false })), /^BLANK: left blank: no Twitter/);
  assert.match(answer(F("Replit Profile URL", "String", { required: false })), /^BLANK: left blank: no replit link/);
  assert.match(answer(F("Other", "String", { required: false })), /^BLANK/);
  const withX = buildProfileForJob({ ...USER, twitter: "https://x.com/ada" }, RESUME, job(), { now: NOW });
  assert.equal(answer(F("X (formerly Twitter)", "String", { required: false }), { profile: withX }), "https://x.com/ada");
  assert.match(answer(F("Exercise Submission (Shared URL)", "Url")), /^PARKED/);
  assert.equal(answer(F("Please provide a link to the App Store and/or personal portfolio showcasing your top 1-2 apps", "String")), "https://ada.dev");
  // A yes/no that merely starts with "If" is still a real question.
  assert.equal(answer(F("If not currently in the Bay Area, are you willing to relocate near our Foster City, CA Office?", "Boolean")), "Yes");
});

test("office, relocation and city questions use the applicant's real metro", () => {
  const harvey = ["Yes, I’m based in this location and able to work from the office 3 days per week", "No, I’m not based in this location but willing to relocate", "No, I’m not able to work from this office"];
  assert.equal(answer(F("This role is tied to the office location listed in the job posting. Team members are expected to work from the office 3 days per week.", "ValueSelect", { options: harvey })), harvey[0]);
  assert.equal(answer(F("This role is tied to the office location listed in the job posting. Team members are expected to work from the office 3 days per week.", "ValueSelect", { options: harvey }), { jobOver: { locationName: "New York" } }), harvey[1]);
  assert.equal(answer(F("Are you able to come into the office four days per week?", "Boolean")), "Yes");
  assert.equal(answer(F("Are you willing and able to commute to our New York City office 3 times per week?", "Boolean")), "Yes");
  assert.deepEqual(answer(F("In what cities are you available to work?*", "MultiValueSelect", { options: ["Chicago", "Denver", "London", "New York City", "San Francisco", "Paris"] })), ["San Francisco"]);
  assert.deepEqual(answer(F("In what cities are you available to work?*", "MultiValueSelect", { options: ["Chicago", "Denver", "London", "Paris"] }), { jobOver: { locationName: "Denver, CO" } }), ["Denver"]);
  assert.equal(answer(F("Do you live in one of the following metro areas?", "ValueSelect", { options: ["San Francisco Bay Area", "New York Metropolitan Area", "Indianapolis Metropolitan Area", "Other"] })), "San Francisco Bay Area");
  assert.deepEqual(answer(F("To foster collaboration, we prioritize hiring in our hubs. Please select your current location or preference:", "MultiValueSelect", { required: false, options: ["Atlanta, GA", "Boston, MA", "New York, NY", "San Francisco, CA", "Los Angeles, CA", "Other - Open to Relo"] })), ["San Francisco, CA"]);
  assert.equal(answer(F("If this role requires a security clearance, do you currently hold an active clearance? If yes, please select the level.", "ValueSelect", { required: false, options: ["None", "Confidential", "Secret", "Top Secret (TS)"] })), "None");
});

test("timing: notice period buckets, start dates, earliest-start selects", () => {
  assert.equal(answer(F("What is your current notice period (if applicable)?", "ValueSelect", { options: ["1-2 weeks", "3-4 weeks", "1 month", "2 months", "3+ months"] })), "1-2 weeks");
  assert.equal(answer(F("When can you start a new role?", "String")), "Immediately");
  assert.match(answer(F("When can you start a new role?", "Date")), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(answer(F("If yes, when is your earliest start date?", "ValueSelect", { options: ["Immediately/next few months, full-time", "Immediately/next few months, part-time", "Winter 2025 (upon graduation)", "Spring 2026 (upon graduation)"] })), "Immediately/next few months, full-time");
});

test("consents, disclosures and low-stakes yeses", () => {
  assert.equal(answer(F("Interview Recording Consent", "ValueSelect", { options: ["Yes, I consent to be recorded", "Opt out of recording"] })), "Yes, I consent to be recorded");
  assert.equal(answer(F("We use Metaview, an AI notetaking tool, to streamline interviews by recording and summarizing discussions. Do you consent?", "ValueSelect", { options: ["Yes", "No"] })), "Yes");
  assert.equal(answer(F("On-Call Requirements: Are you willing and able to participate in this job's on-call requirements?", "Boolean")), "Yes");
  assert.equal(answer(F("Are you willing to provide professional references (e.g. former managers or colleagues) if requested?", "Boolean")), "Yes");
  assert.equal(answer(F("Outside Work / Advisory Disclosure", "Boolean")), "No");
  assert.equal(answer(F("Are you a government official or a Limble business partner (such as a Limble customer or prospective customer)?", "Boolean")), "No");
  assert.equal(answer(F("Do you have a family member, spouse or significant other that is currently employed by Flock?", "ValueSelect", { options: ["Immediate family member", "Spouse/Partner", "No relationship to current employees"] })), "No relationship to current employees");
  assert.equal(answer(F("Have you worked at Snowflake in the past in a Full-time, Part-time, contractor or Intern capacity?", "Boolean")), "No");
  assert.deepEqual(answer(F("Applicant Arbitration Agreement Acknowledgement", "MultiValueSelect", { options: ["I acknowledge that I have opened, read, and understood the Arbitration Agreement."] })), ["I acknowledge that I have opened, read, and understood the Arbitration Agreement."]);
  assert.equal(answer(F("Are you at least 18 years of age?", "Boolean")), "Yes");
  // Policy statements phrased as yes/no still park: agreeing is the person's call.
  assert.match(answer(F("We encourage you to use AI tools to help research, prepare, or refine your application materials. However, we ask that all answers are your own.", "Boolean")), /^PARKED/);
  assert.match(answer(F("Have you heard of TRM before applying?", "Boolean")), /^PARKED/);
});

test("how did you hear: LinkedIn, preferring the job-ad flavour", () => {
  assert.equal(answer(F("How did you hear about this role/Halter?", "ValueSelect", { options: ["LinkedIn job ad", "LinkedIn post or someone's profile", "SEEK", "Indeed", "Halter website or careers page", "A Halter employee referred"] })), "LinkedIn job ad");
  assert.equal(answer(F("How did you hear about Decagon?", "String")), "LinkedIn");
  assert.deepEqual(answer(F("How did you hear about this opportunity? (select all that apply)", "MultiValueSelect", { required: false, options: ["LinkedIn", "Glassdoor", "Notion Blog"] })), ["LinkedIn"]);
});

test("countries and citizenship", () => {
  const countries = ["Canada", "India", "United States", "None"];
  assert.equal(answer(F("Select your country of employment", "ValueSelect", { options: countries })), "United States");
  assert.match(answer(F("Please select the country you hold citizenship in", "ValueSelect", { options: countries })), /^PARKED/);
  const indian = buildProfileForJob({ ...USER, citizenshipCountry: "India" }, RESUME, job(), { now: NOW });
  assert.equal(answer(F("Please select the country you hold citizenship in", "ValueSelect", { options: countries }), { profile: indian }), "India");
  assert.equal(answer(F("If you hold citizenship in a second country, please select it below. Otherwise, select None.", "ValueSelect", { required: false, options: countries })), "None");
});

test("salary and pronouns", () => {
  assert.equal(answer(F("What are your salary expectations?*", "LongText")), "Open to discussion");
  assert.equal(answer(F("What is your desired salary range?", "String")), "Open to discussion");
  assert.match(answer(F("Please share your base compensation expectations in USD:", "Number")), /^PARKED/);
  assert.deepEqual(answer(F("Pronouns", "MultiValueSelect", { required: false, options: ["She/her", "He/him", "They/them", "Other (please list below)"] })), ["He/him"]);
  assert.equal(answer(F("What pronouns would you like our team to use when addressing you?", "ValueSelect", { required: false, options: ["He/Him", "She/Her", "They/Them", "Prefer not to say"] })), "He/Him");
});

test("EEO selects on the main form fall back to the decline option", () => {
  assert.equal(answer(F("Gender", "ValueSelect", { required: false, options: ["Man", "Woman", "Non-binary", "Decline to self-identify"] })), "Decline to self-identify");
  assert.equal(answer(F("Race", "ValueSelect", { required: false, options: ["Asian (Not Hispanic or Latino)", "White (Not Hispanic or Latino)", "Decline to self-identify"] })), "Asian (Not Hispanic or Latino)");
});

test("free text goes to the AI, compliance never does, and the gate catches it", () => {
  const p = buildProfileForJob(USER, RESUME, job(), { now: NOW });
  const questions = qs([
    F("Why are you excited about this role at Halter?", "LongText"),
    F("Anything else you want to share?", "LongText", { required: false }),
    F("Will you now or in the future require visa sponsorship to work in the United States?", "Boolean"),
    F("What's your favorite junk food?", "String", { required: false }),
  ]);
  const m = engine.mapForm(questions, p, AI);
  assert.equal(m.answers[0].source, "ai");
  assert.equal(m.answers[1].source, "ai");
  assert.equal(m.answers[2].source, "profile");
  assert.equal(m.answers[3].source, "ai");
  assert.ok(engine.verifyFourTimes(m, questions, p).ok);
  // Flip the compliance answer to AI and the compliance pass must fail.
  m.answers[2].source = "ai";
  const v = engine.verifyFourTimes(m, questions, p);
  assert.ok(!v.ok && v.failures.some((f) => /compliance/.test(f)));
  // Option validity understands Ashby select types.
  const m2 = engine.mapForm(questions, p, AI);
  m2.answers[2].answers[0].value = "Maybe";
  assert.ok(engine.verifyFourTimes(m2, questions, p).failures.some((f) => /not an allowed option/.test(f)));
});

// ── The captured corpus (untracked, local only): coverage must not regress ───
const CORPUS = path.join(__dirname, "..", "..", "scripts", "observations", "high-scores_2026-08-27T00-00-09", "jobs.json");
test("corpus: Ashby forms fully answerable with AI for free text", { skip: !fs.existsSync(CORPUS) && "corpus not on this machine" }, () => {
  const { jobs } = JSON.parse(fs.readFileSync(CORPUS, "utf8"));
  const forms = jobs.filter((j) => j.source === "ashbyhq" && j.applicationForm?.form?.sections);
  let full = 0; const blockers = [];
  for (const j of forms) {
    const p = buildProfileForJob(USER, RESUME, { title: j.title, companyName: j.companyName, locationName: j.locationName || "", descriptionHtml: "" }, { now: NOW, appliedBefore: false });
    const questions = ashbyToQuestions(j.applicationForm.form.sections).filter((q) => !/^_systemfield_(name|email|resume|location)$/.test(q.path) && q.ashbyType !== "Location");
    const m = engine.mapForm(questions, p, AI);
    const v = engine.verifyFourTimes(m, questions, p);
    assert.ok(!v.failures.some((f) => /compliance/.test(f)), `${j.companyName}: ${v.failures.join("; ")}`);
    if (m.review.length === 0) full++; else blockers.push(...m.review.map((r) => `${j.companyName}: ${r.label.slice(0, 70)} — ${r.note}`));
  }
  console.log(`corpus: ${full}/${forms.length} Ashby forms fully answerable; blockers:\n  ${blockers.join("\n  ")}`);
  assert.ok(full >= Math.floor(forms.length * 0.8), `only ${full}/${forms.length} fully answerable`);
});
