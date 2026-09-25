/**
 * resumeLocation.cjs — pick the "City, ST" a tailored resume should show for a
 * job, from the job's own location list.
 *
 * Rules (from the product spec):
 *  - Cities are tiered. When a job lists several locations, use the most
 *    important one (lowest tier, then earlier in the tier list): SF beats
 *    everything; New York beats Boston and Chicago; …
 *  - A single recognised city is used as-is.
 *  - Suburbs map to their metro's display city (Sunnyvale → San Jose,
 *    Redmond → Seattle, Reston → Washington, DC, Jersey City → New York).
 *  - Remote / "United States" / unparseable → San Francisco, CA.
 *  - An unrecognised but well-formed "City, ST" (e.g. Findlay, OH) is used
 *    as-is rather than replaced.
 *
 * Only city + state (+ a representative ZIP for the city) are produced —
 * never a street address.
 *
 * Deliberately independent of mapLocation: the map normaliser falls back to
 * San Francisco for cities it can't geocode, so it can't tell "SF" from
 * "unknown".
 */

const STATES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE",
  nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC",
  "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA",
  washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};
const STATE_CODES = new Set(Object.values(STATES));
const STATE_NAMES_BY_LENGTH = Object.keys(STATES).sort((a, b) => b.length - a.length);

/**
 * Metro table. `display` is what goes on the resume; `cities` are the
 * spellings that map to it (lower-case). Order within a tier is priority.
 */
