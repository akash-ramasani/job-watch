// Assistant tool helpers + the tools themselves against an in-memory Firestore stand-in.
// Run: npm test (in functions/)
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../lib/assistantTools.cjs");

test("parseStates understands names, codes and lists", () => {
  assert.deepEqual(T.parseStates("California"), ["CA"]);
  assert.deepEqual(T.parseStates("ca, Washington; new york"), ["CA", "WA", "NY"]);
  assert.deepEqual(T.parseStates("state of Texas"), ["TX"]);
  assert.deepEqual(T.parseStates("Washington DC"), ["DC"]);
  assert.deepEqual(T.parseStates("Narnia"), []);
  assert.deepEqual(T.parseStates(""), []);
});

test("parseCity maps cities and metro nicknames to cities + states", () => {
  const seattle = T.parseCity("Seattle");
  assert.deepEqual(seattle.cities, ["seattle"]);
  assert.deepEqual(seattle.states, ["WA"]);
  assert.deepEqual(T.parseCity("NYC").states.sort(), ["NJ", "NY"]);
  assert.ok(T.parseCity("Bay Area").cities.includes("palo alto"));
  assert.deepEqual(T.parseCity("bay area").states, ["CA"]);
  assert.ok(T.parseCity("Seattle area").cities.includes("bellevue"));
  assert.deepEqual(T.parseCity("Seattle, WA").cities, ["seattle"]);
  assert.deepEqual(T.parseCity("Tuscaloosa"), { cities: ["tuscaloosa"], states: [] }); // unknown city: no state narrowing
});

test("titleMatches: any phrase, all of its words, short words whole", () => {
  const p = T.parseKeywords("software engineer, backend");
  assert.ok(T.titleMatches("Senior Software Engineer, Payments", p));
  assert.ok(T.titleMatches("Backend Developer", p));
  assert.ok(!T.titleMatches("Product Manager", p));
  assert.ok(T.titleMatches("ML Engineer", T.parseKeywords("ml")));
  assert.ok(!T.titleMatches("HTML Developer", T.parseKeywords("ml")));
  assert.ok(T.titleMatches("Anything", []));
});

test("isRelatedJob follows the Jobs page rule", () => {
  const types = ["software", "ml_ai"];
  assert.ok(T.isRelatedJob({ fam: ["software"] }, null, types));
  assert.ok(!T.isRelatedJob({ fam: ["sales"] }, null, types));
  assert.ok(T.isRelatedJob({ fam: [] }, null, types));
  assert.ok(!T.isRelatedJob({ fam: ["software"] }, { o: 1 }, types));
  assert.ok(T.isRelatedJob({ fam: ["sales"] }, { k: "2:1", score: 70 }, types));
  assert.ok(!T.isRelatedJob({ fam: ["software"], el: ["no_sponsorship"] }, null, types, { needsSponsorship: true }));
  assert.ok(T.isRelatedJob({ fam: ["software"], el: ["no_sponsorship"] }, null, types, { needsSponsorship: false }));
});

test("stripHtml keeps list structure and decodes entities", () => {
  assert.equal(T.stripHtml("<p>Hi &amp; bye</p><ul><li>one</li><li>two</li></ul>"), "Hi & bye\n- one\n- two");
});

test("tool definitions are well-formed for OpenAI and MCP", () => {
  const names = T.TOOL_DEFS.map((t) => t.name);
  assert.deepEqual(names, ["search_jobs", "job_stats", "get_job_details", "get_my_profile", "list_tracked_companies", "get_sync_status", "update_memory"]);
  for (const t of T.toolsForOpenAI()) assert.equal(t.function.parameters.type, "object");
  for (const t of T.toolsForMcp()) assert.equal(t.inputSchema.type, "object");
});

