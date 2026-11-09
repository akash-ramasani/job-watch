#!/usr/bin/env node
// setup-tectonic.cjs — Cloud Functions build step (package.json "postinstall",
// which the Cloud Build npm install runs; Firebase's build skipped "gcp-build"):
// download the Tectonic LaTeX engine for Linux and warm its resource cache, so
// compileResumePdf runs with no network at request time. Skips on
// macOS/Windows (local dev uses a Homebrew tectonic through TECTONIC_BIN /
// TECTONIC_CACHE_DIR instead).
//
// The build does not always run this (cached node_modules skip npm install),
// so lib/resumePdf.cjs installs the engine itself at runtime when it is missing.
const path = require("node:path");
const { installTectonic } = require("../lib/tectonicInstall.cjs");

if (process.platform !== "linux") {
  console.log(`setup-tectonic: ${process.platform} is not linux, skipping (set TECTONIC_BIN for local use)`);
  process.exit(0);
}

installTectonic(path.join(__dirname, "..", ".tectonic"), (m) => console.log(`setup-tectonic: ${m}`)).catch((err) => {
  // Never fail the whole functions build over the PDF engine: the runtime
  // installs it on first use instead.
  console.error("setup-tectonic failed (the server will install it on first use):", err.message);
  process.exit(0);
});
