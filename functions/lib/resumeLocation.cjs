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
 * Only city + state are produced — never a street address or ZIP.
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
  { tier: 1, display: "San Francisco, CA", state: "CA", cities: ["san francisco", "sf", "bay area", "san francisco bay area", "sf bay area", "south san francisco", "oakland", "berkeley", "emeryville", "fremont", "redwood city", "menlo park", "palo alto", "san mateo", "foster city", "burlingame", "san bruno", "daly city", "brisbane", "alameda", "san rafael", "walnut creek", "pleasanton", "san ramon", "dublin", "hayward", "union city", "newark"] },
  { tier: 1, display: "New York, NY", state: "NY", cities: ["new york", "new york city", "nyc", "new york new york", "manhattan", "brooklyn", "queens", "bronx", "jersey city", "hoboken", "newark nj", "long island city", "white plains", "stamford"] },
  { tier: 1, display: "Seattle, WA", state: "WA", cities: ["seattle", "bellevue", "redmond", "kirkland", "bothell", "renton", "issaquah", "tacoma"] },
  { tier: 1, display: "San Jose, CA", state: "CA", cities: ["san jose", "sunnyvale", "santa clara", "mountain view", "cupertino", "milpitas", "los gatos", "campbell", "los altos", "saratoga", "morgan hill"] },
  { tier: 1, display: "Los Angeles, CA", state: "CA", cities: ["los angeles", "la", "santa monica", "culver city", "venice", "el segundo", "playa vista", "burbank", "glendale ca", "pasadena", "torrance", "long beach", "manhattan beach", "marina del rey", "hawthorne"] },
  // ── Tier 2 ──
  { tier: 2, display: "Boston, MA", state: "MA", cities: ["boston", "cambridge", "somerville", "waltham", "burlington ma", "lexington", "bedford ma", "woburn", "quincy", "newton", "needham", "watertown", "andover", "billerica", "westford", "marlborough", "framingham"] },
  { tier: 2, display: "Austin, TX", state: "TX", cities: ["austin", "round rock", "cedar park", "pflugerville"] },
  { tier: 2, display: "Chicago, IL", state: "IL", cities: ["chicago", "naperville", "schaumburg", "evanston", "oak brook", "deerfield", "vernon hills", "lisle", "rosemont"] },
  { tier: 2, display: "Washington, DC", state: "DC", cities: ["washington", "washington dc", "washington d.c.", "arlington", "reston", "mclean", "tysons", "herndon", "chantilly", "alexandria", "fairfax", "vienna va", "sterling", "dulles", "bethesda", "rockville", "silver spring", "gaithersburg", "germantown", "columbia md", "annapolis junction", "fort meade", "springfield va", "falls church"] },
  { tier: 2, display: "Denver, CO", state: "CO", cities: ["denver", "boulder", "broomfield", "louisville co", "englewood", "aurora co", "westminster co", "littleton", "golden", "centennial", "lakewood co", "fort collins", "colorado springs"] },
  { tier: 2, display: "San Diego, CA", state: "CA", cities: ["san diego", "la jolla", "carlsbad", "sorrento valley", "carmel valley", "chula vista"] },
  { tier: 2, display: "Atlanta, GA", state: "GA", cities: ["atlanta", "alpharetta", "sandy springs", "marietta", "roswell", "duluth ga", "kennesaw"] },
  { tier: 2, display: "Dallas, TX", state: "TX", cities: ["dallas", "plano", "irving", "richardson", "mckinney", "frisco", "fort worth", "addison", "westlake tx", "southlake", "coppell", "allen"] },
  { tier: 2, display: "Raleigh, NC", state: "NC", cities: ["raleigh", "durham", "cary", "morrisville", "research triangle park", "rtp", "chapel hill"] },
  { tier: 2, display: "Portland, OR", state: "OR", cities: ["portland", "beaverton", "hillsboro", "lake oswego", "tigard", "wilsonville"] },
  { tier: 2, display: "Irvine, CA", state: "CA", cities: ["irvine", "orange county", "newport beach", "costa mesa", "anaheim", "santa ana", "aliso viejo", "lake forest", "tustin"] },
  // ── Tier 3 ──
  { tier: 3, display: "Phoenix, AZ", state: "AZ", cities: ["phoenix", "tempe", "scottsdale", "chandler", "mesa", "gilbert", "glendale az"] },
  { tier: 3, display: "Salt Lake City, UT", state: "UT", cities: ["salt lake city", "lehi", "draper", "provo", "sandy", "south jordan", "orem", "american fork"] },
  { tier: 3, display: "Minneapolis, MN", state: "MN", cities: ["minneapolis", "st. paul", "st paul", "saint paul", "eden prairie", "bloomington mn", "plymouth mn", "minnetonka", "eagan"] },
  { tier: 3, display: "Philadelphia, PA", state: "PA", cities: ["philadelphia", "king of prussia", "malvern", "conshohocken", "wayne pa", "radnor", "blue bell", "wilmington", "cherry hill", "mount laurel"] },
  { tier: 3, display: "Miami, FL", state: "FL", cities: ["miami", "fort lauderdale", "boca raton", "coral gables", "doral", "west palm beach", "sunrise fl"] },
  { tier: 3, display: "Houston, TX", state: "TX", cities: ["houston", "the woodlands", "sugar land", "katy", "spring tx"] },
  { tier: 3, display: "Pittsburgh, PA", state: "PA", cities: ["pittsburgh", "cranberry township"] },
  { tier: 3, display: "Detroit, MI", state: "MI", cities: ["detroit", "ann arbor", "dearborn", "troy mi", "auburn hills", "southfield", "warren mi", "farmington hills", "novi"] },
  { tier: 3, display: "Columbus, OH", state: "OH", cities: ["columbus", "dublin oh", "westerville", "new albany"] },
  { tier: 3, display: "Nashville, TN", state: "TN", cities: ["nashville", "franklin tn", "brentwood tn"] },
  { tier: 3, display: "Charlotte, NC", state: "NC", cities: ["charlotte", "fort mill", "huntersville"] },
  { tier: 3, display: "Kansas City, MO", state: "MO", cities: ["kansas city", "overland park", "olathe", "leawood", "lenexa"] },
  { tier: 3, display: "St. Louis, MO", state: "MO", cities: ["st. louis", "st louis", "saint louis", "chesterfield", "clayton mo", "o'fallon"] },
  { tier: 3, display: "Baltimore, MD", state: "MD", cities: ["baltimore", "towson", "hanover md", "linthicum"] },
  { tier: 3, display: "Orlando, FL", state: "FL", cities: ["orlando", "lake mary", "maitland"] },
  { tier: 3, display: "Tampa, FL", state: "FL", cities: ["tampa", "st. petersburg", "st petersburg", "clearwater"] },
  { tier: 3, display: "Sacramento, CA", state: "CA", cities: ["sacramento", "folsom", "roseville", "rancho cordova"] },
  { tier: 3, display: "Las Vegas, NV", state: "NV", cities: ["las vegas", "henderson", "reno"] },
  { tier: 3, display: "Madison, WI", state: "WI", cities: ["madison"] },
  { tier: 3, display: "Milwaukee, WI", state: "WI", cities: ["milwaukee", "brookfield wi", "waukesha"] },
  { tier: 3, display: "Indianapolis, IN", state: "IN", cities: ["indianapolis", "carmel in", "fishers"] },
  { tier: 3, display: "Cincinnati, OH", state: "OH", cities: ["cincinnati", "mason oh", "blue ash"] },
  { tier: 3, display: "Cleveland, OH", state: "OH", cities: ["cleveland", "mayfield heights", "beachwood", "akron"] },
  { tier: 3, display: "Richmond, VA", state: "VA", cities: ["richmond", "glen allen", "henrico"] },
  { tier: 3, display: "Hartford, CT", state: "CT", cities: ["hartford", "windsor", "bloomfield ct", "farmington ct", "new haven", "north haven"] },
  { tier: 3, display: "Albany, NY", state: "NY", cities: ["albany", "malta", "troy ny", "schenectady"] },
  { tier: 3, display: "Huntsville, AL", state: "AL", cities: ["huntsville"] },
  { tier: 3, display: "Tucson, AZ", state: "AZ", cities: ["tucson"] },
  { tier: 3, display: "Omaha, NE", state: "NE", cities: ["omaha"] },
  { tier: 3, display: "Louisville, KY", state: "KY", cities: ["louisville"] },
  { tier: 3, display: "Jacksonville, FL", state: "FL", cities: ["jacksonville"] },
  { tier: 3, display: "Boise, ID", state: "ID", cities: ["boise"] },
  { tier: 3, display: "Albuquerque, NM", state: "NM", cities: ["albuquerque"] },
  { tier: 3, display: "Oklahoma City, OK", state: "OK", cities: ["oklahoma city", "tulsa"] },
  { tier: 3, display: "Rochester, NY", state: "NY", cities: ["rochester", "buffalo", "syracuse"] },
  { tier: 3, display: "Providence, RI", state: "RI", cities: ["providence", "warwick ri"] },
  { tier: 3, display: "Des Moines, IA", state: "IA", cities: ["des moines", "west des moines"] },
  { tier: 3, display: "Charleston, SC", state: "SC", cities: ["charleston", "greenville sc", "columbia sc"] },
  { tier: 3, display: "San Antonio, TX", state: "TX", cities: ["san antonio"] },
  { tier: 3, display: "New Orleans, LA", state: "LA", cities: ["new orleans", "baton rouge"] },
];

