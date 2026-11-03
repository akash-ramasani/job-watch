// apply-stats.mjs — read-only: Ashby and Greenhouse jobs on the Jobs page
// (All jobs filter), how many are applied to, and how many are left.
//   node worker/apply-stats.mjs
// Same rules as the auto-apply queue (functions/lib/apply/autoApply.cjs).
// Reads only; writes nothing.
import { createRequire } from "node:module";
import { db as getDb, ADMIN_UID } from "./lib/firestore.mjs";

const require = createRequire(import.meta.url);
const { buildQueue } = require("../functions/lib/apply/autoApply.cjs");

const db = await getDb();
const queue = await buildQueue(db, ADMIN_UID, { adminUid: ADMIN_UID });
const st = queue.stats;
const apps = await db.collection("users").doc(ADMIN_UID).collection("applications").get();
const submitted = apps.docs.filter((d) => d.data().status === "submitted");
const bySource = (s) => submitted.filter((d) => String(d.data().source || d.id).toLowerCase().includes(s)).length;

const row = (name, x) => `${name.padEnd(11)} ${String(x.total).padStart(5)} on the Jobs page   ${String(x.applied).padStart(5)} applied   ${String(x.left).padStart(5)} left`;
console.log(row("Ashby", st.ashby));
console.log(row("Greenhouse", st.greenhouse));
console.log(row("Both", { total: st.ashby.total + st.greenhouse.total, applied: st.ashby.applied + st.greenhouse.applied, left: st.ashby.left + st.greenhouse.left }));
console.log(`\nAll submitted applications on record: ${submitted.length} (Ashby ${bySource("ashby")}, Greenhouse ${bySource("greenhouse")}), including jobs no longer on the Jobs page.`);
console.log("Next up:", queue.slice(0, 5).map((j) => `${j.companyName} · ${j.title}`).join(" | ") || "nothing");
process.exit(0);
