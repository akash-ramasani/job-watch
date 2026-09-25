// Visa / citizenship / clearance check. Sentences are real ones from job descriptions.
// Run: npm test (in functions/)
const test = require("node:test");
const assert = require("node:assert/strict");
const { eligibilityOf, blockedReason, needsSponsorship } = require("../lib/eligibility.cjs");

const flagsOf = (sentence) => eligibilityOf(`<p>${sentence}</p>`).flags;

test("firm no-sponsorship statements are caught", () => {
  for (const s of [
    "Visa sponsorship is not available for this role.",
    "We're not able to sponsor US visas right now.",
    "US Visa Sponsorship: No",
    "Candidates must be authorized to work in the United States without the need for current or future company sponsorship.",
    "We are unable to sponsor or take over sponsorship of an employment visa for this role, at this time.",
    "This role is not eligible for visa sponsorship now or in the future.",
    "At this time, Capital One will not sponsor a new applicant for employment authorization for this position.",
    "Please note that at this time, Everlaw is not sponsoring U.S. employment visas for this role.",
    "We do not offer any type of employment-based immigration sponsorship for this position.",
    "No visa sponsorship is provided; applicants must already have the right to work in Europe.",
    "No visa sponsorship available.",
    "Permanently authorized to work in the U.S., must not require sponsorship of an employment visa (e.g., H-1B or green card) at the time of application or in the future.",
    "The company does not sponsor/support H-1B petitions, TN, or Forms I-983/STEM OPT for this role.",
    // Fiserv (the first sentence alone is plain work authorization)
    "You must currently possess valid and unrestricted U.S. work authorization to be considered for this role. Individuals with temporary visas including, but not limited to, F-1 (OPT, CPT, STEM), H-1B, H-2, or TN, or any candidate requiring sponsorship, now or in the future, will not be considered.",
    "Candidates requiring sponsorship now or in the future are not eligible for this position.",
    "Applicants on F-1 OPT or H-1B visas will not be considered for this role.",
    "We are unable to sponsor or take over sponsorship of an employment visa for this role, at this time.",
    "Penn State does not sponsor or take over sponsorship of a staff employment Visa.",
    "For this opportunity, Truist will not sponsor an applicant for work visa status or employment authorization, nor will we offer any immigration-related support for this position.",
    "Please note: This role is not eligible for Work Visa sponsorship, either currently or in the future.",
  ]) assert.deepEqual(flagsOf(s), ["no_sponsorship"], s);
});

test("citizenship requirements are caught, including US-person rules", () => {
  for (const s of [
    "Citizenship: U.S. citizenship required",
    "MUST be a US Citizen",
    "Must be a US citizen or national, US permanent resident (current Green Card holder), or lawfully admitted into the US as a refugee or granted asylum.",
    "Position Restriction: This position is restricted to US citizens or lawful permanent residents",
    "Because this role supports our Public Sector customer base, all candidates must be a US citizen.",
    "U.S. citizenship is contractually required for this role.",
    "U.S Citizenship is required.",
    "Must be a US Citizen or a US Permanent Resident due to nature of client engagements",
    "Government export regulations, applicant must be a (i) U.S. citizen or national, (ii) U.S. lawful, permanent resident (aka green card holder), (iii) Refugee, or (iv) Asylee",
    "Due to the client contract, you will be assigned, this position requires you to be a U.S. citizen",
    "US citizenship is required, as only US citizens are authorized to access certain necessary systems.",
  ]) assert.ok(flagsOf(s).includes("citizen"), s);
});

test("clearance requirements are caught", () => {
  for (const s of [
    "Must have an active TS/SCI with Polygraph clearance.",
    "Clearance: Active Top Secret/SCI required",
    "Clearance Required: Secret",
    "Top Secret Security Clearance required",
    "An interim and/or final US Secret Clearance Post-Start is required.",
    "This position requires an active Secret US Security Clearance.",
  ]) assert.ok(flagsOf(s).includes("clearance"), s);
});

test("legitimate jobs are never flagged", () => {
  for (const s of [
    // EEO boilerplate and plain work authorization
    "We are an equal opportunity employer and do not discriminate on the basis of race, national origin, citizenship status, or any other protected characteristic.",
    "Candidates must be authorized to work in the United States.",
    "Employment is contingent upon verification of identity and eligibility to work in the United States.",
    // soft / optional
    "U.S. citizen preferred.",
    "An active Secret clearance is a plus.",
    "Ability to obtain a Secret clearance.",
    "Must be able to obtain a Public Trust clearance.",
    "This position does not require a Security Clearance.",
    "Clearance Required: None; Must be able to obtain a Public Trust clearance",
    // hedged / partial
    "It may also support work with Federal customers, requiring U.S. citizenship.",
    "T-Mobile requires U.S. citizenship for certain roles within the organization.",
    "US Citizenship is required for all positions with a government clearance and certain other restricted positions.",
    "However, we aren't able to successfully sponsor visas for every role and every candidate.",
    "Remote roles are not eligible for U.S. visa sponsorship.",
    "While many of our featured local roles require an active clearance with polygraph, uncleared professionals interested in our broader nationwide opportunities are welcome to attend!",
    // accepts visa holders
    "Must be a US Citizen, permanent resident or be an MS student with work authorization (F1 Visa on CPT accepted only for masters-level students).",
    "US citizenship or a valid work authorization is required.",
    // sponsorship offered, or unrelated uses of "sponsor"
    "We do offer visa sponsorship for this role.",
    "Visa sponsorship is available for this position.",
    "Demonstrated delivery against external milestones with industrial partners or sponsored programs",
    "You will work with an executive sponsor to define the roadmap.",
    // application-form questions
    "Will you now or in the future require sponsorship for employment visa status?",
    // visa holders welcome, or "not considered" about something else
    "We sponsor and take over sponsorship of employment visas for this role.",
    "To conform to US Government export regulations, applicant must be a (i) US citizen or national, (ii) US lawful, permanent resident (aka green card holder), (iii) Refugee under 8 U.S.C. § 1157, or (iv) Asylee under 8 U.S.C. § 1158, or be eligible to obtain the required authorizations from the U.S. Department of State.",
    "Allstate generally does not sponsor individuals for employment-based visas for this position.",
    "Candidates on F-1 OPT, CPT or H-1B visas will be considered for this role.",
    "We welcome H-1B transfers; applicants requiring sponsorship will be considered.",
    "Applicants who do not meet the minimum qualifications will not be considered.",
    "H-1B holders may not be considered for certain government programs.",
    "You must currently possess valid and unrestricted U.S. work authorization to be considered for this role.",
  ]) assert.deepEqual(flagsOf(s), [], s);
});

test("only users who need sponsorship are affected", () => {
  assert.equal(blockedReason(["citizen"], true), "Requires US citizenship");
  assert.equal(blockedReason(["no_sponsorship", "clearance"], true), "Requires a security clearance");
  assert.equal(blockedReason(["citizen"], false), null);
  assert.equal(blockedReason([], true), null);
  assert.equal(needsSponsorship({ requiresSponsorship: "Yes" }), true);
  assert.equal(needsSponsorship({ requiresSponsorship: "No" }), false);
  assert.equal(needsSponsorship({}), false);
});
