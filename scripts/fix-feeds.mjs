#!/usr/bin/env node
// fix-feeds.mjs — repoint or archive feeds from a JSON plan. Dry run by default.
//
// Plan file: [{ "company": "Tandem", "action": "repoint", "source": "ashby", "token": "forus", "rename": "Forus" },
//             { "company": "Clockwise", "action": "archive", "reason": "Company shut down" }]
// "company" matches the feed's company name (case-insensitive) among active feeds.
// Repointing keeps the feed id, so its jobs and history stay attached.
// Safe to re-run: feeds already on the target board, and healthy feeds, are skipped.
//
// Usage: node scripts/fix-feeds.mjs plan.json [--write]

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { db, ADMIN_UID } from "../worker/lib/firestore.mjs";

const require = createRequire(new URL("../worker/package.json", import.meta.url));
const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [planPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const write = process.argv.includes("--write");
if (!planPath) { console.error("Usage: node scripts/fix-feeds.mjs plan.json [--write]"); process.exit(1); }

const URLS = {
  greenhouse: (t) => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=true`,
  ashby: (t) => `https://api.ashbyhq.com/posting-api/job-board/${t}`,
  workday: (t) => t, // careers URL as-is
};
const CHECK = {
  greenhouse: async (t) => { const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${t}/jobs`); return r.ok ? (await r.json()).jobs.length : null; },
  ashby: async (t) => { const r = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${t}`); return r.ok ? (await r.json()).jobs.length : null; },
  workday: async () => 0, // verified by the next sync
};

const plan = JSON.parse(await readFile(planPath, "utf8"));
const f = await db();
const feedsCol = f.collection("users").doc(ADMIN_UID).collection("feeds");
const active = (await feedsCol.where("archivedAt", "==", null).get()).docs;
// A name can have several active feeds (old dead board + new live one): the
// plan is about the failing one.
const byName = new Map();
for (const d of active) {
  const key = String(d.get("company") || d.get("companyName") || "").toLowerCase();
  (byName.get(key) || byName.set(key, []).get(key)).push(d);
}
const pick = (name) => {
  const all = byName.get(String(name).toLowerCase()) || [];
  const failing = all.filter((d) => d.get("lastError"));
  return failing.length === 1 ? failing[0] : all.length === 1 ? all[0] : null;
};

const backup = [];
for (const step of plan) {
  const doc = pick(step.company);
  if (!doc) { console.log(`?? ${step.company}: no single matching active feed; skipped`); continue; }
  if (step.action === "repoint") {
    if (!URLS[step.source]) { console.log(`?? ${step.company}: unsupported source ${step.source}`); continue; }
    const jobs = await CHECK[step.source](step.token);
    if (jobs == null) { console.log(`!! ${step.company}: ${step.source}:${step.token} does not answer; skipped`); continue; }
    const url = URLS[step.source](step.token);
    if (doc.get("url") === url) { console.log(`= ${step.company}: already on ${url}`); continue; }
    console.log(`${write ? "→" : "would"} repoint ${step.company}${step.rename ? ` (now ${step.rename})` : ""}: ${doc.get("url")} → ${url} (${jobs} jobs)`);
    backup.push({ id: doc.id, ...doc.data(), createdAt: doc.get("createdAt")?.toDate?.().toISOString() ?? null });
    if (write) {
      await doc.ref.update({
        source: step.source, url, lastError: null, lastErrorAt: FieldValue.delete(), repointedAt: Timestamp.now(), previousUrl: doc.get("url"),
        ...(step.rename ? { company: step.rename, previousCompany: doc.get("company") || null } : {}),
      });
    }
  } else if (step.action === "archive") {
    // Only failing feeds: a healthy feed with the same name is never archived.
    if (!doc.get("lastError")) { console.log(`= ${step.company}: not failing; left alone`); continue; }
    console.log(`${write ? "→" : "would"} archive ${step.company}: ${step.reason}`);
    backup.push({ id: doc.id, ...doc.data(), createdAt: doc.get("createdAt")?.toDate?.().toISOString() ?? null });
    if (write) await doc.ref.update({ archivedAt: Timestamp.now(), archivedReason: step.reason || "Board gone" });
  }
}

if (write && backup.length) {
  const dir = path.join(__dirname, "..", "private", "backups");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `feeds-before-fix-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.json`);
  await writeFile(file, JSON.stringify(backup, null, 1));
  console.log(`backup: ${file}`);
}
if (!write) console.log("dry run — add --write to apply");
process.exit(0);
