// companyExclude.cjs — companies a person never wants to apply to
// (settings/preferences.excludedCompanies), matched by name the way people
// type them: "CVS" covers "CVS Health" and "CVS Pharmacy", "Costco" covers
// "Costco Wholesale", "U.S. Bank" covers "US Bank" (Riti, 2026-11-13).
// The same logic lives in functions/lib/companyExclude.cjs for auto-apply.

const SUFFIX = new Set(["inc", "incorporated", "corp", "corporation", "co", "company", "llc", "ltd", "limited", "plc", "lp", "llp", "group", "the"]);

/** "U.S. Bank, Inc." -> ["us", "bank"] */
function companyWords(name) {
  return String(name || "").toLowerCase()
    .replace(/&/g, " and ")
    .replace(/(\b[a-z])\.(?=[a-z]\.)/g, "$1") // u.s.a. -> usa.
    .replace(/\b([a-z])\.(?=\s|$)/g, "$1")
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ")
    .filter((w) => w && !SUFFIX.has(w));
}

/** A matcher for a list of excluded names: true when the company's name starts with one of them, word for word. */
function companyExcluder(list) {
  const rules = (Array.isArray(list) ? list : []).map(companyWords).filter((w) => w.length);
  return (companyName) => {
    if (!rules.length) return false;
    const have = companyWords(companyName);
    return rules.some((w) => w.length <= have.length && w.every((x, i) => have[i] === x));
  };
}

export { companyWords, companyExcluder };
