/**
 * functions/lib/ruleScore.cjs
 *
 * A free, instant match score from parsing — no model call. It builds the
 * same requirement list the AI assessment builds (jobFit.cjs), just by rules:
 *
 *   1. The description is split into sections; lines under "requirements /
 *      minimum qualifications / what you'll need" are must-haves, lines under
 *      "preferred / nice to have / bonus" are nice-to-haves.
 *   2. Skills are found with a dictionary (SKILLS below). A line that offers
 *      alternatives ("Java, Go, or C++", "such as AWS or GCP") is one
 *      requirement met by any of them; otherwise each skill is its own.
 *   3. Each requirement is checked against the resume: yes when the resume
 *      has the skill, partial when it has a close sibling (GCP vs AWS),
 *      else no. Years ("5+ years") and security clearances are added too.
 *   4. The result goes through jobFit.scoreAssessment — the exact scoring,
 *      role/level caps and one-line reason the AI score uses.
 *
 * So the two scores are the same formula; only how requirements are read
 * differs. Measured against the AI score in scripts/measure-rule-score.mjs.
 */

const { scoreAssessment, candidateYearsOf, isSoftwareCandidate, buildProfileText, contentWords } = require("./jobFit.cjs");
const { classifyTitle, familiesForProfile, ownFamilyForProfile, ADJACENT } = require("./jobFamilies.cjs");

const RULE_VERSION = 2; // bump when the rules change, so stored rule scores are redone

