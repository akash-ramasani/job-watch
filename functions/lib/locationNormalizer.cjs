/**
 * functions/lib/locationNormalizer.cjs
 * 
 * Normalizes raw locationName strings from any source (greenhouse, ashby, eightfold)
 * into a canonical { city, state, lat, lng } object for map display.
 * 
 * Returns null for remote-only / vague / unresolvable locations.
 */

// ──────────────────────────────────────────────────────
// US City Coordinates Lookup
// ──────────────────────────────────────────────────────
const CITY_COORDS = {
  // Major metros
  "san francisco": { state: "CA", lat: 37.7749, lng: -122.4194 },
  "new york": { state: "NY", lat: 40.7128, lng: -74.0060 },
  "new york city": { state: "NY", lat: 40.7128, lng: -74.0060 },
  "nyc": { state: "NY", lat: 40.7128, lng: -74.0060 },
  "manhattan": { state: "NY", lat: 40.7831, lng: -73.9712 },
  "brooklyn": { state: "NY", lat: 40.6782, lng: -73.9442 },
  "seattle": { state: "WA", lat: 47.6062, lng: -122.3321 },
  "austin": { state: "TX", lat: 30.2672, lng: -97.7431 },
  "chicago": { state: "IL", lat: 41.8781, lng: -87.6298 },
  "boston": { state: "MA", lat: 42.3601, lng: -71.0589 },
  "los angeles": { state: "CA", lat: 34.0522, lng: -118.2437 },
  "denver": { state: "CO", lat: 39.7392, lng: -104.9903 },
  "atlanta": { state: "GA", lat: 33.7490, lng: -84.3880 },
  "miami": { state: "FL", lat: 25.7617, lng: -80.1918 },
  "dallas": { state: "TX", lat: 32.7767, lng: -96.7970 },
  "houston": { state: "TX", lat: 29.7604, lng: -95.3698 },
  "san jose": { state: "CA", lat: 37.3382, lng: -121.8863 },
  "san diego": { state: "CA", lat: 32.7157, lng: -117.1611 },
  "phoenix": { state: "AZ", lat: 33.4484, lng: -112.0740 },
  "portland": { state: "OR", lat: 45.5155, lng: -122.6789 },
  "nashville": { state: "TN", lat: 36.1627, lng: -86.7816 },
  "washington": { state: "DC", lat: 38.9072, lng: -77.0369 },
  "washington dc": { state: "DC", lat: 38.9072, lng: -77.0369 },
  "washington d.c.": { state: "DC", lat: 38.9072, lng: -77.0369 },
  "dc": { state: "DC", lat: 38.9072, lng: -77.0369 },
  "dc metro": { state: "DC", lat: 38.9072, lng: -77.0369 },
  "sf": { state: "CA", lat: 37.7749, lng: -122.4194 },
  "ny": { state: "NY", lat: 40.7128, lng: -74.0060 },

  // California
  "costa mesa": { state: "CA", lat: 33.6412, lng: -117.9187 },
  "irvine": { state: "CA", lat: 33.6846, lng: -117.8265 },
  "palo alto": { state: "CA", lat: 37.4419, lng: -122.1430 },
  "mountain view": { state: "CA", lat: 37.3861, lng: -122.0839 },
  "sunnyvale": { state: "CA", lat: 37.3688, lng: -122.0363 },
  "santa clara": { state: "CA", lat: 37.3541, lng: -121.9552 },
  "san mateo": { state: "CA", lat: 37.5630, lng: -122.3255 },
  "santa ana": { state: "CA", lat: 33.7455, lng: -117.8677 },
  "long beach": { state: "CA", lat: 33.7701, lng: -118.1937 },
  "sacramento": { state: "CA", lat: 38.5816, lng: -121.4944 },
  "bay area": { state: "CA", lat: 37.5585, lng: -122.2711 },
  "south san francisco": { state: "CA", lat: 37.6547, lng: -122.4077 },
  "menlo park": { state: "CA", lat: 37.4530, lng: -122.1817 },
  "foster city": { state: "CA", lat: 37.5585, lng: -122.2711 },
  "fremont": { state: "CA", lat: 37.5485, lng: -121.9886 },
  "oakland": { state: "CA", lat: 37.8044, lng: -122.2712 },
  "el segundo": { state: "CA", lat: 33.9192, lng: -118.4165 },
  "culver city": { state: "CA", lat: 34.0211, lng: -118.3965 },
  "santa monica": { state: "CA", lat: 34.0195, lng: -118.4912 },
  "burbank": { state: "CA", lat: 34.1808, lng: -118.3090 },
  "pasadena": { state: "CA", lat: 34.1478, lng: -118.1445 },
  "los gatos": { state: "CA", lat: 37.2358, lng: -121.9624 },
  "san ramon": { state: "CA", lat: 37.7799, lng: -121.9780 },
  "pleasanton": { state: "CA", lat: 37.6624, lng: -121.8747 },
  "dublin": { state: "CA", lat: 37.7022, lng: -121.9358 },
  "livermore": { state: "CA", lat: 37.6819, lng: -121.7680 },
  "burlingame": { state: "CA", lat: 37.5841, lng: -122.3660 },
  "redwood city": { state: "CA", lat: 37.4852, lng: -122.2364 },
  "hawthorne": { state: "CA", lat: 33.9164, lng: -118.3526 },
  "victorville": { state: "CA", lat: 34.5362, lng: -117.2928 },
  "san clemente": { state: "CA", lat: 33.4270, lng: -117.6120 },
  "east palo alto": { state: "CA", lat: 37.4689, lng: -122.1411 },
  "fresno": { state: "CA", lat: 36.7378, lng: -119.7871 },
  "hayward": { state: "CA", lat: 37.6688, lng: -122.0808 },
  "berkeley": { state: "CA", lat: 37.8716, lng: -122.2727 },
  "los alamitos": { state: "CA", lat: 33.8031, lng: -118.0726 },
  "stockton": { state: "CA", lat: 37.9577, lng: -121.2908 },
  "redding": { state: "CA", lat: 40.5865, lng: -122.3917 },
  "newport beach": { state: "CA", lat: 33.6189, lng: -117.9289 },
  "compton": { state: "CA", lat: 33.8958, lng: -118.2201 },
  "roseville": { state: "CA", lat: 38.7521, lng: -121.2880 },
  "bay point": { state: "CA", lat: 38.0291, lng: -121.9614 },
  "petaluma": { state: "CA", lat: 38.2324, lng: -122.6367 },

  // Washington
  "redmond": { state: "WA", lat: 47.6740, lng: -122.1215 },
  "bellevue": { state: "WA", lat: 47.6101, lng: -122.2015 },
  "spokane": { state: "WA", lat: 47.6588, lng: -117.4260 },
  "tacoma": { state: "WA", lat: 47.2529, lng: -122.4443 },
  "kirkland": { state: "WA", lat: 47.6815, lng: -122.2087 },
  "north bend": { state: "WA", lat: 47.4957, lng: -121.7868 },

  // Virginia
  "reston": { state: "VA", lat: 38.9586, lng: -77.3570 },
  "richmond": { state: "VA", lat: 37.5407, lng: -77.4360 },
  "arlington": { state: "VA", lat: 38.8799, lng: -77.1068 },
  "tysons": { state: "VA", lat: 38.9187, lng: -77.2311 },
  "herndon": { state: "VA", lat: 38.9696, lng: -77.3861 },
  "mclean": { state: "VA", lat: 38.9339, lng: -77.1773 },
  "norfolk": { state: "VA", lat: 36.8508, lng: -76.2859 },
  "virginia beach": { state: "VA", lat: 36.8529, lng: -75.9780 },
  "boydton": { state: "VA", lat: 36.6677, lng: -78.3875 },
  "alexandria": { state: "VA", lat: 38.8048, lng: -77.0469 },
  "woodbridge": { state: "VA", lat: 38.6582, lng: -77.2497 },

  // Texas
  "san antonio": { state: "TX", lat: 29.4241, lng: -98.4936 },
  "plano": { state: "TX", lat: 33.0198, lng: -96.6989 },
  "fort worth": { state: "TX", lat: 32.7555, lng: -97.3308 },
  "el paso": { state: "TX", lat: 31.7619, lng: -106.4850 },
  "garland": { state: "TX", lat: 32.9126, lng: -96.6389 },
  "carrollton": { state: "TX", lat: 32.9537, lng: -96.8903 },
  "westlake": { state: "TX", lat: 32.9915, lng: -97.1964 },
  "bastrop": { state: "TX", lat: 30.1105, lng: -97.3153 },
  "dallas-fort worth": { state: "TX", lat: 32.8998, lng: -97.0403 },
  "san marcos": { state: "TX", lat: 29.8833, lng: -97.9414 },
  "spring": { state: "TX", lat: 30.0799, lng: -95.4172 },
  "denton": { state: "TX", lat: 33.2148, lng: -97.1331 },
  "coppell": { state: "TX", lat: 32.9546, lng: -97.0150 },
  "lewisville": { state: "TX", lat: 33.0462, lng: -96.9942 },
  "afton": { state: "TX", lat: 33.7687, lng: -100.8126 },
  "texarkana": { state: "AR", lat: 33.4418, lng: -94.0477 },

  // Tennessee
  "memphis": { state: "TN", lat: 35.1495, lng: -90.0490 },
  "brentwood": { state: "TN", lat: 36.0331, lng: -86.7828 },
  "chattanooga": { state: "TN", lat: 35.0456, lng: -85.3097 },
  "knoxville": { state: "TN", lat: 35.9606, lng: -83.9207 },

  // New York
  "long island city": { state: "NY", lat: 40.7447, lng: -73.9485 },
  "long island": { state: "NY", lat: 40.7891, lng: -73.1350 },
  "white plains": { state: "NY", lat: 41.0340, lng: -73.7629 },
  "rochester": { state: "NY", lat: 43.1566, lng: -77.6088 },
  "albany": { state: "NY", lat: 42.6526, lng: -73.7562 },
  "buffalo": { state: "NY", lat: 42.8864, lng: -78.8784 },
  "syracuse": { state: "NY", lat: 43.0481, lng: -76.1474 },
  "rego park": { state: "NY", lat: 40.7264, lng: -73.8627 },
  "west babylon": { state: "NY", lat: 40.7176, lng: -73.3551 },
  "watertown": { state: "NY", lat: 43.9748, lng: -75.9108 },
  "brookhaven": { state: "NY", lat: 40.7793, lng: -72.9154 },
  "new hyde park": { state: "NY", lat: 40.7351, lng: -73.6879 },
  "east meadow": { state: "NY", lat: 40.7140, lng: -73.5590 },
  "hempstead": { state: "NY", lat: 40.7062, lng: -73.6187 },

  // Massachusetts
  "lexington": { state: "MA", lat: 42.4473, lng: -71.2245 },
  "quincy": { state: "MA", lat: 42.2529, lng: -71.0023 },
  "waltham": { state: "MA", lat: 42.3765, lng: -71.2356 },
  "cambridge": { state: "MA", lat: 42.3736, lng: -71.1097 },
  "somerville": { state: "MA", lat: 42.3876, lng: -71.0995 },
  "woburn": { state: "MA", lat: 42.4793, lng: -71.1523 },
  "burlington": { state: "MA", lat: 42.5048, lng: -71.1956 },
  "springfield": { state: "MA", lat: 42.1015, lng: -72.5898 },
  "needham": { state: "MA", lat: 42.2843, lng: -71.2328 },
  "bedford": { state: "MA", lat: 42.4906, lng: -71.2760 },

  // New Jersey
  "newark": { state: "NJ", lat: 40.7357, lng: -74.1724 },
  "hoboken": { state: "NJ", lat: 40.7440, lng: -74.0324 },
  "livingston": { state: "NJ", lat: 40.7921, lng: -74.3150 },
  "jersey city": { state: "NJ", lat: 40.7178, lng: -74.0431 },
  "new brunswick": { state: "NJ", lat: 40.4862, lng: -74.4518 },
  "red bank": { state: "NJ", lat: 40.3471, lng: -74.0643 },
  "kenilworth": { state: "NJ", lat: 40.6765, lng: -74.2910 },
  "elizabeth": { state: "NJ", lat: 40.6640, lng: -74.2107 },
  "cherry hill": { state: "NJ", lat: 39.9348, lng: -75.0307 },
  "turnersville": { state: "NJ", lat: 39.7743, lng: -75.0535 },
  "hackettstown": { state: "NJ", lat: 40.8529, lng: -74.8288 },
  "edison": { state: "NJ", lat: 40.5187, lng: -74.4121 },
  "lakewood": { state: "NJ", lat: 40.0979, lng: -74.2177 },

  // Connecticut
  "stamford": { state: "CT", lat: 41.0534, lng: -73.5387 },
  "new haven": { state: "CT", lat: 41.3083, lng: -72.9279 },
  "norwalk": { state: "CT", lat: 41.1177, lng: -73.4082 },
  "wallingford": { state: "CT", lat: 41.4570, lng: -72.8232 },
  "monroe": { state: "CT", lat: 41.3326, lng: -73.2065 },
  "cheshire": { state: "CT", lat: 41.4990, lng: -72.9007 },
  "naugatuck": { state: "CT", lat: 41.4890, lng: -73.0507 },
  "southington": { state: "CT", lat: 41.5959, lng: -72.8782 },
  "watertown": { state: "CT", lat: 41.6062, lng: -73.1182 },
  "hartford": { state: "CT", lat: 41.7658, lng: -72.6734 },

  // Colorado
  "boulder": { state: "CO", lat: 40.0150, lng: -105.2705 },
  "broomfield": { state: "CO", lat: 39.9205, lng: -105.0867 },
  "fort collins": { state: "CO", lat: 40.5853, lng: -105.0844 },
  "arvada": { state: "CO", lat: 39.8028, lng: -105.0875 },
  "colorado springs": { state: "CO", lat: 38.8339, lng: -104.8214 },
  "brighton": { state: "CO", lat: 39.9853, lng: -104.8206 },
  "aurora": { state: "CO", lat: 39.7294, lng: -104.8319 },

  // Arizona
  "tempe": { state: "AZ", lat: 33.4255, lng: -111.9400 },
  "scottsdale": { state: "AZ", lat: 33.4942, lng: -111.9261 },
  "tucson": { state: "AZ", lat: 32.2226, lng: -110.9747 },
  "mesa": { state: "AZ", lat: 33.4152, lng: -111.8315 },
  "chandler": { state: "AZ", lat: 33.3062, lng: -111.8413 },
  "peoria": { state: "AZ", lat: 33.5806, lng: -112.2374 },
  "kingman": { state: "AZ", lat: 35.1894, lng: -114.0530 },

  // Florida
  "orlando": { state: "FL", lat: 28.5383, lng: -81.3792 },
  "tampa": { state: "FL", lat: 27.9506, lng: -82.4572 },
  "jacksonville": { state: "FL", lat: 30.3322, lng: -81.6557 },
  "pensacola": { state: "FL", lat: 30.4213, lng: -87.2169 },
  "west palm beach": { state: "FL", lat: 26.7153, lng: -80.0534 },
  "sarasota": { state: "FL", lat: 27.3364, lng: -82.5307 },
  "naples": { state: "FL", lat: 26.1420, lng: -81.7948 },
  "st. petersburg": { state: "FL", lat: 27.7676, lng: -82.6403 },
  "saint petersburg": { state: "FL", lat: 27.7676, lng: -82.6403 },
  "vero beach": { state: "FL", lat: 27.6386, lng: -80.3973 },
  "jupiter": { state: "FL", lat: 26.9342, lng: -80.0942 },
  "ocala": { state: "FL", lat: 29.1872, lng: -82.1401 },

  // Georgia
  "savannah": { state: "GA", lat: 32.0809, lng: -81.0912 },
  "morrow": { state: "GA", lat: 33.5832, lng: -84.3385 },
  "decatur": { state: "GA", lat: 33.7748, lng: -84.2963 },
  "marietta": { state: "GA", lat: 33.9526, lng: -84.5499 },
  "roswell": { state: "GA", lat: 34.0232, lng: -84.3616 },
  "johns creek": { state: "GA", lat: 34.0289, lng: -84.1986 },

  // North Carolina
  "cary": { state: "NC", lat: 35.7915, lng: -78.7811 },
  "morrisville": { state: "NC", lat: 35.8235, lng: -78.8256 },
  "durham": { state: "NC", lat: 35.9940, lng: -78.8986 },
  "raleigh": { state: "NC", lat: 35.7796, lng: -78.6382 },
  "charlotte": { state: "NC", lat: 35.2271, lng: -80.8431 },
  "salisbury": { state: "NC", lat: 35.6710, lng: -80.4743 },
  "fort bragg": { state: "NC", lat: 35.1390, lng: -79.0034 },

  // Ohio
  "columbus": { state: "OH", lat: 39.9612, lng: -82.9988 },
  "cincinnati": { state: "OH", lat: 39.1031, lng: -84.5120 },
  "cleveland": { state: "OH", lat: 41.4993, lng: -81.6944 },
  "ashville": { state: "OH", lat: 39.7176, lng: -82.9527 },
  "dayton": { state: "OH", lat: 39.7589, lng: -84.1916 },

  // Michigan
  "detroit": { state: "MI", lat: 42.3314, lng: -83.0458 },
  "ann arbor": { state: "MI", lat: 42.2808, lng: -83.7430 },
  "grand rapids": { state: "MI", lat: 42.9634, lng: -85.6681 },
  "sterling heights": { state: "MI", lat: 42.5803, lng: -83.0302 },
  "saint johns": { state: "MI", lat: 43.0011, lng: -84.5589 },

  // Pennsylvania
  "philadelphia": { state: "PA", lat: 39.9526, lng: -75.1652 },
  "pittsburgh": { state: "PA", lat: 40.4406, lng: -79.9959 },
  "harrisburg": { state: "PA", lat: 40.2732, lng: -76.8867 },
  "swissvale": { state: "PA", lat: 40.4234, lng: -79.8826 },
  "sharon hill": { state: "PA", lat: 39.9065, lng: -75.2710 },

  // Maryland
  "patuxent river": { state: "MD", lat: 38.2857, lng: -76.4280 },
  "gaithersburg": { state: "MD", lat: 39.1434, lng: -77.2014 },
  "silver spring": { state: "MD", lat: 38.9907, lng: -77.0261 },
  "columbia": { state: "MD", lat: 39.2037, lng: -76.8610 },
  "baltimore": { state: "MD", lat: 39.2904, lng: -76.6122 },
  "glen burnie": { state: "MD", lat: 39.1626, lng: -76.6247 },
  "lothian": { state: "MD", lat: 38.8215, lng: -76.6261 },

  // Illinois
  "rockford": { state: "IL", lat: 42.2711, lng: -89.0940 },
  "effingham": { state: "IL", lat: 39.1200, lng: -88.5434 },
  "carbondale": { state: "IL", lat: 37.7273, lng: -89.2168 },
  "edwardsville": { state: "IL", lat: 38.8114, lng: -89.9532 },
  "north aurora": { state: "IL", lat: 41.8064, lng: -88.3273 },
  "la grange": { state: "IL", lat: 41.8050, lng: -87.8690 },

  // Indiana
  "indianapolis": { state: "IN", lat: 39.7684, lng: -86.1581 },
  "lafayette": { state: "IN", lat: 40.4167, lng: -86.8753 },
  "south bend": { state: "IN", lat: 41.6764, lng: -86.2520 },
  "valparaiso": { state: "IN", lat: 41.4731, lng: -87.0611 },
  "batesville": { state: "IN", lat: 39.3000, lng: -85.2222 },

  // Missouri
  "kansas city": { state: "MO", lat: 39.0997, lng: -94.5786 },
  "st. louis": { state: "MO", lat: 38.6270, lng: -90.1994 },
  "saint louis": { state: "MO", lat: 38.6270, lng: -90.1994 },
  "florissant": { state: "MO", lat: 38.7892, lng: -90.3226 },
  "jefferson city": { state: "MO", lat: 38.5767, lng: -92.1735 },

  // Utah
  "salt lake city": { state: "UT", lat: 40.7608, lng: -111.8910 },
  "provo": { state: "UT", lat: 40.2338, lng: -111.6585 },
  "st. george": { state: "UT", lat: 37.0965, lng: -113.5684 },
  "draper": { state: "UT", lat: 40.5247, lng: -111.8638 },
  "lehi": { state: "UT", lat: 40.3916, lng: -111.8508 },
  "millcreek": { state: "UT", lat: 40.6869, lng: -111.8755 },
  "ogden": { state: "UT", lat: 41.2230, lng: -111.9738 },

  // Nevada
  "las vegas": { state: "NV", lat: 36.1699, lng: -115.1398 },
  "reno": { state: "NV", lat: 39.5296, lng: -119.8138 },
  "henderson": { state: "NV", lat: 36.0395, lng: -114.9817 },

  // Minnesota
  "minneapolis": { state: "MN", lat: 44.9778, lng: -93.2650 },
  "maple grove": { state: "MN", lat: 45.0725, lng: -93.4558 },
  "st. paul": { state: "MN", lat: 44.9537, lng: -93.0900 },

  // Oklahoma
  "oklahoma city": { state: "OK", lat: 35.4676, lng: -97.5164 },
  "tulsa": { state: "OK", lat: 36.1540, lng: -95.9928 },
  "muskogee": { state: "OK", lat: 35.7479, lng: -95.3694 },

  // South Carolina
  "charleston": { state: "SC", lat: 32.7765, lng: -79.9311 },
  "greenville": { state: "SC", lat: 34.8526, lng: -82.3940 },

  // Alabama
  "huntsville": { state: "AL", lat: 34.7304, lng: -86.5861 },
  "birmingham": { state: "AL", lat: 33.5207, lng: -86.8025 },
  "fairhope": { state: "AL", lat: 30.5230, lng: -87.9033 },

  // Louisiana
  "new orleans": { state: "LA", lat: 29.9511, lng: -90.0715 },
  "lake charles": { state: "LA", lat: 30.2266, lng: -93.2174 },
  "franklin": { state: "LA", lat: 29.7961, lng: -91.5015 },

  // Arkansas
  "fort smith": { state: "AR", lat: 35.3859, lng: -94.3985 },
  "jonesboro": { state: "AR", lat: 35.8423, lng: -90.7043 },

  // New Mexico
  "albuquerque": { state: "NM", lat: 35.0844, lng: -106.6504 },
  "santa fe": { state: "NM", lat: 35.6870, lng: -105.9378 },

  // Iowa
  "des moines": { state: "IA", lat: 41.5868, lng: -93.6250 },

  // Idaho
  "boise": { state: "ID", lat: 43.6150, lng: -116.2023 },
  "garden city": { state: "ID", lat: 43.6527, lng: -116.2816 },

  // Kentucky
  "louisville": { state: "KY", lat: 38.2527, lng: -85.7585 },

  // Kansas
  "wichita": { state: "KS", lat: 37.6872, lng: -97.3301 },
  "overland park": { state: "KS", lat: 38.9822, lng: -94.6708 },

  // Wisconsin
  "milwaukee": { state: "WI", lat: 43.0389, lng: -87.9065 },
  "madison": { state: "WI", lat: 43.0731, lng: -89.4012 },

  // Nebraska
  "omaha": { state: "NE", lat: 41.2565, lng: -95.9345 },

  // Oregon
  "portland": { state: "OR", lat: 45.5155, lng: -122.6789 },

  // Hawaii
  "honolulu": { state: "HI", lat: 21.3069, lng: -157.8583 },

  // Rhode Island
  "quonset": { state: "RI", lat: 41.5870, lng: -71.4128 },
  "providence": { state: "RI", lat: 41.8240, lng: -71.4128 },

  // New Hampshire
  "hudson": { state: "NH", lat: 42.7648, lng: -71.4398 },

  // Mississippi
  "mchenry": { state: "MS", lat: 30.7413, lng: -89.1548 },

  // Maine
  "bangor": { state: "ME", lat: 44.8016, lng: -68.7712 },
};

