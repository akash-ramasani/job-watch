// Answers the Workday test runs got wrong (audit of 501 saved questions, 2026-11-10).
const test = require("node:test");
const assert = require("node:assert/strict");

const P = {
  firstName: "Akash", lastName: "Ramasani", requiresSponsorship: "Yes", workAuthorized: "Yes", visaStatus: { student: true },
  yearsOfExperience: 5, education: [{ degree: "Master of Science", field: "Computer Science" }],
  resumeText: "Software Engineer. Python, SQL, React, dashboards, ETL pipelines. M.S. Computer Science.",
};
const sel = (label, opts) => ({ label, required: true, fields: [{ name: "q", type: "multi_value_single_select", values: opts.map((o) => ({ label: o, value: o })) }] });
const txt = (label) => ({ label, required: true, fields: [{ name: "q", type: "textarea" }] });
let ae;
const val = (q, p = P) => ae.answerQuestion(q, p, null).answers.map((a) => a.value)[0];
test.before(async () => { ae = await import("../lib/apply/answer-engine.mjs"); });

test("unrestricted authorization is No on F-1 OPT (U.S. Bank)", () => {
  assert.equal(val(sel('Are you currently authorized for employment in the U.S. without any restrictions to the length of employment period? (Answer "No" if you are in a non-immigrant status such as H, L, E, TN, B or F, including OPT, CPT)', ["Yes", "No"])), "No");
});

test("'please initial' gets initials, not the current employer (Samsung)", () => {
  assert.equal(val(txt("By submitting an application, you, the applicant, agree to not disclose to Samsung any confidential or proprietary information belonging to any current or previous employer or other person or entity. Please initial that you acknowledge and understand this statement.")), "AR");
});

test("driver's license is never answered from the resume", () => {
  const q = sel("Do you have a valid driver's license in the country this job is based?", ["Yes", "No"]);
  const a = ae.answerQuestion(q, P, null);
  assert.equal(a.answers.length, 0);
  assert.match(a.note, /^Only you can answer/);
  assert.equal(val(q, { ...P, driversLicense: "Yes" }), "Yes");
});

test("a degree in another field is No; a matching or related field is Yes", () => {
  assert.equal(val(sel("Do you have an Associate’s or Bachelor’s degree in a Chemical or Biological science, Clinical Laboratory Science or Medical Technology?", ["Yes", "No"])), "No");
  assert.equal(val(sel("Do you have a Bachelor's degree in Computer Science, Engineering, or a related field?", ["Yes", "No"])), "Yes");
  assert.equal(val(sel("Do you have a bachelor's degree in a STEM field?", ["Yes", "No"])), "Yes");
  assert.equal(val(sel("Do you have a bachelor's degree?", ["Yes", "No"])), "Yes");
});

test("years in a domain the resume never shows: the no-experience bucket", () => {
  const boeing = ["No experience", "Less than 1 year", "More than 1 year but less than 3 years", "More than 3 years but less than 5 years", "More than 5 years but less than 10 years", "More than 10 years"];
  assert.equal(val(sel("How many years of experience do you have in aerospace production and maintenance?", boeing)), "No experience");
  assert.equal(val(sel("How many years of clinical experience in blood draw/venipuncture do you have?", ["Less than 1 year", "1-3 years", "3-5 years", "5+ years", "No Experience"])), "No Experience");
  assert.equal(val(sel("How many years experience do you have in claims adjusting?", ["Less than 1 year", "1-3 years", "4-5 years"])), "Less than 1 year");
  // Shown on the resume, or general: total years.
  assert.equal(val(sel("How many years of experience do you have with dashboards, reports, and KPIs?", boeing)), "More than 5 years but less than 10 years");
  assert.equal(val(sel("How many years of experience do you have working both independently and in team environments?", boeing)), "More than 5 years but less than 10 years");
});

test("month buckets are not years (J&J '0 - 6 months')", () => {
  assert.equal(val(sel("How many years of experience do you have in roles or projects that closely align with the responsibilities outlined in the job description?", ["0 - 6 months", "6 - 11 months", "1 - 2 years", "3 - 4 years", "5 - 6 years", "7 - 8 years"])), "5 - 6 years");
});

test("age questions phrased 'N years or older'", () => {
  assert.equal(val(sel("Are you 18 years or older?", ["Yes", "No"])), "Yes");
  assert.equal(val(sel("Are you 16 years of age or older?", ["Yes", "No"])), "Yes");
  assert.notEqual(ae.classifyQuestion(sel("Are you younger than 18 years old?", ["Yes", "No"])), "age18");
});

