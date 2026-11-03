// Mark applications as submitted when the browser reached the board's own
// confirmation page but the extension never recorded it (an extension older
// than 1.11.5 had no thank-you-page watcher, so a Greenhouse submit that
// navigated to /embed/job_app/confirmation was logged as "the tab was closed").
// Without this the ledger's duplicate guard does not know about them, and
// "Retry failed jobs" would apply a second time.
//
// Input: lines "<org>&token=<id>|<yyyy-mm-dd hh:mm:ss local>" (from Edge's
// History: visits to greenhouse.io/embed/job_app/confirmation).
// Usage: node scripts/mark-confirmed-submissions.mjs <uid> <file> [--apply]
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const { recordEvent, formKeyOf, docIdOf } = require("../functions/lib/apply/ledger.cjs");

const [uid, file, flag] = process.argv.slice(2);
if (!uid || !file) { console.error("usage: <uid> <file> [--apply]"); process.exit(1); }
const apply = flag === "--apply";
const sa = JSON.parse(await readFile(new URL("../worker/service-account.json", import.meta.url), "utf8"));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const apps = db.collection("users").doc(uid).collection("applications");

const lines = (await readFile(file, "utf8")).split("\n").map((l) => l.trim()).filter(Boolean);
for (const line of lines) {
  const [key, when] = line.split("|");
  const m = key.match(/^([^&]+)&token=(\d+)/);
  if (!m) { console.log("skip", line); continue; }
  const [, org, id] = m;
  const formKey = formKeyOf("greenhouse", org, id);
  const snap = await apps.doc(docIdOf(formKey)).get();
  const cur = snap.exists ? snap.data() : null;
  if (cur?.status === "submitted") { console.log("already submitted", formKey); continue; }
  const at = new Date(when.replace(" ", "T")); // local time on this machine
  console.log(`${apply ? "MARK" : "would mark"} ${formKey} (${cur?.status || "no record"}) submitted at ${at.toISOString()}`);
  if (!apply) continue;
  await recordEvent(db, uid, {
    event: "submitted",
    formKey,
    source: "greenhouse",
    org,
    postingId: id,
    applyUrl: `https://job-boards.greenhouse.io/embed/job_app?for=${org}&token=${id}`,
    companyName: cur?.companyName || "",
    jobTitle: cur?.jobTitle || "",
    ...(cur?.jobId ? { jobId: cur.jobId } : {}),
  }, at);
}