// Canonical display names for cities that have multiple lookup keys
const CITY_CANONICAL = {
  "new york city": "New York",
  "nyc": "New York",
  "manhattan": "New York",
  "brooklyn": "New York",
  "long island city": "New York",
  "long island": "New York",
  "rego park": "New York",
  "west babylon": "New York",
  "brookhaven": "New York",
  "new hyde park": "New York",
  "east meadow": "New York",
  "hempstead": "New York",
  "washington dc": "Washington",
  "washington d.c.": "Washington",
  "dc": "Washington",
  "dc metro": "Washington",
  "ny": "New York",
  "sf": "San Francisco",
  "bay area": "San Francisco",
  "south san francisco": "San Francisco",
  "saint louis": "St. Louis",
  "st. paul": "St. Paul",
  "dallas-fort worth": "Dallas",
  "saint petersburg": "St. Petersburg",
  "saint johns": "Saint Johns",
  "fort smith": "Fort Smith",
};

// State name → abbreviation mapping
const STATE_TO_ABBR = {
  "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
  "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
  "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
  "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
  "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
  "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
  "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
  "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT",
  "vermont": "VT", "virginia": "VA", "washington": "WA", "west virginia": "WV",
  "wisconsin": "WI", "wyoming": "WY", "district of columbia": "DC",
};

