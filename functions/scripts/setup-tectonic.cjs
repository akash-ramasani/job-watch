#!/usr/bin/env node
// setup-tectonic.cjs — Cloud Functions build step (package.json "postinstall",
// which the Cloud Build npm install runs; Firebase's build skipped "gcp-build"):
// download the Tectonic LaTeX engine for Linux and warm its resource cache by
// compiling the resume template once, so compileResumePdf runs with no
// network at request time. Skips on macOS/Windows (local dev uses a Homebrew
// tectonic through TECTONIC_BIN / TECTONIC_CACHE_DIR instead).
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const VERSION = "0.17.0";
const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, ".tectonic");
const BIN_DIR = path.join(DIR, "bin");
const BIN = path.join(BIN_DIR, "tectonic");
const CACHE = path.join(DIR, "cache");
const WARMUP = path.join(__dirname, "tectonic-warmup.tex");

if (process.platform !== "linux") {
  console.log(`setup-tectonic: ${process.platform} is not linux, skipping (set TECTONIC_BIN for local use)`);
  process.exit(0);
}

async function main() {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const asset = `tectonic-${VERSION}-${arch}-unknown-linux-musl.tar.gz`;
  const url = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${VERSION}/${asset}`;
  fs.mkdirSync(BIN_DIR, { recursive: true });
  if (fs.existsSync(BIN) && fs.existsSync(CACHE) && fs.readdirSync(CACHE).length) {
    console.log("setup-tectonic: already installed");
    return;
  }
  if (!fs.existsSync(BIN)) {
    console.log(`setup-tectonic: downloading ${asset}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
    const tgz = path.join(BIN_DIR, asset);
    fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
    execFileSync("tar", ["-xzf", tgz, "-C", BIN_DIR]);
    fs.unlinkSync(tgz);
    fs.chmodSync(BIN, 0o755);
  }
  console.log("setup-tectonic:", execFileSync(BIN, ["--version"]).toString().trim());

  // Warm the cache: one online compile of a document that uses every package,
  // font size and command the resume template uses.
  fs.mkdirSync(CACHE, { recursive: true });
  const out = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "tectonic-warmup-"));
  const env = { ...process.env, TECTONIC_CACHE_DIR: CACHE };
  console.log("setup-tectonic: warming the resource cache");
  execFileSync(BIN, ["--chatter", "minimal", "-o", out, WARMUP], { env, stdio: "inherit" });
  // Prove the cache is complete: the same compile must work offline.
  execFileSync(BIN, ["--untrusted", "--only-cached", "--chatter", "minimal", "-o", out, WARMUP], { env, stdio: "inherit" });
  const pdf = fs.statSync(path.join(out, "tectonic-warmup.pdf")).size;
  fs.rmSync(out, { recursive: true, force: true });
  const files = fs.readdirSync(CACHE, { recursive: true }).length;
  console.log(`setup-tectonic: ready (warm-up PDF ${pdf} bytes, ${files} cached files)`);
}

main().catch((err) => {
  // Never fail the whole functions build over the PDF engine: compileResumePdf
  // answers "unavailable" and the web app falls back to its local renderer.
  console.error("setup-tectonic failed (compileResumePdf will be unavailable):", err.message);
  process.exit(0);
});
