#!/usr/bin/env node
// run-sync-now.mjs — trigger the production sync from the terminal, exactly
// like the "Run sync now" button on the Feeds page, and print the summary.
//
// Mints a custom token for the admin with worker/service-account.json,
// exchanges it for an ID token (needs VITE_FIREBASE_API_KEY from .env), then
// calls the runSyncNow HTTP function. The sync can take several minutes.
//
// Usage: node scripts/run-sync-now.mjs

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { db, ADMIN_UID } from "../worker/lib/firestore.mjs";

// firebase-admin is installed under worker/, not at the repo root.
const require = createRequire(new URL("../worker/package.json", import.meta.url));
const { getAuth } = require("firebase-admin/auth");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ID = "greenhouse-jobs-scrapper";
const REGION = "us-central1";

async function readApiKey() {
  if (process.env.VITE_FIREBASE_API_KEY) return process.env.VITE_FIREBASE_API_KEY;
  const env = await readFile(path.join(__dirname, "..", ".env"), "utf8");
  const m = env.match(/^VITE_FIREBASE_API_KEY=(.+)$/m);
  if (!m) throw new Error("VITE_FIREBASE_API_KEY not found in .env");
  return m[1].trim().replace(/^["']|["']$/g, "");
}

await db(); // initialises the admin app
const customToken = await getAuth().createCustomToken(ADMIN_UID);
const apiKey = await readApiKey();

const signIn = await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  }
);
if (!signIn.ok) throw new Error(`signInWithCustomToken failed: ${signIn.status} ${await signIn.text()}`);
const { idToken } = await signIn.json();

const url = `https://${REGION}-${PROJECT_ID}.cloudfunctions.net/runSyncNow?userId=${encodeURIComponent(ADMIN_UID)}`;
console.log(`POST ${url}\n(waiting — a full sync can take a few minutes)`);
const startedAt = Date.now();
let resp;
try {
  resp = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${idToken}` },
  });
} catch (err) {
  // The HTTP connection is dropped after ~5 minutes, but the function keeps
  // running to its 540 s limit. Long runs (e.g. seeding many feeds) finish
  // server-side; the result lands in users/{ADMIN_UID}/syncRuns.
  console.log(`\nConnection dropped after ${Math.round((Date.now() - startedAt) / 1000)}s (${err?.cause?.code || err.message}).`);
  console.log("The sync is still running in Cloud Functions — check the Feeds page sync history or users/{ADMIN_UID}/syncRuns.");
  process.exit(0);
}
const text = await resp.text();
console.log(`\nHTTP ${resp.status} after ${Math.round((Date.now() - startedAt) / 1000)}s`);
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}
process.exit(resp.ok ? 0 : 1);
