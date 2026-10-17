/**
 * functions/lib/resumePdf.cjs
 *
 * Compile a resume's LaTeX (src/lib/resumeLatex.js output) to PDF with
 * Tectonic, so the PDF a user downloads is the real typeset document and not
 * the jsPDF approximation. Tectonic and a pre-warmed resource cache are put
 * in functions/.tectonic by scripts/setup-tectonic.cjs during the Cloud
 * Functions build (npm "gcp-build"), so a compile needs no network: it runs
 * with --only-cached and --untrusted (no shell escape, no reads outside the
 * job directory) and takes well under a second.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const TECTONIC_DIR = path.join(__dirname, "..", ".tectonic");
const MAX_TEX_CHARS = 200_000;

function tectonicPaths() {
  return {
    bin: process.env.TECTONIC_BIN || path.join(TECTONIC_DIR, "bin", "tectonic"),
    cacheDir: process.env.TECTONIC_CACHE_DIR || path.join(TECTONIC_DIR, "cache"),
  };
}

async function tectonicAvailable() {
  try {
    await fs.access(tectonicPaths().bin);
    return true;
  } catch {
    return false;
  }
}

/** Throws with a user-readable message when `tex` isn't a resume in our template. */
function validateResumeTex(tex) {
  if (typeof tex !== "string" || !tex.trim()) throw new Error("No LaTeX source was sent.");
  if (tex.length > MAX_TEX_CHARS) throw new Error(`LaTeX source is too large (${tex.length} characters; limit ${MAX_TEX_CHARS}).`);
  for (const marker of ["\\documentclass", "\\begin{document}", "\\end{document}"]) {
    if (!tex.includes(marker)) throw new Error(`LaTeX source is missing ${marker}.`);
  }
  if (!/\\resumeSubheading|\\resumeItem|\\resumeProjectHeading/.test(tex)) throw new Error("LaTeX source doesn't use the resume template.");
  // Belt and braces on top of --untrusted: nothing that reaches outside the job.
  if (/\\write18|\\openout|\\openin|\\input\s*\{\s*[/~]|\\include\s*\{\s*[/~]|\\directlua|\\ShellEscape/.test(tex)) {
    throw new Error("LaTeX source contains a command that isn't allowed.");
  }
  return true;
}

/**
 * @returns {Promise<{ pdf: Buffer, log: string }>}
 */
async function compileResumeTex(tex, { timeoutMs = 60_000 } = {}) {
  validateResumeTex(tex);
  const { bin, cacheDir } = tectonicPaths();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "resume-"));
  const texPath = path.join(dir, "resume.tex");
  try {
    await fs.writeFile(texPath, tex, "utf8");
    const log = await new Promise((resolve, reject) => {
      const child = spawn(bin, ["--untrusted", "--only-cached", "--chatter", "minimal", "-o", dir, texPath], {
        cwd: dir,
        env: { ...process.env, TECTONIC_CACHE_DIR: cacheDir, HOME: dir },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`timed out after ${timeoutMs} ms`)); }, timeoutMs);
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      child.on("error", (err) => { clearTimeout(timer); reject(err); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve(out);
        // Surface the TeX error lines, not Tectonic's chatter.
        const lines = out.split("\n").filter((l) => /^(error|!)|^l\.\d+/.test(l.trim())).slice(0, 6);
        reject(new Error(lines.join(" | ") || `tectonic exited with code ${code}`));
      });
    });
    const pdf = await fs.readFile(path.join(dir, "resume.pdf"));
    return { pdf, log };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { tectonicPaths, tectonicAvailable, validateResumeTex, compileResumeTex, MAX_TEX_CHARS };