const METROS = [
  // ── Tier 1 ──
  { tier: 1, display: "San Francisco, CA", zip: "94114", state: "CA", cities: ["san francisco", "sf", "bay area", "east palo alto", "san francisco bay area", "sf bay area", "south san francisco", "oakland", "berkeley", "emeryville", "fremont", "redwood city", "menlo park", "palo alto", "san mateo", "foster city", "burlingame", "san bruno", "daly city", "brisbane", "alameda", "san rafael", "walnut creek", "pleasanton", "san ramon", "dublin", "hayward", "union city", "newark"] },
  { tier: 1, display: "New York, NY", zip: "10016", state: "NY", cities: ["new york", "new york city", "nyc", "new york new york", "manhattan", "brooklyn", "queens", "bronx", "jersey city", "hoboken", "newark nj", "long island city", "white plains", "stamford"] },
  { tier: 1, display: "Seattle, WA", zip: "98109", state: "WA", cities: ["seattle", "bellevue", "redmond", "kirkland", "bothell", "renton", "issaquah", "tacoma"] },
  { tier: 1, display: "San Jose, CA", zip: "95112", state: "CA", cities: ["san jose", "sunnyvale", "santa clara", "mountain view", "cupertino", "milpitas", "los gatos", "campbell", "los altos", "saratoga", "morgan hill"] },
  { tier: 1, display: "Los Angeles, CA", zip: "90015", state: "CA", cities: ["los angeles", "la", "santa monica", "culver city", "venice", "el segundo", "playa vista", "burbank", "glendale ca", "pasadena", "torrance", "long beach", "manhattan beach", "marina del rey", "hawthorne"] },
  // ── Tier 2 ──
  { tier: 2, display: "Boston, MA", zip: "02116", state: "MA", cities: ["boston", "cambridge", "somerville", "waltham", "burlington ma", "lexington", "bedford ma", "woburn", "quincy", "newton", "needham", "watertown", "andover", "billerica", "westford", "marlborough", "framingham"] },
  { tier: 2, display: "Austin, TX", zip: "78701", state: "TX", cities: ["austin", "round rock", "cedar park", "pflugerville"] },
  { tier: 2, display: "Chicago, IL", zip: "60611", state: "IL", cities: ["chicago", "naperville", "schaumburg", "evanston", "oak brook", "deerfield", "vernon hills", "lisle", "rosemont"] },
  { tier: 2, display: "Washington, DC", zip: "20001", state: "DC", cities: ["washington", "washington dc", "washington d.c.", "arlington", "reston", "mclean", "tysons", "tysons corner", "herndon", "chantilly", "alexandria", "fairfax", "vienna va", "sterling", "dulles", "bethesda", "rockville", "silver spring", "gaithersburg", "germantown", "columbia md", "annapolis junction", "fort meade", "springfield va", "falls church"] },
  { tier: 2, display: "Denver, CO", zip: "80202", state: "CO", cities: ["denver", "boulder", "broomfield", "louisville co", "englewood", "aurora co", "westminster co", "littleton", "golden", "centennial", "lakewood co", "fort collins", "colorado springs"] },
  { tier: 2, display: "San Diego, CA", zip: "92101", state: "CA", cities: ["san diego", "la jolla", "carlsbad", "sorrento valley", "carmel valley", "chula vista"] },
  { tier: 2, display: "Atlanta, GA", zip: "30309", state: "GA", cities: ["atlanta", "alpharetta", "sandy springs", "marietta", "roswell", "duluth ga", "kennesaw"] },
  { tier: 2, display: "Dallas, TX", zip: "75201", state: "TX", cities: ["dallas", "plano", "irving", "richardson", "mckinney", "frisco", "fort worth", "addison", "westlake tx", "southlake", "coppell", "allen"] },
  { tier: 2, display: "Raleigh, NC", zip: "27601", state: "NC", cities: ["raleigh", "durham", "cary", "morrisville", "research triangle park", "rtp", "chapel hill"] },
  { tier: 2, display: "Portland, OR", zip: "97209", state: "OR", cities: ["portland", "beaverton", "hillsboro", "lake oswego", "tigard", "wilsonville"] },
  { tier: 2, display: "Irvine, CA", zip: "92618", state: "CA", cities: ["irvine", "orange county", "newport beach", "costa mesa", "anaheim", "santa ana", "aliso viejo", "lake forest", "tustin"] },
  // ── Tier 3 ──
  { tier: 3, display: "Phoenix, AZ", zip: "85004", state: "AZ", cities: ["phoenix", "tempe", "scottsdale", "chandler", "mesa", "gilbert", "glendale az"] },
  { tier: 3, display: "Salt Lake City, UT", zip: "84101", state: "UT", cities: ["salt lake city", "lehi", "draper", "provo", "sandy", "south jordan", "orem", "american fork"] },
  { tier: 3, display: "Minneapolis, MN", zip: "55401", state: "MN", cities: ["minneapolis", "st. paul", "st paul", "saint paul", "eden prairie", "bloomington mn", "plymouth mn", "minnetonka", "eagan"] },
  { tier: 3, display: "Philadelphia, PA", zip: "19103", state: "PA", cities: ["philadelphia", "king of prussia", "malvern", "conshohocken", "wayne pa", "radnor", "blue bell", "wilmington", "cherry hill", "mount laurel"] },
  { tier: 3, display: "Miami, FL", zip: "33131", state: "FL", cities: ["miami", "fort lauderdale", "boca raton", "coral gables", "doral", "west palm beach", "sunrise fl"] },
  { tier: 3, display: "Houston, TX", zip: "77002", state: "TX", cities: ["houston", "the woodlands", "sugar land", "katy", "spring tx"] },
  { tier: 3, display: "Pittsburgh, PA", zip: "15222", state: "PA", cities: ["pittsburgh", "cranberry township"] },
  { tier: 3, display: "Detroit, MI", zip: "48226", state: "MI", cities: ["detroit", "ann arbor", "dearborn", "troy mi", "auburn hills", "southfield", "warren mi", "farmington hills", "novi"] },
  { tier: 3, display: "Columbus, OH", zip: "43215", state: "OH", cities: ["columbus", "dublin oh", "westerville", "new albany"] },
  { tier: 3, display: "Nashville, TN", zip: "37203", state: "TN", cities: ["nashville", "franklin tn", "brentwood tn"] },
  { tier: 3, display: "Charlotte, NC", zip: "28202", state: "NC", cities: ["charlotte", "fort mill", "huntersville"] },
  { tier: 3, display: "Kansas City, MO", zip: "64105", state: "MO", cities: ["kansas city", "overland park", "olathe", "leawood", "lenexa"] },
  { tier: 3, display: "St. Louis, MO", zip: "63101", state: "MO", cities: ["st. louis", "st louis", "saint louis", "chesterfield", "clayton mo", "o'fallon"] },
  { tier: 3, display: "Baltimore, MD", zip: "21201", state: "MD", cities: ["baltimore", "towson", "hanover md", "linthicum"] },
  { tier: 3, display: "Orlando, FL", zip: "32801", state: "FL", cities: ["orlando", "lake mary", "maitland"] },
  { tier: 3, display: "Tampa, FL", zip: "33602", state: "FL", cities: ["tampa", "st. petersburg", "st petersburg", "clearwater"] },
  { tier: 3, display: "Sacramento, CA", zip: "95814", state: "CA", cities: ["sacramento", "folsom", "roseville", "rancho cordova"] },
  { tier: 3, display: "Las Vegas, NV", zip: "89101", state: "NV", cities: ["las vegas", "henderson", "reno"] },
  { tier: 3, display: "Madison, WI", zip: "53703", state: "WI", cities: ["madison"] },
  { tier: 3, display: "Milwaukee, WI", zip: "53202", state: "WI", cities: ["milwaukee", "brookfield wi", "waukesha"] },
  { tier: 3, display: "Indianapolis, IN", zip: "46204", state: "IN", cities: ["indianapolis", "carmel in", "fishers"] },
  { tier: 3, display: "Cincinnati, OH", zip: "45202", state: "OH", cities: ["cincinnati", "mason oh", "blue ash"] },
  { tier: 3, display: "Cleveland, OH", zip: "44114", state: "OH", cities: ["cleveland", "mayfield heights", "beachwood", "akron"] },
  { tier: 3, display: "Richmond, VA", zip: "23219", state: "VA", cities: ["richmond", "glen allen", "henrico"] },
  { tier: 3, display: "Hartford, CT", zip: "06103", state: "CT", cities: ["hartford", "windsor", "bloomfield ct", "farmington ct", "new haven", "north haven"] },
  { tier: 3, display: "Albany, NY", zip: "12207", state: "NY", cities: ["albany", "malta", "troy ny", "schenectady"] },
  { tier: 3, display: "Huntsville, AL", zip: "35801", state: "AL", cities: ["huntsville"] },
  { tier: 3, display: "Tucson, AZ", zip: "85701", state: "AZ", cities: ["tucson"] },
  { tier: 3, display: "Omaha, NE", zip: "68102", state: "NE", cities: ["omaha"] },
  { tier: 3, display: "Louisville, KY", zip: "40202", state: "KY", cities: ["louisville"] },
  { tier: 3, display: "Jacksonville, FL", zip: "32202", state: "FL", cities: ["jacksonville"] },
  { tier: 3, display: "Boise, ID", zip: "83702", state: "ID", cities: ["boise"] },
  { tier: 3, display: "Albuquerque, NM", zip: "87102", state: "NM", cities: ["albuquerque"] },
  { tier: 3, display: "Oklahoma City, OK", zip: "73102", state: "OK", cities: ["oklahoma city", "tulsa"] },
  { tier: 3, display: "Rochester, NY", zip: "14604", state: "NY", cities: ["rochester", "buffalo", "syracuse"] },
  { tier: 3, display: "Providence, RI", zip: "02903", state: "RI", cities: ["providence", "warwick ri"] },
  { tier: 3, display: "Des Moines, IA", zip: "50309", state: "IA", cities: ["des moines", "west des moines"] },
  { tier: 3, display: "Charleston, SC", zip: "29401", state: "SC", cities: ["charleston", "greenville sc", "columbia sc"] },
  { tier: 3, display: "San Antonio, TX", zip: "78205", state: "TX", cities: ["san antonio"] },
  { tier: 3, display: "New Orleans, LA", zip: "70112", state: "LA", cities: ["new orleans", "baton rouge"] },
  { tier: 3, display: "Birmingham, AL", zip: "35203", state: "AL", cities: ["birmingham al", "hoover"] },
  { tier: 3, display: "Memphis, TN", zip: "38103", state: "TN", cities: ["memphis"] },
  { tier: 3, display: "Manchester, NH", zip: "03101", state: "NH", cities: ["manchester nh", "nashua", "portsmouth nh"] },
  { tier: 3, display: "Burlington, VT", zip: "05401", state: "VT", cities: ["burlington vt", "essex junction"] },
  { tier: 3, display: "Portland, ME", zip: "04101", state: "ME", cities: ["portland me"] },
  { tier: 3, display: "Little Rock, AR", zip: "72201", state: "AR", cities: ["little rock"] },
  { tier: 3, display: "Wichita, KS", zip: "67202", state: "KS", cities: ["wichita"] },
  { tier: 3, display: "Sioux Falls, SD", zip: "57104", state: "SD", cities: ["sioux falls"] },
  { tier: 3, display: "Fargo, ND", zip: "58102", state: "ND", cities: ["fargo"] },
  { tier: 3, display: "Billings, MT", zip: "59101", state: "MT", cities: ["billings", "bozeman"] },
  { tier: 3, display: "Cheyenne, WY", zip: "82001", state: "WY", cities: ["cheyenne"] },
  { tier: 3, display: "Honolulu, HI", zip: "96813", state: "HI", cities: ["honolulu"] },
  { tier: 3, display: "Anchorage, AK", zip: "99501", state: "AK", cities: ["anchorage"] },
  { tier: 3, display: "Jackson, MS", zip: "39201", state: "MS", cities: ["jackson ms"] },
  { tier: 3, display: "Charleston, WV", zip: "25301", state: "WV", cities: ["charleston wv", "morgantown"] },
  { tier: 3, display: "Wilmington, DE", zip: "19801", state: "DE", cities: ["wilmington de", "newark de", "dover de"] },
  { tier: 3, display: "Idaho Falls, ID", zip: "83402", state: "ID", cities: ["idaho falls"] },
];

