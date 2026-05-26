import React, { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, GeoJSON } from "react-leaflet";
import { useNavigate } from "react-router-dom";
import L from "leaflet";
import { doc, getDoc, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { ADMIN_UID } from "../App.jsx";
import "leaflet/dist/leaflet.css";

/**
 * HeroUSMap — Live, animated US-mainland map for the landing-page hero.
 * - No tile layer (so no country/state borders shown)
 * - Pulsing SVG bubbles for each city cluster (real-time data from Firestore,
 *   with a graceful fallback to sample cities if the fetch fails).
 * - Locked to mainland USA, fully non-interactive, full-bleed width.
 */

const EXCLUDED_STATES = new Set(["02", "15", "72"]); // Alaska, Hawaii, Puerto Rico

const FALLBACK_CITIES = [
  { city: "Seattle", state: "WA", lat: 47.6062, lng: -122.3321, count: 142 },
  { city: "San Francisco", state: "CA", lat: 37.7749, lng: -122.4194, count: 287 },
  { city: "Los Angeles", state: "CA", lat: 34.0522, lng: -118.2437, count: 165 },
  { city: "San Diego", state: "CA", lat: 32.7157, lng: -117.1611, count: 64 },
  { city: "Denver", state: "CO", lat: 39.7392, lng: -104.9903, count: 78 },
  { city: "Phoenix", state: "AZ", lat: 33.4484, lng: -112.0740, count: 52 },
  { city: "Austin", state: "TX", lat: 30.2672, lng: -97.7431, count: 134 },
  { city: "Dallas", state: "TX", lat: 32.7767, lng: -96.7970, count: 96 },
  { city: "Houston", state: "TX", lat: 29.7604, lng: -95.3698, count: 71 },
  { city: "Chicago", state: "IL", lat: 41.8781, lng: -87.6298, count: 118 },
  { city: "Minneapolis", state: "MN", lat: 44.9778, lng: -93.2650, count: 41 },
  { city: "Atlanta", state: "GA", lat: 33.7490, lng: -84.3880, count: 89 },
  { city: "Miami", state: "FL", lat: 25.7617, lng: -80.1918, count: 47 },
  { city: "Washington", state: "DC", lat: 38.9072, lng: -77.0369, count: 102 },
  { city: "Philadelphia", state: "PA", lat: 39.9526, lng: -75.1652, count: 58 },
  { city: "New York", state: "NY", lat: 40.7128, lng: -74.0060, count: 312 },
  { city: "Boston", state: "MA", lat: 42.3601, lng: -71.0589, count: 124 },
  { city: "Raleigh", state: "NC", lat: 35.7796, lng: -78.6382, count: 36 },
  { city: "Salt Lake City", state: "UT", lat: 40.7608, lng: -111.8910, count: 33 },
  { city: "Portland", state: "OR", lat: 45.5152, lng: -122.6784, count: 49 },
];

function radiusFor(count, scale = 1) {
  let r;
  if (count >= 200) r = 14;
  else if (count >= 100) r = 11;
  else if (count >= 50) r = 8;
  else if (count >= 25) r = 6;
  else r = 5;
  return Math.max(3, r * scale);
}

// Mainland USA bounding box
function inMainland(lat, lng) {
  return lat >= 24.0 && lat <= 49.5 && lng >= -125.0 && lng <= -66.0;
}

/** Renders animated SVG bubbles as a Leaflet overlay using project()/unproject().
 *  Greedily merges cities that project within ~38px of each other so dense
 *  metros (e.g. NYC + Newark + Jersey City) collapse into one larger bubble.
 */
function AnimatedBubbles({ map, clusters, interactive = false, onBubbleClick, onPositions }) {
  const [, force] = useState(0);
  const [hovered, setHovered] = useState(null);

  useEffect(() => {
    if (!map) return;
    const rerender = () => force((n) => n + 1);
    map.on("zoom move resize", rerender);
    return () => map.off("zoom move resize", rerender);
  }, [map]);

  // Compute everything up front so we can call hooks unconditionally.
  const size = map ? map.getSize() : { x: 0, y: 0 };
  const isMobile = size.x < 640;
  const bubbleScale = isMobile ? 0.7 : size.x < 1024 ? 0.85 : 1;
  const MERGE_PX = isMobile ? 28 : size.x < 1024 ? 34 : 42;

  const merged = [];
  if (map) {
    // Project + greedy-cluster
    const projected = clusters
      .map((c) => ({ ...c, _p: map.latLngToContainerPoint([c.lat, c.lng]) }))
      .sort((a, b) => b.count - a.count);

    const taken = new Array(projected.length).fill(false);
    for (let i = 0; i < projected.length; i++) {
      if (taken[i]) continue;
      const a = projected[i];
      let sumX = a._p.x * a.count;
      let sumY = a._p.y * a.count;
      let total = a.count;
      let mergedNames = [a.city];
      for (let j = i + 1; j < projected.length; j++) {
        if (taken[j]) continue;
        const b = projected[j];
        const dx = a._p.x - b._p.x;
        const dy = a._p.y - b._p.y;
        if (dx * dx + dy * dy <= MERGE_PX * MERGE_PX) {
          sumX += b._p.x * b.count;
          sumY += b._p.y * b.count;
          total += b.count;
          mergedNames.push(b.city);
          taken[j] = true;
        }
      }
      taken[i] = true;
      merged.push({
        key: `${a.city}-${a.state}-${i}`,
        city: a.city,
        state: a.state,
        x: sumX / total,
        y: sumY / total,
        count: total,
        mergedCount: mergedNames.length,
      });
    }
  }

  // Expose computed positions upward so parent overlays (e.g. live ticker card)
  // can pin themselves to specific bubbles. Stringified hash key prevents
  // infinite re-renders while still updating on resize / data change.
  const positionsHash = merged
    .map((m) => `${m.city}|${m.state}:${Math.round(m.x)},${Math.round(m.y)}:${m.count}`)
    .join(";");
  useEffect(() => {
    if (!onPositions) return;
    const out = {};
    merged.forEach((m) => {
      out[`${m.city}|${m.state}`] = {
        x: m.x,
        y: m.y,
        r: radiusFor(m.count, bubbleScale),
        city: m.city,
        state: m.state,
        count: m.count,
      };
    });
    onPositions(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionsHash]);

  if (!map) return null;

  return (
    <>
    <svg
      className="hero-bubbles-svg"
      width={size.x}
      height={size.y}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        pointerEvents: "none",
        zIndex: 400,
      }}
    >
      <defs>
        <radialGradient id="bubbleGrad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#6366f1" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#4f46e5" stopOpacity="0.95" />
        </radialGradient>
      </defs>
      {merged.map((c, idx) => {
        const r = radiusFor(c.count, bubbleScale);
        const delay = (idx % 7) * 0.35;
        const isHovered = hovered?.key === c.key;
        return (
          <g
            key={c.key}
            transform={`translate(${c.x}, ${c.y})`}
            style={{ pointerEvents: interactive ? "auto" : "none", cursor: interactive ? "pointer" : "default" }}
            onMouseEnter={interactive ? () => setHovered(c) : undefined}
            onMouseLeave={interactive ? () => setHovered(null) : undefined}
            onClick={interactive ? () => onBubbleClick?.(c) : undefined}
          >
            {/* invisible hit target so small bubbles are still hoverable */}
            {interactive && (
              <circle r={Math.max(r + 6, 14)} fill="transparent" />
            )}
            {/* outer expanding ring */}
            <circle
              className="hero-bubble-ring"
              r={r}
              style={{ animationDelay: `${delay}s` }}
            />
            {/* secondary ring */}
            <circle
              className="hero-bubble-ring hero-bubble-ring-2"
              r={r}
              style={{ animationDelay: `${delay + 0.8}s` }}
            />
            {/* solid core */}
            <circle
              r={isHovered ? r * 1.25 : r}
              fill="url(#bubbleGrad)"
              stroke="#ffffff"
              strokeWidth={isHovered ? 2 : 1.5}
              opacity="0.95"
              style={{ transition: "r 0.2s ease-out, stroke-width 0.2s ease-out" }}
            />
          </g>
        );
      })}
    </svg>
    {/* HTML tooltip overlay (positioned over the SVG, follows hovered bubble) */}
    {interactive && hovered && (
      <div
        className="hero-bubble-tooltip"
        style={{
          position: "absolute",
          left: hovered.x,
          top: hovered.y,
          transform: "translate(-50%, calc(-100% - 14px))",
          zIndex: 500,
          pointerEvents: "none",
        }}
      >
        <div className="rounded-lg bg-gray-900/90 backdrop-blur-md text-white px-2.5 py-1.5 text-[11px] font-semibold shadow-xl whitespace-nowrap">
          <span className="text-white">{hovered.city}, {hovered.state}</span>
          <span className="ml-1.5 text-indigo-300">· {hovered.count.toLocaleString()} jobs</span>
          {hovered.mergedCount > 1 && (
            <span className="ml-1 text-gray-400 text-[10px]">+{hovered.mergedCount - 1} nearby</span>
          )}
        </div>
        <div className="absolute left-1/2 -translate-x-1/2 -bottom-1 w-2 h-2 rotate-45 bg-gray-900/90" />
      </div>
    )}
    </>
  );
}

