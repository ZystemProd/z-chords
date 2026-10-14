// Cloud song library: Google sign-in and a private list of songs per user,
// stored in Firestore.
//
// This module knows nothing about chords, boards or melodies. A cloud song is
// exactly what the Save song button writes to a file — script.js hands over
// `buildSongFile` and a `replaceSong` that applies one — so adding fields to a
// song needs no change here, the same thinness the file pair already has.
//
// script.js calls initCloud(deps) rather than this module importing script.js,
// which keeps the module graph one-directional, as with initLayout.
//
// The Firebase SDK is loaded with a dynamic import() from Google's CDN rather
// than a static import: a static one would make the whole app fail to boot
// whenever gstatic is unreachable. Here a failed load only disables this one
// feature, and the app stays fully usable signed out — which is the point of
// local storage remaining the working copy.

const SDK = "https://www.gstatic.com/firebasejs/12.7.0";

// Not a secret. A web API key only identifies the project; what protects the
// data is firestore.rules, which lets a user reach their own songs and nothing
// else.
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyA2jTncY9dqQiAxYJMMMJQROL1GQHmFu7k",
  authDomain: "z-chord.firebaseapp.com",
  projectId: "z-chord",
  storageBucket: "z-chord.firebasestorage.app",
  messagingSenderId: "269180125117",
  appId: "1:269180125117:web:be3a02f32be496700ddcd4",
};

// `?emulator` on a local origin points everything at the Firebase emulators
// (see tests/cloud/). Gated on the hostname so the flag does nothing on the
// real site.
const USE_EMULATOR =
  new URLSearchParams(location.search).has("emulator") &&
  /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

// Which cloud song the song on screen came from, so Save updates it instead of
// making a copy. `rev` is the revision we last saw: if the stored one has moved
// on, another device saved in between and Save asks before overwriting.
const LINK_KEY = "cv-cloud-song";

// Firestore caps a document at 1 MiB; leave room for the other fields. The
// rules enforce the same limit, this just gives a readable message first.
const MAX_DATA_CHARS = 900000;

let deps = null;
let fb = null; // { auth, db, ...SDK functions } once loaded
let user = null;
let phase = "loading"; // loading | ready | unavailable
let songs = null; // null = not fetched yet
let busy = false;
let status = { text: "", error: false };

let modalEl, bodyEl, buttonEl;

export function initCloud(d) {
  deps = d;
  modalEl = document.getElementById("cloudModal");
  bodyEl = document.getElementById("cloudBody");
  buttonEl = document.getElementById("cloudSongs");
  if (!modalEl || !bodyEl || !buttonEl) return;

  buttonEl.addEventListener("click", openModal);
  document.getElementById("closeCloudModal")?.addEventListener("click", closeModal);
  modalEl.addEventListener("click", (e) => {
    if (e.target === modalEl) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) closeModal();
  });

  updateButton();
  loadSdk();
}

// The song on screen no longer came from the cloud — a file was loaded over
// it — so Save must not overwrite the cloud song it used to be.
export function detachCloudSong() {
  writeLink(null);
  if (isOpen()) render();
}

