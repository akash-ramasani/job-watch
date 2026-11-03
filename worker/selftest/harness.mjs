// harness.mjs — run the real extension's Autofill on live Ashby, Greenhouse
// and Lever forms (worker/selftest/run.mjs picks them). Server calls are
// answered by the local prepare modules with a complete test profile and a
// stand-in AI. Never submits: jwNoSubmit is set, and submit requests are
// blocked at the network. No resume bytes, so nothing is uploaded.
//   node worker/selftest/harness.mjs <list.txt> <out.json>
import { chromium } from "playwright-core";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const EXT = `${ROOT}/extension`;
function chromeForTesting() {
  const base = `${process.env.HOME}/Library/Caches/ms-playwright`;
  const dir = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
  return `${base}/${dir}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
}
const fresh = (m) => { delete require.cache[require.resolve(m)]; return require(m); };
const { prepareGreenhouseApplication } = fresh(`${ROOT}/functions/lib/apply/prepare.cjs`);
const { prepareAshbyApplication } = fresh(`${ROOT}/functions/lib/apply/ashby.cjs`);
const { prepareLeverApplication } = fresh(`${ROOT}/functions/lib/apply/lever.cjs`);

const USER = {
  firstName: "Ada", lastName: "Lovelace", fullName: "Ada Lovelace", email: "ada.test@example.com", phone: "+1 (415) 555-0100",
  city: "San Francisco", region: "California", postalCode: "94109", addressLine1: "1 Main St", country: "United States",
  linkedin: "https://linkedin.com/in/ada", github: "https://github.com/ada", portfolio: "", university: "California State University, East Bay",
  workAuthorized: "Yes", requiresSponsorship: "Yes", visaType: "H-1B", citizenshipCountry: "India", usPersonExportControl: "No", willingToRelocate: "Yes", willingToWorkHybrid: "Yes", smsConsent: "No",
  eeoGender: "Male", eeoEthnicity: "Asian", eeoVeteran: "I am not a protected veteran", eeoDisability: "No, I don't have a disability",
  pronouns: "He/Him", hourlyRate: "75 USD per hour", clearanceStatus: "None", clearanceLevel: "None", availability: "",
};
const RESUME = {
  summary: "Software engineer building backend services and data pipelines in Python on AWS.",
  skills: ["Python", "SQL", "JavaScript", "TypeScript", "React", "AWS", "Docker", "Kubernetes", "PostgreSQL"],
  roles: [
    { title: "Software Engineer", company: "Runn Technologies", location: "San Francisco, CA", startDate: "Jan 2023", endDate: "Present", description: "Built Python microservices on AWS. Designed PostgreSQL schemas. Shipped React dashboards." },
    { title: "Software Engineer Intern", company: "Acme Corp", location: "Hayward, CA", startDate: "Jun 2022", endDate: "Dec 2022", description: "Wrote ETL jobs in Python and SQL." },
  ],
  education: [{ degree: "Master of Science, Computer Science", institution: "California State University, East Bay", startDate: "2021", endDate: "May 2023" }],
};
const snap = (d) => ({ exists: !!d, data: () => d });
const db = { collection: () => ({ doc: () => ({ get: async () => snap(USER), collection: (n) => ({ doc: () => ({ get: async () => snap(n === "resume" ? RESUME : null) }), where: () => ({ limit: () => ({ get: async () => ({ empty: true }) }) }) }) }) }) };
const fetchFn = async (u, o) => (/resume\.pdf/.test(u) ? { ok: false, status: 404 } : fetch(u, o));
const openai = { chat: { completions: { create: async (req) => {
  if (/multiple-choice question/.test(req.messages?.[0]?.content || "")) {
    const opts = (req.messages[1].content.split("Options:\n")[1] || "").split("\n").map((l) => l.replace(/^- /, "")).filter(Boolean);
    const pick = opts.find((o) => /^yes\b/i.test(o)) || opts[0];
    return { choices: [{ message: { content: JSON.stringify({ picks: pick ? [pick] : [], why: "stub" }) } }] };
  }
  const q = (req.messages?.[1]?.content || "").match(/Question: (.*)/)?.[1] || "";
  return { choices: [{ message: { content: /cover/i.test(JSON.stringify(req.messages[0]?.content || "")) ? "I build backend services in Python and would like to do that work here." : "I have built Python services on AWS and enjoy shipping reliable systems." } }] };
} } } };
const deps = { db, openai, model: "t", fetch: fetchFn };

const [listFile, outFile] = process.argv.slice(2);
const urls = fs.readFileSync(listFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const ctx = await chromium.launchPersistentContext("", {
  executablePath: process.env.JW_CHROME || chromeForTesting(),
  headless: true, viewport: { width: 1280, height: 1000 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
await sw.evaluate(() => chrome.storage.local.set({ jwNoSubmit: true, jwIdToken: "t", jwRefreshToken: "r", jwUid: "u", jwTokenExpiry: Date.now() + 1e10 }));
// Belt and braces: no application request ever leaves a test browser.
await ctx.route(/ashbyhq\.com\/api\/non-user-graphql\?op=[^&]*Submit/i, (r) => r.abort());
await ctx.route(/lever\.co\/.*apply/i, (r) => (r.request().method() === "POST" ? r.abort() : r.continue()));
await ctx.route(/greenhouse\.io\/.*(applications|submit)/i, (r) => (r.request().method() === "POST" ? r.abort() : r.continue()));
await ctx.route("https://firestore.googleapis.com/**", (r) => r.fulfill({ contentType: "application/json", body: r.request().url().includes(":runQuery") ? "[]" : "{}" }));
await ctx.route("https://us-central1-greenhouse-jobs-scrapper.cloudfunctions.net/**", async (r) => {
  const fn = new URL(r.request().url()).pathname.slice(1);
  const data = JSON.parse(r.request().postData() || "{}").data || {};
  try {
    let result = { ok: true };
    if (fn === "prepareGreenhouseApplication") result = await prepareGreenhouseApplication("u", data.token, data.id, deps);
    else if (fn === "prepareAshbyApplication") result = await prepareAshbyApplication("u", data.org, data.id, deps, { domFields: data.domFields, jobTitle: data.jobTitle, companyName: data.companyName });
    else if (fn === "prepareLeverApplication") result = await prepareLeverApplication("u", data.site, data.id, deps, { domFields: data.domFields, jobTitle: data.jobTitle, companyName: data.companyName, jobLocationName: data.jobLocationName, eu: data.eu === true });
    else if (fn === "rescueField") {
      const be = (data.history || []).find((h) => h.boardError)?.boardError;
      if (be) {
        const ref = (String(data.html).match(/<input[^>]*data-jw-ref="(r\d+)"/) || [])[1];
        console.log("RESCUE_WITH_ERROR", JSON.stringify({ q: data.question, be, ref, round: data.round })); if (data.round === 1) console.log("HTML", String(data.html).slice(0, 1500));
        result = ref ? { steps: [{ op: "type", ref, text: "https://linkedin.com/in/fixed-by-ai" }], done: true, answer: "fixed", cannot: "" } : { steps: [], done: false, answer: "", cannot: "no input" };
      } else result = { steps: [], done: false, answer: "", cannot: "no AI in this test" };
    }
    else if (fn === "tailoredResumeFile") return r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not in test" } }) });
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ result }) });
  } catch (e) { r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: e.message } }) }); }
});
const GDOM = fs.readFileSync(`${EXT}/lib/generic-dom.js`, "utf8");
const LDOM = fs.readFileSync(`${EXT}/lib/lever-dom.js`, "utf8");
const results = [];
for (const url of urls) {
  const page = await ctx.newPage();
  const warnings = [];
  page.on("console", (m) => { const t = m.text(); if (/JobWatch/.test(t) && (process.env.ALLLOGS || /fill failed|fill error|could not|not found|failed/i.test(t))) warnings.push(t.slice(0, 400)); });
  const rec = { url, card: "", items: [], emptyRequired: [], warnings };
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    const card = () => page.evaluate(() => { const r = document.getElementById("jw-notify")?.shadowRoot; return r ? { pill: r.querySelector(".pill")?.textContent, msg: r.querySelector(".msg")?.textContent, items: [...r.querySelectorAll(".items li")].map((l) => l.textContent), btn: r.querySelector(".btn")?.textContent || "" } : null; }).catch(() => null);
    let c = null;
    for (let i = 0; i < 90 && !(c = await card())?.btn?.includes("Autofill"); i++) await page.waitForTimeout(500);
    if (!c) throw new Error("no Autofill card");
    await page.click("#jw-notify >> .btn");
    const t0 = Date.now();
    while (Date.now() - t0 < 300000) { await page.waitForTimeout(2000); c = await card(); if (c && /Done|Needs you|Error/.test(c.pill || "") && !/checking|filling|reading|working/i.test(c.msg || "")) break; }
    rec.card = `[${c?.pill}] ${c?.msg}`; rec.items = c?.items || [];
    // Lever: its own field reader (the generic one takes the optional EEO
    // survey for required questions); elsewhere the generic scan.
    let empties;
    if (/lever\.co\//.test(url)) {
      await page.evaluate(LDOM).catch(() => {});
      empties = await page.evaluate(() => window.__jwLever.scan().filter((f) => f.required && !f.filled && f.type !== "file").map((f) => `${f.type}: ${f.label}`)).catch((e) => [`scan failed: ${e.message}`]);
    } else {
      await page.evaluate(GDOM).catch(() => {});
      empties = await page.evaluate(async () => (await window.__jwGeneric.scan({ readOptions: false })).filter((f) => f.required && !f.filled && f.type !== "file").map((f) => `${f.type}: ${f.label}`)).catch((e) => [`scan failed: ${e.message}`]);
    }
    rec.emptyRequired = empties;
    if (process.env.ERRTEST) {
      const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url.startsWith(u.slice(0, 40)))?.id, url);
      const out = await sw.evaluate(async (t) => (await chrome.scripting.executeScript({ target: { tabId: t }, func: async () => window.__jwRescue("LinkedIn Profile", { error: "Enter a valid URL", force: true }) }))[0]?.result, tabId);
      console.log("RESCUE RESULT", JSON.stringify(out), "value now:", await page.evaluate(() => [...document.querySelectorAll("[data-field-path]")].find((w) => /linkedin/i.test(w.textContent))?.querySelector("input")?.value));
    }
  } catch (e) { rec.card = `HARNESS ERROR: ${e.message}`; }
  results.push(rec);
  console.log(`\n== ${url}\n   card: ${rec.card}\n   needs: ${rec.items.join(" | ")}\n   empty required: ${rec.emptyRequired.join(" | ")}\n   warnings: ${warnings.slice(0, process.env.ALLLOGS ? 80 : 6).join("\n     ")}`);
  fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
  await page.close();
}
await ctx.close();