export default function HeroUSMap({ realtime = false, interactive = false, onBubblePositions }) {
  const navigate = useNavigate();
  const [geo, setGeo] = useState(null);
  const [clusters, setClusters] = useState(FALLBACK_CITIES);
  const [map, setMap] = useState(null);

  // Load US states outline
  useEffect(() => {
    let cancelled = false;
    fetch("/us-states.geojson")
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (cancelled || !json) return;
        setGeo({
          ...json,
          features: json.features.filter((f) => !EXCLUDED_STATES.has(f.id)),
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Data: real-time subscription (logged-in dashboard) or one-shot fetch (landing).
  // Falls back to sample data on permission errors so the visual never breaks.
  useEffect(() => {
    const ref = doc(db, "users", ADMIN_UID, "aggregations", "mapClusters");

    const applySnapshot = (data) => {
      if (!data) return;
      const list = Object.entries(data.clusters || {})
        .map(([key, val]) => {
          const [cityName, stateCode] = key.split("|");
          return { ...val, city: cityName, state: stateCode };
        })
        .filter(
          (c) =>
            Number.isFinite(c.lat) &&
            Number.isFinite(c.lng) &&
            inMainland(c.lat, c.lng)
        )
        .sort((a, b) => b.count - a.count)
        .slice(0, 80);
      if (list.length > 0) setClusters(list);
    };

    if (realtime) {
      const unsub = onSnapshot(
        ref,
        (snap) => snap.exists() && applySnapshot(snap.data()),
        () => {}
      );
      return () => unsub();
    }

    let cancelled = false;
    (async () => {
      try {
        const snap = await getDoc(ref);
        if (cancelled || !snap.exists()) return;
        applySnapshot(snap.data());
      } catch {
        // keep fallback
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [realtime]);

  const bounds = useMemo(
    () => L.latLngBounds([24.4, -125.0], [49.5, -66.5]),
    []
  );

  return (
    <div className="hero-us-map-wrap">
      <div className="hero-us-map-inner">
        <MapContainer
          bounds={bounds}
          maxBounds={bounds}
          maxBoundsViscosity={1.0}
          zoomControl={false}
          scrollWheelZoom={false}
          doubleClickZoom={false}
          dragging={false}
          touchZoom={false}
          boxZoom={false}
          keyboard={false}
          attributionControl={false}
          zoomSnap={0.25}
          ref={setMap}
          style={{ height: "100%", width: "100%", background: "transparent" }}
        >
          {geo && (
            <GeoJSON
              data={geo}
              style={() => ({
                color: "#a5b4fc",
                weight: 0.75,
                opacity: 0.55,
                fillColor: "#c7d2fe",
                fillOpacity: 0.55,
              })}
              interactive={false}
            />
          )}
          <AnimatedBubbles
            map={map}
            clusters={clusters}
            interactive={interactive}
            onBubbleClick={(c) => navigate(`/jobs?city=${encodeURIComponent(c.city)}&state=${encodeURIComponent(c.state)}`)}
            onPositions={onBubblePositions}
          />
        </MapContainer>
      </div>

      {/* edge fades so the map blends into the page */}
      <div className="hero-us-map-fade-l" />
      <div className="hero-us-map-fade-r" />
      <div className="hero-us-map-fade-b" />

      <style>{`
        .hero-us-map-wrap {
          position: relative;
          width: 100vw;
          left: 50%;
          right: 50%;
          margin-left: -50vw;
          margin-right: -50vw;
          height: 100%;
          overflow: hidden;
          perspective: 1400px;
        }
        .hero-us-map-inner {
          position: absolute;
          inset: 0;
          transform: rotateX(10deg) scale(1.04);
          transform-origin: center 65%;
          border-radius: 32px;
        }
        @media (max-width: 640px) {
          .hero-us-map-wrap { perspective: 900px; }
          .hero-us-map-inner {
            transform: rotateX(6deg) scale(1.08);
            border-radius: 20px;
          }
          .hero-us-map-fade-l,
          .hero-us-map-fade-r { width: 8%; }
        }
        .hero-us-map-inner .leaflet-container {
          background: transparent !important;
          outline: none;
        }
        .hero-bubble-ring {
          fill: #6366f1;
          fill-opacity: 0.35;
          transform-box: fill-box;
          transform-origin: center;
          animation: hero-bubble-pulse 2.4s ease-out infinite;
        }
        .hero-bubble-ring-2 {
          fill-opacity: 0.18;
          animation-duration: 3s;
        }
        @keyframes hero-bubble-pulse {
          0%   { transform: scale(1);   opacity: 0.55; }
          70%  { transform: scale(3.8); opacity: 0;    }
          100% { transform: scale(4);   opacity: 0;    }
        }
        .hero-us-map-fade-l,
        .hero-us-map-fade-r {
          position: absolute;
          top: 0;
          bottom: 0;
          width: 14%;
          pointer-events: none;
          z-index: 2;
        }
        .hero-us-map-fade-l {
          left: 0;
          background: linear-gradient(to right, #ffffff 0%, rgba(255,255,255,0) 100%);
        }
        .hero-us-map-fade-r {
          right: 0;
          background: linear-gradient(to left, #ffffff 0%, rgba(255,255,255,0) 100%);
        }
        .hero-us-map-fade-b {
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          height: 30%;
          pointer-events: none;
          z-index: 2;
          background: linear-gradient(to top, #ffffff 0%, rgba(255,255,255,0) 100%);
        }
      `}</style>
    </div>
  );
}
