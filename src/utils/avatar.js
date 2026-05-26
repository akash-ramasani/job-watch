import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { doc, setDoc } from "firebase/firestore";
import { storage, db } from "../firebase";

const COLORS = ["c7d2fe", "ddd6fe", "fbcfe8", "bae6fd", "bbf7d0", "fde68a", "fecaca"];
const HAIR_VARIANTS =
  "variant01,variant02,variant10,variant11,variant12,variant13,variant20,variant22,variant24,variant26";

const LS_URL_PREFIX = "jw_avatar_url:";
const LS_PENDING_PREFIX = "jw_avatar_pending:";

function hashCode(str = "") {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
}

export function colorForSeed(seed = "") {
  return COLORS[hashCode(seed) % COLORS.length];
}

export function diceBearUrl(seed = "anon", bg) {
  const bgColor = bg || colorForSeed(seed);
  return `https://api.dicebear.com/9.x/notionists/svg?seed=${encodeURIComponent(
    seed,
  )}&backgroundColor=${bgColor}&hair=${HAIR_VARIANTS}`;
}

export function getCachedAvatarUrl(uid) {
  if (!uid || typeof window === "undefined") return null;
  try {
    return localStorage.getItem(LS_URL_PREFIX + uid) || null;
  } catch {
    return null;
  }
}

export function setCachedAvatarUrl(uid, url) {
  if (!uid || !url || typeof window === "undefined") return;
  try {
    localStorage.setItem(LS_URL_PREFIX + uid, url);
  } catch {
    /* quota — ignore */
  }
}

/**
 * Generate a DiceBear avatar SVG, upload it to Firebase Storage under
 * `avatars/{uid}.svg`, then persist the download URL to `users/{uid}.avatarUrl`.
 * Returns the public download URL.
 */
export async function generateAndUploadAvatar(uid, { persist = true } = {}) {
  if (!uid) throw new Error("uid required");
  const url = diceBearUrl(uid);
  const res = await fetch(url);
  if (!res.ok) throw new Error("DiceBear fetch failed");
  const svg = await res.arrayBuffer();

  const ref = storageRef(storage, `avatars/${uid}.svg`);
  await uploadBytes(ref, svg, {
    contentType: "image/svg+xml",
    cacheControl: "public, max-age=31536000, immutable",
  });
  const downloadUrl = await getDownloadURL(ref);

  if (persist) {
    await setDoc(doc(db, "users", uid), { avatarUrl: downloadUrl }, { merge: true });
  }
  setCachedAvatarUrl(uid, downloadUrl);
  return downloadUrl;
}

/**
 * Idempotently ensure the user has an avatar persisted in Storage + Firestore.
 * Uses an in-flight flag to avoid duplicate uploads across components/tabs.
 */
export async function ensureUserAvatar(uid, existingUrl) {
  if (!uid) return null;
  if (existingUrl) {
    setCachedAvatarUrl(uid, existingUrl);
    return existingUrl;
  }
  const cached = getCachedAvatarUrl(uid);
  if (cached) return cached;

  const pendingKey = LS_PENDING_PREFIX + uid;
  try {
    if (typeof window !== "undefined" && localStorage.getItem(pendingKey)) return null;
    if (typeof window !== "undefined") localStorage.setItem(pendingKey, "1");
  } catch {
    /* ignore */
  }
  try {
    return await generateAndUploadAvatar(uid);
  } catch (e) {
    console.warn("[avatar] upload failed, falling back to DiceBear URL:", e?.message);
    const fallback = diceBearUrl(uid);
    setCachedAvatarUrl(uid, fallback);
    return fallback;
  } finally {
    try {
      if (typeof window !== "undefined") localStorage.removeItem(pendingKey);
    } catch {
      /* ignore */
    }
  }
}