test("plain facts the AI used to answer are rules now", () => {
  const p = { ...P, eeoGender: "Male", usPersonExportControl: "No", roles: [{ company: "Runn Technologies", title: "Software Engineer" }] };
  assert.equal(val(sel("What is your Sex?", ["Female", "I do not wish to answer", "Male"]), p), "Male");
  assert.equal(val(sel("Are you a citizen of the United States?", ["Yes", "No"]), p), "No");
  assert.equal(val(sel("Are you legally authorized for employment in the United States?", ["Yes", "No"]), p), "Yes");
  assert.equal(val(sel("Have you ever been terminated or asked to resign from a position?", ["Yes", "No"]), p), "No");
  assert.equal(val(sel("Are you a CURRENT U.S. federal government civilian or military (active duty or reserves) employee?", ["Yes", "No", "Unsure"]), p), "No");
  for (const l of ["You must AGREE to proceed.", "I accept the Terms and Conditions.", "Yes, I accept these terms."]) assert.equal(ae.classifyQuestion(sel(l, ["Yes", "No"])), "acknowledgement");
  // A veteran statement that says "authorized" is not a work-authorization question.
  assert.notEqual(ae.classifyQuestion(sel("This employer is a Government contractor subject to VEVRAA, which requires us to invite protected veterans to self-identify; we are authorized to work with…", ["I AM NOT A VETERAN"])), "workAuthorized");
});

test("'Are you currently employed?' is the resume's present role, not this company", () => {
  const q = sel("Are you currently employed?", ["Yes", "No"]);
  assert.equal(val(q, { ...P, roles: [{ company: "Runn Technologies", title: "Senior Software Engineer", endDate: "Present" }] }), "Yes");
  assert.equal(val(q, { ...P, roles: [{ company: "Oracle", title: "SDE II", endDate: "Jul 2024" }] }), "No");
  assert.equal(ae.classifyQuestion(sel("Are you currently employed by Microchip?", ["Yes", "No"])), "companyRelationship");
});

test("'Have you ever applied here?' comes from the submitted-applications record", () => {
  for (const l of ["Have you ever applied for employment with this company?", "Have you applied on any previous occasions for employment in any capacity with Micron?", "Have you ever Applied for Work at Cadence?"]) {
    assert.equal(ae.classifyQuestion(sel(l, ["Yes", "No"])), "previouslyApplied");
    assert.equal(val(sel(l, ["Yes", "No"]), { ...P, appliedToCompanyBefore: true }), "Yes");
    assert.equal(val(sel(l, ["Yes", "No"]), { ...P, appliedToCompanyBefore: false }), "No");
  }
  assert.equal(val(sel("Have you ever applied for employment with this company?", ["Yes, I have applied previously", "No, I have not applied previously"]), { ...P, appliedToCompanyBefore: false }), "No, I have not applied previously");
  assert.notEqual(ae.classifyQuestion(sel("Have you previously interviewed for employment with HCSC in the last 12 months?", ["Yes", "No"])), "previouslyApplied");
});

test("Profile > Application questions answer their many wordings", () => {
  const p = { ...P, aiConsent: "Yes", futureRolesConsent: "No", willingToTravel: "Yes", everTerminated: "No", outsideActivities: "No", otherNames: "" };
  assert.equal(val(sel("Visa may use automated tools such as AI to support review of your application for this role", ["Opt-In", "Opt-Out"]), p), "Opt-In");
  assert.equal(val(sel("McKesson seeks to use Artificial intelligence (AI) to accelerate the creation of insights on your application", ["Yes, I consent to the use of AI on this application.", "No, I do not consent to the use of AI on this application."]), p), "Yes, I consent to the use of AI on this application.");
  assert.equal(val(sel("May we contact you about relevant job opportunities at JLL beyond the position you are applying for?", ["Yes, I consent to being contacted", "No, I only wish to be considered for this role"]), p), "No, I only wish to be considered for this role");
  assert.equal(val(sel("Are you willing and able to travel the required percentage of time for this role?", ["Yes", "No"]), p), "Yes");
  assert.equal(val(sel("Have you ever been terminated or asked to resign from a position?", ["Yes", "No"]), p), "No");
  assert.equal(val(sel("Are you currently serving on the board of directors of any for-profit company?", ["Yes", "No"]), p), "No");
  assert.equal(val(txt("Please list if you have ever worked under or earned degrees under another name (i.e., maiden name)"), p), "No");
  assert.equal(val(txt("Please list if you have ever worked under or earned degrees under another name (i.e., maiden name)"), { ...p, otherNames: "Akash R" }), "Akash R");
  // Not answered in the Profile: AI consent is left to the AI pick.
  assert.equal(ae.answerQuestion(sel("Visa may use automated tools such as AI to support review of your application for this role", ["Opt-In", "Opt-Out"]), P, null).answers.length, 0);
});