const STATE_ABBRS = new Set(Object.values(STATE_TO_ABBR));

// Biggest city per state (for state-only location fallback)
const STATE_BIGGEST_CITY = {
  "AL": "birmingham", "AK": "anchorage", "AZ": "phoenix", "AR": "fort smith",
  "CA": "los angeles", "CO": "denver", "CT": "hartford", "DE": "wilmington",
  "FL": "miami", "GA": "atlanta", "HI": "honolulu", "ID": "boise",
  "IL": "chicago", "IN": "indianapolis", "IA": "des moines", "KS": "wichita",
  "KY": "louisville", "LA": "new orleans", "ME": "bangor", "MD": "baltimore",
  "MA": "boston", "MI": "detroit", "MN": "minneapolis", "MS": "mchenry",
  "MO": "kansas city", "MT": "billings", "NE": "omaha", "NV": "las vegas",
  "NH": "hudson", "NJ": "newark", "NM": "albuquerque", "NY": "new york",
  "NC": "charlotte", "ND": "fargo", "OH": "columbus", "OK": "oklahoma city",
  "OR": "portland", "PA": "philadelphia", "RI": "providence", "SC": "charleston",
  "SD": "sioux falls", "TN": "nashville", "TX": "houston", "UT": "salt lake city",
  "VT": "burlington", "VA": "richmond", "WA": "seattle", "WV": "charleston",
  "WI": "milwaukee", "WY": "cheyenne", "DC": "washington",
};

