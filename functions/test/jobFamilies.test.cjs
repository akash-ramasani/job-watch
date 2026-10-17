// Job types and the "should this user's AI assessment run?" gate.
// Titles are real ones from the corpus. Run: npm test (in functions/)
const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyTitle, familiesForProfile, shouldAssess, targetsKey, ADJACENT } = require("../lib/jobFamilies.cjs");

const SDE = familiesForProfile({ roles: [
  { title: "Senior AI Native Software Engineer" }, { title: "Senior Software Engineer" }, { title: "Software Development Engineer II" }, { title: "Machine Learning Engineer" },
] });
const DA = familiesForProfile({ roles: [{ title: "Data Analyst" }, { title: "Business Intelligence Analyst Intern" }] });
const MISSION = "We are building the future of our industry with a world-class team. ".repeat(5);

test("profiles get their own types plus realistic neighbours", () => {
  for (const f of ["software", "ml_ai", "data_engineering", "devops_cloud", "security", "qa_test", "engineering_general"]) assert.ok(SDE.includes(f), f);
  // Sales / pre-sales / implementation engineering is a different career (user's call, 2026-10-14); it can be added back in Profile → job types.
  assert.ok(!SDE.includes("data_analytics") && !SDE.includes("sales") && !SDE.includes("solutions"));
  assert.deepEqual([...DA].sort(), ["data_analytics", "data_engineering", "data_science"]);
  assert.deepEqual(familiesForProfile({}), []);
});

test("software profile: every job that scored 40+ in the audit set is assessed", () => {
  for (const t of ["Software Engineer, Agent - Retail", "Staff Software Engineer, Tax Experiences", "Senior Staff Software Engineer - Pricing and Packaging",
    "Software Engineer, Robot Manufacturing", "Sr. Forward Deployed Engineer (FDE) - Manufacturing", "Globalization Tech Lead", "Senior Data Engineer - US",
    "Senior Software Security Engineer, Infrastructure & Identity", "Application Engineer", "Enterprise People Platform Engineer",
    "Data Specialist II, Cat Digital", "Agent Engineer", "Staff Modeling Engineer", "Data Scientist, Payments", "Applied AI Engineer", "Senior Founding Engineer"]) {
    assert.equal(shouldAssess(t, SDE, MISSION).assess, true, t);
  }
});

test("software profile: titles the 2026-10-11 audit found skipped are now assessed", () => {
  // Every one of these was skipped before: a non-tech word won the title, a
  // family regex had a gap, or a generic tech word carried the whole title.
  for (const t of ["Manager, CUDA Driver", "Information Systems Security Officer - ISSO", "Senior Information System Security Officer (ISSO) II - Tucson, AZ",
    "Senior Phishing Tradecraft Researcher", "Security GRC Senior Analyst", "GRC and Security Compliance Lead", "Security & IT Intern", "Staff CSIRT Analyst",
    "CTI Analyst", "Data Protection Specialist", "Senior Director, Privacy, Product and Platform Security", "Detection Analyst",
    "Research Intern, Spatial Intelligence - Summer 2027", "Research Intern, World Models and Synthetic Data for Autonomous Driving - Summer 2027",
    "Senior IT Engineer", "IT Operations Engineer", "Principal IT Engineer - Networking", "Lead IT Architect", "Senior IT System Administrator", "Principal IT Technologist",
    "Senior Architect, Data and Analytics", "DataOps - Lead Data Analyst", "Director of Data Governance & Enablement Platforms", "Senior Data Manager",
    "Chief Architect (System Architecting, Requirements & Interfaces)", "Enterprise Business Architect", "Legal Systems Architect", "VP, IT Strategy and Architecture",
    "Global Vice President, Compute Control Plane", "Vice President, Product Architecture & Security Platforms", "Director, Head of Core Banking Technology Platforms",
    "NA Head of eFX and FX Front Office Technology ,Managing Director", "Staff Systems Eng, Navigation",
    "Lead Technology Business Consultant",
    "Quantum Compute Simulation Scientist",
    "Technical Specialist, Battery Algorithms and Digital Twin, Ford Energy", "Executive Director, Health100 App — Digital Product"]) {
    assert.equal(shouldAssess(t, SDE, MISSION).assess, true, t);
  }
  // Architects of buildings and lecture halls are still not engineers; neither are PMs, recruiters or writers with "technical" in the title.
  for (const t of ["Architect (Data Centers & Workplace) - Memphis", "Adjunct Faculty - Architecture", "Senior Technical Program Manager", "Technical Product Manager",
    "Senior Technical Recruiter", "Senior-level Technical Writer", "Head of People Technology", "Security Guard", "Target Security Specialist", "Fire Service Technician"]) {
    assert.equal(shouldAssess(t, SDE, MISSION).assess, false, t);
  }
  // Analyst profile: applied scientists count as data science; software titles still do not.
  assert.equal(shouldAssess("Applied Scientist, Optimization & Logistics", DA, MISSION).assess, true);
  assert.equal(shouldAssess("Manager, CUDA Driver", DA, MISSION).assess, false);
});