const DEFAULT = { display: "San Francisco, CA", city: "San Francisco", state: "CA", zip: "94114", tier: 1 };

const CITY_INDEX = new Map(); // "city" or "city ST" → metro
for (const m of METROS) {
  for (const c of m.cities) {
    const parts = c.split(" ");
    const last = parts[parts.length - 1].toUpperCase();
    if (parts.length > 1 && STATE_CODES.has(last) && last.length === 2 && parts[parts.length - 1] === parts[parts.length - 1].toLowerCase()) {
      CITY_INDEX.set(`${parts.slice(0, -1).join(" ")} ${last}`, m);
    } else {
      CITY_INDEX.set(c, m);
    }
  }
}

// ── ZIP lookup (dataset) ────────────────────────────────────────────────────
let zipcodesMod = null;
function zipcodes() {
  if (zipcodesMod === null) {
    try { zipcodesMod = require("zipcodes"); } catch { zipcodesMod = false; }
  }
  return zipcodesMod || null;
}
const CITY_ABBR = [[/^st\.?\s+/i, "Saint "], [/^mt\.?\s+/i, "Mount "], [/^ft\.?\s+/i, "Fort "], [/^n\.\s+/i, "North "], [/^s\.\s+/i, "South "], [/^e\.\s+/i, "East "], [/^w\.\s+/i, "West "]];
function zipFor(city, state) {
  const z = zipcodes();
  if (!z || !city || !state) return null;
  const tries = [city];
  for (const [re, rep] of CITY_ABBR) if (re.test(city)) tries.push(city.replace(re, rep));
  tries.push(city.replace(/\s+(county|township|twp|parish)$/i, ""));
  for (const t of tries) {
    const hits = z.lookupByName(t, state) || [];
    if (hits.length) return hits[0].zip;
  }
  return null;
}
/** Is "city, state" a real place per the dataset? */
function isRealCity(city, state) {
  return zipFor(city, state) != null;
}

