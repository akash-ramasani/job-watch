/**
 * functions/lib/jobFamilies.cjs
 *
 * Job types ("families") read from a job title, and which types each
 * profile wants scored. Jobs are shared by every user, so a title is sorted
 * once, for free, in code; only jobs whose type a user targets (or whose
 * type can't be told from the title) go to the AI assessment for that user.
 *
 * Built for recall over precision:
 *   - a title can match several types ("Data Analyst, Sales Ops" is both
 *     data analytics and sales); it is skipped only when NONE of its types
 *     is one the user targets;
 *   - a title that matches no type at all is always assessed.
 */

// Order doesn't matter: every matching type is returned.
const FAMILIES = {
  software: {
    label: "Software engineering",
    re: /\b(software|sde|swe|sdet|developer|programmer|full[- ]?stack|back[- ]?end|front[- ]?end|web (engineer|developer)|mobile (engineer|developer)|ios|android|platform engineer(ing)?|forward[- ]deployed|fde|member of technical staff|mts|application(s)? (engineer|developer)|engineering manager|tech(nical)? lead|staff engineer|principal engineer|distinguished engineer|founding engineer|product engineer|systems? engineer|integration engineer|api|devex|developer (experience|productivity)|compiler|distributed systems|game (engineer|programmer|developer)|graphics engineer|embedded software|firmware|design engineer|ux engineer|ui engineer|design technologist|creative technologist|director of engineering|engineering director|head of engineering|vp,? (of )?engineering|chief technology officer|cuda|gpu|kernel|device drivers?|driver (development|engineer\w*|software)|algorithms?|computational)\b/i,
  },
  ml_ai: {
    label: "Machine learning & AI",
    re: /\b(machine learning|ml|ai|artificial intelligence|llm|nlp|computer vision|deep learning|applied scientist|research (engineer|scientist)|mlops|generative|genai|ai agents?|agentic|perception|autonomy|speech (recognition|scientist|engineer)|asr|robotics|research (intern|engineer|scientist|associate, (ai|ml|machine learning))|world models?|synthetic data|autonomous (driving|vehicles?|systems)|spatial intelligence|foundation models?|reinforcement learning|neural|transformers?|diffusion|multimodal|recommendation(s| systems?)?|ranking|search (relevance|quality|engineer\w*)|personalization|embeddings?|simulation)\b/i,
  },
  data_engineering: {
    label: "Data engineering",
    re: /\b(data engineer(ing)?|etl|elt|analytics engineer(ing)?|data platform|big data|data (architect|infrastructure|warehouse|warehousing|pipeline|integration|ops|modeler|modeling)|database (engineer|developer|administrator)|dba|data management|data specialist|dataops|data (governance|lineage|quality|trust|strategy|services|products?|manager|transformation|catalog|observability)|lakehouse|data lake|databricks|snowflake|spark|kafka|airflow)\b/i,
  },
  data_science: {
    label: "Data science",
    re: /\b(data scien(ce|tist)|statistic(s|ian|al)|quantitative|quant|decision scien(ce|tist)|econometric|economist|experimentation|causal inference|operations research|biostatistic\w*|applied scien(ce|tist)|modeler|predictive model\w*|forecasting scientist)\b/i,
  },
  data_analytics: {
    label: "Data & business analytics",
    re: /\b(analyst|analytics|analytic|business intelligence|bi|insights?|reporting|report developer|dashboard|tableau|power ?bi|looker|sql|metrics|measurement|data (specialist|associate|steward|governance|quality|visuali[sz]ation|coordinator|manager|lead|consultant)|business systems|business analysis|intelligence|analysis|data(?! center)|forecast\w*|kpi|strategy (and|&) operations|business operations|bizops|sales operations|revenue operations|revops|pricing|planning (and|&) (performance|analysis)|performance analytics)\b/i,
  },
  devops_cloud: {
    label: "DevOps, SRE & cloud",
    re: /\b(devops|dev ops|devsecops|site reliability|sre|reliability engineer(ing)?|cloud|infrastructure|platform operations|build (and|&) release|release engineer|kubernetes|observability|production engineer(ing)?|systems? administrator|sysadmin|linux|network (engineer|architect|administrator)|storage engineer|virtualization|networks?|service engineer|triage|rca|compute|control plane|data ?center (engineer\w*|operations|software)|platform (engineer\w*|architect\w*|team|lead)|terraform|ci\/cd|release management)\b/i,
  },
  security: {
    label: "Security",
    re: /\b(security (engineer\w*|analyst|architect\w*|researcher|operations|software|developer|consultant|manager|lead|specialist, (cloud|network|application|product))|(application|product|cloud|network|information|infrastructure|data) security|cyber\w*|appsec|infosec|penetration|pentest\w*|soc|threat|vulnerability|identity (and|&) access|iam|detection (and|&) response|incident response|cryptograph\w*|isso|information systems? security|platform security|security (grc|compliance|risk|awareness|intern|administrator|program|platforms?)|csirt|cert team|security (&|and) it|it (&|and) security|grc|phishing|tradecraft|detection (analyst|engineer\w*)|cti|threat intelligence|fusion center|data protection|red team|blue team|purple team|malware|forensics|siem|zero trust|technology (risk|audit\w*|controls?))\b/i,
  },
  qa_test: {
    label: "QA & test automation",
    re: /\b(qa|quality assurance|test (automation|engineer|lead|analyst)|automation engineer|sdet|software test\w*|tester|quality engineer(ing)?|(integration|regression|performance|acceptance|software|system|automated) testing|test(ing)? (specialist|advisor|architect))\b/i,
  },
  solutions: {
    label: "Solutions & customer engineering",
    re: /\b(solutions? (engineer|architect|consultant)|sales engineer|customer engineer|implementation (engineer|consultant|specialist|manager|lead)|integrations? (engineer|developer|specialist|architect)|technical account manager|tam|support engineer|technical support engineer|technical consultant|deployment (engineer)|onboarding engineer|partner engineer|pre-?sales|value engineer|solutions? (architecture|leader)|federal solution|industry solution|solutions? consult\w*|technology consultant|technical (relationship|advisor|solutions?|account)|platform consultant|enablement architect|field (support|engineer)|applications? (specialist|consultant))\b/i,
  },
  it_support: {
    label: "IT & help desk",
    re: /\b(it (support|specialist|technician|analyst|manager|administrator|operations|engineer|director)|help ?desk|service desk|desktop support|end user|technical support specialist|information technology|endpoint|servicenow|salesforce (developer|administrator|admin)|workday (developer|analyst|integration|consultant)|erp|sap|oracle (developer|consultant|analyst)|business applications|storefront)\b/i,
  },
  product: {
    label: "Product management",
    re: /\b(product (manager|management|owner|lead|director|operations|strategy|marketing manager)|group product|head of product|vp,? product|chief product|product specialist|product intern|product support)\b/i,
  },
  program_project: {
    label: "Program & project management",
    re: /\b(program manager|programme manager|project manager|project management|technical program|tpm|scrum master|delivery (manager|lead)|pmo|project coordinator|program coordinator|portfolio manager)\b/i,
  },
  design: {
    label: "Design & UX",
    re: /\b(designer|design (lead|manager|director|systems)|ux|ui|user experience|user research(er)?|interaction design|visual design|graphic|creative director|illustrator|motion design|content design|product design|(ux|design|market|consumer) researcher)\b/i,
  },
  sales: {
    label: "Sales & business development",
    re: /\b(sales|account executive|account manager|business development|bdr|sdr|ae|seller|territory|inside sales|partnerships?|channel|alliances|revenue|go[- ]to[- ]market|gtm|commercial|enterprise development|development representative|relationship manager|client (partner|executive)|merchant|account director|renewals?|partner development|enterprise account|engagement manager|account success|account management|customer relations|client relations|consultant relations|field enablement|sales enablement|regional director|rvp|smb|mid-market|account development|development executive|market development|partner (services|business)|quote to order|marketplace)\b/i,
  },
  customer_success: {
    label: "Customer success & support",
    re: /\b(customer (success|support|service|experience|care|advocate)|client (success|services|support)|support (specialist|representative|associate|agent)|service (advocate|representative|coordinator|center)|call center|contact center|member services)\b/i,
  },
  marketing: {
    label: "Marketing & communications",
    re: /\b(marketing|growth|brand|content|communications|comms|public relations|pr|seo|sem|social media|copywriter|editor|writer|campaign|demand generation|events?|community|advertising|media (buyer|planner)|influencer|journalist|producer|marketer|paid (social|media|search)|paid|digital marketing|creative|storytell\w*|creator|youtube|campaigns|lifecycle|social|video|photograph\w*)\b/i,
  },
  hr_recruiting: {
    label: "HR & recruiting",
    re: /\b(recruit\w*|sourcer|talent|human resources|hr|hrbp|people (partner|operations|business|team|experience)|compensation|benefits|payroll|learning (and|&) development|l&d|workforce|employee relations|total rewards|dei|diversity|global mobility|head of people|people|employee (tech|experience)|executive business partner|executive search)\b/i,
  },
  finance: {
    label: "Finance, accounting & insurance",
    re: /\b(financ\w*|fp&a|accountant|accounting|accounts (payable|receivable)|controller|tax|audit\w*|treasury|billing|bookkeep\w*|underwrit\w*|actuar\w*|investment|investor|credit|lending|loan|mortgage|banker|banking|wealth|portfolio|trader|trading|equity|fund|claims|insurance|risk|capital markets|pricing|procure-to-pay|revenue accounting|cpa)\b/i,
  },
  legal_compliance: {
    label: "Legal, compliance & policy",
    re: /\b(attorney|counsel|lawyer|legal|paralegal|compliance|regulatory|privacy|policy|contracts?|litigation|governance|ethics|aml|kyc|investigator|fraud|grc|government affairs|federal affairs|public affairs|public policy|licensing|government relations)\b/i,
  },
  healthcare: {
    label: "Healthcare & clinical",
    re: /\b(nurse|nursing|rn|lpn|np|pa-c|physician|doctor|md|clinical|clinician|pharmac\w*|therapist|therapy|medical|patient|facilitator|crisis intervention|\bsud\b|mental health|behavioral|care coach|advanced practice|epilepsy|neurolog\w*|inpatient|outpatient|refractive|reimbursement|specimen|phlebotom\w*|phlebotom\w*|dental|dentist|radiolog\w*|sonograph\w*|polysomnograph\w*|sleep (?:lab|center|technolog\w*|technician)|echocardiograph\w*|electrophysiolog\w*|mri|ct technolog\w*|nuclear medicine|respiratory|cardiovascular technolog\w*|histolog\w*|cytolog\w*|anesthes\w*|perfusion\w*|dialysis|ultrasound|x-?ray|mammograph\w*|audiolog\w*|surgical|surgeon|psychiatr\w*|psycholog\w*|counselor|caregiver|care (coordinator|manager)|health (coach|educator)|practitioner|scribe|behavioral health|lab(oratory)? (technician|technologist|assistant)|veterinar\w*|optometr\w*|dietitian|respiratory|family care|mental health|care experience|health)\b/i,
  },
  hardware_eng: {
    label: "Hardware & other engineering",
    re: /\b(mechanical|electrical|hardware|electronics?|rf|analog|mixed[- ]signal|asic|fpga|soc design|silicon|semiconductor|chip|pcb|layout|circuit|vlsi|rtl|physical design|design verification|dft|signal integrity|transportation|line engineer|protection (?:&|and) control|maintenance|process (?:development|engineer\w*)|epitaxy|cvd|metrology|equipment|wafer|compression|guidance|flight|commissioning|electro-?mechanical|propulsion|structural|civil|manufacturing|industrial|field service|hvac|plant|piping|facilities|environmental|chemical|materials|photonics|optical|opto-?\w*|lab engineer|guest facing devices|power (electronics|systems|engineer)|civil|structural|chemical|materials?|manufacturing|process engineer|industrial engineer|quality engineer|reliability engineer|aerospace|propulsion|avionics|optical|photonics|thermal|mechatronics|robotics engineer|controls engineer|test engineer|validation engineer|packaging|hvac|fire protection|geotechnical|environmental engineer|mining|petroleum|nuclear|battery|cell engineer|substation|transmission|utility|design verification|verification engineer|payload|quantum|fabrication|tooling|fragrance|compounder|sensory|olfactive|aseptic|qc manager|quality manager|driller|quality|building technology)\b/i,
  },
  operations: {
    label: "Operations, supply chain & logistics",
    re: /\b(operations (manager|associate|specialist|coordinator|lead|director)|business operations|(?:product|business|revenue|sales|people|marketing|finance) ops\b|supply chain|logistics|warehouse|fulfillment|distribution|inventory|procurement|purchasing|buyer|sourcing|planner|planning|demand|materials manager|fleet|dispatch|shipping|receiving|facilities|workplace|real estate|vendor management|strategy (and|&) operations|bizops|revops|sales operations|chief of staff|order to cash|processing center|process management|strategic projects|country launch|market operations|customer operations|experiences? lead|commodity|supplier|new product introduction|npi|business partner|strategist|strategy|launch|site manager|vendor operations|performance excellence|s&o)\b/i,
  },
  trades_field: {
    label: "Trades, field & technician",
    re: /\b(technician|tech [iv]+|mechanic|cleaner|attendant|vehicle operator|proctor|electrician|plumber|installer|(?<!cuda |device |gpu |kernel |software |display |graphics |print |linux |windows )drivers?|cdl|operator|machinist|welder|assembler|assembly|maintenance|field service|construction|foreman|superintendent|carpenter|laborer|janitor|custodian|groundskeeper|inspector|lineman|crew|protective services|pilot|security (officer|guard)|loss prevention|asset protection|target security)\b/i,
  },
  retail_hospitality: {
    label: "Retail, food & hospitality",
    re: /\b(retail|store|cashier|mobile expert|barista|crew member|restaurant|server|cook|chef|kitchen|hospitality|hotel|front desk|housekeep\w*|sales associate|merchandis\w*|stocker|shift (lead|supervisor)|branch manager|teller|banker associate|keyholder|team member|dashmart|associate - |store associate)\b/i,
  },
  admin_office: {
    label: "Administrative & office",
    re: /\b(administrative|admin(istrative)? assistant|executive assistant|receptionist|office (manager|coordinator|assistant)|secretary|clerk|data entry|scheduler|coordinator|assistant to)\b/i,
  },
  science_research: {
    label: "Science & research (non-software)",
    re: /\b(scientist|research associate|biolog\w*|chemist|chemistry|biochem\w*|molecular|genomic\w*|immunolog\w*|pharmacolog\w*|toxicolog\w*|microbiolog\w*|formulation|assay|bioinformatic\w*|computational biolog\w*|clinical research|postdoc\w*|physicist|geologist|epidemiolog\w*)\b/i,
  },
  education: {
    label: "Education & training",
    re: /\b(teacher|tutor|instructor|professor|lecturer|faculty|curriculum|instructional design\w*|trainer|training (specialist|manager)|education|teaching|academic|student success|admissions|learning lead|enablement|early learning|aide)\b/i,
  },
  executive_general: {
    label: "General management",
    re: /\b(general manager|country manager|managing director|ceo|coo|president|founder|chief executive|head of operations)\b/i,
  },
};

