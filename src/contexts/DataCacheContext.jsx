import React, { createContext, useContext, useRef, useCallback } from "react";
import { doc, getDoc } from "firebase/firestore";
import { db } from "../firebase";
import { ADMIN_UID } from "../App.jsx";

const DataCacheContext = createContext(null);

const TTL = {
  mapClusters: 5 * 60 * 1000,
  companyStats: 5 * 60 * 1000,
  jobs: 2 * 60 * 1000,
};

export function DataCacheProvider({ children }) {
  const cache = useRef({});

  const getCached = useCallback((key) => {
    const entry = cache.current[key];
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > (TTL[key] || 120_000)) {
      delete cache.current[key];
      return null;
    }
    return entry.data;
  }, []);

  const setCached = useCallback((key, data) => {
    cache.current[key] = { data, fetchedAt: Date.now() };
  }, []);

  const invalidate = useCallback((key) => {
    if (key) {
      delete cache.current[key];
    } else {
      cache.current = {};
    }
  }, []);

  const getMapClusters = useCallback(async () => {
    const cached = getCached("mapClusters");
    if (cached) return cached;

    const snap = await getDoc(doc(db, "users", ADMIN_UID, "aggregations", "mapClusters"));
    if (!snap.exists()) return { clusters: {}, totalJobs: 0 };
    const data = snap.data();
    setCached("mapClusters", data);
    return data;
  }, [getCached, setCached]);

  const getCompanyStats = useCallback(async () => {
    const cached = getCached("companyStats");
    if (cached) return cached;

    const snap = await getDoc(doc(db, "users", ADMIN_UID, "aggregations", "companyStats"));
    if (!snap.exists()) return { companies: {}, totalCompanies: 0 };
    const data = snap.data();
    setCached("companyStats", data);
    return data;
  }, [getCached, setCached]);

  const value = { getCached, setCached, invalidate, getMapClusters, getCompanyStats };

  return (
    <DataCacheContext.Provider value={value}>
      {children}
    </DataCacheContext.Provider>
  );
}

export function useDataCache() {
  const ctx = useContext(DataCacheContext);
  if (!ctx) throw new Error("useDataCache must be used within DataCacheProvider");
  return ctx;
}
