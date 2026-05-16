# JobWatch — Architecture & Data Flow

## Overview

JobWatch is a job tracking web app that syncs job postings from Greenhouse, Ashby, and Eightfold AI into Firestore, scores them with AI, and displays them on a map and filterable list.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Cloud Functions                              │
│                                                                     │
│  syncRecentJobsHourly (hourly)                                      │
│    → Fetches jobs from Greenhouse/Ashby/Eightfold APIs              │
│    → Normalizes location → mapLocation { city, state, lat, lng,     │
│                                          pinType }                   │
│    → Writes to /users/{uid}/jobs/{jobId}                            │
│    → Scores new jobs with AI → writes aiScore + scoringStatus agg   │
│                                                                     │
│  dailyAggregationReconciliation (daily 3am PT)                      │
│    → Reads ALL jobs (paginated, 500/page)                           │
│    → Computes mapClusters + companyStats                            │
│    → Writes to /users/{uid}/aggregations/                           │
│                                                                     │
│  runSyncNow (on-demand callable)                                    │
│    → Same as hourly sync but triggered manually                     │
└─────────────────────────────────────────────────────────────────────┘
                              ↕ Firestore
┌─────────────────────────────────────────────────────────────────────┐
│                         Firestore DB                                 │
│                                                                     │
│  /users/{uid}/                                                      │
│    ├── jobs/{jobId}         ← Individual job documents (5,000+)     │
│    ├── companies/{key}      ← Company metadata                      │
│    ├── aggregations/                                                │
│    │   ├── mapClusters      ← Pre-computed city counts (~19KB)      │
│    │   ├── companyStats     ← Pre-computed company counts (~12KB)   │
│    │   └── scoringStatus    ← Recently scored job summaries         │
│    └── scheduledRuns/{id}   ← Sync execution logs                   │
└─────────────────────────────────────────────────────────────────────┘
                              ↕ Reads
┌─────────────────────────────────────────────────────────────────────┐
│                         React Frontend                               │
│                                                                     │
│  DataCacheContext (TTL: 5min)                                       │
│    → getMapClusters()     → 1 read for entire map page              │
│    → getCompanyStats()    → 1 read for companies dropdown           │
│                                                                     │
│  JobMap page                                                        │
│    → Loads clusters from cache (1 read)                             │
│    → On city click: queries jobs WHERE mapLocation.city == X        │
│                                                                     │
│  Jobs page                                                          │
│    → Paginated job list (50/page, time-filtered)                    │
│    → Companies from aggregation (1 read vs 1,000)                   │
│    → Score updates via onSnapshot on scoringStatus (1 listener)     │
│                                                                     │
│  No heartbeat polling — onSnapshot handles session enforcement      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Read Optimization Strategy

### Before (wasteful)
| Feature | Reads/Session |
|---------|---------------|
| Map page load | 5,300 (every job doc) |
| Companies dropdown | 1,000 (every company doc) |
| Score polling | 2,400/hr (160 docs × 15s interval) |
| Session heartbeat | 60/hr |
| **Total** | **~13,760/hr** |

### After (optimized)
| Feature | Reads/Session |
|---------|---------------|
| Map page load | 1 (aggregation doc, cached 5 min) |
| Companies dropdown | 1 (aggregation doc, cached 5 min) |
| Score updates | 1 listener (onSnapshot, real-time) |
| Session heartbeat | 0 (onSnapshot on user doc) |
| City click (on-demand) | ~50-200 (only when user clicks a city) |
| **Total** | **~150/hr** |

**Result: 99% reduction in Firestore reads**

---

## Location Normalization

The `locationNormalizer.cjs` resolves raw location strings from job sources into map-ready coordinates.

### Input Examples
```
"San Francisco, CA"           → { city: "San Francisco", state: "CA", pinType: "city" }
"Remote"                      → { city: "San Francisco", state: "CA", pinType: "remote" }
"United States"               → { city: "San Francisco", state: "CA", pinType: "remote" }
"California"                  → { city: "Los Angeles", state: "CA", pinType: "state" }
"NYC, New York"               → { city: "New York", state: "NY", pinType: "city" }
"Austin, TX; Remote"          → { city: "Austin", state: "TX", pinType: "city" }
```

### Pin Types
- **`city`** — Exact city match found in 230+ US city database
- **`remote`** — Remote, country-only ("United States"), or vague locations → defaults to San Francisco
- **`state`** — State-only ("California") → mapped to biggest city in that state

### Multi-location Jobs
First resolvable city is used. Job appears once on the map.

---

## Aggregation Documents

