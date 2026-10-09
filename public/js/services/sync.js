// Mirrors the synced localStorage keys of a signed-in user to Firestore: document users/<uid>, field "data" with a
// JSON string of { key: rawValue } (the format older versions of the app wrote too), field "updated" in ms.
//
// How it stays safe:
// - Every write is a transaction that reads the cloud copy first and merges (services/sync-merge.js) when another
//   device changed it, so a stale or offline copy never overwrites newer data.
// - Local edits are marked dirty (persisted) until the cloud has them. Edits made before sync starts, offline, or
//   in a tab closed too early are merged in on the next sync instead of being thrown away.
// - Only a server snapshot can start the first sync; a cached (offline) one never decides anything.
// - Applying a cloud copy never writes back, so devices do not echo each other's updates.
// - A device that holds another account's data never uploads it; guest vacancies join the account they sign in to.

import { KEYS, SYNC_PREFIX, getRaw, getJSON, setRaw, setJSON, remove, silently, onWrite, syncedEntries } from "../core/storage.js";
import { loadFirebase, firebaseNow } from "./firebase.js";
import { emit } from "../core/events.js";
import { currentUser, setUser, rememberGender } from "../data/user.js";
import { merge, fingerprint, sameData } from "./sync-merge.js";

const PUSH_DELAY_MS = 800;
const FLUSH_TIMEOUT_MS = 4000;
const MAX_DOC_CHARS = 900 * 1024; // Firestore documents are limited to 1 MiB
const USER_DATA_KEYS = [KEYS.progress, KEYS.jobs, KEYS.cv, KEYS.fairy, KEYS.wallpaper, KEYS.collapsed];
const NO_HISTORY = { keys: {}, jobs: {} };

// the account that was signed in when the page loaded: an upgraded device whose old app never wrote
// jd2000_owner still holds that account's data, not a guest's
const loadedUid = (currentUser() || {}).uid || "";

let uid = null;          // account being synced
let ready = false;       // first server snapshot handled
let timer = null;
let running = null;      // promise of the push in flight; pushes never overlap
let again = false;       // another push was asked for while one was running
let lastPushed = null;   // JSON we wrote last, to recognise its echo
let inflight = null;     // JSON of the write being committed (its snapshot can arrive before the commit resolves)
let unsubscribe = null;

const docRef = (fb, id) => fb.F.doc(fb.db, "users", id);
const isDirty = () => getRaw(KEYS.syncDirty) === "1";
const setDirty = (on) => (on ? setRaw(KEYS.syncDirty, "1") : remove(KEYS.syncDirty));
const loadBase = () => getJSON(KEYS.syncBase, null) || NO_HISTORY;
const hasBase = () => getRaw(KEYS.syncBase) !== null;
const saveBase = (data) => setJSON(KEYS.syncBase, fingerprint(data));

function parseDoc(snap) {
  if (!snap.exists()) return {};
  const d = snap.data();
  try { return d && d.data ? JSON.parse(d.data) || {} : {}; } catch (e) { return {}; }
}

const localData = () => syncedEntries();
const hasUserData = (data) => Object.keys(data).some((k) => k !== KEYS.user);

// The wallpaper is left out of the cloud copy when the document would get too big; it then lives on this device.
function forCloud(data) {
  if (JSON.stringify(data).length <= MAX_DOC_CHARS) return { cloud: data, wallLocal: false };
  const { [KEYS.wallpaper]: wall, ...rest } = data;
  return { cloud: rest, wallLocal: wall !== undefined };
}

// The user record belongs to this account: the cloud may update its name and gender, never swap the account.
function sameAccountUser(merged, local) {
  let next = null;
  try { next = JSON.parse(merged[KEYS.user] || "null"); } catch (e) { /* keep local */ }
  return next && next.uid === uid ? merged[KEYS.user] : local[KEYS.user];
}

function adoptUser(record) {
  let next = null;
  try { next = JSON.parse(record || "null"); } catch (e) { return; }
  const cur = currentUser();
  if (!next || !cur || next.uid !== cur.uid) return;
  if (next.gender && next.gender !== cur.gender) rememberGender(cur.uid, next.gender);
  if ((next.name && next.name !== cur.name) || (next.gender && next.gender !== cur.gender)) {
    setUser({ ...cur, name: next.name || cur.name, gender: next.gender || cur.gender });
  }
}

// Makes the local synced keys equal to `next`, without writing anything back to the cloud.
function replaceLocal(next) {
  const local = localData();
  const keepWall = getRaw(KEYS.wallLocal) === "1" && next[KEYS.wallpaper] === undefined;
  silently(() => {
    for (const key of Object.keys(local)) {
      if (key === KEYS.user || (key === KEYS.wallpaper && keepWall)) continue;
      if (!(key in next)) remove(key);
    }
    for (const [key, value] of Object.entries(next)) {
      if (key !== KEYS.user && key.startsWith(SYNC_PREFIX) && typeof value === "string" && local[key] !== value) setRaw(key, value);
    }
    adoptUser(next[KEYS.user]);
    emit("state"); // stores reload; what they write while reloading is not a user edit
  });
}

function clearUserData() {
  silently(() => {
    USER_DATA_KEYS.forEach(remove);
    emit("state");
  });
  remove(KEYS.syncBase);
  remove(KEYS.wallLocal);
}