// Well-known military / federal sites → the city the ZIP dataset knows.
const SITE_ALIASES = [
  [/\bedwards\s+afb\b/i, "Edwards", "CA"], [/\bvandenberg\s+(afb|sfb)\b/i, "Lompoc", "CA"], [/\bschriever\s+(afb|sfb)\b/i, "Colorado Springs", "CO"],
  [/\bpeterson\s+(afb|sfb)\b/i, "Colorado Springs", "CO"], [/\bbuckley\s+(afb|sfb)\b/i, "Aurora", "CO"], [/\btinker\s+afb\b/i, "Oklahoma City", "OK"],
  [/\bwright[- ]patterson\s+afb\b/i, "Dayton", "OH"], [/\bkennedy\s+space\s+center\b/i, "Titusville", "FL"], [/\bpatrick\s+(afb|sfb)\b/i, "Cocoa Beach", "FL"],
  [/\beglin\s+afb\b/i, "Fort Walton Beach", "FL"], [/\bhill\s+afb\b/i, "Ogden", "UT"], [/\bminot\s+afb\b/i, "Minot", "ND"], [/\bfort\s+cavazos\b/i, "Killeen", "TX"],
  [/\bfort\s+meade\b/i, "Fort Meade", "MD"], [/\bjb\s+lindsey\s+graham\b/i, "Charleston", "SC"], [/\bredstone\s+arsenal\b/i, "Huntsville", "AL"],
  [/\brocket\s+center\b/i, "Rocket Center", "WV"], [/\blos\s+alamos\b/i, "Los Alamos", "NM"], [/\bspace\s+coast\b/i, "Melbourne", "FL"],
];
// Hyphenated city names that must survive dash splitting.
const HYPHENATED = ["winston-salem", "wilkes-barre", "fuquay-varina", "sedro-woolley", "wright-patterson"];
function expandAbbr(name) {
  let n = String(name);
  for (const [re, rep] of CITY_ABBR) n = n.replace(re, rep);
  return n;
}

