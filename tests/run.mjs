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
import { Worker } from "node:worker_threads";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/browser.mjs";
import { createRecorder } from "./lib/assert.mjs";

// A pure suite runs in its own thread so a synchronous infinite loop (real
// bug, see lib/worker-run.mjs) can be killed on a deadline from outside it —
// no in-process timeout can do that, since a tight loop never yields for a
// timer to fire. Browser suites get the weaker Promise.race guard below,
// which is real protection against a forgotten await, not a hung sync loop.
const PURE_SUITE_TIMEOUT_MS = 15000;
const BROWSER_SUITE_TIMEOUT_MS = 60000;

function runPureSuiteInWorker(suiteFile, id) {
  return new Promise((resolve) => {
    const worker = new Worker(path.join(HERE, "lib", "worker-run.mjs"), {
      workerData: { suiteFile, id },
    });
    let settled = false;
    const finish = (results) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(results);
    };
    const timer = setTimeout(() => {
      finish([
        {
          label: `suite did not finish within ${PURE_SUITE_TIMEOUT_MS}ms`,
          pass: false,
          detail: "likely an infinite loop — see lib/worker-run.mjs",
        },
      ]);
    }, PURE_SUITE_TIMEOUT_MS);
    worker.on("message", (msg) => finish(msg.results));
    worker.on("error", (e) => finish([{ label: "worker error", pass: false, detail: e.stack || String(e) }]));
  });
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve([{ label, pass: false, detail: `exceeded ${ms}ms` }]),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const filters = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const verbose = process.argv.includes("--verbose");

const files = (await readdir(path.join(HERE, "suites")))
  .filter((f) => f.endsWith(".test.mjs"))
  .sort();

const suites = [];
for (const file of files) {
  const fullPath = path.join(HERE, "suites", file);
  // pathToFileURL: on Windows a bare absolute path is not a valid ESM specifier.
  const mod = await import(pathToFileURL(fullPath).href);
  const id = file.replace(/\.test\.mjs$/, "");
  if (filters.length && !filters.some((f) => id.includes(f) || (mod.name || "").toLowerCase().includes(f.toLowerCase()))) {
    continue;
  }
  suites.push({ id, mod, file: fullPath });
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
for (const { id, mod, file } of suites) {
  const isPure = mod.needsBrowser === false;
  const t = createRecorder(mod.name || id);
  const started = Date.now();

  if (isPure) {
    // Runs in a worker thread — see the comment above and worker-run.mjs.
    const results = await runPureSuiteInWorker(file, id);
    results.forEach((r) => t.ok(r.label, r.pass, r.detail));
  } else {
    try {
      const guarded = withTimeout(
        mod.default({ browser, origin: server.origin, t }),
        BROWSER_SUITE_TIMEOUT_MS,
        `suite did not finish within ${BROWSER_SUITE_TIMEOUT_MS}ms`
      );
      const timeoutResult = await guarded;
      // withTimeout resolves with an array only when the timeout itself won
      // the race; a normal completion resolves with mod.default's return
      // value (undefined), which every suite here ignores.
      if (Array.isArray(timeoutResult)) {
        timeoutResult.forEach((r) => t.ok(r.label, r.pass, r.detail));
      }
    } catch (e) {
      t.ok("suite ran to completion", false, e.stack || String(e));
    }
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
