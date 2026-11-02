// archive-roblox.mjs — archive the Roblox feed(s) and delete their jobs (and
// the admin's scores for them). Prints what it would do; pass --apply to do it.
//   node worker/archive-roblox.mjs            # dry run
//   node worker/archive-roblox.mjs --apply
import { db as getDb, ADMIN_UID } from "./lib/firestore.mjs";
import { FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const db = await getDb();
const user = db.collection("users").doc(ADMIN_UID);

const feeds = (await user.collection("feeds").get()).docs
  .filter((d) => /roblox/i.test(`${d.data().companyName || ""} ${d.data().company || ""} ${d.data().url || ""}`));
console.log("feeds:", feeds.map((d) => `${d.id} ${d.data().companyName || d.data().company} ${d.data().url} archived=${!!d.data().archivedAt}`));

const jobs = [];
for (const f of feeds) jobs.push(...(await user.collection("jobs").where("companyKey", "==", f.id).get()).docs);
for (const d of (await user.collection("jobs").where("companyName", "==", "Roblox").get()).docs) if (!jobs.some((j) => j.id === d.id)) jobs.push(d);
const scores = (await Promise.all(jobs.map((j) => user.collection("jobScores").doc(j.id).get()))).filter((s) => s.exists);
console.log(`jobs: ${jobs.length}, scores: ${scores.length}`);
if (!APPLY) { console.log("dry run: nothing changed. Run again with --apply."); process.exit(0); }

for (const f of feeds) if (!f.data().archivedAt) await f.ref.update({ archivedAt: FieldValue.serverTimestamp(), archivedReason: "Archived on request" });
const refs = [...jobs.map((d) => d.ref), ...scores.map((s) => s.ref)];
for (let i = 0; i < refs.length; i += 400) { const b = db.batch(); refs.slice(i, i + 400).forEach((r) => b.delete(r)); await b.commit(); }
console.log(`archived ${feeds.length} feed(s), deleted ${jobs.length} jobs and ${scores.length} scores`);
process.exit(0);
