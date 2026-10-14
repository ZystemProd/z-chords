// firestore.rules against the Firestore emulator.
//
//   npm run test:cloud      (starts the emulators, runs this and app.test.mjs)
//
// The rules are the only thing protecting the songs — the web API key is
// public — so every way one user could reach another's data is tried here, not
// just the happy path.
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-z-chord",
    firestore: {
      rules: await readFile(new URL("../../firestore.rules", import.meta.url), "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

beforeEach(() => env.clearFirestore());
after(() => env.cleanup());

const alice = () => env.authenticatedContext("alice").firestore();
const bob = () => env.authenticatedContext("bob").firestore();
const anon = () => env.unauthenticatedContext().firestore();

const song = (overrides = {}) => ({
  title: "Song",
  subtitle: "",
  data: '{"format":"z-chords-song"}',
  rev: 1,
  createdAt: serverTimestamp(),
  updatedAt: serverTimestamp(),
  ...overrides,
});

// Seed alice's song with the rules switched off, so a test about reading or
// updating does not depend on create also being right.
async function seed(id = "s1", data = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "users/alice/songs", id), {
      ...song(),
      createdAt: new Date(2026, 0, 1),
      updatedAt: new Date(2026, 0, 1),
      ...data,
    });
  });
}

test("a user can create a song in their own library", async () => {
  await assertSucceeds(setDoc(doc(alice(), "users/alice/songs/s1"), song()));
});

test("a user cannot create a song in someone else's library", async () => {
  await assertFails(setDoc(doc(bob(), "users/alice/songs/s1"), song()));
});

test("signed out, nothing can be written or read", async () => {
  await seed();
  await assertFails(setDoc(doc(anon(), "users/alice/songs/s2"), song()));
  await assertFails(getDoc(doc(anon(), "users/alice/songs/s1")));
  await assertFails(getDocs(collection(anon(), "users/alice/songs")));
});

test("a user can read and list only their own songs", async () => {
  await seed();
  await assertSucceeds(getDoc(doc(alice(), "users/alice/songs/s1")));
  await assertSucceeds(getDocs(collection(alice(), "users/alice/songs")));
  await assertFails(getDoc(doc(bob(), "users/alice/songs/s1")));
  await assertFails(getDocs(collection(bob(), "users/alice/songs")));
});

test("nothing outside users/{uid}/songs is reachable", async () => {
  await assertFails(setDoc(doc(alice(), "users/alice"), { x: 1 }));
  await assertFails(setDoc(doc(alice(), "songs/s1"), song()));
  await assertFails(getDocs(collection(alice(), "users")));
});

test("create rejects malformed songs", async () => {
  const db = alice();
  const ref = (id) => doc(db, "users/alice/songs", id);
  await assertFails(setDoc(ref("a"), song({ extra: true })));  // unknown field
  await assertFails(setDoc(ref("b"), song({ data: { not: "a string" } })));  // data not a string
  await assertFails(setDoc(ref("c"), song({ data: "x".repeat(900001) })));  // data too large
  await assertFails(setDoc(ref("d"), song({ title: "t".repeat(201) })));  // title too long
  await assertFails(setDoc(ref("e"), song({ rev: 5 })));  // rev must start at 1
  await assertFails(setDoc(ref("f"), song({ createdAt: new Date(2000, 0, 1) })));  // client createdAt
  await assertFails(setDoc(ref("g"), song({ updatedAt: new Date(2000, 0, 1) })));  // client updatedAt
  const { title, ...noTitle } = song();
  await assertFails(setDoc(ref("h"), noTitle));  // missing title
});

test("an update must advance rev by exactly one", async () => {
  await seed("s1", { rev: 3 });
  const ref = doc(alice(), "users/alice/songs/s1");
  const changes = { title: "New", data: "{}", updatedAt: serverTimestamp() };
  await assertFails(updateDoc(ref, { ...changes, rev: 3 }));  // stale rev
  await assertFails(updateDoc(ref, { ...changes, rev: 5 }));  // skipped rev
  await assertSucceeds(updateDoc(ref, { ...changes, rev: 4 }));
});

test("an update cannot rewrite createdAt or skip updatedAt", async () => {
  await seed("s1", { rev: 1 });
  const ref = doc(alice(), "users/alice/songs/s1");
  await assertFails(
    updateDoc(ref, { rev: 2, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
  );
  await assertFails(updateDoc(ref, { rev: 2, title: "No timestamp" }));
});

test("only the owner can update or delete", async () => {
  await seed();
  await assertFails(
    updateDoc(doc(bob(), "users/alice/songs/s1"), { rev: 2, updatedAt: serverTimestamp() })
  );
  await assertFails(deleteDoc(doc(bob(), "users/alice/songs/s1")));
  await assertSucceeds(deleteDoc(doc(alice(), "users/alice/songs/s1")));
});