// Cities outside the US that show up with US-looking codes ("IL - Tel Aviv", "CA-Toronto", "London, New York").
const NON_US_STRONG_RE = /\b(bangalore|bengaluru|hyderabad|pune|chennai|mumbai|delhi|gurgaon|gurugram|noida|singapore|tel aviv|toronto|montr[eé]al|calgary|ottawa|krak[oó]w|munich|zurich|stockholm|sydney|tokyo|seoul|shanghai|beijing|hong kong|taipei|manila|mexico city|guadalajara|monterrey|s[aã]o paulo|buenos aires|bogot[aá]|cairo|nairobi|johannesburg|cape town|karnataka|tamil nadu|maharashtra|telangana|quebec|british columbia|alberta|lucan|co\. dublin|united kingdom|england|canada|india|israel|ireland|germany|france|poland|mexico|brazil|australia|japan|china)\b/i;
const NON_US_WEAK_RE = /\b(london|dublin|paris|berlin|warsaw|melbourne|vancouver|lima|santiago|madrid|milan|birmingham|ontario|amsterdam|richmond hill|cambridge uk)\b/i;
const STATE_NAME_TOKEN = (t) => stateName(t) != null;

const REMOTE_RE = /\b(remote|work from home|wfh|telecommute|telework|virtual|home[- ]?based|offsite\/home|anywhere|field worker|field based|regional)\b/i;
// Words that never name a place; removed before parsing.
const NOISE_RE = /\b(hybrid|onsite|on-site|in-office|in office|offices?|campus|hq|headquarters|home office|corporate|store\s*\d*|shop|warehouse|plant|factory|distribution center|fulfillment center|fulfillment services|ecomm|supercenter|sam's club|data center|datacenter|bldg|building|suite|ste|floor|fl\.|usa?|u\.s\.a?\.?|united states( of america)?|amer|americas|north america|na|greater|northern|southern|central|metro(?:plex|politan)?(?: area)?|any city|all cities|state of|multiple locations|multiple|locations?|hub|engagement|domain|design studio|studio|fleet|retail|car care plus|walmart|mart|admin|general offices|infomart|legacy|non|other|university of|inc|llc|l\.l\.c\.|i|ii|iii|iv|d\d+|[a-z]{2,}\d+[a-z0-9]*)\b/gi;

function titleCase(s) {
  const noStreet = String(s).replace(/\u2011/g, "-").replace(/\s+\S+\s+(drive|dr|street|st|avenue|ave|road|rd|blvd|boulevard|lane|ln|way|pkwy|parkway|hwy|highway|plaza|court|ct|lex)\b.*$/i, "");
  return noStreet.toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase()).replace(/\bDc\b/, "DC").replace(/\bAfb\b/, "AFB").replace(/\bSfb\b/, "SFB");
}
function stateCode(tok) {
  const t = String(tok || "").trim().replace(/\./g, "");
  return /^[A-Z]{2}$/.test(t) && STATE_CODES.has(t) ? t : null; // uppercase only: "in", "or" are words
}
function stateName(tok) {
  return STATES[String(tok || "").trim().toLowerCase()] || null;
}
const isWordy = (t) => /[A-Za-z]{2,}/.test(t) && !/\d{3,}/.test(t);

const STATE_DEFAULT = new Map();
for (const m of METROS) if (!STATE_DEFAULT.has(m.state)) STATE_DEFAULT.set(m.state, m);
STATE_DEFAULT.set("NJ", METROS.find((m) => m.display === "New York, NY"));

