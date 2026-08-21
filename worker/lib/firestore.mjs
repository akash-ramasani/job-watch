// firestore.mjs — Firebase Admin access for the worker.
// Uses worker/service-account.json (git-ignored). Read-mostly: the worker reads
// the profile, resume, and scored jobs, and later writes apply records +
// the review queue.

import { readFile } from "node:fs/promises";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const KEY_PATH = new URL("../service-account.json", import.meta.url);
const STORAGE_BUCKET = "greenhouse-jobs-scrapper.firebasestorage.app";

let _app;
async function app() {
  if (_app) return _app;
  if (getApps().length) return (_app = getApps()[0]);
  const sa = JSON.parse(await readFile(KEY_PATH, "utf8"));
  _app = initializeApp({ credential: cert(sa), storageBucket: STORAGE_BUCKET });
  return _app;
}

export async function db() {
  return getFirestore(await app());
}
export async function bucket() {
  return getStorage(await app()).bucket();
}

/** The single user of this personal tool. */
export const ADMIN_UID = "7Tojjo8l5PZIYctPmdwncf7PC133";

/** Read the user profile doc (identity, links, compliance settings). */
export async function getProfile(uid = ADMIN_UID) {
  const snap = await (await db()).collection("users").doc(uid).get();
  return snap.exists ? snap.data() : null;
}

/** Read the parsed resume subdoc (summary, skills, roles, education, ...). */
export async function getResume(uid = ADMIN_UID) {
  const snap = await (await db()).collection("users").doc(uid).collection("resume").doc("profile").get();
  return snap.exists ? snap.data() : null;
}

/** Download the user's REAL uploaded resume PDF to destPath. Uses the stored
 *  download URL (resumeUrl). Returns destPath, or null if there is no resume. */
export async function downloadResume(destPath, uid = ADMIN_UID) {
  const { writeFile } = await import("node:fs/promises");
  const resume = await getResume(uid);
  const url = resume?.resumeUrl;
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`resume download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(destPath, buf);
  return destPath;
}