const DEFAULT = { display: "San Francisco, CA", city: "San Francisco", state: "CA", tier: 1 };

const CITY_INDEX = new Map(); // "city" or "city st" → metro
for (const m of METROS) {
  for (const c of m.cities) {
    // "glendale ca" style entries carry a state to disambiguate
    const parts = c.split(" ");
    const last = parts[parts.length - 1].toUpperCase();
    if (parts.length > 1 && STATE_CODES.has(last)) CITY_INDEX.set(`${parts.slice(0, -1).join(" ")} ${last}`, m);
    else CITY_INDEX.set(c, m);
  }
}

const REMOTE_RE = /\b(remote|work from home|wfh|telecommute|virtual|home[- ]?based|offsite\/home|anywhere|field worker)\b/i;
const NOISE_RE = /\b(hybrid|onsite|on-site|in-office|office|campus|hq|headquarters|home office|corporate|store\s*\d+|bldg|building|suite|ste|floor|fl\.|usa?|u\.s\.a?\.?|united states( of america)?|amer|americas|north america|greater|metro(?:plex|politan)? area|metro(?:plex|politan)?|any city|multiple locations|hub|home)\b/gi;

function titleCase(s) {
  // Drop anything that reads like a street ("Plano Legacy Drive" → "Plano").
  const noStreet = String(s).replace(/\s+\S+\s+(drive|dr|street|st|avenue|ave|road|rd|blvd|boulevard|lane|ln|way|pkwy|parkway|hwy|highway|plaza|court|ct)\b.*$/i, "");
  return noStreet.toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase()).replace(/\bDc\b/, "DC");
}