// ──────────────────────────────────────────────────────
// Patterns that indicate "Remote / Other"
// ──────────────────────────────────────────────────────
const REMOTE_ONLY_RE = /^(remote|united states|anywhere in the united states|us|usa|u\.s\.|us remote|remote us|remote usa|remote - usa|us-remote|remote \(usa\)|united states - remote|remote - us: all locations|remote - us: select locations|remote in united states|remote in the us|remote in the usa|in-office|multiple locations|united states, multiple locations, multiple locations)$/i;

const REMOTE_INDICATOR_RE = /\bremote\b/i;

// State-only patterns (no specific city)
const STATE_ONLY_RE = new RegExp(
  "^(" + Object.keys(STATE_TO_ABBR).join("|") + ")\\s*,?\\s*(united states( of america)?|usa|us)?\\s*$", "i"
);

// Default fallback for remote/vague locations
const SF_COORDS = CITY_COORDS["san francisco"];
const REMOTE_FALLBACK = { city: "San Francisco", state: "CA", lat: SF_COORDS.lat, lng: SF_COORDS.lng, pinType: "remote" };

/**
 * Returns a map location for a state-only location string.
 */
function stateOnlyFallback(stateAbbr) {
  const cityKey = STATE_BIGGEST_CITY[stateAbbr];
  if (!cityKey || !CITY_COORDS[cityKey]) return { ...REMOTE_FALLBACK, pinType: "state" };
  const coords = CITY_COORDS[cityKey];
  const canonicalName = CITY_CANONICAL[cityKey] || toTitleCase(cityKey);
  return { city: canonicalName, state: stateAbbr, lat: coords.lat, lng: coords.lng, pinType: "state" };
}

