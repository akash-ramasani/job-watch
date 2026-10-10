// Lever prepare on the shared engine: the fields come scraped from the page
// (lever-dom.js scan()), the posting from Lever's public API. Runs end to end
// with a fake Firestore, a fake fetch and a scripted OpenAI; the fixture is the
// form shape seen live on 2026-10-10 (Match Group, Veeva).
const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareLeverApplication } = require("../lib/apply/lever.cjs");
const { formKeyFromUrl } = require("../lib/apply/ledger.cjs");

const USER = {
  firstName: "Ada", lastName: "Lovelace", email: "ada@example.com", phone: "415-555-0100", city: "Hayward", region: "California", country: "United States",
  linkedin: "https://linkedin.com/in/ada", github: "https://github.com/ada", website: "https://ada.dev", pronouns: "She/Her",
  workAuthorized: "Yes", requiresSponsorship: "Yes", visaStatus: { student: true, sponsored: false }, usPersonExportControl: "No",
  willingToRelocate: "Yes", willingToWorkHybrid: "Yes", eeoGender: "Female", eeoEthnicity: "Asian", eeoVeteran: "I am not a protected veteran", eeoDisability: "No, I don't have a disability",
  heardAboutUs: "LinkedIn", resumeUrl: "https://files.example/resume.pdf", resumeFileName: "ada.pdf",
};
const RESUME = {
  summary: "Backend engineer who ships Python services on AWS.", skills: ["Python", "AWS", "Terraform"],
  roles: [{ title: "Software Engineer", company: "Runn Technologies", startDate: "Jan 2024", endDate: "Present", description: "Built billing services in Python on AWS." }],
  education: [{ degree: "Master of Science, Computer Science", institution: "California State University, East Bay", endDate: "2023" }],
};
const o = (...labels) => labels.map((l) => ({ label: l, value: l }));
const FIELDS = [
  { id: "resume", label: "Resume/CV", type: "file", required: true, options: [] },
  { id: "name", label: "Full name", type: "text", required: true, options: [] },
  { id: "pronouns", label: "Pronouns", type: "checkbox", required: false, options: o("He/him", "She/her", "They/them", "Use name only") },
  { id: "email", label: "Email", type: "email", required: true, options: [] },
  { id: "phone", label: "Phone", type: "text", required: true, options: [] },
  { id: "location", label: "Current location", type: "location", required: true, options: [] },
  { id: "org", label: "Current company", type: "text", required: false, options: [] },
  { id: "urls[LinkedIn]", label: "LinkedIn URL", type: "text", required: false, options: [] },
  { id: "urls[GitHub]", label: "GitHub URL", type: "text", required: false, options: [] },
  { id: "urls[Portfolio]", label: "Portfolio URL", type: "text", required: false, options: [] },
  { id: "urls[Other]", label: "Other website", type: "text", required: false, options: [] },
  { id: "cards[c1][field0]", label: "Where did you first hear about this job?", type: "select", required: true, options: o("Award Annoucement", "LinkedIn - Job Posting", "Glassdoor", "Indeed", "Other") },
  { id: "cards[c2][field0]", label: "Are you authorized to work in the United States?", type: "radio", required: true, options: o("Yes", "No") },
  { id: "cards[c2][field1]", label: "Will you now or in the future require our company to file a petition or application for employment - based immigration status on your behalf?", type: "select", required: true, options: o("Yes", "No") },
  { id: "cards[c3][field0]", label: "Why do you want to work at Match Group?", type: "textarea", required: true, options: [] },
  { id: "cards[c4][field0]", label: "Stay Connected | To ensure you receive status updates, please add no-reply@hire.lever.co to your safe sender list.", type: "checkbox", required: true, options: o("I understand that next steps will be sent via email and I have marked the sender address above as safe.") },
  { id: "comments", label: "Additional information", type: "textarea", required: false, options: [] },
  { id: "eeo[gender]", label: "Gender", type: "select", required: false, options: o("Male", "Female", "Decline to self-identify") },
  { id: "eeo[race]", label: "Race", type: "select", required: false, options: o("Hispanic or Latino", "Asian (Not Hispanic or Latino)", "Decline to self-identify") },
  { id: "eeo[veteran]", label: "Veteran status", type: "select", required: false, options: o("I am not a protected veteran", "I identify as one or more of the classifications of protected veteran", "Decline to self-identify") },
  { id: "consent[marketing]", label: "Yes, Veeva Systems can contact me about future job opportunities for up to 2 years", type: "checkbox", required: false, options: o("Yes, Veeva Systems can contact me about future job opportunities for up to 2 years") },
];
const POSTING = {
  id: "0a5ad123-7c5b-4d88-b498-5a0262beb331", text: "Backend Engineer", workplaceType: "hybrid", country: "US",
  categories: { location: "New York, NY", team: "Engineering", commitment: "Full-Time" },
  descriptionBody: "<h3>The Role</h3><div>Build billing for dating apps in Python.</div>", lists: [{ text: "You will", content: "<li>Ship Python services on AWS</li>" }], additional: "<div>Hybrid in NYC.</div>", opening: "<div>Match Group is home to Tinder and Hinge.</div>",
};