/** Split a location string into independent place segments. */
function splitSegments(text) {
  return String(text || "")
    .replace(/\s*[>:]\s*/g, " - ")
    .replace(/\s+(?:or|and)\s+/g, " ; ").replace(/\s*[&+]\s*/g, " ; ")            // "NY or SF", "Chicago and NYC", "Austin & Sunnyvale"
    .replace(/\s*\/\s*/g, " ; ")                          // "Elk Grove, IL / Plano, TX", "NYC / Austin"
    .split(/\s*[;|•·]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse one segment into [{ city, state }]. Either field may be null.
 * A segment can yield several places ("Cambridge, Waltham" without states).
 */
function parseSegment(seg) {
  let s = String(seg || "")
    .replace(/~.*$/, " ")
    .replace(/\b(?:san francisco |sf )?bay area\b/gi, "San Francisco")
    .replace(/\bnew york city\b/gi, "New York")
    .replace(/\bnyc\b/gi, "New York")
    .replace(/\bd\.c\.\b/gi, "DC")
    .trim();
  if (!s) return [];
  // Known military / federal sites anywhere in the segment
  for (const [re, city, st] of SITE_ALIASES) if (re.test(s)) return [{ city, state: st }];
  // Foreign places with US-looking codes ("IL - Tel Aviv", "Bangalore, IN"): drop
  // them; keep the segment only if a US metro remains. Ambiguous names (London,
  // Melbourne, Warsaw, Dublin…) are foreign only when no US state is present.
  const hasUsState = s.split(/[\s,\-–—/()]+/).some((t) => stateCode(t)) || STATE_NAMES_BY_LENGTH.some((n) => new RegExp(`\\b${n}\\b`, "i").test(s));
  const foreign = NON_US_STRONG_RE.test(s) || (!hasUsState && NON_US_WEAK_RE.test(s));
  if (foreign) {
    const rest = s.replace(NON_US_STRONG_RE, " ").replace(hasUsState ? /$^/ : NON_US_WEAK_RE, " ");
    const restLower = rest.toLowerCase();
    let keeps = false;
    for (const key of CITY_INDEX.keys()) if (key.length > 3 && new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(restLower)) { keeps = true; break; }
    if (!keeps) return [];
    s = rest;
  }
  s = s.replace(/^\s*\((?:usa?|us)\)\s*/i, "");                              // "(USA) TX FORT WORTH …"
  s = s.replace(/\b([A-Z][a-zA-Z])\s+(\d{5})(?:-\d{4})?\b/g, (m0, c, z) => `${c.toUpperCase()} ${z}`); // "Va 23455" → "VA 23455"
  s = s.replace(/\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/g, "$1");                  // "NY 12010-8174" → "NY"
  for (const h of HYPHENATED) s = s.replace(new RegExp(h, "ig"), h.replace("-", "\u2011")); // protect the hyphen

  // "US-AZ-TUCSON-M13" / "USA-CA-SAN JOSE" / "USA.VA.Reston" / "US-VA Richmond" / "USA-TX Plano Legacy Drive Suite 700" / "IL-Wheaton Car Care Plus"
  let m = s.match(/^(?:U\.?S\.?A?[-.\s]+)?([A-Z]{2})[-.\s]+([A-Za-z][A-Za-z .'-]*?)(?:\s+\d.*|-.*|,.*|\s*\(.*)?$/);
  if (m && stateCode(m[1]) && !stateName(m[2].trim()) && !/^[A-Z]{2}$/.test(m[2].trim())) {
    const r = resolveCity(m[2], stateCode(m[1]));
    if (r) return [{ city: r.city, state: stateCode(m[1]) }];
  }

  // Keep parenthetical text as its own comma group: "Nassau (East Meadow, NY)" → "Nassau , East Meadow, NY"
  s = s.replace(/[()]/g, " , ").replace(/\s+,/g, ",");
  const cleaned = s.replace(NOISE_RE, " ").replace(/\s+/g, " ").replace(/\s+,/g, ",").replace(/,\s*,+/g, ",").trim();
  let tokens = cleaned.split(/\s*[,\-–—]\s*/).map((t) => t.trim()).filter((t) => t && /[A-Za-z]/.test(t));
  // "Seattle WA" / "Chicago Illinois" — city and state without a comma; but never split a state name itself ("West Virginia")
  tokens = tokens.flatMap((t) => {
    if (stateName(t)) return [t];
    const mm = t.match(/^(.+?)\s+([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/);
    if (mm && stateCode(mm[2]) && !stateCode(mm[1])) return [mm[1], mm[2]];
    const lead = t.match(/^([A-Z]{2})\s+([A-Za-z].*)$/);           // "MI Home", "WA Bellevue"
    if (lead && stateCode(lead[1])) return [lead[1], lead[2]];
    const lower = t.toLowerCase();
    for (const name of STATE_NAMES_BY_LENGTH) {
      if (lower.endsWith(" " + name) && lower.length > name.length + 1) return [t.slice(0, t.length - name.length - 1), t.slice(t.length - name.length)];
    }
    return [t.replace(/\s+\d{5}(?:-\d{4})?$/, "")];
  });
  if (tokens.length === 0) return [];

  // "Washington, District of Columbia" / "New York, New York": a city that is also a state name, then its state
  if (tokens.length >= 2 && CITY_INDEX.has(tokens[0].toLowerCase()) && (stateName(tokens[1]) || stateCode(tokens[1]))) {
    return [{ city: titleCase(tokens[0]), state: stateCode(tokens[1]) || stateName(tokens[1]) }];
  }
  // Lists of state names only ("Colorado, Illinois", "Georgia, Texas, Virginia") → one state-only place each
  if (tokens.length > 1 && tokens.every((t) => stateName(t) || stateCode(t))) {
    return tokens.map((t) => ({ city: null, state: stateCode(t) || stateName(t) }));
  }

  // Pick the state token: a 2-letter code wins; otherwise the LAST state-name token.
  let si = tokens.findIndex((t) => stateCode(t));
  let st = si !== -1 ? stateCode(tokens[si]) : null;
  if (si === -1) {
    for (let i = tokens.length - 1; i >= 0; i--) if (stateName(tokens[i])) { si = i; st = stateName(tokens[i]); break; }
  }

  if (si !== -1) {
    let cityTok = null;
    for (let j = si - 1; j >= 0; j--) if (isWordy(tokens[j]) && !stateName(tokens[j]) && !stateCode(tokens[j])) { cityTok = tokens[j]; break; }
    if (!cityTok) for (let j = si + 1; j < tokens.length; j++) if (isWordy(tokens[j]) && !stateCode(tokens[j]) && !stateName(tokens[j])) { cityTok = tokens[j]; break; }
    const bare = tokens[si].toLowerCase();                 // "New York" / "Washington" alone mean the city
    const bareIsCity = CITY_INDEX.has(bare);
    if (cityTok) {
      const r = resolveCity(cityTok, st);
      // An unverified word next to "New York" ("Betterment HQ - New York") is a company, not a city.
      if (r && (r.verified || !bareIsCity)) return [{ city: r.city, state: st }];
    }
    if (bareIsCity) return [{ city: titleCase(bare), state: CITY_INDEX.get(bare).state }];
    return [{ city: null, state: st }];
  }

  // No state: every token that is a known city is a place ("San Francisco, New York, Austin")
  const out = [];
  for (const t of tokens) {
    const hit = resolveBare(t);
    if (hit) out.push(hit);
  }
  return out;
}

/** Trim junk words until the metro index or the ZIP dataset recognises the city.
 *  Returns { city, verified } — verified=false means "kept as a plausible name". */
function resolveCity(raw, state) {
  const rawTrim = String(raw).trim();
  // An all-caps short token ("PLS", "AOB", "UGA") is a code, not a city.
  if (/^[A-Z]{2,4}$/.test(rawTrim)) return null;
  const words = titleCase(rawTrim.replace(NOISE_RE, " ").replace(/\s+/g, " ").trim()).split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  // The state's own name is not a city ("OTHER TEXAS" → state only)
  if (stateName(words.join(" ")) || /^state$/i.test(words.join(" "))) return null;
  const tryName = (name) => {
    const key = name.toLowerCase();
    const key2 = expandAbbr(name).toLowerCase();
    if (CITY_INDEX.has(`${key} ${state}`) || CITY_INDEX.has(key) || CITY_INDEX.has(`${key2} ${state}`) || CITY_INDEX.has(key2)) return name;
    if (isRealCity(name, state)) return name;
    return null;
  };
  const full = words.join(" ");
  const direct = tryName(full);
  if (direct) return { city: direct, verified: true };
  for (let n = words.length - 1; n >= 1; n--) { const c = tryName(words.slice(0, n).join(" ")); if (c) return { city: c, verified: true }; }
  for (let i = 1; i < words.length; i++) { const c = tryName(words.slice(i).join(" ")); if (c) return { city: c, verified: true }; }
  // Unknown to both: keep it as a plausible name, minus trailing junk ("Coon Rapids New", "Madison East")
  const trimmed = [...words];
  while (trimmed.length > 1 && /^(new|old|main|east|west|north|south|retail|fleet|plus|sto|home|office|state|ii|iii)$/i.test(trimmed[trimmed.length - 1])) trimmed.pop();
  const name = trimmed.join(" ");
  return trimmed.length <= 4 && /^[A-Za-z .'\u2011-]+$/.test(name) && !/^(in|or|at|of|the|and|first|based|home|office|state|of)$/i.test(name)
    ? { city: name, verified: false }
    : null;
}

/** A token with no state: match the metro index, trimming junk words. */
function resolveBare(tok) {
  const words = String(tok).toLowerCase().split(/\s+/).filter(Boolean);
  for (let n = words.length; n >= 1; n--) {
    const key = words.slice(0, n).join(" ");
    if (CITY_INDEX.has(key)) return { city: titleCase(key), state: CITY_INDEX.get(key).state };
  }
  for (let i = 1; i < words.length; i++) {
    const key = words.slice(i).join(" ");
    if (CITY_INDEX.has(key)) return { city: titleCase(key), state: CITY_INDEX.get(key).state };
  }
  return null;
}

function metroFor(city, state) {
  if (!city) return null;
  for (const c of [city.toLowerCase(), expandAbbr(city).toLowerCase()]) {
    const hit = (state && CITY_INDEX.get(`${c} ${state}`)) || CITY_INDEX.get(c);
    if (hit) return hit;
  }
  return null;
}
function withZip(display, zip) {
  return zip ? `${display} ${zip}` : display;
}

/**
 * @param job  { locationName, isRemote, workplaceType }
 * @returns { display, displayWithZip, zip, city, state, tier, reason, candidates }
 */
function chooseResumeLocation(job) {
  const text = String(job?.locationName || "");
  const candidates = [];
  for (const seg of splitSegments(text)) {
    const noRemote = seg.replace(REMOTE_RE, " ").replace(/\s+/g, " ").trim();
    if (!noRemote || !/[A-Za-z]{2,}/.test(noRemote)) continue; // pure "Remote" / "Remote - US"
    for (const parsed of parseSegment(noRemote)) {
      const metro = metroFor(parsed.city, parsed.state);
      if (metro) {
        candidates.push({ display: metro.display, zip: metro.zip, city: metro.display.split(",")[0], state: metro.state, tier: metro.tier, rank: METROS.indexOf(metro), from: seg });
      } else if (parsed.city && parsed.state) {
        candidates.push({ display: `${parsed.city}, ${parsed.state}`, zip: null, city: parsed.city, state: parsed.state, tier: 4, rank: 999, from: seg });
      } else if (!parsed.city && parsed.state && STATE_DEFAULT.has(parsed.state)) {
        const sm = STATE_DEFAULT.get(parsed.state);
        candidates.push({ display: sm.display, zip: sm.zip, city: sm.display.split(",")[0], state: sm.state, tier: sm.tier + 0.5, rank: METROS.indexOf(sm), from: seg });
      }
    }
  }

  if (candidates.length === 0) {
    const remote = REMOTE_RE.test(text) || job?.isRemote === true || /remote/i.test(job?.workplaceType || "");
    return { ...DEFAULT, displayWithZip: withZip(DEFAULT.display, DEFAULT.zip), reason: remote ? "remote → default" : (text ? "no US city parsed → default" : "no location → default"), candidates: [] };
  }
  candidates.sort((a, b) => a.tier - b.tier || a.rank - b.rank);
  const best = candidates[0];
  const distinct = [...new Set(candidates.map((c) => c.display))];
  const zip = best.zip || zipFor(best.city, best.state);
  return {
    display: best.display,
    zip,
    displayWithZip: withZip(best.display, zip),
    city: best.city,
    state: best.state,
    tier: Math.floor(best.tier),
    reason: distinct.length > 1 ? `best of ${distinct.length} listed locations` : (best.tier === 4 ? "single unlisted city, used as-is" : best.tier % 1 ? "state only → its main metro" : "single listed city"),
    candidates: distinct,
  };
}

module.exports = { chooseResumeLocation, parseSegment, splitSegments, METROS, DEFAULT };