// ──────────────────────────────────────────────────────
// Main normalization function
// ──────────────────────────────────────────────────────

/**
 * Normalizes a raw locationName string to a map location object.
 * @param {string|null} locationName - Raw location from the job document
 * @returns {{ city: string, state: string, lat: number, lng: number, pinType: string } | null}
 *   pinType: "city" = exact city match, "remote" = remote/vague → SF, "state" = state-only → biggest city
 *   Returns null ONLY for international locations.
 */
function normalizeToMapLocation(locationName) {
  if (!locationName || typeof locationName !== "string") return { ...REMOTE_FALLBACK };

  const trimmed = locationName.trim();
  if (!trimmed) return { ...REMOTE_FALLBACK };

  // Remote/vague/country-only → San Francisco with pinType: "remote"
  if (REMOTE_ONLY_RE.test(trimmed)) return { ...REMOTE_FALLBACK };
  if (/^united states\s*$/i.test(trimmed)) return { ...REMOTE_FALLBACK };
  if (/^us\s*$/i.test(trimmed)) return { ...REMOTE_FALLBACK };

  // State-only (no city) → biggest city in that state with pinType: "state"
  // BUT exclude state names that are also known cities (New York, Washington)
  if (STATE_ONLY_RE.test(trimmed)) {
    const stateNameMatch = trimmed.match(/^([a-z\s]+)/i);
    if (stateNameMatch) {
      const possibleCity = stateNameMatch[1].trim().toLowerCase();
      if (!CITY_COORDS[possibleCity]) {
        const stateAbbr = STATE_TO_ABBR[possibleCity];
        return stateAbbr ? stateOnlyFallback(stateAbbr) : { ...REMOTE_FALLBACK };
      }
    } else {
      return { ...REMOTE_FALLBACK };
    }
  }

  // International patterns → null (not US jobs)
  if (/^(uk|india|canada|europe)\s*[\/ ]/i.test(trimmed)) return null;
  if (/^[A-Z]{2}-(pune|bengaluru|bangalore|london|paris|berlin|mumbai|hyderabad|chennai)/i.test(trimmed)) return null;
  if (/^(east|west|north|south)\s+(texas|coast|region)/i.test(trimmed)) return { ...REMOTE_FALLBACK };

  // Clean the string
  let cleaned = trimmed;

  // Remove zip codes (5 digit or 5+4 format)
  cleaned = cleaned.replace(/\b\d{5}(-\d{4})?\b/g, "").trim();

  // Remove street addresses (patterns like "123 Main St," or "710 Center St,")
  cleaned = cleaned.replace(/^\d+\s+[\w\s]+\b(st|ave|blvd|rd|dr|ln|ct|way|pl|pkwy|hwy)\b\.?\s*,\s*/i, "");

  // Remove known prefixes (ORDER MATTERS - more specific first)
  cleaned = cleaned.replace(/^\*HQ\s*-\s*/i, "");
  cleaned = cleaned.replace(/^US-[A-Z]{2}-/i, ""); // "US-CA-Menlo Park"
  cleaned = cleaned.replace(/^US\s+[A-Z]{2}\s+/i, ""); // "US CA San Mateo"
  cleaned = cleaned.replace(/^US\s*-\s*/i, ""); // "US - San Francisco"
  cleaned = cleaned.replace(/^USA\s*-\s*/i, ""); // "USA - New York NY"
  cleaned = cleaned.replace(/^US\s*>\s*[^>]+\s*>\s*/i, ""); // "US > Arizona > Chandler"
  cleaned = cleaned.replace(/^Onsite\s*-\s*/i, "");
  cleaned = cleaned.replace(/^Hybrid\s*[-–—:]\s*/i, ""); // "Hybrid- Fremont, CA"
  cleaned = cleaned.replace(/^Hybrid\s+in\s+/i, ""); // "Hybrid in Santa Clara, CA"
  cleaned = cleaned.replace(/^U\.S\.\s*\(Hybrid\)\s*;?\s*/i, ""); // "U.S. (Hybrid); ..."
  cleaned = cleaned.replace(/^[A-Za-z]+\s+HQ\s*-\s*/i, ""); // "Betterment HQ - New York City"
  cleaned = cleaned.replace(/^[A-Za-z]+\s+Small Business\s+/i, ""); // "NerdWallet Small Business New York"

  // Remove known suffixes
  cleaned = cleaned.replace(/\s*-\s*HQ$/i, "");
  cleaned = cleaned.replace(/\s*-\s*US$/i, "");
  cleaned = cleaned.replace(/\s*\(Hybrid\).*$/i, "");
  cleaned = cleaned.replace(/\s*\(HQ\)$/i, "");
  cleaned = cleaned.replace(/\s*\(Remote\).*$/i, "");
  cleaned = cleaned.replace(/\s*\(In office.*\)$/i, "");
  cleaned = cleaned.replace(/\s*\([A-Z]{2}\)\s*/i, " ").trim(); // "Austin (TX)" → "Austin"
  cleaned = cleaned.replace(/\s+(Office|Warehouse|Campus|HQ|Headquarters|Privy HQ)$/i, "");
  cleaned = cleaned.replace(/\s+office\s*$/i, "");

  // Remove en-dash/em-dash suffixes: "Los Angeles – Primary Metro Area"
  cleaned = cleaned.replace(/\s*[–—]\s+.+$/, "");

  // Handle "State - City (Office)" format: "California - Los Angeles Office" or "New York - New York City Office"
  const stateCityMatch = cleaned.match(/^([A-Za-z\s]+)\s*-\s*(.+?)(?:\s+Office)?$/i);
  if (stateCityMatch) {
    const possibleState = stateCityMatch[1].trim().toLowerCase();
    if (STATE_TO_ABBR[possibleState]) {
      cleaned = stateCityMatch[2].trim();
    }
  }

  // Handle "City - address" format: "Charlotte - 101 S Tryon St"
  const cityAddressMatch = cleaned.match(/^([A-Za-z\s]+)\s*-\s*\d+/);
  if (cityAddressMatch) {
    cleaned = cityAddressMatch[1].trim();
  }

  // Handle "DC - address" pattern
  if (/^DC\s*-\s*\d+/i.test(cleaned)) {
    cleaned = "DC";
  }

  // For multi-location strings, split on ; | / and bullet •
  const segments = splitMultiLocation(cleaned);
  
  let bestCity = null;
  for (const segment of segments) {
    const seg = segment.trim();
    if (!seg) continue;
    if (/^(united states|US|USA|U\.S\.)$/i.test(seg)) continue;
    if (/^united states\s*-\s*remote$/i.test(seg)) continue;
    if (/^(uk|india|canada|europe|dublin|london|toronto|paris|berlin)$/i.test(seg)) continue;
    
    // Skip segments that are ONLY remote indicators
    if (/^remote(\s|$)/i.test(seg) || /^(remote)$/i.test(seg)) {
      const afterRemote = seg.replace(/^remote\s*[-–—:]\s*/i, "").trim();
      if (afterRemote && afterRemote.length > 2 && !/^(us|usa|united states)/i.test(afterRemote)) {
        const result = extractCityFromSegment(afterRemote);
        if (result) { bestCity = result; break; }
      }
      continue;
    }

    // Skip "Hybrid (City)" and extract city
    const hybridMatch = seg.match(/^Hybrid\s*\(([^)]+)\)/i);
    if (hybridMatch) {
      const result = extractCityFromSegment(hybridMatch[1]);
      if (result) { bestCity = result; break; }
      continue;
    }
    
    const result = extractCityFromSegment(seg);
    if (result) {
      bestCity = result;
      break;
    }
  }

  return bestCity || { ...REMOTE_FALLBACK };
}

