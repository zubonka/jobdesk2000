// Mirrors the synced localStorage keys of a signed-in user to Firestore (users/<uid>, field "data"
// holds a JSON string of { key: rawValue }; the format is shared with older versions of the app).
//
// Rules:
// - The first server snapshot after sign-in decides the merge. Cached (offline) snapshots never do,
//   so an offline device cannot overwrite the cloud with stale or empty data.
// - Cloud data wins. Guest vacancies created on this device before signing in are merged in.
// - A device that holds another account's data never uploads it into this account.
// - Our own writes echoing back are ignored, so typing is never overwritten by an older copy.

import { KEYS, SYNC_PREFIX, getRaw, setRaw, remove, silently, onWrite, syncedEntries } from "../core/storage.js";
import { loadFirebase, firebaseNow } from "./firebase.js";
import { emit } from "../core/events.js";
import { currentUser, setUser, rememberGender } from "../data/user.js";

const PUSH_DELAY_MS = 800;
const MAX_DOC_CHARS = 900 * 1024; // Firestore documents are limited to 1 MiB
const USER_DATA_KEYS = [KEYS.progress, KEYS.jobs, KEYS.cv, KEYS.fairy, KEYS.wallpaper, KEYS.collapsed];

let uid = null;          // account being synced
let ready = false;       // first server snapshot handled
let inSync = false;      // local data equals the cloud copy
let timer = null;
let pending = null;      // promise of the push in flight
let lastPushed = null;   // JSON we wrote last, to recognise its echo
let unsubscribe = null;

const docRef = (fb, id) => fb.F.doc(fb.db, "users", id);

function parseDoc(snap) {
  if (!snap.exists()) return {};
  const d = snap.data();
  try { return d && d.data ? JSON.parse(d.data) || {} : {}; } catch (e) { return {}; }
}

// local synced entries except the user record, which comes from Firebase Auth
function localData() {
  const entries = syncedEntries();
  delete entries[KEYS.user];
  return entries;
}

