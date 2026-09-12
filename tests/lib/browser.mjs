// Browser plumbing: find a Chrome, open the app with a known localStorage state,
// and collect page errors.
//
// puppeteer-core rather than puppeteer: it drives a Chrome that is already on
// the machine instead of downloading its own, which keeps the install small.
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";

const CANDIDATES = {
  win32: [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ],
};

export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const p of CANDIDATES[process.platform] || []) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    "No Chrome found. Set CHROME_PATH to a Chrome or Edge executable."
  );
}

export async function launch() {
  return puppeteer.launch({
    executablePath: findChrome(),
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}

// Open the app with `state` written to localStorage.
//
// The app reads localStorage while it boots, so the page is loaded once to get
// an origin to write into, seeded, then reloaded to boot against that state.
export async function openApp(browser, origin, { state = {}, viewport = {} } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000, ...viewport });

  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });

  const url = `${origin}/index.html`;
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.evaluate((s) => {
    localStorage.clear();
    for (const [k, v] of Object.entries(s)) {
      localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
    }
  }, state);
  await page.goto(url, { waitUntil: "networkidle0" });

  // Cards are built, then their black keys are placed a frame later, then the
  // sheet repaginates. Settle before measuring anything.
  await page.evaluate(
    () =>
      new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 400)))
      )
  );

  page.pageErrors = errors;
  return page;
}

// A board with one section, shaped the way script.js stores them.
export function board(chords, { id = "s_test", name = "Intro/vers" } = {}) {
  return [
    {
      id,
      name,
      chords: chords.map((sym, i) => ({ id: `c_${i}_${sym}`, sym, inversion: 0 })),
    },
  ];
}

export function layoutDoc(blocks) {
  return {
    format: "z-chords-layout",
    version: 1,
    columns: 12,
    gutterMm: 4,
    rowGapMm: 4,
    blocks,
  };
}
