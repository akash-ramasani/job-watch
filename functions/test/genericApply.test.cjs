// Generic prepare (Workday and every other board) on the shared engine: the
// fields come scanned from the page (extension/lib/generic-dom.js scan()),
// Workday postings from its public CXS API. Runs end to end with a fake
// Firestore, a fake fetch and a scripted OpenAI; the fixture is the shape of
// Workday's My Information, Application Questions and Self Identify steps.
const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareGenericApplication, workdayPostingApi, parseMonthYear } = require("../lib/apply/generic.cjs");
const { formKeyFromUrl } = require("../lib/apply/ledger.cjs");

const USER = {
  firstName: "Ada", lastName: "Lovelace", email: "ada@example.com", phone: "415-555-0100", city: "Hayward", region: "California", country: "United States",
  addressLine1: "1 Main St", postalCode: "94541",
  linkedin: "https://linkedin.com/in/ada", github: "https://github.com/ada",
  workAuthorized: "Yes", requiresSponsorship: "Yes", eeoGender: "Female", eeoEthnicity: "Asian", eeoVeteran: "I am not a protected veteran", eeoDisability: "No, I don't have a disability",
  heardAboutUs: "LinkedIn", resumeUrl: "https://files.example/resume.pdf", resumeFileName: "ada.pdf",
};
const RESUME = {
  summary: "Backend engineer who ships Python services on AWS.", skills: ["Python", "AWS"],
  roles: [{ title: "Software Engineer", company: "Runn Technologies", location: "Remote", startDate: "Jan 2024", endDate: "Present", description: "Built billing services in Python on AWS." },
    { title: "Intern", company: "Acme", startDate: "Jun 2022", endDate: "Aug 2022", description: "Wrote tests." }],
  education: [{ degree: "Master of Science, Computer Science", institution: "California State University, East Bay", startDate: "2021", endDate: "May 2023" }],
};
const o = (...labels) => labels.map((l) => ({ label: l, value: l }));
const WD_URL = "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-Software-Engineer_JR1987654/apply/applyManually";
const FIELDS = [
  { id: "country:select#1", label: "Country", type: "select", required: true, options: o("Canada", "United States of America", "United Kingdom") },
  { id: "first-name:text#1", label: "First Name", type: "text", required: true, options: [] },
  { id: "last-name:text#1", label: "Last Name", type: "text", required: true, options: [] },
  { id: "i-have-a-preferred-name:yesno#1", label: "I have a preferred name", type: "yesno", required: false, options: [] },
  { id: "address-line-1:text#1", label: "Address Line 1", type: "text", required: true, options: [] },
  { id: "city:text#1", label: "City", type: "text", required: true, options: [] },
  { id: "state:select#1", label: "State", type: "select", required: true, options: o("Arizona", "California", "Colorado") },
  { id: "postal-code:text#1", label: "Postal Code", type: "text", required: true, options: [] },
  { id: "email:email#1", label: "Email", type: "email", required: true, options: [] },
  { id: "phone-device-type:select#1", label: "Phone Device Type", type: "select", required: true, options: o("Home", "Mobile", "Work") },
  { id: "country-phone-code:typeahead#1", label: "Country Phone Code", type: "typeahead", required: true, options: [] },
  { id: "phone-number:tel#1", label: "Phone Number", type: "tel", required: true, options: [] },
  { id: "phone-extension:text#1", label: "Phone Extension", type: "text", required: false, options: [] },
  { id: "how-did-you-hear:typeahead#1", label: "How Did You Hear About Us?", type: "typeahead", required: true, options: [] },
  { id: "previously-worked:radio#1", label: "Have you previously worked for NVIDIA?", type: "radio", required: true, options: o("Yes", "No") },
  { id: "authorized:select#1", label: "Are you legally authorized to work in the country in which the job is located?", type: "select", required: true, options: o("Yes", "No") },
  { id: "sponsorship:select#1", label: "Will you now or in the future require sponsorship for employment visa status?", type: "select", required: true, options: o("Yes", "No") },
  { id: "why:textarea#1", label: "Why are you interested in this role?", type: "textarea", required: true, options: [] },
  { id: "gender:select#1", label: "Gender", type: "select", required: false, options: o("Male", "Female", "I do not wish to answer") },
  { id: "terms:yesno#1", label: "Yes, I have read and consent to the terms and conditions", type: "yesno", required: true, options: [] },
  { id: "job-alerts:yesno#1", label: "Send me job alerts and marketing emails", type: "yesno", required: false, options: [] },
  { id: "name:text#1", label: "Name", type: "text", required: true, options: [] },
  { id: "date:date#1", label: "Date", type: "date", required: true, options: [] },
  { id: "resume-cv:file#1", label: "Resume/CV (Select files)", type: "file", required: true, options: [] },
  { id: "date-available:text#1", label: "Date Available", type: "text", required: false, options: [] },
];
const POSTING = {
  jobPostingInfo: { title: "Senior Software Engineer", location: "US, CA, Santa Clara", remoteType: "Hybrid", jobReqId: "JR1987654", jobDescription: "<p>Build GPU cloud services in Python.</p>" },
  hiringOrganization: { name: "NVIDIA" },
};