function sameData(a, b) {
  const ka = Object.keys(a).filter((k) => k !== KEYS.user).sort();
  const kb = Object.keys(b).filter((k) => k !== KEYS.user).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

function payload() {
  const entries = syncedEntries();
  let json = JSON.stringify(entries);
  if (json.length > MAX_DOC_CHARS) {
    delete entries[KEYS.wallpaper]; // a big wallpaper stays on this device only
    json = JSON.stringify(entries);
  }
  return json;
}

async function push() {
  timer = null;
  const fb = firebaseNow();
  if (!fb || !uid || !ready) return false;
  const json = payload();
  if (json.length > MAX_DOC_CHARS) { console.warn("cloud sync skipped: data too large", json.length); return false; }
  lastPushed = json;
  try {
    await fb.F.setDoc(docRef(fb, uid), { data: json, updated: Date.now() }, { merge: true });
    if (json === payload()) inSync = true;
    return true;
  } catch (err) {
    console.warn("cloud sync failed:", err);
    return false;
  }
}

function schedule() {
  inSync = false;
  if (!ready || !uid) return;
  clearTimeout(timer);
  timer = setTimeout(() => { pending = push(); }, PUSH_DELAY_MS);
}
onWrite(schedule);

// Takes the cloud's name and gender for this account (the gender is not part of the Firebase profile).
function adoptRemoteUser(remote) {
  let ru = null;
  try { ru = JSON.parse(remote[KEYS.user] || "null"); } catch (e) { return; }
  const cur = currentUser();
  if (!ru || !cur || ru.uid !== cur.uid) return;
  if (ru.gender && ru.gender !== cur.gender) rememberGender(cur.uid, ru.gender);
  if ((ru.name && ru.name !== cur.name) || (ru.gender && ru.gender !== cur.gender)) {
    setUser({ ...cur, name: ru.name || cur.name, gender: ru.gender || cur.gender });
  }
}

// Makes the local synced keys equal to `remote` (the user record excepted).
// The wallpaper is only ever overwritten, because it is left out of the cloud copy when too big.
function replaceLocal(remote) {
  silently(() => {
    for (const key of Object.keys(localData())) {
      if (!(key in remote) && key !== KEYS.wallpaper) remove(key);
    }
    for (const [key, value] of Object.entries(remote)) {
      if (key !== KEYS.user && key.startsWith(SYNC_PREFIX) && typeof value === "string") setRaw(key, value);
    }
  });
  emit("state");
}

const parse = (text, fallback) => { try { return JSON.parse(text) ?? fallback; } catch (e) { return fallback; } };

// Guest vacancies (and their progress) join the account; on any clash the cloud copy wins.
function withGuestJobs(remote, local) {
  const remoteJobs = parse(remote[KEYS.jobs], []), localJobs = parse(local[KEYS.jobs], []);
  if (!Array.isArray(localJobs) || !localJobs.length) return { data: remote, changed: false };
  const jobs = Array.isArray(remoteJobs) ? remoteJobs.slice() : [];
  const ids = new Set(jobs.map((j) => j.company + "|" + j.title));
  const progress = parse(remote[KEYS.progress], {}) || {};
  const localProgress = parse(local[KEYS.progress], {}) || {};
  let changed = false;
  for (const j of localJobs) {
    const id = j.company + "|" + j.title;
    if (ids.has(id)) continue;
    ids.add(id);
    jobs.push(j);
    if (localProgress[id]) progress[id] = localProgress[id];
    changed = true;
  }
  if (!changed) return { data: remote, changed };
  return { data: { ...remote, [KEYS.jobs]: JSON.stringify(jobs), [KEYS.progress]: JSON.stringify(progress) }, changed };
}

function clearUserData() {
  silently(() => USER_DATA_KEYS.forEach(remove));
  emit("state");
}

function firstSync(remote) {
  const owner = getRaw(KEYS.owner);
  const hasRemote = Object.keys(remote).some((k) => k !== KEYS.user);
  let needsPush = false;
  if (hasRemote) {
    let data = remote;
    if (!owner) {
      const merged = withGuestJobs(remote, localData());
      data = merged.data;
      needsPush = merged.changed;
    }
    adoptRemoteUser(remote);
    if (!sameData(data, localData())) replaceLocal(data);
  } else if (owner && owner !== uid) {
    clearUserData(); // this device holds someone else's data
  } else {
    needsPush = Object.keys(localData()).length > 0; // first sign-in: the device data becomes the account's
  }
  setRaw(KEYS.owner, uid);
  ready = true;
  inSync = !needsPush;
  if (needsPush) schedule();
}

export async function startSync(id) {
  if (uid === id) return;
  stopSync();
  uid = id;
  const fb = await loadFirebase();
  if (!fb || uid !== id) return;
  unsubscribe = fb.F.onSnapshot(docRef(fb, id), { includeMetadataChanges: true }, (snap) => {
    if (uid !== id || snap.metadata.hasPendingWrites) return;
    if (!ready) {
      if (!snap.metadata.fromCache) firstSync(parseDoc(snap));
      return;
    }
    const d = snap.exists() ? snap.data() : null;
    if (d && d.data === lastPushed) return; // the echo of our own write
    const remote = parseDoc(snap);
    if (sameData(remote, syncedEntries())) { inSync = true; return; }
    adoptRemoteUser(remote);
    replaceLocal(remote);
    inSync = true;
  }, (err) => console.warn("cloud watch failed:", err));
}

export function stopSync() {
  if (unsubscribe) { try { unsubscribe(); } catch (e) { /* already closed */ } }
  unsubscribe = null;
  clearTimeout(timer);
  timer = null;
  uid = null;
  ready = false;
  inSync = false;
}

// Sends pending changes now. Resolves true when the cloud copy is known to match this device.
export async function flushSync() {
  if (timer) { clearTimeout(timer); pending = push(); }
  if (pending) { try { await pending; } catch (e) { /* reported in push */ } }
  return ready && inSync;
}

// After signing out: drop this account's data from the device, but only if the cloud has it.
export function forgetAccountData() {
  clearUserData();
  remove(KEYS.owner);
}