FAMILIES.engineering_general = { label: "Other engineering", re: /$^/ }; // assigned in classifyTitle, never by pattern
const FAMILY_IDS = Object.keys(FAMILIES).filter((id) => id !== "engineering_general");
// it_support is not here on purpose: an "IT Engineer" is an engineer first.
const ENGINEERING = new Set(["software", "ml_ai", "data_engineering", "devops_cloud", "security", "qa_test", "solutions", "hardware_eng", "engineering_general"]);

/**
 * Every type a job title reads as. Empty = can't tell from the title.
 * Parenthesised asides and trailing locations don't count ("(Hybrid)", "- Remote").
 */
// A program/project/product manager (or "Program Management Engineer") is a PM
// whatever product is in the title; a "Technical Product Manager / Engineer" keeps the engineer.
const SALES_ENG_RE = /\b(pre-?sales|sales engineer\w*|gtm engineer\w*|customer success engineer\w*|product marketing engineer\w*|solutions? (?:engineer\w*|architect\w*|consultant\w*)|field (?:application|applications) engineer\w*)\b/i;
const PM_RE = { test: (t) => /\b(program|programme|project|product) management engineer\w*\b/i.test(t)
  || (/\b(program|programme|project|product) manager\b/i.test(t) && !/\b(engineer\w*|developer|scientist|architect\w*|programmer|researcher)\b/i.test(t)) };
