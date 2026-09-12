// Runs one non-browser suite inside a worker thread.
//
// This exists because of a real bug: melody-model.js's layoutBars once had a
// synchronous `while` loop that never terminated. A same-process timeout
// (Promise.race, setTimeout) cannot rescue that — a tight synchronous loop
// never yields to the event loop, so no timer fires until the process is
// killed from outside. A worker thread runs on its own thread with its own
// event loop; the parent can terminate it on a wall-clock deadline no matter
// what the worker's JS is doing.
//
// Only pure suites (`needsBrowser === false`) run this way: they need nothing
// but the import, so there is no Puppeteer Browser object to hand across the
// thread boundary (which isn't possible — a Browser handle isn't structured
// -cloneable). Browser suites get a lighter Promise.race guard in run.mjs
// instead, which is real protection against a forgotten await, just not
// against a synchronous infinite loop.
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { createRecorder } from "./assert.mjs";

async function main() {
  const mod = await import(pathToFileURL(workerData.suiteFile).href);
  const t = createRecorder(mod.name || workerData.id);
  try {
    await mod.default({ t });
  } catch (e) {
    t.ok("suite ran to completion", false, e.stack || String(e));
  }
  parentPort.postMessage({ results: t.results });
}

main().catch((e) => {
  parentPort.postMessage({
    results: [{ label: "worker crashed", pass: false, detail: e.stack || String(e) }],
  });
});