function stateCode(tok) {
  const t = String(tok || "").trim().replace(/\./g, "");
  return /^[A-Za-z]{2}$/.test(t) && STATE_CODES.has(t.toUpperCase()) ? t.toUpperCase() : null;
}
function stateName(tok) {
  return STATES[String(tok || "").trim().toLowerCase()] || null;
}
const isCityToken = (t) => /[A-Za-z]/.test(t) && !/\d{3,}/.test(t);

// The most important metro in a state, for state-only postings ("Colorado, United States").
const STATE_DEFAULT = new Map();
for (const m of METROS) if (!STATE_DEFAULT.has(m.state)) STATE_DEFAULT.set(m.state, m);

/**
 * Parse one location segment into [{ city, state }] (either may be null).
 * Handles: "City, ST", "City, State[, United States]", "United States-State-City",
 * "AMER - United States - State - City", "State - City", "ST-City",
 * "US-ST-CITY-…", "Hybrid- City, ST", "City ST" (no comma), "ST City <street>",
 * street addresses "…, City, ST 12345", comma lists of bare cities
 * ("San Francisco, New York City, Austin"), and a bare known city.
 */
function parseSegment(seg) {
  let s = String(seg || "")
    .replace(/\(.*?\)/g, " ")
    .replace(/~.*$/, " ")
    .replace(/\s*[>:]\s*/g, " - ")                // "US > Arizona > Phoenix", "Madison : 1 Exact Lane"
    .replace(/\b(?:san francisco |sf )?bay area\b/gi, "San Francisco") // "Bay Area, CA", "SF Bay Area"
    .replace(/\bgreater\s+([A-Za-z .]+?)\s+area\b/gi, "$1")          // "Greater Chicago Area"
    .trim();
  if (!s) return [];

  // "US-AZ-TUCSON-M13" / "USA-CA-SAN JOSE" / "USA.VA.Reston" / "US-VA Richmond" / "USA-TX Plano Legacy Drive Suite 700"
  let m = s.match(/^U\.?S\.?A?[-.]([A-Z]{2})[-.\s]+([A-Za-z][A-Za-z .'-]*?)(?:\s+\d.*|-.*)?$/i);
  if (m && stateCode(m[1])) {
    const city = m[2].replace(NOISE_RE, " ").trim();
    if (city && !stateName(city)) return [{ city: titleCase(city), state: stateCode(m[1]) }];
  }

  // "WA Bellevue 205 108th Avenue NE" / "US MN Minneapolis Office"
  const noUs = s.replace(/^U\.?S\.?A?\s+/i, "");
  m = noUs.match(/^([A-Z]{2})\s+([A-Za-z][A-Za-z .'-]*?)(?:\s+\d.*)?$/);
  if (m && stateCode(m[1]) && !stateName(m[2])) {
    const city = m[2].replace(NOISE_RE, " ").trim();
    if (city) return [{ city: titleCase(city), state: stateCode(m[1]) }];
  }

  const cleaned = s.replace(NOISE_RE, " ").replace(/\s+/g, " ").replace(/\s+,/g, ",").trim();
  let tokens = cleaned.split(/\s*[,\-–—/]\s*/).map((t) => t.trim()).filter(Boolean);
  // "Seattle WA" / "Oak Creek WI" / "Chicago Illinois" — city and state without a comma
  tokens = tokens.flatMap((t) => {
    const mm = t.match(/^(.+?)\s+([A-Za-z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/);
    if (mm && stateCode(mm[2]) && !stateCode(mm[1])) return [mm[1], mm[2]];
    const lower = t.toLowerCase();
    for (const name of STATE_NAMES_BY_LENGTH) {
      if (lower.endsWith(" " + name) && lower.length > name.length + 1) return [t.slice(0, t.length - name.length - 1), t.slice(t.length - name.length)];
    }
    return [t.replace(/\s+\d{5}(?:-\d{4})?$/, "")];
  });
  if (tokens.length === 0) return [];

  // Pick the state token: a 2-letter code wins; otherwise the LAST state-name
  // token (so "New York, New York" reads city then state).
  let si = tokens.findIndex((t) => stateCode(t));
  let st = si !== -1 ? stateCode(tokens[si]) : null;
  if (si === -1) {
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (stateName(tokens[i])) { si = i; st = stateName(tokens[i]); break; }
    }
  }

  if (si !== -1) {
    let city = null;
    for (let j = si - 1; j >= 0; j--) if (isCityToken(tokens[j])) { city = tokens[j]; break; }
    if (!city) for (let j = si + 1; j < tokens.length; j++) if (isCityToken(tokens[j]) && !stateCode(tokens[j]) && !stateName(tokens[j])) { city = tokens[j]; break; }
    if (city) return [{ city: titleCase(city), state: st }];
    // Only a state name — but "New York"/"Washington" alone mean the city.
    const bare = tokens[si].toLowerCase();
    if (CITY_INDEX.has(bare)) return [{ city: titleCase(bare), state: CITY_INDEX.get(bare).state }];
    return [{ city: null, state: st }];
  }

  // No state at all: every token that is a known city is a candidate
  // ("San Francisco, New York City, Austin"; "Dallas-Fort Worth").
  const out = [];
  for (const t of tokens) {
    const bare = t.toLowerCase();
    if (CITY_INDEX.has(bare)) out.push({ city: titleCase(bare), state: CITY_INDEX.get(bare).state });
  }
  if (out.length) return out;
  const whole = cleaned.toLowerCase();
  if (CITY_INDEX.has(whole)) return [{ city: titleCase(whole), state: CITY_INDEX.get(whole).state }];
  return [];
}

function metroFor(city, state) {
  if (!city) return null;
  const c = city.toLowerCase();
  return (state && CITY_INDEX.get(`${c} ${state}`)) || CITY_INDEX.get(c) || null;
}

/**
 * @param job  { locationName, isRemote, workplaceType }
 * @returns { display, city, state, tier, reason, candidates }
 */
function chooseResumeLocation(job) {
  const text = String(job?.locationName || "");
  const segments = text.split(/\s*[;|•·]\s*/).map((s) => s.trim()).filter(Boolean);

  const candidates = [];
  for (const seg of segments) {
    if (REMOTE_RE.test(seg) && !/[,\-]/.test(seg.replace(REMOTE_RE, ""))) continue; // pure remote segment
    for (const parsed of parseSegment(seg.replace(REMOTE_RE, " "))) {
      const metro = metroFor(parsed.city, parsed.state);
      if (metro) {
        candidates.push({ display: metro.display, city: metro.display.split(",")[0], state: metro.state, tier: metro.tier, rank: METROS.indexOf(metro), from: seg });
      } else if (parsed.city && parsed.state) {
        candidates.push({ display: `${parsed.city}, ${parsed.state}`, city: parsed.city, state: parsed.state, tier: 4, rank: 999, from: seg });
      } else if (!parsed.city && parsed.state && STATE_DEFAULT.has(parsed.state)) {
        const sm = STATE_DEFAULT.get(parsed.state); // state-only posting → its main metro
        candidates.push({ display: sm.display, city: sm.display.split(",")[0], state: sm.state, tier: sm.tier + 0.5, rank: METROS.indexOf(sm), from: seg });
      }
    }
  }

  if (candidates.length === 0) {
    const remote = REMOTE_RE.test(text) || job?.isRemote === true || /remote/i.test(job?.workplaceType || "");
    return { ...DEFAULT, reason: remote ? "remote → default" : (text ? "no US city parsed → default" : "no location → default"), candidates: [] };
  }
  candidates.sort((a, b) => a.tier - b.tier || a.rank - b.rank);
  const best = candidates[0];
  const distinct = [...new Set(candidates.map((c) => c.display))];
  return {
    display: best.display,
    city: best.city,
    state: best.state,
    tier: Math.floor(best.tier),
    reason: distinct.length > 1 ? `best of ${distinct.length} listed locations` : (best.tier === 4 ? "single unlisted city, used as-is" : best.tier % 1 ? "state only → its main metro" : "single listed city"),
    candidates: distinct,
  };
}

module.exports = { chooseResumeLocation, parseSegment, METROS, DEFAULT };