### `/aggregations/mapClusters`
```json
{
  "clusters": {
    "San Francisco|CA": { "lat": 37.7749, "lng": -122.4194, "count": 842, "city": 620, "remote": 180, "state": 42 },
    "New York|NY": { "lat": 40.7128, "lng": -74.0060, "count": 534, "city": 510, "remote": 20, "state": 4 }
  },
  "totalJobs": 5296,
  "updatedAt": "2026-05-16T..."
}
```

### `/aggregations/companyStats`
```json
{
  "companies": {
    "stripe": { "name": "Stripe", "count": 45 },
    "openai": { "name": "OpenAI", "count": 32 }
  },
  "totalCompanies": 320,
  "updatedAt": "2026-05-16T..."
}
```

### `/aggregations/scoringStatus`
Written at end of each AI scoring run. Frontend listens via onSnapshot for real-time updates.

---

## Client-Side Cache (DataCacheContext)

```
Request → Check in-memory cache (TTL: 5 min)
  ├── HIT  → Return cached data (0 reads)
  └── MISS → Read from Firestore → Store in cache → Return
```

- `getMapClusters()` — Cached 5 minutes
- `getCompanyStats()` — Cached 5 minutes
- `invalidate(key)` — Manually bust cache (e.g., after sync)

Navigation between pages does NOT re-fetch if within TTL window.

---

## Scheduled Functions

| Function | Schedule | Purpose | Reads |
|----------|----------|---------|-------|
| `syncRecentJobsHourly` | Every hour | Fetch new jobs from sources | External APIs |
| `dailyAggregationReconciliation` | 3am PT daily | Rebuild aggregation docs | ~5,000 (once/day) |

---

## Composite Indexes

| Collection | Fields | Purpose |
|------------|--------|---------|
| `jobs` | `mapLocation.city` ASC, `sourceUpdatedTs` DESC | Map city-click query |
| `jobs` | `companyKey` ASC, `sourceUpdatedTs` DESC | Company filter |

---

## Future Improvements

### 🔥 High Impact

1. **Incremental aggregation on sync**
   - Instead of daily full rebuild, update aggregation counts at the end of each hourly sync
   - Track new/deleted jobs delta → increment/decrement counters
   - Reduces staleness from 24h to 1h

2. **Push aggregation updates to frontend**
   - Add `onSnapshot` on `mapClusters` doc so map updates in real-time when sync runs
   - Currently requires page refresh or waiting for 5-min cache expiry

3. **Edge caching with CDN**
   - Serve aggregation docs via Cloud Functions HTTP endpoint + CDN headers
   - Eliminates even the 1-read-per-session cost for map/companies

4. **Firestore Bundle (offline pre-fetch)**
   - Generate a Firestore Bundle during daily reconciliation
   - Frontend loads bundle from Cloud Storage on app start → zero reads for initial load

### ⚡ Performance

5. **Paginated map city-click with cursor**
   - Currently loads ALL jobs for a city (some cities have 800+ jobs)
   - Add pagination (50 at a time) with "Load more" button

6. **Lazy-load companies list**
   - Only fetch company stats when user opens the dropdown filter
   - Currently fetches on Jobs page mount even if filter isn't used

7. **Service Worker caching**
   - Cache aggregation responses in Service Worker
   - Serve instantly on revisit, background-refresh when stale

### 🗺️ Map Enhancements

8. **Cluster animation on zoom**
   - Merge nearby cities into region clusters at low zoom
   - Split into individual city pins on zoom-in (e.g., SF Bay Area)

9. **Heatmap mode toggle**
   - Density-based heatmap view alternative to circle markers
   - Better for seeing concentration patterns at a glance

10. **Time-based map filtering**
    - Slider to show jobs posted in last 24h / 7d / 30d
    - Animate map over time to see hiring trends

### 🏗️ Infrastructure

11. **TTL-aware aggregation refresh**
    - When a job's `expireAt` TTL fires, aggregation counts become stale
    - Add Cloud Function trigger on TTL deletion to decrement counts
    - (Note: Firestore TTL doesn't trigger Cloud Functions today — would need workaround)

12. **Multi-user aggregation efficiency**
    - Current daily reconciliation rebuilds for ALL users
    - Add `lastSyncAt` check — skip users who haven't had new jobs since last rebuild

13. **Upgrade to Firebase Functions v2 SDK**
    - Current SDK is v4.9.0 (deprecated warnings on deploy)
    - v5.1+ unlocks new Extensions features and removes deprecation warnings

14. **Node.js runtime upgrade**
    - Currently Node.js 20 (deprecated 2026-04-30, decommissions 2026-10-30)
    - Upgrade to Node.js 22 before October deadline

### 📊 Analytics

15. **Read usage dashboard**
    - Track actual Firestore reads per day in a simple counter doc
    - Surface in admin panel to validate optimization effectiveness

16. **Scoring cost tracking**
    - Track AI API calls and costs per scoring run
    - Add budget alerts when approaching limits