test("software profile skips other professions", () => {
  for (const t of ["Grad Pharmacist", "Family Nurse Practitioner - NP/PA (Part-time)", "GTM Recruiter (Fixed Term)", "Account Executive, Mid-Market",
    "Partner Marketing Manager, Online & Regional Events", "Demand Planner II (Hybrid)", "Senior Electrical Engineer (Onsite)", "Part-Time Keyholder - Park Meadows"]) {
    assert.equal(shouldAssess(t, SDE, MISSION).assess, false, t);
  }
});

test("data-analyst profile keeps anything analytical, including other departments' analysts", () => {
  for (const t of ["Data Analyst II", "Business Intelligence Developer", "Senior Product Analyst", "Marketing Analytics Manager", "Financial Analyst, FP&A",
    "Financial Planning and Analysis (FP&A) - Associate Director", "Operations Analyst", "Reporting Specialist", "Data Specialist II, Cat Digital",
    "Senior Data Engineer - US", "Data Scientist, Payments", "Insights Manager, Consumer Research", "Power BI Developer", "Revenue Operations Analyst"]) {
    assert.equal(shouldAssess(t, DA, MISSION).assess, true, t);
  }
});

test("data-analyst profile skips engineering and unrelated fields", () => {
  for (const t of ["Senior Software Engineer - Camera Platform", "Staff Backend Engineer - Streaming", "Agent Engineer", "Grad Pharmacist",
    "Account Executive, Mid-Market", "Senior Electrical Engineer (Onsite)", "Site Reliability Engineer"]) {
    assert.equal(shouldAssess(t, DA, MISSION).assess, false, t);
  }
});

test("a title with no type falls back to the description, and assesses when unsure", () => {
  const sqlJob = "You will build dashboards in Tableau and write SQL for weekly reporting. ".repeat(4);
  const storeJob = "Lead store teams, merchandising, customer service and scheduling. ".repeat(4);
  assert.equal(classifyTitle("Rotational Development Program").length, 0);
  assert.equal(shouldAssess("Rotational Development Program", DA, sqlJob).assess, true);
  assert.equal(shouldAssess("Rotational Development Program", DA, storeJob).assess, false);
  assert.equal(shouldAssess("Rotational Development Program", DA, "").assess, true); // no description: assess
  assert.equal(shouldAssess("", SDE, storeJob).assess, true); // no title: assess
  assert.equal(shouldAssess("Anything at all", [], storeJob).assess, true); // no targets: assess
  // Marketing profile: no vocabulary defined, so untyped titles are assessed.
  assert.equal(shouldAssess("Rotational Development Program", ADJACENT.marketing, storeJob).assess, true);
});

test("multi-type titles are kept if any type is targeted", () => {
  assert.deepEqual(classifyTitle("Data Analyst, Sales Operations").includes("sales"), true);
  assert.equal(shouldAssess("Data Analyst, Sales Operations", DA, MISSION).assess, true);
  assert.equal(shouldAssess("Principal Specialist Sales Engineer, Data Security", SDE, MISSION).assess, false); // a sales engineer, even in security
});