// Leadership of a tech function ("Director of Engineering, Logistics", "Senior
// Director, Privacy, Product and Platform Security"), as opposed to an org
// adjective ("Compute Engineering Business Operations Manager").
const TECH_LEADERSHIP_RE = { test: (t) => /\b(director|head|vp|vice president|chief|manager|lead)(?: of|,)? (?:[\w&]+,? ){0,3}(engineering|security|technolog\w*|platform|software|data|infrastructure|architecture|it|solutions?)\b/i.test(t)
  || /\b(engineering|security|technolog\w*|platform|software|data|infrastructure|architecture|solutions?) (?:[\w&]+,? ){0,1}(director|head|vp|vice president|lead|manager)\b/i.test(t) };
const ENGINEER_ROLE_RE = /\b(engineers?|developer|software|scientist|architects?|programmer|researcher)\b/i;
const ENGINEER_NOUN_RE = /\b(engineer\w*|developer|software|scientist|architect\w*|programmer|researcher)\b/i;
// A discipline naming the engineering itself ("Mechanical Engineering Manager",
// "Manufacturing Engineer"), not a domain tag ("FDE - Manufacturing").
const DISCIPLINE_RE = /\b(mechanical|electrical|civil|structural|manufacturing|industrial|chemical|materials|aerospace|mechatronics|hvac|piping|process) (?:engineer\w*|design\w*|technician\w*)\b/i;
const CHIP_RE = /\b(vlsi|rtl|asic|fpga|physical design|design verification|soc design|silicon|mixed[- ]signal|dft|signal integrity)\b/i;
// Abbreviations and misspellings seen in real titles ("Graduate Mechnical/Hdwr
// Eningeer I"), expanded so the family patterns can read them.
const TITLE_FIXES = [
  [/\b(?:hdwr|hdw|hw)\b/gi, "hardware"], [/\bsw\b/gi, "software"], [/\bmech\b/gi, "mechanical"], [/\belec\b/gi, "electrical"],
  [/\bmfg\b/gi, "manufacturing"], [/\bengr\b/gi, "engineer"], [/\bmechnical\b/gi, "mechanical"], [/\belectical\b/gi, "electrical"],
  [/\b(?:eningeer|enginer|engineeer|enginner|engieer|engineeer)(s|ing)?\b/gi, "engineer$1"],
];
function classifyTitle(title) {
  let t = String(title || "")
    .replace(/\(([^)]*)\)/g, " $1 ")
    .replace(/[_|/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const [re, to] of TITLE_FIXES) t = t.replace(re, to);
  if (/\b(cnc|plc|ladder logic)\b/i.test(t)) return ["trades_field"]; // a CNC/PLC "programmer" runs machines
  if (!t) return [];
  const found = FAMILY_IDS.filter((id) => FAMILIES[id].re.test(t));
  // Chip-design words name the field: "RTL Design Engineer" is hardware, not
  // software "design", and "Design Verification" is not security verification.
  if (CHIP_RE.test(t)) return ["hardware_eng", ...found.filter((f) => !["hardware_eng", "software", "security", "qa_test", "engineering_general"].includes(f))];
  // An engineering discipline in the title ("Mechanical Engineering Manager")
  // beats the generic software match on "engineering manager".
  if (DISCIPLINE_RE.test(t) && !/\bsoftware\b/i.test(t)) return ["hardware_eng", ...found.filter((f) => !["hardware_eng", "software", "qa_test", "engineering_general"].includes(f))];
  // Physical security is operations, not cyber security.
  if (/\b(physical security|security (?:guard|officer)|loss prevention|assets? protection)\b/i.test(t)) return ["operations", ...found.filter((f) => !["security", "operations"].includes(f))];
  // A program/project/product manager is not an engineer because "software" is in the title.
  if (PM_RE.test(t)) return ["program_project", ...found.filter((f) => !ENGINEERING.has(f) && f !== "program_project")];
  // Postdocs and legal engineers belong to their own professions, whatever else the title says.
  if (/\bpost-?\s?doc\w*\b/i.test(t)) return ["science_research", ...found.filter((f) => !ENGINEERING.has(f) && f !== "science_research")];
  if (/\blegal engineer\w*\b/i.test(t)) return ["legal_compliance"];
  // Customer-facing engineering (pre-sales, sales, GTM, customer success,
  // product marketing) is its own career, whatever tech words follow.
  if (SALES_ENG_RE.test(t)) return ["solutions", "sales", ...found.filter((f) => !ENGINEERING.has(f) && f !== "sales")];
  // A trades title ("Autonomous Vehicle Operator", "Robotics Technician") is
  // not an engineering job because of a tech word, unless it is an engineer's.
  if (found.includes("trades_field") && !ENGINEER_NOUN_RE.test(t)) return found.filter((f) => !ENGINEERING.has(f));
  // Likewise any non-engineering profession's title ("Cloud Hosting Finance
  // Analyst", "Compute Engineering Business Operations Manager"): a tech word
  // in it does not make it engineering unless the role itself is an engineer's.
  if (found.some((f) => NON_TECH_CLAIMS.includes(f)) && !ENGINEER_ROLE_RE.test(t) && !SPECIFIC_TECH_RE.test(t) && !TECH_LEADERSHIP_RE.test(t)) return found.filter((f) => !ENGINEERING.has(f));
  if (/\bIT\b/.test(t) && !found.includes("it_support")) found.push("it_support"); // "IT" only in capitals
  // An "engineer" title always carries an engineering type, even beside
  // another one ("Technical Product Manager / Engineer", "GRC Engineer").
  // "Engineering" as an org name ("Compute Engineering Business Operations
  // Manager") does not make a manager/analyst an engineer; "Engineer" as the role does.
  const nonTechRole = found.some((f) => NON_TECH_CLAIMS.includes(f)) && !/\bengineers?\b/i.test(t);
  if (/\bengineer(ing|s)?\b|\beng\b/i.test(t) && !found.some((f) => ENGINEERING.has(f)) && !found.includes("trades_field") && !nonTechRole) found.push("engineering_general");
  // An architect of systems/software/data/the enterprise is engineering;
  // only buildings, landscapes and lecture halls are not.
  if (/\barchitect(s|ure|ing)?\b/i.test(t) && !/\b(building|landscape|interior|construction|naval|workplace|faculty|adjunct|real estate|learning|instructional|curriculum|brand|experience|solutions? sales)\b/i.test(t)
    && !found.some((f) => ENGINEERING.has(f))) found.push("engineering_general");
  return found;
}