// One transaction: read the cloud copy, merge it with this device's data when someone else changed it, write.
async function push() {
  const fb = firebaseNow();
  if (!fb || !uid || !ready) return false;
  const id = uid;
  let before = null;
  try {
    const result = await fb.F.runTransaction(fb.db, async (tx) => {
      const remote = parseDoc(await tx.get(docRef(fb, id)));
      // This device's data and the history it shares with the cloud are read together, after the read above:
      // a snapshot applied while it waited changes both, and a stale copy paired with newer history would look
      // like the user deleted whatever the other device added. Firestore may run this function again; each run
      // takes a fresh pair.
      before = localData();
      // an empty cloud document is a new account, not "everything was deleted"
      const merged = hasUserData(remote) ? merge(loadBase(), before, remote) : { ...before };
      const user = sameAccountUser(merged, before);
      if (user !== undefined) merged[KEYS.user] = user;
      const { cloud, wallLocal } = forCloud(merged);
      const json = JSON.stringify(cloud);
      if (!sameData(cloud, remote)) {
        inflight = json;
        tx.set(docRef(fb, id), { data: json, updated: Date.now() }, { merge: true });
      }
      return { merged, cloud, json, wallLocal };
    });
    if (uid !== id) return false;
    lastPushed = result.json;
    saveBase(result.cloud);
    if (result.wallLocal) setRaw(KEYS.wallLocal, "1"); else remove(KEYS.wallLocal);
    const now = localData();
    if (!sameData(now, before)) {
      // The user kept typing while this was sent. What was written is the new common history, so it has to reach
      // this device too, or the next push would read another device's edits in it as deleted here.
      const next = merge(fingerprint(before), now, result.merged);
      if (!sameData(next, now)) replaceLocal(next);
      schedule();
      return true;
    }
    if (!sameData(result.merged, before)) replaceLocal(result.merged); // another device's edits came in with the merge
    setDirty(false);
    return true;
  } catch (err) {
    console.warn("cloud sync postponed:", err && (err.code || err.message)); // offline or contention; stays dirty
    return false;
  }
}

// Starts a push now, or queues one more behind the push that is running.
function pushNow() {
  clearTimeout(timer);
  timer = null;
  if (running) { again = true; return; }
  running = push().finally(() => {
    running = null;
    if (again) { again = false; pushNow(); }
  });
}

function schedule() {
  if (!ready || !uid) return;
  clearTimeout(timer);
  timer = setTimeout(pushNow, PUSH_DELAY_MS);
}

onWrite(() => {
  setDirty(true);
  schedule();
});

function firstSync(remote) {
  const owner = getRaw(KEYS.owner) || (loadedUid === uid ? uid : "");
  const local = localData();
  if (owner && owner !== uid) {
    clearUserData(); // this device held someone else's data
    if (hasUserData(remote)) replaceLocal(remote);
    setDirty(false);
  } else if (!owner && hasUserData(local)) {
    // guest data on this device joins the account
    const merged = hasUserData(remote) ? merge(NO_HISTORY, local, remote) : local;
    if (!sameData(merged, local)) replaceLocal(merged);
    setDirty(true);
  } else if (isDirty() && hasBase() && hasUserData(remote)) {
    // edits this device made before the cloud had them: merge instead of throwing them away.
    // Without a base (a device upgraded from the old app) there is no common history to merge on, so the cloud wins.
    const merged = merge(loadBase(), local, remote);
    if (!sameData(merged, local)) replaceLocal(merged);
  } else if (hasUserData(remote)) {
    if (!sameData(remote, local)) replaceLocal(remote);
    setDirty(false);
  } else {
    setDirty(hasUserData(local)); // a new account: whatever is here becomes its first cloud copy
  }
  setRaw(KEYS.owner, uid);
  if (hasUserData(remote)) saveBase(remote); else remove(KEYS.syncBase);
  ready = true;
  if (isDirty()) schedule();
}

function onSnapshot(id, snap) {
  if (uid !== id || snap.metadata.hasPendingWrites) return;
  if (!ready) {
    if (!snap.metadata.fromCache) firstSync(parseDoc(snap));
    return;
  }
  if (snap.metadata.fromCache) return;
  const d = snap.exists() ? snap.data() : null;
  if (d && (d.data === lastPushed || d.data === inflight)) return; // the echo of our own write
  const remote = parseDoc(snap);
  const local = localData();
  const next = isDirty() && hasBase() ? merge(loadBase(), local, remote) : remote;
  if (!sameData(next, local)) replaceLocal(next);
  saveBase(remote);
  if (isDirty()) schedule();
}

export async function startSync(id) {
  if (uid === id) return;
  stopSync();
  uid = id;
  const fb = await loadFirebase();
  if (!fb || uid !== id) return;
  unsubscribe = fb.F.onSnapshot(docRef(fb, id), { includeMetadataChanges: true }, (snap) => onSnapshot(id, snap),
    (err) => console.warn("cloud watch failed:", err));
}

export function stopSync() {
  if (unsubscribe) { try { unsubscribe(); } catch (e) { /* already closed */ } }
  unsubscribe = null;
  clearTimeout(timer);
  timer = null;
  again = false;
  uid = null;
  ready = false;
}

// Sends pending changes now, waiting at most a few seconds (offline the write would wait forever).
// Resolves true when the cloud copy is known to match this device.
export async function flushSync() {
  if (!ready) return false;
  if (timer || isDirty()) pushNow();
  const settled = (async () => { while (running) await running; })(); // the push in flight and the one queued behind it
  const timeout = new Promise((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS, false));
  await Promise.race([settled, timeout]);
  return ready && !isDirty();
}

// After signing out: drop this account's data from the device, but only if the cloud has it.
export function forgetAccountData() {
  clearUserData();
  remove(KEYS.owner);
  remove(KEYS.syncDirty);
}

// Leaving the tab or getting the connection back: send what is still waiting.
const pushIfDirty = () => { if (ready && isDirty() && !timer) pushNow(); };
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") pushIfDirty(); });
window.addEventListener("online", pushIfDirty);