function fakeDb() {
  const snap = (data) => ({ exists: !!data, data: () => data });
  return {
    collection: () => ({
      doc: () => ({
        get: async () => snap(USER),
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
    if (/api\.lever\.co\/v0\/postings\/matchgroup\/0a5ad123/.test(url)) return { ok: true, json: async () => POSTING };
    if (/resume\.pdf/.test(url)) return { ok: true, arrayBuffer: async () => Buffer.from("%PDF-1.4 test") };
    return { ok: false, status: 404 };
  };
}
function fakeOpenai(script) {
  const seen = [];
  return {
    seen,
    chat: { completions: { create: async (req) => {
      const q = req.messages[1].content.match(/Question: (.*)/)?.[1] || "<cover>";
      seen.push({ q, sys: req.messages[0].content, user: req.messages[1].content });
      return { choices: [{ message: { content: script(q, seen.filter((s) => s.q === q).length) } }] };
    } } },
  };
}

test("lever: scraped form end to end on the shared engine", async () => {
  const calls = [];
  const openai = fakeOpenai((q) => {
    if (/Why do you want/.test(q)) return "I build billing systems in Python and want to do that for products people use every day.";
    if (/Additional information/.test(q)) return "I can start on short notice. I am happy to share more work samples.";
    return "NEEDS_REVIEW";
  });
  const out = await prepareLeverApplication("uid1", "matchgroup", "0a5ad123-7c5b-4d88-b498-5a0262beb331", { db: fakeDb(), openai, model: "test", fetch: fakeFetch(calls) }, {
    domFields: FIELDS, companyName: "Match Group", jobTitle: "ignored when the API answers", jobLocationName: "ignored",
  });
  const by = Object.fromEntries(out.fills.map((f) => [f.path, f]));

  assert.equal(out.jobTitle, "Backend Engineer");
  assert.equal(out.companyName, "Match Group");
  assert.equal(out.locationName, "New York, NY");
  assert.equal(out.schemaSource, "dom");
  // Contact + links straight from the profile.
  assert.equal(by.name.value, "Ada Lovelace");
  assert.equal(by.email.value, "ada@example.com");
  assert.equal(by.phone.value, "415-555-0100");
  assert.equal(by.org.value, "Runn Technologies");
  assert.equal(by["urls[LinkedIn]"].value, "https://linkedin.com/in/ada");
  assert.equal(by["urls[GitHub]"].value, "https://github.com/ada");
  assert.equal(by["urls[Portfolio]"].value, "https://ada.dev");
  assert.equal(by["urls[Other]"], undefined, "the same link is not repeated in Other website");
  assert.equal(by.resume.kind, "file");
  assert.ok(out.resumeB64, "resume bytes fetched");
  // Location widget gets the job's posted city (the user's long-standing rule).
  assert.equal(by.location.kind, "location");
  assert.equal(by.location.value, "New York");
  assert.equal(by.location.match, "New York, NY", "Lever suggestions read City, ST, USA");
  // Pronouns from the profile, matched to the offered spelling.
  assert.deepEqual(by.pronouns.values, ["She/her"]);
  // Rules and compliance from the profile only.
  assert.equal(by["cards[c1][field0]"].value, "LinkedIn - Job Posting");
  assert.equal(by["cards[c2][field0]"].value, "Yes");
  assert.equal(by["cards[c2][field1]"].value, "Yes");
  assert.equal(by["eeo[gender]"].value, "Female");
  assert.equal(by["eeo[race]"].value, "Asian (Not Hispanic or Latino)");
  assert.equal(by["eeo[veteran]"].value, "I am not a protected veteran");
  // A required single-option checkbox is an acknowledgement; a marketing opt-in is left alone.
  assert.equal(by["cards[c4][field0]"].kind, "multiselect");
  assert.equal(by["cards[c4][field0]"].values.length, 1);
  assert.equal(by["consent[marketing]"], undefined);
  // AI free text in the plain style: periods only.
  assert.match(by["cards[c3][field0]"].value, /^I build billing systems in Python/);
  assert.ok(!/[,;:—-]/.test(by["cards[c3][field0]"].value), "no commas or dashes in AI text");
  assert.equal(by["cards[c3][field0]"].source, "ai");
  assert.ok(by.comments.value.length > 10, "optional free text is answered too");
  assert.ok(openai.seen.every((s) => /Match Group/.test(s.user) || /Match Group/.test(s.sys)), "the AI sees the company");
  // Verdict.
  assert.equal(out.review.length, 0, JSON.stringify(out.review));
  assert.equal(out.ready, true, JSON.stringify(out.reasons));
  assert.equal(out.requiredTotal, FIELDS.filter((f) => f.required).length);
  assert.ok(calls.some((u) => /api\.lever\.co\/v0\/postings\/matchgroup/.test(u)));
});

test("lever: without AI the required essay parks with a reason and the form is not ready", async () => {
  const out = await prepareLeverApplication("uid1", "matchgroup", "0a5ad123-7c5b-4d88-b498-5a0262beb331", { db: fakeDb(), openai: null, model: "test", fetch: fakeFetch([]) }, { domFields: FIELDS, companyName: "Match Group" });
  assert.equal(out.ready, false);
  assert.ok(out.review.some((r) => /Why do you want/.test(r.label) && /no AI/.test(r.note)), JSON.stringify(out.review));
  assert.ok(!out.fills.some((f) => f.path === "comments"), "optional free text is skipped without AI");
});

test("lever: the page header stands in when the posting API is down", async () => {
  const fetchDown = async (url) => (/resume\.pdf/.test(url) ? { ok: true, arrayBuffer: async () => Buffer.from("%PDF") } : { ok: false, status: 503 });
  const out = await prepareLeverApplication("uid1", "acme", "0a5ad123-7c5b-4d88-b498-5a0262beb331", { db: fakeDb(), openai: null, model: "test", fetch: fetchDown }, {
    domFields: FIELDS.slice(0, 6), companyName: "Acme Robots", jobTitle: "Robotics Engineer", jobLocationName: "Austin, TX",
  });
  assert.equal(out.jobTitle, "Robotics Engineer");
  assert.equal(out.companyName, "Acme Robots");
  const loc = out.fills.find((f) => f.path === "location");
  assert.equal(loc.value, "Austin");
  assert.equal(loc.match, "Austin, TX");
});

test("lever: ledger keys from apply URLs", () => {
  const k = formKeyFromUrl("https://jobs.lever.co/matchgroup/0A5AD123-7c5b-4d88-b498-5a0262beb331/apply?lever-source=LinkedIn");
  assert.deepEqual(k, { source: "lever", org: "matchgroup", postingId: "0a5ad123-7c5b-4d88-b498-5a0262beb331", formKey: "lever|matchgroup|0a5ad123-7c5b-4d88-b498-5a0262beb331" });
  assert.equal(formKeyFromUrl("https://jobs.eu.lever.co/acme/0a5ad123-7c5b-4d88-b498-5a0262beb331").source, "lever");
  assert.equal(formKeyFromUrl("https://jobs.lever.co/matchgroup"), null);
});