// ── Tech signal in a title ─────────────────────────────────────────────────
// For profiles that target engineering types, these words in a title mean the
// job is assessed no matter what else the title says ("Manager, CUDA Driver",
// "Global VP, Compute Control Plane", "Information Systems Security Officer").
// Being generous here is cheap: the rule score is free and decides what the
// AI sees; missing a real job is not.
// data_engineering alone (an analyst profile) does not count: a software title is not her type.
const ENGINEERING_TARGETS = ["software", "ml_ai", "devops_cloud", "security", "qa_test", "solutions", "engineering_general"];
const TECH_TITLE_RE = /\b(software|developer|programm(er|ing)|coding|cuda|gpu|kernel|compiler|devops|devsecops|sre|kubernetes|cloud|infrastructure|machine learning|ml|ai|llm|agentic|ai agents?|dataops|data (engineer\w*|platform|pipelines?|infrastructure|architect\w*)|cyber\w*|infosec|appsec|isso|information systems? security|grc|phishing|threat|siem|forensics|malware|red team|pentest\w*|penetration test\w*|research (intern|scientist|engineer)|world models?|synthetic data|autonomous|robotics|simulation|computational|algorithm\w*|quant\w*|\bapi|sdk|saas|technical (consultant|advisor|relationship|solutions?|account)|platform consultant|enablement architect|software quality engineer\w*|test automation|sdet|automation engineer|systems? administrator|network engineer\w*|database|compute|control plane|technology platforms?|digital product|web|mobile|apps?|firmware|embedded|it (engineer\w*|architect\w*|technologist|systems?|ops|operations)|salesforce|workday|servicenow|sap|erp|observability|reliability|linux|aws|azure|gcp)\b/i;
// Softer words that make a title worth assessing only when no family claims
// it for another profession ("Control Systems Team Lead", "Field Technical Support").
const TECH_HINT_RE = /\b(technolog(y|ies|ist)|technical|platforms?|digital|automation|systems?|data|intelligence|analytics?|scien(ce|tist)|security|it|eng|architect\w*)\b/i;
// Technology leadership ("Head of Core Banking Technology Platforms") unless
// the title says it is HR, sales, finance, audit or risk.
const TECH_LEAD_RE = /\btechnolog(y|ies)\b/i;
const LEAD_RE = /\b(head|director|vp|vice president|managing director|lead|manager|cto|chief)\b/i;
const NON_TECH_LEAD_RE = /\b(recruit\w*|sourc\w*|talent|people|hr|human resources|benefits|rewards|sales|marketing|account\w*|audit\w*|risk|compliance|treasury|procurement|purchase|writer|editor|animator|legal|counsel)\b/i;
// Tech words specific enough to name a role on their own ("Information Systems
// Security Officer"), unlike "autonomous", "mobile" or "data".
const SPECIFIC_TECH_RE = /\b(information systems? security|isso|cyber\w*|infosec|appsec|grc|siem|pentest\w*|penetration test\w*|forensics|malware|threat (intel\w*|hunt\w*|detection)|devops|devsecops|sre|kubernetes|cuda|compiler|kernel|sdk|\bapi\b)\b/i;
const NON_TECH_CLAIMS = ["trades_field", "retail_hospitality", "admin_office", "healthcare", "education", "hr_recruiting", "legal_compliance", "sales", "marketing", "customer_success", "operations", "finance"];
/** "strong" (the title names a tech role), "hint" (a tech-ish word only) or false. */
function techTitle(title, families) {
  const t = String(title || "");
  if (/\b(cnc|plc|ladder logic)\b/i.test(t)) return false; // machine programming, not software
  if (/\bpost-?\s?doc\w*\b/i.test(t)) return false; // a postdoc is a PhD research post, whatever the field
  if (PM_RE.test(t)) return false; // a PM, whatever the product
  if (SALES_ENG_RE.test(t)) return false; // customer-facing engineering, whatever the product
  if (TECH_LEAD_RE.test(t) && LEAD_RE.test(t) && !NON_TECH_LEAD_RE.test(t)) return "strong";
  // A title another, non-engineering profession has claimed ("Sr Mobile
  // Expert" in retail, "Autonomous Vehicle Operator") is not a tech job
  // because of a tech word, unless it is an engineer's.
  // ("Engineering" as an org name does not count; "Engineer" as the role does.)
  if (families.some((f) => NON_TECH_CLAIMS.includes(f)) && !ENGINEER_ROLE_RE.test(t) && !SPECIFIC_TECH_RE.test(t)) return false;
  if (TECH_TITLE_RE.test(t)) return "strong";
  // Hints count only for titles no other profession has claimed (or IT, which is close).
  const unclaimed = !families.length || families.every((f) => f === "it_support");
  return unclaimed && TECH_HINT_RE.test(t) ? "hint" : false;
}

