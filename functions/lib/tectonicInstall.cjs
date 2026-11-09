/**
 * functions/lib/tectonicInstall.cjs
 *
 * Download the Tectonic LaTeX engine for Linux into `dir` (bin/tectonic) and
 * warm its resource cache (cache/) by compiling the resume template once, so
 * later compiles run with --only-cached and no network.
 *
 * Used twice: by scripts/setup-tectonic.cjs during the functions build, and by
 * lib/resumePdf.cjs at runtime when the build left no engine behind (the
 * Cloud Functions build reuses cached node_modules when package.json and the
 * lockfile are unchanged, and then npm "postinstall" never runs: 2026-11-09).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const run = promisify(execFile);
const VERSION = "0.17.0";
const WARMUP = path.join(__dirname, "..", "scripts", "tectonic-warmup.tex");

function pathsIn(dir) {
  return { bin: path.join(dir, "bin", "tectonic"), cacheDir: path.join(dir, "cache") };
}

/** Whether `dir` holds an engine and a warmed cache. */
function installedIn(dir) {
  const { bin, cacheDir } = pathsIn(dir);
  try {
    return fs.existsSync(bin) && fs.readdirSync(cacheDir).length > 0;
  } catch {
    return false;
  }
}

/** @returns {Promise<{ bin: string, cacheDir: string }>} */
async function installTectonic(dir, log = console.log) {
  const { bin, cacheDir } = pathsIn(dir);
  const binDir = path.dirname(bin);
  if (installedIn(dir)) return { bin, cacheDir };
  await fs.promises.mkdir(binDir, { recursive: true });
  if (!fs.existsSync(bin)) {
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    const asset = `tectonic-${VERSION}-${arch}-unknown-linux-musl.tar.gz`;
    const url = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${VERSION}/${asset}`;
    log(`tectonic: downloading ${asset}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
    const tgz = path.join(binDir, asset);
    await fs.promises.writeFile(tgz, Buffer.from(await res.arrayBuffer()));
    await run("tar", ["-xzf", tgz, "-C", binDir]);
    await fs.promises.unlink(tgz);
    await fs.promises.chmod(bin, 0o755);
  }
  log(`tectonic: ${(await run(bin, ["--version"])).stdout.trim()}`);

  // Warm the cache: one online compile of a document that uses every package,
  // font size and command the resume template uses, then prove it works offline.
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const out = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tectonic-warmup-"));
  const env = { ...process.env, TECTONIC_CACHE_DIR: cacheDir };
  try {
    log("tectonic: warming the resource cache");
    await run(bin, ["--chatter", "minimal", "-o", out, WARMUP], { env, maxBuffer: 16 << 20 });
    await run(bin, ["--untrusted", "--only-cached", "--chatter", "minimal", "-o", out, WARMUP], { env, maxBuffer: 16 << 20 });
    const pdf = (await fs.promises.stat(path.join(out, "tectonic-warmup.pdf"))).size;
    log(`tectonic: ready (warm-up PDF ${pdf} bytes)`);
  } catch (err) {
    // A half-warmed cache would make installedIn() lie next time.
    await fs.promises.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  } finally {
    await fs.promises.rm(out, { recursive: true, force: true }).catch(() => {});
  }
  return { bin, cacheDir };
}

module.exports = { installTectonic, installedIn, pathsIn, VERSION };