/**
 * Smart split for multi-location strings.
 */
function splitMultiLocation(str) {
  // Split on semicolons, pipes, bullets, and "or" keyword
  let parts = str.split(/\s*[;|•]\s*|\s+or\s+/i);
  
  // For slash separators, only split if it separates "City, ST / City, ST" patterns
  const result = [];
  for (const part of parts) {
    if (part.includes("/")) {
      const slashParts = part.split(/\s*\/\s*/);
      const looksMultiCity = slashParts.filter(p => p.includes(",") || CITY_COORDS[p.toLowerCase().trim()]).length > 1;
      if (looksMultiCity) {
        result.push(...slashParts);
      } else {
        result.push(part);
      }
    } else {
      result.push(part);
    }
  }

  // Handle comma-separated multi-city (only if ALL parts are city abbreviations or known cities)
  // e.g., "NY, SF, Chicago" or "DC, SF, NYC"
  if (result.length === 1 && !result[0].match(/,\s*[A-Z]{2}\s*$/)) {
    const commaParts = result[0].split(/,\s*/);
    if (commaParts.length >= 2) {
      const allCities = commaParts.every(p => {
        const lower = p.trim().toLowerCase();
        return CITY_COORDS[lower] || /^[a-z]{2,3}$/i.test(p.trim());
      });
      if (allCities) {
        return commaParts;
      }
    }
  }

  return result;
}