function fakeDb(user = USER) {
  const snap = (data) => ({ exists: !!data, data: () => data });
  return {
    collection: () => ({
      doc: () => ({
        get: async () => snap(user),
        collection: (name) => ({
          doc: () => ({ get: async () => snap(name === "resume" ? RESUME : null) }),
          where: () => ({ limit: () => ({ get: async () => ({ empty: true }) }) }),
        }),
      }),
    }),
  };
}
function fakeFetch(calls) {
  return async (url) => {
    calls.push(url);
    if (url === "https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-Software-Engineer_JR1987654") return { ok: true, json: async () => POSTING };
    if (/resume\.pdf/.test(url)) return { ok: true, arrayBuffer: async () => Buffer.from("%PDF-1.4 test") };
    return { ok: false, status: 404 };
  };
}
const openai = {
  chat: { completions: { create: async () => ({ choices: [{ message: { content: "I build cloud services in Python and want to do that work on GPU infrastructure." } }] }) } },
};

test("workday: CXS endpoint and req id from posting and apply URLs", () => {
  const a = workdayPostingApi(WD_URL);
  assert.equal(a.url, "https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-Software-Engineer_JR1987654");
  assert.equal(a.reqId, "JR1987654");
  const b = workdayPostingApi("https://wd1.myworkdaysite.com/recruiting/acme/External/job/Remote/Data-Analyst_R-12345");
  assert.equal(b.url, "https://wd1.myworkdaysite.com/wday/cxs/acme/External/job/Remote/Data-Analyst_R-12345");
  assert.equal(workdayPostingApi("https://example.com/jobs/1"), null);
});

test("ledger: Workday apply URLs key on tenant and req id", () => {
  const k = formKeyFromUrl(WD_URL);
  assert.equal(k.source, "workday");
  assert.equal(k.formKey, "workday|nvidia|JR1987654");
  assert.equal(formKeyFromUrl("https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-Software-Engineer_JR1987654").formKey, "workday|nvidia|JR1987654");
});

test("dates: resume month/year strings", () => {
  assert.deepEqual(parseMonthYear("Jan 2024"), { year: 2024, month: 1 });
  assert.deepEqual(parseMonthYear("2023-05"), { year: 2023, month: 5 });
  assert.deepEqual(parseMonthYear("2021"), { year: 2021, month: null });
  assert.equal(parseMonthYear("Present"), null);
});

