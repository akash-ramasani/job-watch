import React, { useEffect, useMemo, useState } from "react";
import { collection, getDocs, query, where, orderBy } from "firebase/firestore";
import { MapContainer, TileLayer, CircleMarker, Popup } from "react-leaflet";
import { db } from "../firebase";
import { ADMIN_UID } from "../App.jsx";
import { useDataCache } from "../contexts/DataCacheContext.jsx";
import "leaflet/dist/leaflet.css";

/**
 * JobMap — Displays all jobs grouped by city on a minimal US map.
 * Reads 1 aggregation doc for clusters. Queries jobs only on city click.
 */
export default function JobMap({ user }) {
  const [clusters, setClusters] = useState([]);
  const [totalJobs, setTotalJobs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedCity, setSelectedCity] = useState(null);
  const [cityJobs, setCityJobs] = useState([]);
  const [cityLoading, setCityLoading] = useState(false);

  const { getMapClusters } = useDataCache();

  // Fetch aggregation doc (1 read, cached 5 min)
  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      try {
        const data = await getMapClusters();
        const clusterList = Object.entries(data.clusters || {}).map(([key, val]) => {
          const [city, state] = key.split("|");
          return { city, state, ...val };
        });
        setClusters(clusterList.sort((a, b) => b.count - a.count));
        setTotalJobs(data.totalJobs || 0);
      } catch (err) {
        console.error("Failed to fetch map data:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [getMapClusters]);

  // On city click, query jobs for that city
  async function handleCityClick(cluster) {
    setSelectedCity(cluster);
    setCityLoading(true);
    try {
      const jobsCol = collection(db, "users", ADMIN_UID, "jobs");
      const q = query(
        jobsCol,
        where("mapLocation.city", "==", cluster.city),
        orderBy("sourceUpdatedTs", "desc")
      );
      const snap = await getDocs(q);
      setCityJobs(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (err) {
      console.error("Failed to fetch city jobs:", err);
      setCityJobs([]);
    } finally {
      setCityLoading(false);
    }
  }

  function getRadius(count) {
    const min = 6;
    const max = 40;
    if (count <= 1) return min;
    return Math.min(max, min + Math.log2(count) * 5);
  }

  function getColor(count) {
    if (count >= 100) return "#1d4ed8";
    if (count >= 50) return "#2563eb";
    if (count >= 20) return "#3b82f6";
    if (count >= 10) return "#60a5fa";
    return "#93c5fd";
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-sm text-gray-400 animate-pulse">Loading map data...</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Job Map</h1>
          <p className="text-sm text-gray-500 mt-1">
            {totalJobs.toLocaleString()} jobs across {clusters.length} cities
          </p>
        </div>
        {selectedCity && (
          <button
            onClick={() => { setSelectedCity(null); setCityJobs([]); }}
            className="text-sm text-blue-600 hover:text-blue-700 font-medium"
          >
            ← Back to map
          </button>
        )}
      </div>

      {/* Map or City Detail */}
      {!selectedCity ? (
        <div className="rounded-xl overflow-hidden border border-gray-200 shadow-sm">
          <MapContainer
            center={[39.5, -98.0]}
            zoom={4}
            style={{ height: "70vh", width: "100%" }}
            scrollWheelZoom={true}
            zoomControl={true}
          >
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>'
            />
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png"
              attribution=""
            />

            {clusters.map((cluster) => (
              <CircleMarker
                key={`${cluster.city}-${cluster.state}`}
                center={[cluster.lat, cluster.lng]}
                radius={getRadius(cluster.count)}
                pathOptions={{
                  fillColor: getColor(cluster.count),
                  fillOpacity: 0.7,
                  color: "#1e40af",
                  weight: 1.5,
                  opacity: 0.8,
                }}
                eventHandlers={{ click: () => handleCityClick(cluster) }}
              >
                <Popup>
                  <div className="text-center min-w-[120px]">
                    <div className="font-semibold text-gray-900">{cluster.city}, {cluster.state}</div>
                    <div className="text-sm text-gray-500">{cluster.count} job{cluster.count !== 1 ? "s" : ""}</div>
                    <button
                      className="mt-1 text-xs text-blue-600 hover:underline"
                      onClick={() => handleCityClick(cluster)}
                    >
                      View jobs →
                    </button>
                  </div>
                </Popup>
              </CircleMarker>
            ))}
          </MapContainer>
        </div>
      ) : (
        <CityJobsList city={selectedCity} jobs={cityJobs} loading={cityLoading} />
      )}

      {/* Top cities legend */}
      {!selectedCity && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 mt-4">
          {clusters.slice(0, 20).map((c) => (
            <button
              key={`${c.city}-${c.state}`}
              onClick={() => handleCityClick(c)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-100 hover:border-blue-200 hover:bg-blue-50/50 transition-colors text-left"
            >
              <span
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: getColor(c.count) }}
              />
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-900 truncate">{c.city}</div>
                <div className="text-xs text-gray-500">{c.count} jobs</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CityJobsList({ city, jobs, loading }) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <div className="text-sm text-gray-400 animate-pulse">Loading jobs...</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="bg-blue-50 rounded-lg px-4 py-3">
        <h2 className="text-lg font-semibold text-gray-900">{city.city}, {city.state}</h2>
        <p className="text-sm text-gray-600">{jobs.length} job{jobs.length !== 1 ? "s" : ""}</p>
      </div>

      <div className="space-y-2 max-h-[60vh] overflow-y-auto">
        {jobs.map((job) => (
          <a
            key={job.id}
            href={job.jobUrl || "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="block px-4 py-3 rounded-lg border border-gray-100 hover:border-blue-200 hover:bg-blue-50/30 transition-colors"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-gray-900 text-sm truncate">{job.title}</div>
                <div className="text-xs text-gray-500 mt-0.5">{job.companyName}</div>
                {job.locationName && (
                  <div className="text-xs text-gray-400 mt-0.5 truncate">{job.locationName}</div>
                )}
              </div>
              {job.relevanceScore != null && job.relevanceScore >= 0 && (
                <span className={`flex-shrink-0 text-xs font-medium px-2 py-0.5 rounded-full ${
                  job.relevanceScore >= 80 ? "bg-green-100 text-green-700" :
                  job.relevanceScore >= 60 ? "bg-yellow-100 text-yellow-700" :
                  "bg-gray-100 text-gray-600"
                }`}>
                  {job.relevanceScore}%
                </span>
              )}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