/**
 * Extracts city info from a single location segment.
 */
function extractCityFromSegment(segment) {
  if (!segment) return null;
  
  let seg = segment.trim();
  
  // Remove "Remote - " prefix if followed by a city
  seg = seg.replace(/^Remote\s*[-–—:]\s*/i, "");
  seg = seg.replace(/^Remote\s*\(([^)]+)\)$/i, "$1");
  
  // Handle Eightfold reversed format: "United States, State, City"
  if (/^United States,/i.test(seg)) {
    const parts = seg.split(",").map(p => p.trim());
    if (parts.length >= 3) {
      const city = parts[parts.length - 1];
      const state = parts[parts.length - 2];
      return lookupCity(city, state);
    }
  }
  
  // Remove country suffixes (including "United States of America")
  seg = seg.replace(/,?\s*(United States( of America)?|USA|US)\s*$/i, "").trim();
  
  // Handle Eightfold no-space format: "City,State,Country" (already stripped country above)
  if (/^[^,]+,[^,]+$/.test(seg) && !seg.includes(", ")) {
    const noSpaceParts = seg.split(",").map(p => p.trim());
    if (noSpaceParts.length === 2) {
      return lookupCity(noSpaceParts[0], noSpaceParts[1]);
    }
  }

  // Standard format: "City, State" or "City, State, Country" or just "City"
  const parts = seg.split(",").map(p => p.trim()).filter(Boolean);
  
  if (parts.length === 0) return null;
  
  // If just one part, try direct city lookup
  if (parts.length === 1) {
    return lookupCity(parts[0], null);
  }
  
  // Two or more parts: first is city, second might be state
  const cityCandidate = parts[0];
  const stateCandidate = parts[1];
  
  return lookupCity(cityCandidate, stateCandidate);
}

