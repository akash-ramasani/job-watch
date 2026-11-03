// applications-start-fresh.mjs — the Applications page shows only activity
// from a given moment on (users/{uid}.applicationsSince). Older records stay:
// they are what stops JobWatch from applying to the same job twice.
//   node worker/applications-start-fresh.mjs                 # from the coming midnight (this Mac's time)
//   node worker/applications-start-fresh.mjs 2026-11-03T00:00:00-08:00
// Changes that one field; nothing else.
import { db as getDb, ADMIN_UID } from "./lib/firestore.mjs";

const arg = process.argv[2];
let since;
if (arg) since = new Date(arg);
else { since = new Date(); since.setHours(24, 0, 0, 0); } // the next midnight
if (Number.isNaN(since.getTime())) { console.log(`Not a date: ${arg}`); process.exit(1); }

const db = await getDb();
await db.collection("users").doc(ADMIN_UID).set({ applicationsSince: since.toISOString() }, { merge: true });
console.log(`Applications page now starts at ${since.toLocaleString()} (${since.toISOString()}). Older applications are hidden there and still prevent duplicates.`);
process.exit(0);
