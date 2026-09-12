// Test runner.
//
//   npm test                 run everything
//   npm test -- keys board   run only suites whose name matches
//   CHROME_PATH=... npm test  point at a specific browser
//
// Starts its own static server on a free port, so nothing needs to be running
// first and a stray server on :8000 cannot make the results lie.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/browser.mjs";
import { createRecorder } from "./lib/assert.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const filters = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const verbose = process.argv.includes("--verbose");

const files = (await readdir(path.join(HERE, "suites")))
  .filter((f) => f.endsWith(".test.mjs"))
  .sort();

const suites = [];
for (const file of files) {
  // pathToFileURL: on Windows a bare absolute path is not a valid ESM specifier.
  const mod = await import(pathToFileURL(path.join(HERE, "suites", file)).href);
  const id = file.replace(/\.test\.mjs$/, "");
  if (filters.length && !filters.some((f) => id.includes(f) || (mod.name || "").toLowerCase().includes(f.toLowerCase()))) {
    continue;
  }
  suites.push({ id, mod });
}

if (!suites.length) {
  console.error(filters.length ? `No suites match: ${filters.join(", ")}` : "No suites found.");
  process.exit(1);
}

const needsBrowser = suites.some((s) => s.mod.needsBrowser !== false);
const server = await startServer();
let browser = null;
if (needsBrowser) {
  try {
    browser = await launch();
  } catch (e) {
    await server.close();
    console.error(`\n${e.message}\n`);
    process.exit(1);
  }
}

console.log(`z-chords tests — ${suites.length} suite${suites.length === 1 ? "" : "s"}, serving ${server.origin}\n`);

const records = [];
for (const { id, mod } of suites) {
  const t = createRecorder(mod.name || id);
  const started = Date.now();
  try {
    await mod.default({ browser, origin: server.origin, t });
  } catch (e) {
    t.ok("suite ran to completion", false, e.stack || String(e));
  }
  const ms = Date.now() - started;
  const failed = t.failed;
  const icon = failed.length ? "FAIL" : "ok  ";
  console.log(`${icon} ${(mod.name || id).padEnd(24)} ${String(t.results.length).padStart(3)} checks  ${ms}ms`);
  if (verbose) {
    for (const r of t.results) console.log(`       ${r.pass ? "·" : "x"} ${r.label}${r.detail ? "  — " + r.detail : ""}`);
  } else {
    for (const r of failed) console.log(`       x ${r.label}${r.detail ? "  — " + r.detail : ""}`);
  }
  records.push({ name: mod.name || id, t });
}

if (browser) await browser.close();
await server.close();

const total = records.reduce((n, r) => n + r.t.results.length, 0);
const failed = records.reduce((n, r) => n + r.t.failed.length, 0);
console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