// What a profile of each kind should see scored: its own type plus the
// types people with that background realistically move into.
const ADJACENT = {
  software: ["software", "ml_ai", "data_engineering", "devops_cloud", "security", "qa_test", "data_science", "engineering_general"],
  ml_ai: ["ml_ai", "software", "data_science", "data_engineering", "engineering_general"],
  data_engineering: ["data_engineering", "software", "data_analytics", "data_science", "devops_cloud", "ml_ai", "engineering_general"],
  data_science: ["data_science", "data_analytics", "ml_ai", "data_engineering"],
  data_analytics: ["data_analytics", "data_science", "data_engineering"],
  devops_cloud: ["devops_cloud", "software", "security", "it_support", "engineering_general"],
  security: ["security", "devops_cloud", "it_support", "software", "engineering_general"],
  qa_test: ["qa_test", "software", "engineering_general"],
  solutions: ["solutions", "software", "customer_success"],
  it_support: ["it_support", "devops_cloud", "security"],
  product: ["product", "program_project"],
  program_project: ["program_project", "product"],
  design: ["design"],
  sales: ["sales", "customer_success"],
  customer_success: ["customer_success", "sales"],
  marketing: ["marketing"],
  hr_recruiting: ["hr_recruiting"],
  finance: ["finance"],
  legal_compliance: ["legal_compliance"],
  healthcare: ["healthcare"],
  hardware_eng: ["hardware_eng"],
  operations: ["operations"],
  trades_field: ["trades_field"],
  retail_hospitality: ["retail_hospitality"],
  admin_office: ["admin_office"],
  science_research: ["science_research"],
  education: ["education"],
  executive_general: ["executive_general"],
  engineering_general: ["engineering_general", "software", "hardware_eng"],
};