// id: canonical skill; re: how it's written; group: siblings that earn partial credit.
// Case-sensitive patterns are for words that are also ordinary English (Go, React, Swift, R).
const SKILLS = [
  // Languages
  ["python", /\bpython\b/i, "lang"], ["java", /\bjava\b(?!\s*script)/i, "lang"], ["javascript", /\b(javascript|ecmascript)\b/i, "js"],
  ["typescript", /\btypescript\b/i, "js"], ["go", /\b(golang|Go)\b(?![- ]to[- ]market|-live| live)/, "lang"], ["cpp", /(\bc\+\+|\bcpp\b)/i, "lang"],
  ["csharp", /(\bc#|\.net\b|\bdotnet\b)/i, "lang"], ["rust", /\brust\b/i, "lang"], ["kotlin", /\bkotlin\b/i, "lang"], ["scala", /\bscala\b/i, "lang"],
  ["ruby", /\b(ruby|rails)\b/i, "lang"], ["php", /\bphp\b/i, "lang"], ["swift", /\bSwift\b/, "mobile"], ["objc", /\bobjective-?c\b/i, "mobile"],
  ["r", /\bR\b(?![&-])(?=[\s,/)]|$)/, "stats"], ["sql", /\b(sql|t-sql|pl\/sql)\b/i, "sql"], ["bash", /\b(bash|shell scripting|shell scripts)\b/i, "ops"],
  ["html_css", /\b(html5?|css3?|sass)\b/i, "web"],
  // Frontend / mobile
  ["react", /\b(React(\.js)?|ReactJS)\b/, "fe"], ["nextjs", /\bnext\.?js\b/i, "fe"], ["vue", /\bvue(\.js)?\b/i, "fe"], ["angular", /\bangular\b/i, "fe"],
  ["svelte", /\bsvelte\b/i, "fe"], ["tailwind", /\btailwind\b/i, "web"], ["ios", /\b(ios|swiftui|uikit)\b/i, "mobile"], ["android", /\b(android|jetpack compose)\b/i, "mobile"],
  ["react_native", /\breact native\b/i, "mobile"], ["flutter", /\bflutter\b/i, "mobile"],
  // Backend frameworks & APIs
  ["nodejs", /\bnode(\.?js)?\b(?!s)/i, "be"], ["spring", /\bspring( boot)?\b/i, "be"], ["django", /\bdjango\b/i, "be"], ["flask", /\bflask\b/i, "be"],
  ["fastapi", /\bfastapi\b/i, "be"], ["express", /\bexpress(\.js)?\b(?= ?(js|framework|,|\/| or| and))/i, "be"], ["fastify", /\bfastify\b/i, "be"],
  ["hibernate", /\b(hibernate|jpa)\b/i, "orm"], ["orm", /\b(orm|prisma|drizzle|sqlalchemy)\b/i, "orm"],
  ["rest", /\b(rest(ful)?( apis?| services)?|rest api)\b/i, "api"], ["graphql", /\bgraphql\b/i, "api"], ["grpc", /\bgrpc\b/i, "api"],
  ["websockets", /\bwebsockets?\b/i, "api"], ["apis", /\b(apis?|api design)\b/i, "api"],
  ["microservices", /\bmicro-?services?\b/i, "arch"], ["distributed", /\bdistributed (systems?|computing|architectures?)\b/i, "arch"],
  ["system_design", /\b(system design|systems design|scalable (systems|architecture|services))\b/i, "arch"], ["event_driven", /\bevent[- ]driven\b/i, "arch"],
  ["backend", /\bback[- ]?end\b/i, "role"], ["frontend", /\bfront[- ]?end\b/i, "role"], ["fullstack", /\bfull[- ]?stack\b/i, "role"],
  ["workflow", /\b(temporal|workflow orchestration|airflow|step functions)\b/i, "orch"],
  // Cloud & infra
  ["aws", /\b(aws|amazon web services|ec2|s3|lambda|ecs|eks|app runner)\b/i, "cloud"], ["gcp", /\b(gcp|google cloud)\b/i, "cloud"], ["azure", /\bazure\b/i, "cloud"],
  ["cloud", /\bcloud(-native)?\b/i, "cloud"], ["docker", /\b(docker|containers?|containerization)\b/i, "container"], ["kubernetes", /\b(kubernetes|k8s|eks|gke|aks|helm)\b/i, "container"],
  ["terraform", /\b(terraform|infrastructure as code|iac|cloudformation|pulumi)\b/i, "iac"], ["ansible", /\b(ansible|chef|puppet)\b/i, "iac"],
  ["cicd", /\b(ci\/cd|ci ?\/ ?cd|continuous (integration|delivery|deployment)|github actions|jenkins|gitlab ci|circleci|argo ?cd)\b/i, "cicd"],
  ["linux", /\b(linux|unix)\b/i, "ops"], ["git", /\bgit(hub|lab)?\b/i, "tool"], ["serverless", /\bserverless\b/i, "cloud"],
  ["networking", /\b(networking|tcp\/ip|dns|load balanc\w+|http\/2)\b/i, "net"],
  ["observability", /\b(observability|monitoring|prometheus|grafana|datadog|opentelemetry|splunk|new relic|alerting)\b/i, "obs"],
  ["incident", /\b(on-?call|incident response|incident management|sre practices)\b/i, "obs"],
  ["performance", /\b(performance (tuning|testing|optimization)|load testing|profiling|latency)\b/i, "perf"],
  // Data stores & data eng
  ["postgres", /\b(postgres(ql)?)\b/i, "rdbms"], ["mysql", /\bmysql\b/i, "rdbms"], ["sqlserver", /\b(sql server|mssql)\b/i, "rdbms"], ["oracle_db", /\boracle (database|db)\b/i, "rdbms"],
  ["db2", /\bdb2\b/i, "rdbms"], ["mongodb", /\bmongo(db)?\b/i, "nosql"], ["dynamodb", /\bdynamo(db)?\b/i, "nosql"], ["cassandra", /\bcassandra\b/i, "nosql"],
  ["redis", /\b(redis|memcached|caching|ignite)\b/i, "cache"], ["elasticsearch", /\b(elasticsearch|opensearch|solr)\b/i, "search"],
  ["databases", /\b(databases?|data stores?|rdbms|relational)\b/i, "rdbms"], ["schema", /\b(schema design|data modell?ing|database design)\b/i, "rdbms"],
  ["kafka", /\b(kafka|kinesis|pub\/sub|rabbitmq|sqs|message (queues?|brokers?)|streaming)\b/i, "queue"],
  ["spark", /\b(spark|pyspark|hadoop|flink|beam)\b/i, "bigdata"], ["etl", /\b(etl|elt|data pipelines?)\b/i, "pipe"], ["dbt", /\bdbt\b/i, "pipe"],
  ["snowflake", /\b(snowflake|bigquery|redshift|databricks|data warehouse|lakehouse)\b/i, "dw"],
  // Analytics
  ["tableau", /\b(tableau|power ?bi|looker|qlik|superset|mode analytics)\b/i, "bi"], ["excel", /\b(excel|spreadsheets?|google sheets)\b/i, "bi"],
  ["statistics", /\b(statistic(s|al)|hypothesis testing|regression)\b/i, "stats"], ["ab_testing", /\b(a\/b test\w*|experimentation)\b/i, "stats"],
  ["analytics", /\b(analytics|data analysis|dashboards?|reporting|kpis?)\b/i, "bi"],
  // ML / AI
  ["ml", /\b(machine learning|ml(?!\s*s)|ml models?)\b/i, "ml"], ["deep_learning", /\b(deep learning|neural networks?)\b/i, "ml"],
  ["pytorch", /\b(pytorch|tensorflow|jax|keras|scikit-learn|sklearn)\b/i, "ml"], ["llm", /\b(llms?|large language models?|generative ai|genai|gpt|claude|openai|anthropic)\b/i, "llm"],
  ["agents", /\b(ai agents?|agentic|agents? (framework|workflows?|systems?)|multi-agent|mcp|model context protocol|tool use)\b/i, "llm"],
  ["rag", /\b(rag|retrieval[- ]augmented|vector (databases?|search|stores?)|embeddings?|pinecone|pgvector)\b/i, "llm"],
  ["prompting", /\b(prompt engineering|prompt design|prompting|evals?|evaluations? of (llms?|models))\b/i, "llm"],
  ["nlp", /\b(nlp|natural language processing)\b/i, "ml"], ["cv", /\bcomputer vision\b/i, "ml"], ["mlops", /\b(mlops|model serving|model deployment|inference)\b/i, "ml"],
  ["cuda", /\b(cuda|gpu programming|triton)\b/i, "hw"],
  // Practices
  ["testing", /\b(unit test\w*|automated test\w*|test automation|tdd|integration tests?|testing frameworks?|pytest|jest|junit|selenium|cypress|playwright)\b/i, "test"],
  ["agile", /\b(agile|scrum|kanban)\b/i, "process"], ["security_practices", /\b(oauth|oidc|sso|saml|encryption|secure coding|owasp|iam)\b/i, "sec"],
  ["payments", /\b(payments?|stripe|billing systems?)\b/i, "domain"],
  // Enterprise / other fields (so their jobs don't look skill-free)
  ["salesforce", /\b(salesforce|apex)\b/i, "ent"], ["sap", /\bsap\b/i, "ent"], ["servicenow", /\bservicenow\b/i, "ent"], ["workday_app", /\bworkday (hcm|studio|integrations?)\b/i, "ent"],
  ["embedded", /\b(embedded|firmware|rtos|microcontrollers?)\b/i, "hw"], ["fpga", /\b(fpga|verilog|vhdl|asic|rtl)\b/i, "hw"], ["figma", /\bfigma\b/i, "design"],
].map(([id, re, group]) => ({ id, re, group }));

const LABELS = {
  python: "Python", java: "Java", javascript: "JavaScript", typescript: "TypeScript", go: "Go", cpp: "C++", csharp: "C#/.NET", rust: "Rust", kotlin: "Kotlin",
  scala: "Scala", ruby: "Ruby", php: "PHP", swift: "Swift", objc: "Objective-C", r: "R", sql: "SQL", bash: "Bash", html_css: "HTML/CSS", react: "React",
  nextjs: "Next.js", vue: "Vue", angular: "Angular", svelte: "Svelte", tailwind: "Tailwind", ios: "iOS", android: "Android", react_native: "React Native",
  flutter: "Flutter", nodejs: "Node.js", spring: "Spring", django: "Django", flask: "Flask", fastapi: "FastAPI", express: "Express", fastify: "Fastify",
  hibernate: "Hibernate/JPA", orm: "ORMs", rest: "REST APIs", graphql: "GraphQL", grpc: "gRPC", websockets: "WebSockets", apis: "APIs",
  microservices: "Microservices", distributed: "Distributed systems", system_design: "System design", event_driven: "Event-driven design",
  backend: "Backend", frontend: "Frontend", fullstack: "Full stack", workflow: "Workflow orchestration", aws: "AWS", gcp: "GCP", azure: "Azure",
  cloud: "Cloud", docker: "Docker", kubernetes: "Kubernetes", terraform: "Terraform/IaC", ansible: "Config management", cicd: "CI/CD", linux: "Linux",
  git: "Git", serverless: "Serverless", networking: "Networking", observability: "Observability", incident: "On-call/incidents",
  performance: "Performance tuning", postgres: "PostgreSQL", mysql: "MySQL", sqlserver: "SQL Server", oracle_db: "Oracle DB", db2: "DB2",
  mongodb: "MongoDB", dynamodb: "DynamoDB", cassandra: "Cassandra", redis: "Caching", elasticsearch: "Search engines", databases: "Databases",
  schema: "Data modeling", kafka: "Streaming/queues", spark: "Spark/big data", etl: "Data pipelines", dbt: "dbt", snowflake: "Data warehouses",
  tableau: "BI tools", excel: "Excel", statistics: "Statistics", ab_testing: "A/B testing", analytics: "Analytics", ml: "Machine learning",
  deep_learning: "Deep learning", pytorch: "ML frameworks", llm: "LLMs", agents: "AI agents", rag: "RAG/embeddings", prompting: "Prompting/evals",
  nlp: "NLP", cv: "Computer vision", mlops: "MLOps", cuda: "CUDA/GPU", testing: "Automated testing", agile: "Agile", security_practices: "Security",
  payments: "Payments", salesforce: "Salesforce", sap: "SAP", servicenow: "ServiceNow", workday_app: "Workday", embedded: "Embedded", fpga: "FPGA/RTL", figma: "Figma",
};
const label = (id) => LABELS[id] || id;

// Requirement lines the AI is told to ignore (traits), or that every candidate meets.
const SOFT_LINE_RE = /\b(communicat\w*|collaborat\w*|team ?player|passion\w*|curio\w*|self-?starter|ambiguity|fast-paced|ownership|detail[- ]oriented|interpersonal|problem[- ]solving|growth mindset|work (independently|authorization)|authorized to work|sponsorship|travel|relocat\w*|lift \d+|background check|drug|equal opportunity|eoe)\b/i;
const DEGREE_RE = /\b(bachelor|master|b\.?s\.?|m\.?s\.?|ph\.?d|degree|diploma)\b/i;

// Words that make one requirement out of several skills.
const ALTERNATIVES_RE = /\b(or|such as|e\.g\.|eg\.|one or more|at least one|any of|one of)\b|and\/or/i;

const MUST_HEAD_RE = /^(.{0,12})?(requirements?|required|minimum|basic|must[- ]haves?|qualifications|what you('|’)?ll need|what you need|what we('|’)?re looking for|you have|you bring|who you are|about you|your (background|experience|skills)|skills( and| &) experience|experience( and| &) skills|what you bring|key qualifications)\b/i;
const NICE_HEAD_RE = /\b(preferred|nice[- ]to[- ]haves?|bonus|pluses|plus points|a plus|ideally|good to have|desired|extra credit|standout)\b/i;
const IGNORE_HEAD_RE = /\b(benefits|perks|compensation|salary|pay (range|transparency)|equal (opportunity|employment)|about (us|the company|[A-Z][a-z]+$)|our (mission|values|culture)|why (join|work)|what we offer|eeo|accommodation|privacy|disclaimer|location|hybrid|in[- ]office)\b/i;
const RESP_HEAD_RE = /\b(responsibilities|what you('|’)?ll do|the role|your role|what you will do|day[- ]to[- ]day|in this role|you will|job description|overview|the opportunity)\b/i;

function decodeEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;|&rsquo;|&#8217;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** Description (HTML, escaped HTML, or text) → trimmed lines, headings kept on their own line. */
function descriptionLines(description) {
  let t = decodeEntities(decodeEntities(description));
  t = t.replace(/<\s*(br|\/p|\/li|\/h\d|\/div|\/tr|\/ul|\/ol)\b[^>]*>/gi, "\n").replace(/<\s*li\b[^>]*>/gi, "\n- ").replace(/<[^>]+>/g, " ");
  return t.split(/\n+/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
}

// Broad words that mean little next to a specific one ("APIs" beside "REST").
const GENERIC = { apis: "api", cloud: "cloud", databases: "rdbms", analytics: "bi", backend: null, frontend: null, git: null };
const skillsIn = (text) => {
  const found = SKILLS.filter((s) => s.re.test(text));
  return found.filter((s) => !(s.id in GENERIC) || !found.some((o) => o.id !== s.id && GENERIC[s.id] && o.group === GENERIC[s.id]));
};

/**
 * The job's requirements as the AI would list them: [{ r, n: must|nice, skills: [ids] }],
 * plus minYears and whether a clearance is required.
 */
function parseRequirements(description) {
  const lines = descriptionLines(description);
  let section = "other";
  let sawMust = false;
  const bySection = { must: [], nice: [], resp: [], other: [] };
  for (const line of lines) {
    const isHeading = line.length <= 90 && !/[.;]$/.test(line) && (!line.startsWith("-") || line.length < 40);
    if (isHeading) {
      if (IGNORE_HEAD_RE.test(line) && !MUST_HEAD_RE.test(line)) { section = "ignore"; continue; }
      if (NICE_HEAD_RE.test(line)) { section = "nice"; continue; }
      if (MUST_HEAD_RE.test(line)) { section = "must"; sawMust = true; continue; }
      if (RESP_HEAD_RE.test(line)) { section = "resp"; continue; }
    }
    if (section === "ignore") continue;
    // Inline markers inside a requirements list: "(preferred)", "a plus", "nice to have".
    const need = section === "must" && NICE_HEAD_RE.test(line) ? "nice" : section;
    bySection[need].push(line);
  }
  // No requirements heading: the whole text stands in for it.
  const mustLines = sawMust ? bySection.must : [...bySection.resp, ...bySection.other, ...bySection.must];
  const niceLines = bySection.nice;

  const reqs = new Map(); // key → req
  const add = (need, skills, text) => {
    const key = skills.map((s) => s.id).sort().join("|");
    const prev = reqs.get(key);
    if (prev) { if (need === "must") prev.n = "must"; return; }
    // A skill already required on its own doesn't need a second, looser requirement.
    if (skills.length > 1 && skills.some((s) => reqs.has(s.id) && reqs.get(s.id).n === "must")) return;
    reqs.set(key, { r: text, n: need, skills: skills.map((s) => s.id) });
  };
  const plain = []; // requirement lines with no dictionary skill: judged by word overlap
  for (const [need, list] of [["must", mustLines], ["nice", niceLines]]) {
    for (const line of list) {
      const found = skillsIn(line);
      if (!found.length) {
        if ((sawMust || need === "nice") && line.length >= 25 && line.length <= 300 && !SOFT_LINE_RE.test(line) && !/\byears?\b/i.test(line)) plain.push({ r: line.replace(/^- /, ""), n: need });
        continue;
      }
      if (found.length > 1 && ALTERNATIVES_RE.test(line)) add(need, found, found.map((s) => label(s.id)).join(" or "));
      else for (const s of found) add(need, [s], label(s.id));
    }
  }

  const text = lines.join("\n");
  const reqText = (sawMust ? bySection.must : lines).join("\n");
  // Years: the first "N+ years … experience" in the requirements (not "18 years of age").
  const years = [];
  for (const line of reqText.split("\n")) {
    if (!/experience|exp\b|background|industry|professional/i.test(line)) continue;
    for (const m of line.matchAll(/(\d{1,2})\s*\+?\s*(?:-|–|to)?\s*(?:\d{1,2})?\s*\+?\s*(?:years?|yrs)\b(?!\s+(old|of age))/gi)) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 15) years.push(n);
    }
  }
  const minYears = years.length ? years[0] : null;
  // Clearance only when one must already be held, not "able to obtain".
  const clearanceText = text.replace(/[^.\n]*\b(ability to obtain|able to obtain|eligib\w+ (for|to obtain)|obtain and maintain|preferred|a plus)\b[^.\n]*/gi, " ");
  const clearance = /\b(active|current|existing|hold|holds|possess)\b[^.\n]{0,40}\b(ts\/sci|top secret|secret|security) clearance|\b(ts\/sci|top secret) (clearance )?(is )?required|clearance (is )?required\b/i.test(clearanceText);

  return { requirements: [...reqs.values()].slice(0, 16), plain: plain.slice(0, 8), minYears, clearance };
}

/** What the resume offers: skill ids, their groups, and a quotable line per skill. */
function profileSkills(profile) {
  const text = buildProfileText(profile, 20000);
  const lines = text.split("\n").map((l) => l.replace(/^- /, "").trim()).filter(Boolean);
  const have = new Map(); // id → evidence line
  for (const s of SKILLS) {
    const line = lines.find((l) => s.re.test(l));
    if (line) have.set(s.id, line.slice(0, 200));
  }
  const groups = new Set(SKILLS.filter((s) => have.has(s.id)).map((s) => s.group));
  return { have, groups, text, words: new Set(contentWords(text)), hasClearance: /\bclearance\b/i.test(text) };
}

const GROUP_OF = Object.fromEntries(SKILLS.map((s) => [s.id, s.group]));
// Types that the AI scores well below the profile's own even though they're
// in its targets (median AI score 0–15 for a software profile).
const FAR = { software: ["solutions", "security", "data_analytics", "it_support"], ml_ai: ["solutions"], data_engineering: ["solutions"] };
const FAR_CAP = 30;
const SHRINK_TO = 45;
const SHRINK_WEIGHT = 4; // = two must-haves' worth of evidence
const PLAIN_YES = 0.6;
const PLAIN_PARTIAL = 0.35;

// Siblings close enough for partial credit; languages don't count (Java ≠ Go).
const PARTIAL_GROUPS = new Set(["cloud", "fe", "rdbms", "nosql", "queue", "cicd", "obs", "iac", "container", "bi", "dw", "orm", "be", "api", "ml", "llm", "mobile", "js", "cache", "search", "test"]);

/**
 * Rule-based assessment in the same shape as jobFit.assessJobFit's.
 * @param {{ profile, jobTitle, description, targets?: string[], mine? }} args
 *   mine: precomputed profileSkills(profile), to reuse across many jobs
 */
function ruleAssessJob({ profile, jobTitle, description, targets = null, mine = null }) {
  const me = mine || profileSkills(profile);
  const parsed = parseRequirements(description);
  const requirements = parsed.requirements.map((q) => {
    const hit = q.skills.find((id) => me.have.has(id));
    if (hit) return { r: q.r, n: q.n, c: "yes", e: me.have.get(hit) };
    const sibling = q.skills.find((id) => PARTIAL_GROUPS.has(GROUP_OF[id]) && me.groups.has(GROUP_OF[id]));
    if (sibling) {
      const ev = [...me.have.entries()].find(([id]) => GROUP_OF[id] === GROUP_OF[sibling]);
      return { r: q.r, n: q.n, c: "partial", e: ev ? ev[1] : "" };
    }
    return { r: q.r, n: q.n, c: "no", e: "" };
  });
  // Lines without a known skill: degree lines are met (a degree is on the
  // resume), others count as met / partly / not by how many of their words the
  // resume uses — the same test the AI score applies to its evidence quotes.
  const hasDegree = (profile?.education || []).length > 0;
  for (const q of parsed.plain) {
    if (DEGREE_RE.test(q.r)) { if (hasDegree) requirements.push({ r: "Degree", n: q.n, c: "yes", e: null }); continue; }
    const words = [...new Set(contentWords(q.r))];
    if (words.length < 3) continue;
    const share = words.filter((w) => me.words.has(w)).length / words.length;
    requirements.push({ r: q.r, n: q.n, c: share >= PLAIN_YES ? "yes" : share >= PLAIN_PARTIAL ? "partial" : "no", e: share >= PLAIN_PARTIAL ? null : "" });
  }
  const candidateYears = candidateYearsOf(profile);
  if (parsed.minYears != null && candidateYears != null) {
    const c = candidateYears >= parsed.minYears ? "yes" : candidateYears >= parsed.minYears - 2 ? "partial" : "no";
    requirements.push({ r: `${parsed.minYears}+ years experience`, n: "must", c, e: c === "no" ? "" : null });
  }
  if (parsed.clearance) requirements.push({ r: "Security clearance", n: "must", c: me.hasClearance ? "yes" : "no", e: "" });

  // Role: how far the job's type is from the profile's own (see FAR, measured
  // against the AI's scores by job type).
  const own = ownFamilyForProfile(profile);
  // The title's head says what the job is ("Senior Product Manager, Developer
  // Platform" is a product job); the rest is the team or domain.
  const head = String(jobTitle || "").split(/\s[-–—|]\s|,|\(|:/)[0];
  const headFams = classifyTitle(head);
  const fams = headFams.length ? headFams : classifyTitle(jobTitle);
  const near = (ADJACENT[own] || []).filter((f) => f !== own && !(FAR[own] || []).includes(f));
  let tier = "different";
  if (fams.includes(own)) tier = "same";
  else if (!fams.length) tier = "adjacent"; // can't tell from the title
  else if (fams.some((f) => near.includes(f))) tier = "adjacent";
  else if (fams.some((f) => (FAR[own] || []).includes(f) || (targets || []).includes(f))) tier = "far";
  if (tier === "same" && own !== "science_research" && /\b(research|scientist)\b/i.test(jobTitle) && !/\b(software|engineer)\b/i.test(jobTitle)) tier = "adjacent";
  const roleFit = tier === "far" ? "adjacent" : tier;

  // Years/clearance evidence isn't a profile quote; mark them as supported so
  // scoreAssessment's evidence check doesn't downgrade them.
  const withEvidence = requirements.map((q) => (q.e === null ? { ...q, e: me.have.values().next().value || "" } : q));
  let fit = scoreAssessment(
    { roleFit, roleNote: roleFit === "different" ? "Different kind of role from yours" : roleFit === "adjacent" ? "Related role, not quite yours" : "", minYears: parsed.minYears, requirements: withEvidence },
    me.text,
    { jobTitle, candidateYears, softwareCandidate: isSoftwareCandidate(profile) }
  );
  // Few requirements = weak evidence: "covers 1 of 1" isn't a 100. Pull the
  // score toward the middle by how little was read (never pushes it up).
  const weight = fit.requirements.reduce((a, q) => a + (q.need === "must" ? 2 : 1), 0);
  const shrunk = Math.round((fit.score * weight + SHRINK_TO * SHRINK_WEIGHT) / (weight + SHRINK_WEIGHT));
  if (shrunk < fit.score) fit = { ...fit, score: shrunk };
  if (tier === "far" && fit.score > FAR_CAP) fit = { ...fit, score: FAR_CAP, capNote: "Related role, not quite yours", reason: fit.reason.startsWith("Related role") ? fit.reason : `Related role, not quite yours · ${fit.reason.charAt(0).toLowerCase()}${fit.reason.slice(1)}` };
  if (!fit.requirements.length) {
    // Nothing checkable found (short or non-technical description): neutral, not zero.
    return { ...fit, method: "rule", ruleVersion: RULE_VERSION, score: Math.min(fit.score || 40, 40), coverage: null, reason: "Couldn't read requirements from the description" };
  }
  return { ...fit, method: "rule", ruleVersion: RULE_VERSION };
}

module.exports = { RULE_VERSION, SKILLS, ruleAssessJob, parseRequirements, profileSkills, descriptionLines };