/* ---- an in-memory Firestore just big enough for the tools ---- */
function fakeDb(store) {
  // store: { "users/uid/jobs/id": {...} }
  const docRef = (path) => ({
    path,
    get: async () => ({ exists: path in store, id: path.split("/").pop(), data: () => store[path] }),
    set: async (data, opts) => { store[path] = opts?.merge ? { ...(store[path] || {}), ...data } : data; },
    collection: (name) => colRef(`${path}/${name}`),
  });
  const colRef = (path) => {
    const q = { filters: [], lim: Infinity };
    const self = {
      doc: (id) => docRef(`${path}/${id}`),
      where: (f, op, v) => { q.filters.push([f, op, v]); return self; },
      orderBy: () => self,
      select: () => self,
      limit: (n) => { q.lim = n; return self; },
      count: () => ({ get: async () => { const n = (await self.get()).size; return { data: () => ({ count: n }) }; } }),
      get: async () => {
        const docs = Object.entries(store)
          .filter(([k]) => k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes("/"))
          .map(([k, v]) => ({ id: k.split("/").pop(), data: () => v }))
          .filter(({ data }) => q.filters.every(([f, op, v]) => {
            const x = data()[f];
            if (op === ">=") return x >= v;
            if (op === "==") return x === v;
            if (op === "array-contains") return Array.isArray(x) && x.includes(v);
            return true;
          }))
          .slice(0, q.lim);
        return { docs, size: docs.length, exists: true };
      },
    };
    return self;
  };
  return { collection: (name) => colRef(name) };
}

const ADMIN = T.ADMIN_UID;
const NOW = new Date("2026-09-29T20:00:00Z");
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000);
const job = (id, o) => [`users/${ADMIN}/jobs/${id}`, { title: "Software Engineer", companyName: "Acme", locationName: "Seattle, WA", stateCodes: ["WA"], isRemote: false, jobUrl: `https://x/${id}`, sourceUpdatedTs: hoursAgo(2), el: [], ...o }];

function seed() {
  const store = Object.fromEntries([
    job("a", {}),
    job("b", { title: "Backend Engineer", locationName: "San Francisco, CA", stateCodes: ["CA"], sourceUpdatedTs: hoursAgo(5) }),
    job("c", { title: "Account Executive", locationName: "Los Angeles, CA", stateCodes: ["CA"], sourceUpdatedTs: hoursAgo(30) }),
    job("d", { title: "ML Engineer", locationName: "Remote - US", stateCodes: [], isRemote: true, sourceUpdatedTs: hoursAgo(1) }),
    job("e", { title: "Staff Software Engineer", locationName: "Bellevue, WA", stateCodes: ["WA"], sourceUpdatedTs: hoursAgo(100), el: ["no_sponsorship"] }),
  ]);
  store[`users/u1`] = { firstName: "Sam", requiresSponsorship: "Yes" };
  store[`users/u1/resume/profile`] = { roles: [{ title: "Software Engineer", company: "X", startDate: "Jan 2021", endDate: "present" }] };
  store[`users/u1/settings/preferences`] = {};
  store[`users/u1/aggregations/myJobScores`] = { scores: { a: { score: 82, reason: "Covers 5 of 6", k: "2:1" }, b: { score: 55, reason: "Half", k: "2:1" } } };
  return store;
}

test("search_jobs: California in the past 24 hours, relevant first", async () => {
  const ctx = T.createAssistantContext(fakeDb(seed()), "u1", { now: () => NOW });
  const r = await T.runTool(ctx, "search_jobs", { state: "california", postedWithinHours: 24 });
  assert.equal(r.counts.matchingFilters, 1); // c is 30h old
  assert.deepEqual(r.jobs.map((j) => j.id), ["b"]);
  assert.equal(r.jobs[0].myScore, 55);
  assert.match(r.filters, /CA \(california\)/);
  assert.match(r.alsoRemote, /1 remote/);
});