// Resume role titles are sorted more carefully than job titles: a data
// analyst's "Analyst" or a developer's "Engineer" should land on one type.
const ROLE_PRIORITY = ["ml_ai", "data_science", "data_engineering", "data_analytics", "security", "devops_cloud", "qa_test", "software", "solutions", "it_support", "product", "program_project", "design"];

/** The profile's own job type: the type most of its role titles read as (ties → most recent). */
function ownFamilyForProfile(profile) {
  const counts = new Map();
  (profile?.roles || []).forEach((r, i) => {
    const fams = classifyTitle(r.title || "");
    const pick = ROLE_PRIORITY.find((f) => f !== "ml_ai" && fams.includes(f)) || (fams.includes("ml_ai") ? "ml_ai" : fams[0]);
    if (!pick) return;
    const c = counts.get(pick) || { n: 0, first: i };
    c.n++;
    counts.set(pick, c);
  });
  return [...counts.entries()].sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first)[0]?.[0] || null;
}

/** Job types a profile should see scored, from its own role titles (most recent first). */
function familiesForProfile(profile) {
  const titles = (profile?.roles || []).map((r) => r.title || "").filter(Boolean).slice(0, 4);
  const own = [];
  for (const title of titles) {
    const fams = classifyTitle(title);
    const pick = ROLE_PRIORITY.find((f) => fams.includes(f)) || fams[0];
    if (pick && !own.includes(pick)) own.push(pick);
  }
  const out = new Set();
  for (const f of own) for (const a of ADJACENT[f] || [f]) out.add(a);
  return [...out];
}