async function loadSdk() {
  try {
    const [app, auth, store] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-firestore.js`),
    ]);
    const config = USE_EMULATOR
      ? { ...FIREBASE_CONFIG, projectId: "demo-z-chord" }
      : FIREBASE_CONFIG;
    const firebaseApp = app.initializeApp(config);
    const authInst = auth.getAuth(firebaseApp);
    const db = store.getFirestore(firebaseApp);
    if (USE_EMULATOR) {
      auth.connectAuthEmulator(authInst, "http://127.0.0.1:9099", { disableWarnings: true });
      store.connectFirestoreEmulator(db, "127.0.0.1", 8080);
      // The emulator accepts an unsigned Google token, which is how the tests
      // sign in without a real account or a popup.
      window.__cloudTest = {
        signIn: (sub, email) =>
          auth.signInWithCredential(
            authInst,
            auth.GoogleAuthProvider.credential(
              JSON.stringify({ sub, email, email_verified: true, name: email })
            )
          ),
      };
    }
    fb = { ...auth, ...store, auth: authInst, db };
    auth.onAuthStateChanged(authInst, (u) => {
      user = u;
      songs = null;
      phase = "ready";
      updateButton();
      if (isOpen()) {
        render();
        if (user) refreshList();
      }
    });
  } catch (err) {
    phase = "unavailable";
    console.warn("Cloud songs unavailable:", err);
    updateButton();
    if (isOpen()) render();
  }
}

// --- link to the cloud song on screen ----------------------------------------

function readLink() {
  try {
    const link = JSON.parse(localStorage.getItem(LINK_KEY) || "null");
    // A link made while someone else was signed in names a song this user
    // cannot see, so it is no link at all.
    if (link && user && link.uid === user.uid && link.id) return link;
  } catch (_) {}
  return null;
}

function writeLink(link) {
  try {
    if (link) localStorage.setItem(LINK_KEY, JSON.stringify(link));
    else localStorage.removeItem(LINK_KEY);
  } catch (_) {}
}

// --- Firestore ----------------------------------------------------------------

function songsCollection() {
  return fb.collection(fb.db, "users", user.uid, "songs");
}

async function refreshList() {
  if (!user) return;
  try {
    const snap = await fb.getDocs(
      fb.query(songsCollection(), fb.orderBy("updatedAt", "desc"))
    );
    songs = snap.docs.map((d) => {
      const v = d.data();
      return {
        id: d.id,
        title: v.title || "",
        subtitle: v.subtitle || "",
        updatedAt: v.updatedAt ? v.updatedAt.toDate() : null,
      };
    });
  } catch (err) {
    songs = songs || [];
    setStatus(`Could not load your songs: ${message(err)}`, true);
  }
  if (isOpen()) render();
}

function songFields() {
  const song = deps.buildSongFile();
  const data = JSON.stringify(song);
  if (data.length > MAX_DATA_CHARS)
    throw new Error("This song is too large to save to the cloud.");
  return {
    title: String(song.title || "").slice(0, 200),
    subtitle: String(song.subtitle || "").slice(0, 300),
    data,
  };
}

async function saveNew() {
  const fields = songFields();
  const ref = fb.doc(songsCollection());
  await fb.setDoc(ref, {
    ...fields,
    rev: 1,
    createdAt: fb.serverTimestamp(),
    updatedAt: fb.serverTimestamp(),
  });
  writeLink({ uid: user.uid, id: ref.id, rev: 1 });
}

// Update the linked song. A transaction, so "has anyone saved since I opened
// it?" and the write are one step: two devices cannot both pass the check.
// The rules require rev to advance by exactly one, so a stale write fails on
// the server too, not only here.
async function saveExisting(link, { force = false } = {}) {
  const fields = songFields();
  const ref = fb.doc(songsCollection(), link.id);
  const result = await fb.runTransaction(fb.db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return { missing: true };
    const stored = snap.data();
    if (stored.rev !== link.rev && !force)
      return { conflict: true, updatedAt: stored.updatedAt };
    const rev = stored.rev + 1;
    tx.update(ref, { ...fields, rev, updatedAt: fb.serverTimestamp() });
    return { rev };
  });
  if (result.rev) writeLink({ ...link, rev: result.rev });
  return result;
}

async function save({ asNew = false } = {}) {
  await run(async () => {
    const link = asNew ? null : readLink();
    if (!link) {
      await saveNew();
      setStatus(asNew ? "Saved as a new song." : "Saved to your songs.");
      return;
    }
    let result = await saveExisting(link);
    if (result.conflict) {
      const when = result.updatedAt ? ` (${formatDate(result.updatedAt.toDate())})` : "";
      const ok = confirm(
        `This song was saved from another device${when} after you opened it.\n\n` +
          "Overwrite it with what's on this screen? Choose Cancel to keep it, " +
          "then use “Save as new” to keep both."
      );
      if (!ok) {
        setStatus("Not saved.");
        return;
      }
      result = await saveExisting(link, { force: true });
    }
    if (result.missing) {
      // Deleted elsewhere. Saving is still what was asked for.
      await saveNew();
      setStatus("The cloud copy had been deleted, so this was saved as a new song.");
      return;
    }
    setStatus("Saved.");
  });
  refreshList();
}

async function openSong(id) {
  await run(async () => {
    const snap = await fb.getDoc(fb.doc(songsCollection(), id));
    if (!snap.exists()) {
      setStatus("That song no longer exists.", true);
      return;
    }
    const stored = snap.data();
    let song;
    try {
      song = JSON.parse(stored.data);
    } catch (_) {
      throw new Error("That song could not be read.");
    }
    if (!deps.replaceSong(song)) return;
    writeLink({ uid: user.uid, id, rev: stored.rev });
    setStatus(`Opened “${stored.title || "Untitled"}”.`);
  });
  if (isOpen()) render();
}

async function deleteSong(entry) {
  const ok = confirm(
    `Delete “${entry.title || "Untitled"}” from your songs? This can't be undone.`
  );
  if (!ok) return;
  await run(async () => {
    await fb.deleteDoc(fb.doc(songsCollection(), entry.id));
    const link = readLink();
    if (link && link.id === entry.id) writeLink(null);
    setStatus("Deleted.");
  });
  refreshList();
}