test("search_jobs: Seattle narrows by city, hides visa-blocked jobs, falls back to all", async () => {
  const ctx = T.createAssistantContext(fakeDb(seed()), "u1", { now: () => NOW });
  const r = await T.runTool(ctx, "search_jobs", { city: "Seattle", postedWithinHours: 168 });
  assert.deepEqual(r.jobs.map((j) => j.id), ["a"]);
  const wa = await T.runTool(ctx, "search_jobs", { state: "WA", postedWithinHours: 168 });
  assert.equal(wa.counts.matchingFilters, 2);
  assert.equal(wa.counts.relevantToUser, 1); // e needs no sponsorship
  const sales = await T.runTool(ctx, "search_jobs", { state: "CA", postedWithinHours: 72 });
  assert.equal(sales.counts.matchingFilters, 2);
  const only = await T.runTool(ctx, "search_jobs", { state: "CA", keywords: "account executive", postedWithinHours: 72 });
  assert.equal(only.counts.relevantToUser, 0);
  assert.equal(only.jobs.length, 1);
  assert.match(only.note, /none of the 1/i);
});

test("search_jobs: score sort, minScore, paging, remote", async () => {
  const ctx = T.createAssistantContext(fakeDb(seed()), "u1", { now: () => NOW });
  const r = await T.runTool(ctx, "search_jobs", { sortBy: "score", postedWithinHours: 168, limit: 2 });
  assert.deepEqual(r.jobs.map((j) => j.id), ["a", "b"]);
  assert.equal(r.counts.hasMore, true);
  const more = await T.runTool(ctx, "search_jobs", { sortBy: "score", postedWithinHours: 168, limit: 2, offset: 2 });
  assert.deepEqual(more.jobs.map((j) => j.id), ["d"]);
  const strong = await T.runTool(ctx, "search_jobs", { minScore: 80, postedWithinHours: 168 });
  assert.deepEqual(strong.jobs.map((j) => j.id), ["a"]);
  const remote = await T.runTool(ctx, "search_jobs", { remote: true });
  assert.deepEqual(remote.jobs.map((j) => j.id), ["d"]);
});

test("job_stats groups by state and job type", async () => {
  const ctx = T.createAssistantContext(fakeDb(seed()), "u1", { now: () => NOW });
  const r = await T.runTool(ctx, "job_stats", { groupBy: "state", postedWithinHours: 168, onlyRelevantToMe: false });
  assert.equal(r.counts.counted, 5);
  assert.deepEqual(r.groups.slice(0, 2).map((g) => g.count), [2, 2]);
  assert.deepEqual(r.groups.slice(0, 2).map((g) => g.key).sort(), ["CA", "WA"]);
  const t = await T.runTool(ctx, "job_stats", { groupBy: "jobType", postedWithinHours: 168 });
  assert.equal(t.groups[0].key, "Software engineering");
});

test("get_job_details, get_my_profile, update_memory", async () => {
  const store = seed();
  store[`users/${ADMIN}/jobs/a`].fullDescription = "<p>Build things.</p><ul><li>Go</li></ul>";
  store[`users/u1/jobScores/a`] = { fit: { score: 82, method: "ai", roleFit: "same", requirements: [{ requirement: "Go", need: "must", covered: "yes", evidence: "Go at X" }] } };
  const ctx = T.createAssistantContext(fakeDb(store), "u1", { now: () => NOW });
  const d = await T.runTool(ctx, "get_job_details", { jobId: "a" });
  assert.equal(d.description, "Build things.\n- Go");
  assert.equal(d.myAssessment.requirements[0].covered, "yes");
  const gone = await T.runTool(ctx, "get_job_details", { jobId: "zzz" });
  assert.match(gone.error, /no longer stored/);
  const p = await T.runTool(ctx, "get_my_profile", {});
  assert.equal(p.preferredName, "Sam");
  assert.equal(p.needsVisaSponsorship, true);
  assert.equal(p.scoredJobs.strong80plus, 1);
  assert.equal(p.targetedJobTypes[0].id, "software");
  const m = await T.runTool(ctx, "update_memory", { add: "Prefers remote roles in Seattle" });
  assert.deepEqual(m.notes, ["Prefers remote roles in Seattle"]);
  const m2 = await T.runTool(ctx, "update_memory", { remove: "remote roles" });
  assert.equal(m2.removed, 1);
  const prompt = await T.buildSystemPrompt(ctx);
  assert.match(prompt, /Name: Sam/);
  assert.match(prompt, /Needs visa sponsorship/);
  assert.match(prompt, /Pacific Time/);
});