// When a title has no type, the description decides — but only for these
// vocabularies, and loosely: two distinct terms are enough. Descriptions are
// often mission statements, so this errs toward assessing.
const VOCAB = {
  software: ["python", "java", "javascript", "typescript", "golang", "c\\+\\+", "c#", "rust", "kotlin", "swift", "ruby", "scala", "react", "node\\.?js", "kubernetes", "docker", "aws", "gcp", "azure", "microservices?", "apis?", "distributed systems", "back-?end", "front-?end", "full[- ]stack", "software", "ci/cd", "git", "sql", "linux", "cloud", "llms?", "machine learning", "ai", "artificial intelligence", "algorithms?", "code", "coding"],
  data: ["sql", "tableau", "power ?bi", "looker", "dashboards?", "data analysis", "analytics", "analytical", "statistic(s|al)", "python", "excel", "a/b test\\w*", "data visuali[sz]ation", "etl", "data pipelines?", "snowflake", "bigquery", "dbt", "pandas", "reporting", "kpis?", "metrics", "data modeling", "forecast\\w*", "insights", "spreadsheets?"],
};
const VOCAB_RE = Object.fromEntries(Object.entries(VOCAB).map(([k, words]) => [k, words.map((w) => new RegExp(`(^|[^a-z0-9])${w}($|[^a-z0-9])`, "i"))]));
const VOCAB_FOR = {
  software: ["software", "ml_ai", "devops_cloud", "security", "qa_test", "solutions", "engineering_general"],
  data: ["data_analytics", "data_science", "data_engineering"],
};

// Vocabulary of professions none of the targets cover. A title that can't be
// read is still another profession's job when its description is dense with
// these and no denser with the targets' words (an HPE mechanical posting still
// says "cloud", "data" and "CAD software" in its boilerplate).
const OTHER_VOCAB = ["mechanical", "thermal", "cad", "solidworks", "creo", "pro ?engineer", "sheet metal", "tooling", "fea", "gd&t", "heat transfer", "enclosures?", "machining",
  "pcb", "schematics?", "verilog", "vhdl", "rtl", "oscilloscope", "firmware", "hvac", "structural", "civil engineering", "surveying", "geotechnical", "welding", "piping",
  "nursing", "patient care", "patients", "clinical", "pharmacy", "gaap", "accounting", "payroll", "audit(s|ing)?", "litigation", "paralegal", "warehouse", "forklift", "cdl"];
