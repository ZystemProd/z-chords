// The cloud song library, driven through the real UI against the Auth and
// Firestore emulators.
//
//   npm run test:cloud
//
// `?emulator` makes cloud.js connect to the emulators and expose a test-only
// sign-in that takes an unsigned Google token — the emulator accepts those, so
// no real account and no popup are involved.
import assert from "node:assert/strict";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startServer } from "../lib/server.mjs";
import { launch, board } from "../lib/browser.mjs";

let server, browser;
// Unique per run so leftovers from an earlier run cannot satisfy a check.
const RUN = Date.now().toString(36);
const ALICE = `alice-${RUN}`;
const BOB = `bob-${RUN}`;

before(async () => {
  server = await startServer();
  browser = await launch();
});

after(async () => {
  await browser?.close();
  await server?.close();
});

// Open the app on the emulators with `state` in localStorage. Every confirm()
// is answered by the next entry of `page.answers` (default: accept) and its
// text recorded in `page.dialogs`.
async function openCloudApp(context, state = {}) {
  const page = await context.newPage();
  await page.setViewport({ width: 1300, height: 900 });
  page.errors = [];
  page.dialogs = [];
  page.answers = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") page.errors.push(m.text());
  });
  page.on("dialog", async (d) => {
    page.dialogs.push(d.message());
    const accept = page.answers.length ? page.answers.shift() : true;
    await (accept ? d.accept() : d.dismiss());
  });
  const url = `${server.origin}/index.html?emulator`;
  await page.goto(url, { waitUntil: "load" });
  await page.evaluate((s) => {
    localStorage.clear();
    for (const [k, v] of Object.entries(s))
      localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
  }, state);
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => window.__cloudTest, { timeout: 15000 });
  return page;
}

async function signIn(page, uid) {
  await page.evaluate((u) => window.__cloudTest.signIn(u, `${u}@example.com`), uid);
  await page.waitForSelector("#cloudSongs.signed-in");
  // First sign-in asks for a username before anything else.
  if (!(await page.$eval("#cloudModal", (m) => m.style.display === "block")))
    await page.click("#cloudSongs");
  await page.waitForSelector("#cloudUsername, #cloudSave:not([disabled])");
  if (await page.$("#cloudUsername")) {
    await page.type("#cloudUsername", `user_${uid}`);
    await page.$eval("#cloudUsernameSave", (b) => b.click());
    await page.waitForSelector("#cloudSave:not([disabled])");
  }
}

async function openModal(page) {
  if (!(await page.$eval("#cloudModal", (m) => m.style.display === "block")))
    await page.click("#cloudSongs");
  await page.waitForSelector("#cloudModal #cloudSave:not([disabled])");
}

async function waitForList(page, predicate) {
  await page.waitForFunction(
    (src) => {
      const items = [...document.querySelectorAll("#cloudList .cloud-item-title")].map(
        (e) => e.firstChild.textContent
      );
      const empty = !!document.querySelector("#cloudBody .cloud-note") &&
        [...document.querySelectorAll("#cloudBody .cloud-note")].some((n) => n.textContent === "No songs saved yet.");
      return new Function("items", "empty", `return (${src})(items, empty)`)(items, empty);
    },
    { timeout: 10000 },
    predicate.toString()
  );
}

async function waitForStatus(page, text) {
  await page.waitForFunction(
    (t) => document.querySelector("#cloudBody .cloud-status")?.textContent.includes(t),
    { timeout: 10000 },
    text
  );
}

// Click inside the page: the modal re-renders on every list refresh, so a
// handle Puppeteer found a moment earlier can be detached by the time it clicks.
const press = (page, sel) =>
  page.$eval(sel, (el) => el.click());

const cardCount = (page) => page.$$eval("#boards .card", (c) => c.length);