/**
 * Looks up a city in the coordinates table.
 */
function lookupCity(cityRaw, stateRaw) {
  if (!cityRaw) return null;
  
  let city = cityRaw.trim().replace(/\s+/g, " ");
  
  // Strip remaining parentheticals: "Mountain View, California (HQ)"
  city = city.replace(/\s*\([^)]*\)\s*$/, "").trim();
  
  // Strip trailing zip codes that weren't caught earlier
  city = city.replace(/\s+\d{5}(-\d{4})?\s*$/, "").trim();
  
  const cityLower = city.toLowerCase();
  
  // Skip "Multiple Locations" (eightfold)
  if (/multiple locations/i.test(city)) return null;
  // Skip if too short and not a known city
  if (city.length < 2) return null;
  
  // Resolve state abbreviation from the state parameter
  let stateAbbr = null;
  if (stateRaw) {
    const stateClean = stateRaw.trim();
    if (/^[A-Z]{2}$/i.test(stateClean) && STATE_ABBRS.has(stateClean.toUpperCase())) {
      stateAbbr = stateClean.toUpperCase();
    } else {
      stateAbbr = STATE_TO_ABBR[stateClean.toLowerCase()] || null;
    }
  }

  // Direct lookup (check CITY_COORDS FIRST - "new york", "washington" are both city and state names)
  if (CITY_COORDS[cityLower]) {
    const coords = CITY_COORDS[cityLower];
    const canonicalName = CITY_CANONICAL[cityLower] || toTitleCase(cityLower);
    
    // If stateRaw is itself a known city, this is likely a multi-city list
    // (e.g., "San Francisco, New York, ...") - use city's default state
    const stateRawLower = stateRaw ? stateRaw.trim().toLowerCase() : null;
    const stateIsAlsoCity = stateRawLower && CITY_COORDS[stateRawLower];
    
    return {
      city: canonicalName,
      state: (stateAbbr && !stateIsAlsoCity) ? stateAbbr : coords.state,
      lat: coords.lat,
      lng: coords.lng,
      pinType: "city",
    };
  }
  
  // NOW check if it's ONLY a state name (not in CITY_COORDS) → return null
  if (/^[A-Z]{2}$/.test(city) && STATE_ABBRS.has(city)) return null;
  if (STATE_TO_ABBR[cityLower]) return null;

  // Try without trailing state abbreviation in city name (e.g., "Boston MA" or "New York NY")
  const withoutTrailingState = cityLower.replace(/\s+[a-z]{2}$/i, "").trim();
  if (withoutTrailingState !== cityLower && CITY_COORDS[withoutTrailingState]) {
    const coords = CITY_COORDS[withoutTrailingState];
    const canonicalName = CITY_CANONICAL[withoutTrailingState] || toTitleCase(withoutTrailingState);
    return {
      city: canonicalName,
      state: stateAbbr || coords.state,
      lat: coords.lat,
      lng: coords.lng,
      pinType: "city",
    };
  }

  // Handle "Ft. Smith" → "fort smith", "St. Petersburg" → "st. petersburg"
  const normalized = cityLower.replace(/^ft\.\s*/i, "fort ").replace(/^st\.\s*/i, "st. ");
  if (normalized !== cityLower && CITY_COORDS[normalized]) {
    const coords = CITY_COORDS[normalized];
    const canonicalName = CITY_CANONICAL[normalized] || toTitleCase(normalized);
    return {
      city: canonicalName,
      state: stateAbbr || coords.state,
      lat: coords.lat,
      lng: coords.lng,
      pinType: "city",
    };
  }
  
  // Try "saint" ↔ "st." variants
  const saintVariant = cityLower.replace(/^saint\s+/i, "st. ");
  if (saintVariant !== cityLower && CITY_COORDS[saintVariant]) {
    const coords = CITY_COORDS[saintVariant];
    const canonicalName = CITY_CANONICAL[saintVariant] || toTitleCase(saintVariant);
    return {
      city: canonicalName,
      state: stateAbbr || coords.state,
      lat: coords.lat,
      lng: coords.lng,
      pinType: "city",
    };
  }

  // San Francisco Bay Area special case
  if (cityLower.includes("san francisco") || cityLower === "sf") {
    const coords = CITY_COORDS["san francisco"];
    return { city: "San Francisco", state: "CA", lat: coords.lat, lng: coords.lng, pinType: "city" };
  }

  return null;
}

function toTitleCase(str) {
  return str.split(" ").map(w => {
    // Handle "st." prefix
    if (w === "st.") return "St.";
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(" ");
}

module.exports = { normalizeToMapLocation, CITY_COORDS, CITY_CANONICAL, STATE_TO_ABBR };