test("targets key is order-independent", () => {
  assert.equal(targetsKey(["b", "a"]), targetsKey(["a", "b"]));
});

test("the web app's job-type list matches these types", () => {
  const fs = require("fs");
  const path = require("path");
  const { FAMILY_IDS, FAMILIES } = require("../lib/jobFamilies.cjs");
  const src = fs.readFileSync(path.join(__dirname, "../../src/lib/jobTypes.js"), "utf8");
  const web = [...src.matchAll(/id: "([a-z_]+)", label: ("[^"]*")/g)].map((m) => [m[1], JSON.parse(m[2])]);
  const backend = [...FAMILY_IDS, "engineering_general"].map((id) => [id, FAMILIES[id].label]);
  assert.deepEqual(web, backend);
});

test("audit fixes: engineer titles, design engineers, eng directors, business analytics, dense descriptions", () => {
  for (const t of ["Technical Product Manager / Engineer", "Senior GRC Engineer", "Senior Design Engineer, Design Systems", "UX Design Engineer, Content Tooling", "Director of Engineering, Logistics"]) {
    assert.equal(shouldAssess(t, SDE, MISSION).assess, true, t);
  }
  for (const t of ["Manager, Sales Strategy & Operations", "Associate Manager, Consumer Pricing & Affordability", "Revenue Operations Manager", "Business Operations Associate"]) {
    assert.equal(shouldAssess(t, DA, MISSION).assess, true, t);
  }
  const dense = "SQL, Tableau, Power BI, Looker dashboards, Excel, statistics, A/B testing, KPIs and weekly reporting with Python and dbt. ".repeat(3);
  assert.equal(shouldAssess("Finance & Business Management", DA, dense).assess, true);
  assert.equal(shouldAssess("Finance & Business Management", DA, MISSION).assess, false);
});

test("store security isn't a security-engineering job", () => {
  assert.equal(shouldAssess("Target Security Specialist", SDE, MISSION).assess, false);
  assert.equal(shouldAssess("Senior Security Engineer (Infrastructure)", SDE, MISSION).assess, true);
  assert.equal(shouldAssess("Application Security, Senior Analyst", SDE, MISSION).assess, true);
});

test("medical technologist titles are healthcare, not tech", () => {
  const SDE = ["software", "ml_ai", "data_engineering", "devops_cloud", "security", "qa_test", "solutions", "data_science", "engineering_general"];
  for (const t of ["Sr. Polysomnography Technologist", "MRI Technologist", "Sleep Lab Technologist", "Respiratory Therapist", "Nuclear Medicine Technologist", "Echocardiography Technologist II"]) {
    assert.ok(classifyTitle(t).includes("healthcare"), t);
    assert.equal(shouldAssess(t, SDE, "").assess, false, t);
  }
  assert.equal(shouldAssess("Senior Technologist, Platform Engineering", SDE, "").assess, true);
});

test("chip-design titles are hardware, not general engineering", () => {
  const SDE = ["software", "ml_ai", "data_engineering", "devops_cloud", "security", "qa_test", "solutions", "data_science", "engineering_general"];
  for (const t of ["VLSI Engineer I - OT1191", "RTL Design Engineer", "Physical Design Engineer", "Design Verification Engineer, SoC"]) {
    assert.ok(classifyTitle(t).includes("hardware_eng"), t);
    assert.equal(shouldAssess(t, SDE, "").assess, false, t);
  }
});

test("misspelt and abbreviated titles still classify", () => {
  const SDE = ["software", "ml_ai", "data_engineering", "devops_cloud", "security", "qa_test", "solutions", "data_science", "engineering_general"];
  assert.deepEqual(classifyTitle("Graduate Mechnical/Hdwr Eningeer I"), ["hardware_eng"]);
  assert.equal(shouldAssess("Graduate Mechnical/Hdwr Eningeer I", SDE, "").assess, false);
  assert.ok(classifyTitle("Sr SW Engr, Platform").includes("software"));
  assert.ok(classifyTitle("HW Test Enginer").includes("hardware_eng"));
});

test("an unreadable title with a clearly mechanical description is not assessed", () => {
  const SDE = ["software", "ml_ai", "data_engineering", "devops_cloud", "security", "qa_test", "solutions", "data_science", "engineering_general"];
  const mech = "Hewlett Packard Enterprise is the global edge-to-cloud company helping companies analyze their data. Designs mechanical and thermal hardware, electronics enclosures and production tooling. Experience with ProEngineer or other 3D CAD software as a mechanical design tool. Understanding of sheet metal and plastic parts, heat transfer and thermal properties of materials. Bachelor's degree in Mechanical Engineering.";
  assert.equal(shouldAssess("Graduate Associate I", SDE, mech).assess, false);
  const sw = "You will build backend services in Python and Go on Kubernetes and AWS, design REST APIs and microservices, and own CI/CD for our cloud platform. Experience with PostgreSQL and Docker required.";
  assert.equal(shouldAssess("Graduate Associate I", SDE, sw).assess, true);
});

test("a tech-ish word alone needs the description to back it up", () => {
  const SW = "You will build backend services in Python and Go on Kubernetes and AWS, design REST APIs and microservices, and own CI/CD for our cloud platform. Experience with PostgreSQL and Docker required.";
  const BOILER = "We are a mission-driven company using data and technology to transform care. Our software platform helps teams. ".repeat(3);
  for (const t of ["Control Systems Team Lead", "Field Technical Support Representative", "Technical Specialist: UT Space Institute", "General Liability Technical Specialist", "Senior Refractive Tech"]) {
    assert.equal(shouldAssess(t, SDE, MISSION).assess, false, `${t} with a generic description`);
    assert.equal(shouldAssess(t, SDE, BOILER).assess, false, `${t} with boilerplate`);
  }
  // A pure hint with no description at all can't be told apart: assessed.
  for (const t of ["Control Systems Team Lead", "Technical Specialist: UT Space Institute"]) assert.equal(shouldAssess(t, SDE, "").assess, true, t);
  // "Field Technical Support" (kept in the 2026-10-11 recall list until now) is support, not engineering, unless its description says otherwise.
  assert.equal(shouldAssess("Field Technical Support", SDE, MISSION).assess, false);
  // Likewise a "testing advisor" in dental operations: QA only if the description is about software testing.
  assert.equal(shouldAssess("Business Integration Testing Sr. Advisor, Individual Dental Operations", SDE, MISSION).assess, false);
  assert.equal(shouldAssess("Business Integration Testing Sr. Advisor, Individual Dental Operations", SDE, SW).assess, true);
  assert.equal(shouldAssess("Control Systems Team Lead", SDE, SW).assess, true);
  assert.equal(shouldAssess("Field Technical Support Representative", SDE, SW).assess, true);
});

test("unreadable titles need a description dense with the targets' vocabulary", () => {
  const BOILER = "We are a mission-driven company using data and technology to transform care. Our software platform helps teams. ".repeat(3);
  const SW = "You will build backend services in Python and Go on Kubernetes and AWS, design REST APIs and microservices, and own CI/CD for our cloud platform. Experience with PostgreSQL and Docker required.";
  for (const t of ["Internal Acceleration, Kernels", "Vendor Specialist (Property Management)", "Specimen Processor- Full Time- 3rd Shift"]) {
    assert.equal(shouldAssess(t, SDE, BOILER).assess, false, t);
  }
  assert.equal(shouldAssess("Internal Acceleration, Kernels", SDE, SW).assess, true);
  // Titles that now carry their own family
  assert.deepEqual(classifyTitle("CNC Programmer"), ["trades_field"]);
  assert.ok(classifyTitle("Crisis Intervention Specialist (Oregon)").includes("healthcare"));
  assert.ok(classifyTitle("SUD California Group Facilitator").includes("healthcare"));
  assert.ok(classifyTitle("Cleaner (Hospital) - Full Time Evening Shift").includes("trades_field"));
  assert.ok(classifyTitle("Autonomous Vehicle Operator").includes("trades_field"));
  assert.ok(classifyTitle("Sr Mobile Expert").includes("retail_hospitality"));
  for (const t of ["CNC Programmer", "Crisis Intervention Specialist (Oregon)", "Cleaner (Hospital) - Full Time Evening Shift", "Autonomous Vehicle Operator", "Sr Mobile Expert"]) {
    assert.equal(shouldAssess(t, SDE, MISSION).assess, false, t);
  }
});

test("non-software engineering disciplines classify as hardware & other engineering", () => {
  for (const t of ["Transportation Engineer 3", "Lead Line Engineer", "Maintenance Engineer", "Compression Lab Engineer", "Engineer - Guest Facing Devices", "Epitaxy Process Development Engineer (SM1)", "CVD Equipment Engineer", "Guidance Navigation Control Engineer - 20429*", "Lead Engineer - Protection & Control"]) {
    assert.ok(classifyTitle(t).includes("hardware_eng"), t);
    assert.equal(shouldAssess(t, SDE, MISSION).assess, false, t);
  }
  // Vague but software-shaped titles stay assessed on the title alone.
  for (const t of ["Agent Engineer", "Senior Founding Engineer", "Staff Modeling Engineer", "Senior Platform Software Engineer", "Client Platform Engineer", "Senior Infrastructure Engineer"]) {
    assert.equal(shouldAssess(t, SDE, MISSION).assess, true, t);
  }
});

test("title precedence: disciplines, quality, physical security, managers, trades, learning architects", () => {
  assert.ok(classifyTitle("Mechanical Engineering Manager").includes("hardware_eng") && !classifyTitle("Mechanical Engineering Manager").includes("software"));
  // "Quality Engineering" alone is decided by the description: software QA with a tech description, skipped otherwise.
  const SWQA = "You will design automated test suites in Python and Java for our REST APIs and microservices on Kubernetes, build CI/CD pipelines and own quality for the cloud platform.";
  assert.equal(shouldAssess("Quality Engineering", SDE, SWQA).assess, true);
  assert.equal(shouldAssess("Quality Engineer II", SDE, MISSION).assess, false);
  assert.equal(shouldAssess("Software Quality Engineer", SDE, MISSION).assess, true);
  assert.deepEqual(classifyTitle("Physical Security Lead"), ["operations"]);
  assert.ok(!classifyTitle("Software Program Manager, New Product Introduction").includes("software"));
  assert.ok(!classifyTitle("Incident Response Program Manager").includes("security"));
  assert.ok(classifyTitle("Technical Product Manager / Engineer").includes("engineering_general") || classifyTitle("Technical Product Manager / Engineer").includes("software"));
  assert.deepEqual(classifyTitle("Engineering Technician (Level 4)"), ["trades_field"]);
  assert.ok(!classifyTitle("Senior Learning Architect").includes("engineering_general"));
  assert.ok(!classifyTitle("Solutions Specialist - Sales").includes("solutions"));
  assert.ok(!classifyTitle("Deployment Strategist (Travel Heavy)").includes("solutions"));
  for (const t of ["Mechanical Engineering Manager", "Quality Engineer II", "Physical Security Lead", "Software Program Manager, New Product Introduction", "Engineering Technician (Level 4)", "Senior Learning Architect", "Solutions Specialist - Sales"]) {
    assert.equal(shouldAssess(t, SDE, MISSION).assess, false, t);
  }
});

test("org names, programme management and commissioning are not engineering roles", () => {
  assert.ok(!classifyTitle("Compute Engineering Business Operations Manager").includes("engineering_general"));
  assert.ok(!classifyTitle("Program Management Engineer | HVDC").includes("engineering_general"));
  assert.ok(classifyTitle("Commissioning Engineer").includes("hardware_eng"));
  for (const t of ["Compute Engineering Business Operations Manager", "Program Management Engineer | HVDC", "Commissioning Engineer"]) assert.equal(shouldAssess(t, SDE, MISSION).assess, false, t);
  // Engineers in a marketing or operations org are still engineers.
  assert.equal(shouldAssess("Sr Engineer - In-Store Digital Marketing", SDE, MISSION).assess, true);
  assert.equal(shouldAssess("Technical Product Manager / Engineer", SDE, MISSION).assess, true);
});

test("a tech word in another profession's title does not make it engineering", () => {
  for (const t of ["Cloud Hosting Finance Analyst", "Compute Engineering Business Operations Manager", "Clinical Research Data Specialist 2", "Senior Portfolio Operations Manager, Games"]) {
    assert.ok(!classifyTitle(t).some((f) => ["software", "devops_cloud", "ml_ai", "data_engineering", "security", "engineering_general"].includes(f)), t);
    assert.equal(shouldAssess(t, SDE, MISSION).assess, false, t);
  }
  for (const t of ["Security Engineer, Finance Systems", "Data Scientist, Sales Operations", "Sr Engineer - In-Store Digital Marketing"]) {
    assert.equal(shouldAssess(t, SDE, MISSION).assess, true, t);
  }
});

test("electromechanical is hardware; professional-services leadership is not solutions engineering", () => {
  assert.ok(classifyTitle("Electromechanical Engineer - Level 2").includes("hardware_eng"));
  assert.equal(shouldAssess("Electromechanical Engineer - Level 2", SDE, MISSION).assess, false);
  assert.ok(!classifyTitle("Global Professional Services Partner Leader, Professional Services").includes("solutions"));
  assert.equal(shouldAssess("Global Professional Services Partner Leader, Professional Services", SDE, MISSION).assess, false);
});

test("PMs, postdocs, legal engineers and sales engineering are not the software profile's jobs", () => {
  assert.deepEqual(classifyTitle("Program Management Engineer | HVDC"), ["program_project"]);
  assert.ok(classifyTitle("Translational Post Doctoral Researcher - Agentic AI for Neurodegeneration").includes("science_research"));
  assert.ok(!classifyTitle("Translational Post Doctoral Researcher - Agentic AI for Neurodegeneration").includes("ml_ai"));
  assert.deepEqual(classifyTitle("Legal Engineer"), ["legal_compliance"]);
  assert.ok(!SDE.includes("solutions"));
  for (const t of ["Program Management Engineer | HVDC", "Translational Post Doctoral Researcher - Agentic AI for Neurodegeneration", "Legal Engineer", "Senior Sales Engineer, Chicago", "Solutions Engineer II, Pre-Sales", "Presales Solutions Architect"]) {
    assert.equal(shouldAssess(t, SDE, MISSION).assess, false, t);
  }
});

test("sales, pre-sales and implementation engineering are not the software profile's jobs", () => {
  for (const t of ["Senior Implementation Engineer", "Partner & Agentforce Contact Center, Solution Consulting Director", "Sales Engineer"]) assert.equal(shouldAssess(t, SDE, MISSION).assess, false, t);
  // …but they still are for a profile that chose "solutions".
  assert.equal(shouldAssess("Senior Implementation Engineer", [...SDE, "solutions"], MISSION).assess, true);
});

test("customer-facing engineering titles are not the software profile's jobs", () => {
  for (const t of ["Senior Pre-Sales Systems Engineer, Enterprise - Massachusetts", "Sr. Sales Engineer - Rubrik Agent Cloud", "GTM Engineer, Web", "Senior Customer Success Engineer", "Product Marketing Engineer | MPP", "Presales Solutions Architect"]) {
    assert.ok(classifyTitle(t).includes("solutions"), t);
    assert.equal(shouldAssess(t, SDE, MISSION).assess, false, t);
  }
  assert.equal(shouldAssess("Sr. Sales Engineer - Rubrik Agent Cloud", [...SDE, "solutions"], MISSION).assess, true);
});