async function signIn() {
  await run(async () => {
    try {
      await fb.signInWithPopup(fb.auth, new fb.GoogleAuthProvider());
    } catch (err) {
      if (err && err.code === "auth/popup-closed-by-user") return;
      if (err && err.code === "auth/popup-blocked")
        throw new Error("Your browser blocked the sign-in window. Allow pop-ups for this site and try again.");
      throw err;
    }
  });
}

async function signOutUser() {
  await run(() => fb.signOut(fb.auth));
}

// One operation at a time, with its outcome reported in the modal.
async function run(fn) {
  if (busy) return;
  busy = true;
  setStatus("");
  render();
  try {
    await fn();
  } catch (err) {
    setStatus(message(err), true);
  } finally {
    busy = false;
    if (isOpen()) render();
  }
}

function message(err) {
  if (!err) return "Something went wrong.";
  if (err.code === "permission-denied") return "You don't have access to that song.";
  if (err.code === "unavailable") return "You appear to be offline.";
  if (err.code === "auth/unauthorized-domain")
    return "Sign-in isn't enabled for this web address yet.";
  return err.message || String(err);
}

function setStatus(text, error = false) {
  status = { text, error };
}

// --- UI -----------------------------------------------------------------------

function isOpen() {
  return modalEl && modalEl.style.display === "block";
}

function openModal() {
  modalEl.style.display = "block";
  modalEl.setAttribute("aria-hidden", "false");
  setStatus("");
  render();
  if (user) refreshList();
}

function closeModal() {
  modalEl.style.display = "none";
  modalEl.setAttribute("aria-hidden", "true");
}

const CLOUD_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 19a5 5 0 0 1-.9-9.9A6.5 6.5 0 0 1 18.6 10 4.5 4.5 0 0 1 18 19z"/></svg>';

function updateButton() {
  if (!buttonEl) return;
  const label = user
    ? `My songs (signed in as ${user.displayName || user.email || "you"})`
    : "My songs — sign in to save songs online";
  buttonEl.setAttribute("aria-label", label);
  buttonEl.title = label;
  buttonEl.classList.toggle("signed-in", !!user);
  buttonEl.innerHTML = "";
  if (user && user.photoURL) {
    const img = document.createElement("img");
    img.className = "cloud-avatar";
    img.alt = "";
    // Google profile photos refuse requests that carry a referrer.
    img.referrerPolicy = "no-referrer";
    img.src = user.photoURL;
    img.addEventListener("error", () => {
      buttonEl.innerHTML = CLOUD_ICON;
    });
    buttonEl.appendChild(img);
  } else {
    buttonEl.innerHTML = CLOUD_ICON;
  }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c);
  }
  return node;
}

