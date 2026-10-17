// compileResumePdf helpers. The compile test runs only when a Tectonic binary
// and a warmed cache are available (TECTONIC_BIN + TECTONIC_CACHE_DIR, or the
// build-time functions/.tectonic install); it is skipped elsewhere.
// Run: npm test (in functions/)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { validateResumeTex, compileResumeTex, tectonicPaths, MAX_TEX_CHARS } = require("../lib/resumePdf.cjs");

const HAVE_TECTONIC = fs.existsSync(tectonicPaths().bin);
const WARMUP = fs.readFileSync(path.join(__dirname, "..", "scripts", "tectonic-warmup.tex"), "utf8");

test("validateResumeTex accepts the template and rejects everything else", () => {
  assert.equal(validateResumeTex(WARMUP), true);
  assert.throws(() => validateResumeTex(""), /No LaTeX source/);
  assert.throws(() => validateResumeTex(42), /No LaTeX source/);
  assert.throws(() => validateResumeTex("x".repeat(MAX_TEX_CHARS + 1)), /too large/);
  assert.throws(() => validateResumeTex("\\documentclass{article}\\begin{document}hi\\end{document}"), /resume template/);
  assert.throws(() => validateResumeTex(WARMUP.replace("\\end{document}", "")), /missing \\end\{document\}/);
  assert.throws(() => validateResumeTex(WARMUP.replace("\\begin{document}", "\\begin{document}\\input{/etc/passwd}")), /isn't allowed/);
  assert.throws(() => validateResumeTex(WARMUP.replace("\\begin{document}", "\\begin{document}\\immediate\\write18{ls}")), /isn't allowed/);
});

test("the warm-up document is the resume template (keeps the build-time cache honest)", () => {
  for (const cmd of ["\\resumeSubheading", "\\resumeProjectHeading", "\\resumeItem", "\\Needspace", "\\href", "\\section{Certifications}", "\\ifdefined\\pdfgentounicode"]) {
    assert.ok(WARMUP.includes(cmd), `warm-up is missing ${cmd}`);
  }
});

test("compileResumeTex typesets the warm-up document", { skip: !HAVE_TECTONIC && "no tectonic binary (set TECTONIC_BIN + TECTONIC_CACHE_DIR)" }, async () => {
  const { pdf } = await compileResumeTex(WARMUP);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 10_000, `pdf is only ${pdf.length} bytes`);
});

test("compileResumeTex reports the TeX error, not just an exit code", { skip: !HAVE_TECTONIC && "no tectonic binary" }, async () => {
  const broken = WARMUP.replace("\\begin{document}", "\\begin{document}\\undefinedcommandxyz");
  await assert.rejects(() => compileResumeTex(broken), /Undefined control sequence|undefinedcommandxyz|error/);
});

test("tectonicPaths honours the env overrides", () => {
  const { bin, cacheDir } = tectonicPaths();
  assert.ok(bin.endsWith("tectonic") || process.env.TECTONIC_BIN, bin);
  assert.ok(cacheDir.length > 0);
});