test("workday: scanned form end to end on the shared engine", async () => {
  const calls = [];
  const out = await prepareGenericApplication("uid1", { db: fakeDb(), openai, model: "test", fetch: fakeFetch(calls) }, { source: "workday", applyUrl: WD_URL, domFields: FIELDS, jobTitle: "page header", companyName: "page" });
  const by = Object.fromEntries(out.fills.map((f) => [f.path, f]));
  assert.equal(out.jobTitle, "Senior Software Engineer");
  assert.equal(out.companyName, "NVIDIA");
  assert.ok(out.resumeB64);
  assert.equal(by["country:select#1"].value, "United States of America");
  assert.equal(by["first-name:text#1"].value, "Ada");
  assert.equal(by["last-name:text#1"].value, "Lovelace");
  assert.equal(by["i-have-a-preferred-name:yesno#1"].value, "No");
  assert.equal(by["city:text#1"].value, "Hayward");
  assert.equal(by["state:select#1"].value, "California");
  assert.equal(by["email:email#1"].value, "ada@example.com");
  assert.equal(by["phone-device-type:select#1"].value, "Mobile");
  assert.equal(by["country-phone-code:typeahead#1"].kind, "typeahead");
  assert.match(by["country-phone-code:typeahead#1"].match, /United States of America \(\+1\)/);
  assert.equal(by["phone-number:tel#1"].value, "415-555-0100");
  assert.equal(by["phone-extension:text#1"], undefined);
  assert.equal(by["how-did-you-hear:typeahead#1"].kind, "typeahead");
  assert.match(by["how-did-you-hear:typeahead#1"].value, /linkedin/i);
  assert.equal(by["previously-worked:radio#1"].value, "No");
  assert.equal(by["authorized:select#1"].value, "Yes");
  assert.equal(by["sponsorship:select#1"].value, "Yes");
  assert.equal(by["why:textarea#1"].source, "ai");
  assert.equal(by["gender:select#1"].value, "Female");
  assert.equal(by["terms:yesno#1"].value, "Yes");
  assert.equal(by["job-alerts:yesno#1"], undefined, "marketing opt-ins stay unchecked");
  assert.equal(by["name:text#1"].value, "Ada Lovelace");
  assert.equal(by["date:date#1"].kind, "date");
  assert.match(by["date:date#1"].value, /^\d{2}\/\d{2}\/\d{4}$/);
  assert.equal(by["resume-cv:file#1"].kind, "file");
  assert.equal(by["date-available:text#1"].kind, "date");
  assert.match(by["date-available:text#1"].value, /^\d{2}\/\d{2}\/\d{4}$/);
  // Resume history for My Experience.
  assert.equal(out.history.roles[0].company, "Runn Technologies");
  assert.equal(out.history.roles[0].current, true);
  assert.deepEqual(out.history.roles[1].to, { year: 2022, month: 8 });
  assert.equal(out.history.education[0].school, "California State University, East Bay");
  assert.equal(out.history.links[0], "https://linkedin.com/in/ada");
  assert.equal(out.review.length, 0, JSON.stringify(out.review));
  assert.ok(calls.some((u) => /wday\/cxs\/nvidia/.test(u)));
});

test("generic: empty form still returns the resume and its history", async () => {
  const out = await prepareGenericApplication("uid1", { db: fakeDb(), openai: null, model: "test", fetch: fakeFetch([]) }, { source: "icims", applyUrl: "https://careers-acme.icims.com/jobs/1234/apply", domFields: [] });
  assert.equal(out.fills.length, 0);
  assert.ok(out.resumeB64);
  assert.equal(out.history.roles.length, 2);
});

test("generic: a careers-site form uses the page header and the JobWatch job when found", async () => {
  const sharedJobs = { where: () => ({ limit: () => ({ get: async () => ({ docs: [{ data: () => ({ source: "icims", title: "Data Engineer", companyName: "Acme Health", locationName: "Austin, TX", fullDescription: "Build pipelines in Python." }) }] }) }) }) };
  const out = await prepareGenericApplication("uid1", { db: fakeDb(), openai: null, model: "test", fetch: fakeFetch([]), sharedJobs }, {
    source: "icims", applyUrl: "https://careers-acme.icims.com/jobs/1234/apply", externalId: "1234",
    domFields: FIELDS.filter((f) => /first-name|last-name|email|phone-number|resume/.test(f.id)),
  });
  assert.equal(out.companyName, "Acme Health");
  assert.equal(out.jobTitle, "Data Engineer");
  assert.equal(out.fills.length, 5);
  assert.equal(out.ready, true, JSON.stringify(out.reasons));
});