function formatDate(date) {
  if (!date) return "";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function render() {
  if (!bodyEl) return;
  bodyEl.innerHTML = "";

  if (phase === "loading") {
    bodyEl.append(el("p", { class: "cloud-note" }, "Connecting…"));
    return;
  }
  if (phase === "unavailable") {
    bodyEl.append(
      el(
        "p",
        { class: "cloud-note" },
        "Online saving is unavailable right now — check your connection and reload. " +
          "Everything still saves in this browser as usual."
      )
    );
    return;
  }

  if (!user) {
    bodyEl.append(
      el(
        "p",
        { class: "cloud-note" },
        "Sign in to save songs to your account and open them on any device. " +
          "Without signing in, songs keep saving in this browser as they always have."
      ),
      el(
        "button",
        { class: "btn-primary", type: "button", id: "cloudSignIn", disabled: busy, onclick: signIn },
        "Sign in with Google"
      )
    );
    renderStatus();
    return;
  }

  // Account row
  bodyEl.append(
    el(
      "div",
      { class: "cloud-account" },
      el("span", { class: "cloud-account-name" }, user.displayName || user.email || "Signed in"),
      user.displayName && user.email && user.email !== user.displayName
        ? el("span", { class: "cloud-account-email" }, user.email)
        : null,
      el(
        "button",
        { type: "button", id: "cloudSignOut", disabled: busy, onclick: signOutUser },
        "Sign out"
      )
    )
  );

  // This song
  const link = readLink();
  const title = deps.songTitle() || "Untitled";
  const linked = link && songs ? songs.find((s) => s.id === link.id) : null;
  bodyEl.append(
    el(
      "div",
      { class: "cloud-current" },
      el(
        "div",
        { class: "cloud-current-text" },
        el("div", { class: "cloud-current-title" }, `This song: ${title}`),
        el(
          "div",
          { class: "cloud-note" },
          link
            ? linked && linked.updatedAt
              ? `In your songs · last saved ${formatDate(linked.updatedAt)}`
              : "In your songs"
            : "Not saved to your songs yet"
        )
      ),
      el(
        "div",
        { class: "cloud-actions" },
        el(
          "button",
          { class: "btn-primary", type: "button", id: "cloudSave", disabled: busy, onclick: () => save() },
          link ? "Save" : "Save to my songs"
        ),
        link
          ? el(
              "button",
              { type: "button", id: "cloudSaveAsNew", disabled: busy, onclick: () => save({ asNew: true }) },
              "Save as new"
            )
          : null
      )
    )
  );

  renderStatus();

  // Library
  bodyEl.append(el("h4", { class: "cloud-list-heading" }, "My songs"));
  if (songs === null) {
    bodyEl.append(el("p", { class: "cloud-note" }, "Loading…"));
    return;
  }
  if (!songs.length) {
    bodyEl.append(el("p", { class: "cloud-note" }, "No songs saved yet."));
    return;
  }
  const list = el("ul", { class: "cloud-list", id: "cloudList" });
  for (const s of songs) {
    const isCurrent = link && link.id === s.id;
    list.append(
      el(
        "li",
        { class: "cloud-item" + (isCurrent ? " current" : ""), "data-song-id": s.id },
        el(
          "div",
          { class: "cloud-item-text" },
          el(
            "div",
            { class: "cloud-item-title" },
            s.title || "Untitled",
            isCurrent ? el("span", { class: "cloud-badge" }, "Open") : null
          ),
          el(
            "div",
            { class: "cloud-note" },
            [s.subtitle, s.updatedAt ? formatDate(s.updatedAt) : ""].filter(Boolean).join(" · ")
          )
        ),
        el(
          "div",
          { class: "cloud-actions" },
          el(
            "button",
            { type: "button", class: "cloud-open", disabled: busy, onclick: () => openSong(s.id) },
            "Open"
          ),
          el(
            "button",
            { type: "button", class: "btn-danger cloud-delete", disabled: busy, onclick: () => deleteSong(s) },
            "Delete"
          )
        )
      )
    );
  }
  bodyEl.append(list);
}

function renderStatus() {
  if (!status.text) return;
  bodyEl.append(
    el(
      "p",
      { class: "cloud-status" + (status.error ? " error" : ""), role: "status" },
      status.text
    )
  );
}
