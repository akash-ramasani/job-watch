import { getProfile, getResume } from "./lib/firestore.mjs";
import { fetchForm, listJobs } from "./lib/greenhouse.mjs";
import { generateApplicationDocs } from "./lib/generate-docs.mjs";

const profile = await getProfile();
const resume = await getResume();
const jobs = await listJobs("databricks");
const swe = jobs.find(j => /software engineer|backend|full stack|platform/i.test(j.title)) || jobs[0];
const form = await fetchForm("databricks", swe.id);
const job = { title: form.title, companyName: "Databricks", descriptionHtml: form.descriptionHtml };

const res = await generateApplicationDocs(profile, resume, job, "./out");
console.log("JOB:", form.title);
console.log("tailored:", res.tailored);
console.log("resumePath:", res.resumePath);
console.log("coverPath:", res.coverPath);
console.log("\n--- cover letter text ---\n" + res.coverText);
process.exit(0);