test("signed out, the library offers sign-in and nothing else", async () => {
  const page = await openCloudApp(browser.defaultBrowserContext());
  await page.click("#cloudSongs");
  await page.waitForSelector("#cloudSignIn");
  assert.equal(await page.$("#cloudSave"), null, "no Save while signed out");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("save, reopen, conflict, isolation, file load and delete", async () => {
  const deviceA = await browser.createBrowserContext();
  const deviceB = await browser.createBrowserContext();
  const a = await openCloudApp(deviceA, {
    "cv-sections-piano": board(["C", "G"]),
    "cv-title": "Cloud test",
    "cv-instrument": "piano",
    "cv-subtabs": { piano: "chord" },
  });

  // --- save -----------------------------------------------------------------
  await signIn(a, ALICE);
  await openModal(a);
  assert.equal(await a.$eval("#cloudSave", (b) => b.textContent), "Save to my songs");
  await press(a, "#cloudSave");
  // Wait for the status, not the list: Firestore shows a pending write in query
  // results straight away, so the list can show the song before it is saved.
  await waitForStatus(a, "Saved to your songs.");
  await waitForList(a, (items) => items.includes("Cloud test"));
  assert.equal(await a.$eval("#cloudSave", (b) => b.textContent), "Save", "linked after saving");
  assert.ok(await a.$("#cloudList .cloud-item.current"), "the saved song is marked open");

  // --- reopen into an empty board ------------------------------------------
  await a.evaluate(() => {
    localStorage.setItem("cv-sections-piano", "[]");
    localStorage.setItem("cv-title", "");
    localStorage.removeItem("cv-cloud-song");
  });
  await a.reload({ waitUntil: "load" });
  await a.waitForSelector("#cloudSongs.signed-in");
  assert.equal(await cardCount(a), 0, "board emptied before reopening");
  await openModal(a);
  await waitForList(a, (items) => items.includes("Cloud test"));
  await press(a, "#cloudList .cloud-open");
  await waitForStatus(a, "Opened");
  assert.equal(await cardCount(a), 2, "both chords came back");
  assert.equal(await a.$eval("#songTitle", (i) => i.value), "Cloud test");
  assert.equal(a.dialogs.length, 0, "no replace prompt over an empty board");

  // --- conflict: device B saves after A opened -----------------------------
  const b = await openCloudApp(deviceB);
  await signIn(b, ALICE);
  await openModal(b);
  await waitForList(b, (items) => items.includes("Cloud test"));
  await press(b, "#cloudList .cloud-open");
  await waitForStatus(b, "Opened");
  await press(b, "#cloudSave");
  await waitForStatus(b, "Saved.");

  a.answers.push(false); // first time: keep the other device's version
  await press(a, "#cloudSave");
  await waitForStatus(a, "Not saved.");
  assert.match(a.dialogs.at(-1), /another device/, "A was warned about B's save");

  a.answers.push(true); // second time: overwrite it
  await press(a, "#cloudSave");
  await waitForStatus(a, "Saved.");
  assert.match(a.dialogs.at(-1), /another device/);

  // A is now current, so a further save goes straight through.
  const before = a.dialogs.length;
  await press(a, "#cloudSave");
  await waitForStatus(a, "Saved.");
  assert.equal(a.dialogs.length, before, "no warning once up to date");

  // --- another user sees none of it ----------------------------------------
  await press(b, "#cloudSignOut");
  await b.waitForSelector("#cloudSongs:not(.signed-in)");
  await signIn(b, BOB);
  await openModal(b);
  await waitForList(b, (items, empty) => empty);
  assert.equal(await b.$eval("#cloudSave", (x) => x.textContent), "Save to my songs",
    "Alice's link does not carry over to Bob");

  // --- loading a file detaches the cloud link -------------------------------
  const dir = await mkdtemp(path.join(tmpdir(), "zc-cloud-"));
  const file = path.join(dir, "other.json");
  const song = await a.evaluate(() => {
    // Any valid song file will do; reuse the format the app writes.
    return { format: "z-chords-song", version: 3, title: "From a file", subtitle: "",
      boards: { piano: { sections: [] }, guitar: { sections: [] } } };
  });
  await writeFile(file, JSON.stringify(song));
  await a.keyboard.press("Escape"); // the modal's backdrop would take the click
  const [chooser] = await Promise.all([a.waitForFileChooser(), a.click("#loadSong")]);
  await chooser.accept([file]);
  await a.waitForFunction(() => document.querySelector("#songTitle").value === "From a file");
  await openModal(a);
  assert.equal(await a.$eval("#cloudSave", (x) => x.textContent), "Save to my songs",
    "a file is not the cloud song, so Save must not overwrite it");

  // --- delete -----------------------------------------------------------------
  await waitForList(a, (items) => items.includes("Cloud test"));
  a.answers.push(true);
  await press(a, "#cloudList .cloud-delete");
  await waitForStatus(a, "Deleted.");
  await waitForList(a, (items, empty) => empty);

  assert.deepEqual(a.errors, [], "no console errors on device A");
  assert.deepEqual(b.errors, [], "no console errors on device B");
  await deviceA.close();
  await deviceB.close();
});
