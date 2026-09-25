// titleCase — job titles as Title Case for display.
//
//   "VIRTUAL CONSTRUCTION SOFTWARE ENGINEER" → "Virtual Construction Software Engineer"
//   "senior software engineer, ai platform"  → "Senior Software Engineer, AI Platform"
//   "Sr. DevOps Engineer II (Remote)"        → unchanged
//
// Rules:
//   - every word starts with a capital letter, except short joining words
//     (and, of, for, the, to, in, …) in the middle of a title;
//   - known acronyms and roman numerals are upper case (AI, ML, SRE, AWS, II);
//   - words that already mix cases are kept (iOS, DevOps, GraphQL, eBay);
//   - a title written ALL IN CAPITALS is treated like lower case first, so
//     it reads normally — except for the acronyms above;
//   - in a normal title, words already in capitals are kept (IN, HRIS);
//   - hyphenated and slashed parts are each capitalized (Full-Stack, AI/ML),
//     except joining words (Go-to-Market, and/or).

const ACRONYMS = new Set([
  "ai", "ml", "llm", "llms", "nlp", "cv", "ar", "vr", "xr", "iot", "api", "apis", "sdk", "ui", "ux", "qa", "qe", "qc", "sre", "sdet", "sde", "swe",
  "mts", "fde", "tpm", "pm", "pmo", "vp", "svp", "evp", "avp", "ceo", "cto", "cfo", "coo", "cio", "ciso", "cmo", "cpo", "it", "hr", "hrbp", "gtm",
  "bi", "etl", "elt", "sql", "aws", "gcp", "k8s", "ci", "cd", "devsecops", "saas", "paas", "iaas", "b2b", "b2c", "smb", "sme", "erp", "crm", "sap",
  "hvac", "mep", "bim", "cad", "cae", "cnc", "pcb", "rf", "asic", "fpga", "soc", "siem", "iam", "sso", "gis", "gpu", "cpu", "hpc", "os", "kpi",
  "us", "usa", "uk", "eu", "nyc", "sf", "la", "dc", "emea", "apac", "latam", "amer", "na", "r&d", "ehs", "hse", "ts", "sci", "dod", "doe", "nasa",
  "faang", "ios", "rn", "lpn", "np", "pa", "md", "cpa", "cfa", "phd", "mba", "msl", "cra", "gmp", "fp&a", "m&a", "ocr", "etc",
]);
// Acronyms also written in lower case ("senior engineer, ai platform"); the rest
// only become capitals when the title shouts, so "La Porte" and "join us" stay.
const LOWER_OK = new Set(["ai", "ml", "llm", "nlp", "api", "sdk", "ui", "ux", "qa", "sre", "sdet", "aws", "gcp", "sql", "etl", "hr", "it", "bi", "vp", "gtm", "iam", "gpu"]);
const MIXED = { ios: "iOS", devops: "DevOps", devsecops: "DevSecOps", mlops: "MLOps", saas: "SaaS", paas: "PaaS", iaas: "IaaS", iot: "IoT", phd: "PhD", graphql: "GraphQL", javascript: "JavaScript", typescript: "TypeScript", ".net": ".NET", "c#": "C#", "c++": "C++", "k8s": "K8s" };
const ROMAN = /^(ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii)$/i;
const SMALL = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "nor", "of", "on", "or", "per", "the", "to", "vs", "via", "with"]);

function fixPart(part, { first, shouting }) {
  if (!part) return part;
  const m = part.match(/^([^A-Za-z0-9.#+&]*)([A-Za-z0-9.#+&'’]+)([^A-Za-z0-9]*)$/);
  if (!m) return part;
  const [, lead, core, tail] = m;
  const lower = core.toLowerCase();
  let out;
  const bare = lower.replace(/[.'’]/g, "");
  if (MIXED[lower]) out = MIXED[lower];
  else if (!shouting && /[a-z]/.test(core) && /[A-Z]/.test(core.slice(1))) out = core; // already mixed case: keep (eBay, SoC, GitHub)
  else if (ACRONYMS.has(bare) && (shouting || core === core.toUpperCase() || (core === lower && LOWER_OK.has(bare)))) out = core.toUpperCase();
  else if (ROMAN.test(lower) && (shouting || core === core.toUpperCase())) out = core.toUpperCase();
  else if (!shouting && core.length > 1 && /[A-Z]/.test(core) && core === core.toUpperCase()) out = core; // capitals in a normal title are deliberate (IN, HRIS, CRG)
  else if (!first && SMALL.has(lower)) out = lower;
  else {
    const base = shouting ? lower : core;
    out = base.charAt(0).toUpperCase() + base.slice(1);
  }
  return lead + out + tail;
}

export function titleCase(title) {
  const text = String(title || "").replace(/\s+/g, " ").trim();
  if (!text) return text;
  const letters = text.replace(/[^A-Za-z]/g, "");
  // All in capitals (allowing a few lower-case letters from e.g. "iOS"): read it as lower case.
  const shouting = letters.length >= 4 && (letters.match(/[A-Z]/g) || []).length / letters.length > 0.8;
  let first = true;
  return text.split(" ").map((word) => {
    let fixed;
    if (/^w\/$/i.test(word)) fixed = "w/";
    else if (/^co-?op$/i.test(word)) fixed = word.replace(/^co/i, "Co").replace(/op$/i, "op");
    else {
      // Parts after a hyphen or slash are capitalized too, except joining words (Go-to-Market, and/or).
      fixed = word.split(/([-/])/).map((part, i) => (part === "-" || part === "/" ? part : fixPart(part, { first: (first || word.includes("-")) && i === 0, shouting }))).join("");
    }
    // After a dash, colon, bar or opening bracket the next word starts a new phrase.
    first = /[:(–—|]$/.test(word) || word === "-";
    return fixed;
  }).join(" ");
}