const OTHER_RE = OTHER_VOCAB.map((w) => new RegExp(`(^|[^a-z0-9])${w}($|[^a-z0-9])`, "i"));
const countHits = (res, text) => res.filter((re) => re.test(text)).length;

/**
 * Does a description use the core vocabulary of any targeted type (at least
 * `min` distinct terms)? null = no vocabulary applies. With `strict`, another
 * profession's vocabulary that is at least as dense (3+ terms) rules it out.
 */
function descriptionFits(description, targets, min = 2, { strict = false } = {}) {
  const vocabs = Object.keys(VOCAB_FOR).filter((v) => VOCAB_FOR[v].some((f) => targets.includes(f)));
  if (!vocabs.length) return null;
  const text = String(description || "").replace(/<[^>]+>/g, " ");
  const best = Math.max(...vocabs.map((v) => countHits(VOCAB_RE[v], text)));
  if (best < min) return false;
  if (strict) {
    const other = countHits(OTHER_RE, text);
    if (other >= 3 && other >= best) return false;
  }
  return true;
}
// A title of another type is still assessed when its description is dense
// with the profile's own vocabulary (a "Finance & Business Management" role
// that is really SQL/Tableau analytics).
const STRONG_DESCRIPTION_TERMS = 6; // was 8; lowered 2026-10-11 so no job of a selected type is missed
const HINT_DESCRIPTION_TERMS = 3; // title has only a tech-ish word ("Technical Specialist")
const UNKNOWN_DESCRIPTION_TERMS = 4; // title can't be read at all

/**
 * Should this user's AI assessment run on this job?
 *   - title has types: assess when any of them is targeted;
 *   - title has none: assess unless the description clearly lacks the
 *     targeted vocabulary (no description, or no vocabulary: assess).
 * @returns {{ assess: boolean, families: string[], why: "type"|"description"|"unknown" }}
 */
function shouldAssess(title, targets, description = "") {
  const families = classifyTitle(title);
  if (!targets || !targets.length) return { assess: true, families, why: "unknown" };
  if (String(title || "").trim().length < 3) return { assess: true, families, why: "unknown" }; // no real title
  // "Quality Engineer II" is medical-device or manufacturing quality as often
  // as software QA: without a software/test word it is decided by the description.
  const qualityOnly = /\bquality (?:engineer\w*|engineering|assurance)\b/i.test(title) && !/\b(software|automation|test\w*|qa|sdet|web|mobile|api|sre|platform)\b/i.test(title);
  if (!qualityOnly && families.some((f) => targets.includes(f))) return { assess: true, families, why: "type" };
  // Engineering profiles: any tech signal in the title is enough. Never miss
  // a job of a selected type because another word in the title won.
  const tech = targets.some((f) => ENGINEERING_TARGETS.includes(f)) ? techTitle(title, families) : false;
  if (tech === "strong" && !qualityOnly) return { assess: true, families, why: "tech-title" };
  // A hint alone ("Technical Specialist", "Field Technical Support") is not a
  // tech job: the description has to use the targets' vocabulary (3+ terms,
  // and not be denser with another profession's). No description: assess.
  if (tech === "hint" || qualityOnly) {
    if (!description || String(description).length < 200) return { assess: true, families, why: "unknown" };
    return descriptionFits(description, targets, HINT_DESCRIPTION_TERMS, { strict: true })
      ? { assess: true, families, why: "description" }
      : { assess: false, families, why: "type" };
  }
  if (families.length) {
    if (descriptionFits(description, targets, STRONG_DESCRIPTION_TERMS)) return { assess: true, families, why: "description" };
    return { assess: false, families, why: "type" };
  }
  if (!description || String(description).length < 200) return { assess: true, families, why: "unknown" };
  // No readable title at all: only a description dense with the targets'
  // vocabulary (4+ distinct terms) gets the job assessed.
  const fits = descriptionFits(description, targets, UNKNOWN_DESCRIPTION_TERMS, { strict: true });
  return { assess: fits !== false, families, why: fits === null ? "unknown" : "description" };
}

/** Stable key for a set of target types, stored with skipped jobs. */
const targetsKey = (targets) => [...(targets || [])].sort().join(",");

const familyLabel = (id) => FAMILIES[id]?.label || id;

module.exports = { FAMILIES, FAMILY_IDS, ADJACENT, classifyTitle, familiesForProfile, ownFamilyForProfile, shouldAssess, descriptionFits, targetsKey, familyLabel };
