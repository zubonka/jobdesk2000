// Mirrors the synced localStorage keys of a signed-in user to Firestore: document users/<uid>, field "data" with a
// JSON string of { key: rawValue } (the format older versions of the app wrote too), field "updated" in ms
// (the write time, but always above the "updated" it replaced, so it orders the copies even across skewed clocks).
//
// How it stays safe:
// - Every write is a transaction that reads the cloud copy first and merges (services/sync-merge.js) when another
//   device changed it, so a stale or offline copy never overwrites newer data.
// - Local edits are marked dirty (persisted) until the cloud has them. Edits made before sync starts, offline, or
//   in a tab closed too early are merged in on the next sync instead of being thrown away.
// - Only a server snapshot can start the first sync; a cached (offline) one never decides anything.
// - Applying a cloud copy never writes back, so devices do not echo each other's updates.
// - A device that holds another account's data never uploads it; guest vacancies join the account they sign in to.

import { KEYS, SYNC_PREFIX, getRaw, getObject, setRaw, setJSON, remove, silently, onWrite, syncedEntries } from "../core/storage.js";
import { loadFirebase, firebaseNow } from "./firebase.js";
import { emit } from "../core/events.js";
import { currentUser, setUser, rememberGender } from "../data/user.js";
import { merge, fingerprint, sameData, hash } from "./sync-merge.js";

const PUSH_DELAY_MS = 800;
const FLUSH_TIMEOUT_MS = 4000;
// Firestore documents are limited to 1 MiB, counted in UTF-8 bytes: Cyrillic letters take two each
const MAX_DOC_BYTES = 900 * 1024;
const bytes = (text) => new TextEncoder().encode(text).length;
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
// Cloud versions ("updated"). Every write sets "updated" above the version it read, so versions only grow and each
// write has its own.
let lastPushed = 0;      // our last write, to recognise its echo
let inflight = 0;        // the write being committed (its snapshot can arrive before the commit resolves)
// The newest version this device has seen or written: a watch that reconnects can still deliver an older copy after
// this device's own write, and applying that would take back what the write had just merged in.
let seen = 0;
let applied = 0;         // the copy last applied here from the cloud
let held = null;         // the newest snapshot that arrived while a push was running: applied once the push is done
let unsubscribe = null;

const docRef = (fb, id) => fb.F.doc(fb.db, "users", id);
const isDirty = () => getRaw(KEYS.syncDirty) === "1";
const setDirty = (on) => (on ? setRaw(KEYS.syncDirty, "1") : remove(KEYS.syncDirty));
const loadBase = () => {
  const base = getObject(KEYS.syncBase);
  return base.keys && base.jobs ? base : NO_HISTORY;
};
const hasBase = () => getRaw(KEYS.syncBase) !== null;
const saveBase = (data) => setJSON(KEYS.syncBase, fingerprint(data));
// the renames made here that the cloud does not have yet (data/jobs.js records them)
const renamed = () => getObject(KEYS.renames);
// Once a push put them in the cloud, the renames it carried are common history; one made meanwhile stays.
function forgetRenames(sent) {
  const now = renamed();
  for (const [from, to] of Object.entries(sent)) if (now[from] === to) delete now[from];
  if (Object.keys(now).length) setJSON(KEYS.renames, now); else remove(KEYS.renames);
}

// In a cloud copy: the wallpaper was left out because the document got too big, not removed.
const WALL_OMITTED = "jd2000_wall_omitted";

// The cloud copy as { data: { key: raw string }, raw: what the document literally holds }, or null when the document
// is not a copy at all (then this device's copy goes up over it). What the cloud cannot tell is taken from this
// device's data, so it reads as unchanged: a value that is not a string (an edit in the console) and a wallpaper
// left out for size.
function readCloud(snap, local) {
  if (!snap.exists()) return { data: {}, raw: {} };
  const d = snap.data();
  let raw;
  try { raw = d && d.data ? JSON.parse(d.data) : {}; } catch (e) { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const data = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === WALL_OMITTED) continue;
    if (typeof value === "string") data[key] = value;
    else if (local[key] !== undefined) data[key] = local[key];
  }
  const wall = KEYS.wallpaper;
  if (raw[WALL_OMITTED] && data[wall] === undefined && local[wall] !== undefined) data[wall] = local[wall];
  return { data, raw };
}

const localData = () => syncedEntries();
const hasUserData = (data) => Object.keys(data).some((k) => k !== KEYS.user);

// The wallpaper is left out of the cloud copy when the document would get too big; it then lives on this device,
// and the copy says so, or other devices would take its absence for a removal. keepOmitted: the copy says that of
// another device's wallpaper, and this device has not picked a new one, so its own older one must not go up over it.
function forCloud(data, keepOmitted = false) {
  const { [KEYS.wallpaper]: wall, ...rest } = data;
  if (wall !== undefined && keepOmitted) return { cloud: { ...rest, [WALL_OMITTED]: "1" }, wallLocal: false };
  if (wall === undefined || bytes(JSON.stringify(data)) <= MAX_DOC_BYTES) return { cloud: data, wallLocal: false };
  return { cloud: { ...rest, [WALL_OMITTED]: "1" }, wallLocal: true };
}

// A cloud copy as this device reads it back (readCloud): a wallpaper left out is this device's own. The history
// saved with a push must look like that too, or the next push would take this device's wallpaper for a new one.
function asRead(cloud, local) {
  if (!cloud[WALL_OMITTED]) return cloud;
  const { [WALL_OMITTED]: omitted, ...rest } = cloud;
  return local[KEYS.wallpaper] === undefined ? rest : { ...rest, [KEYS.wallpaper]: local[KEYS.wallpaper] };
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

// Makes the local synced keys equal to `next`, without writing anything back to the cloud. False when a value did
// not fit (a full storage): then the device does not hold `next`, and the caller must not count it as common history.
function replaceLocal(next) {
  const local = localData();
  const keepWall = getRaw(KEYS.wallLocal) === "1" && next[KEYS.wallpaper] === undefined;
  let stored = true;
  silently(() => {
    for (const key of Object.keys(local)) {
      if (key === KEYS.user || (key === KEYS.wallpaper && keepWall)) continue;
      if (!(key in next)) remove(key);
    }
    for (const [key, value] of Object.entries(next)) {
      if (key !== KEYS.user && key.startsWith(SYNC_PREFIX) && typeof value === "string" && local[key] !== value) stored = setRaw(key, value) && stored;
    }
    adoptUser(next[KEYS.user]);
    emit("state"); // stores reload; what they write while reloading is not a user edit
  });
  return stored;
}

function clearUserData() {
  silently(() => {
    USER_DATA_KEYS.forEach(remove);
    emit("state");
  });
  remove(KEYS.syncBase);
  remove(KEYS.wallLocal);
  remove(KEYS.renames);
}

// Another tab of this browser signed the account out and took its data off the device (jd2000_owner is gone):
// this tab must neither bring the data back from a snapshot nor push, until its own sign-out arrives.
const deviceLeftAccount = (id) => getRaw(KEYS.owner) !== id;

// One transaction: read the cloud copy, merge it with this device's data when someone else changed it, write.
async function push() {
  const fb = firebaseNow();
  if (!fb || !uid || !ready || deviceLeftAccount(uid)) return false;
  const id = uid;
  let before = null, sent = {};
  try {
    const result = await fb.F.runTransaction(fb.db, async (tx) => {
      const snap = await tx.get(docRef(fb, id));
      // This device's data and the history it shares with the cloud are read together, after the read above:
      // a snapshot applied while it waited changes both, and a stale copy paired with newer history would look
      // like the user deleted whatever the other device added. Firestore may run this function again; each run
      // takes a fresh pair.
      before = localData();
      sent = renamed();
      const copy = readCloud(snap, before) || { data: {}, raw: null }; // a broken document is written over
      const remote = copy.data;
      // an empty cloud document is a new account, not "everything was deleted"
      const merged = hasUserData(remote) ? merge(loadBase(), before, remote, { renamed: sent }) : { ...before };
      const user = sameAccountUser(merged, before);
      if (user !== undefined) merged[KEYS.user] = user;
      const wall = merged[KEYS.wallpaper];
      const othersWall = !!copy.raw?.[WALL_OMITTED] && getRaw(KEYS.wallLocal) !== "1";
      const { cloud, wallLocal } = forCloud(merged, othersWall && wall !== undefined && hash(wall) === loadBase().keys[KEYS.wallpaper]);
      const json = JSON.stringify(cloud);
      const read = snap.exists() ? Number(snap.data()?.updated) || 0 : 0;
      let version = read;
      if (!copy.raw || !sameData(cloud, copy.raw)) {
        version = Math.max(Date.now(), read + 1);
        inflight = version;
        tx.set(docRef(fb, id), { data: json, updated: version }, { merge: true });
      }
      return { merged, cloud, wallLocal, version };
    });
    if (uid !== id) return false;
    // A newer copy from another device was applied while this push waited for its answer: that copy and its base
    // already stand here, and saving this older one as the base would make the other device's edits look like
    // ours. One more push settles it against the current cloud copy.
    const newer = applied > result.version;
    seen = Math.max(seen, result.version);
    lastPushed = result.version;
    if (newer) { schedule(); return true; }
    if (result.wallLocal) setRaw(KEYS.wallLocal, "1"); else remove(KEYS.wallLocal);
    const now = localData();
    if (!sameData(now, before)) {
      // The user kept typing while this was sent. What was written is the new common history, so it has to reach
      // this device too, or the next push would read another device's edits in it as deleted here.
      const shared = asRead(result.cloud, result.merged);
      saveBase(shared);
      forgetRenames(sent);
      const next = merge(fingerprint(before), now, result.merged, { renamed: renamed() });
      if (!sameData(next, now) && !replaceLocal(next)) {
        // what did not fit here is not common history: those keys keep the value this device had before
        const held = localData();
        for (const key of Object.keys(next)) {
          if (key === KEYS.user || held[key] === next[key]) continue;
          if (before[key] === undefined) delete shared[key]; else shared[key] = before[key];
        }
        saveBase(shared);
      }
      schedule();
      return true;
    }
    // Another device's edits came in with the merge but did not all fit here (a full storage). Everything of this
    // device is in the cloud now, so the common history is what this device really holds: the values that did not
    // fit still read as the cloud's, and the device settles instead of pushing its old values again and again.
    if (!sameData(result.merged, before) && !replaceLocal(result.merged)) {
      saveBase(localData());
      forgetRenames(sent);
      setDirty(false);
      return true;
    }
    saveBase(asRead(result.cloud, result.merged));
    forgetRenames(sent);
    setDirty(false);
    return true;
  } catch (err) {
    console.warn("cloud sync postponed:", err && (err.code || err.message)); // offline or contention; stays dirty
    if (err && err.code === "invalid-argument") emit("sync-too-big"); // even without the wallpaper it does not fit
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
    // a copy that came in meanwhile goes on top of the history the push saved, not under it
    if (held) { const { id, snap } = held; held = null; onSnapshot(id, snap); }
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

function firstSync(remote, version) {
  // A page that loaded signed in holds that account's data, unless the sign-in itself happened on an earlier page
  // that closed before this sync ran: then the data on the device is still a guest's, joining the account.
  const owner = getRaw(KEYS.owner) || (loadedUid === uid && getRaw(KEYS.joining) !== uid ? uid : "");
  const local = localData();
  let stored = true, kind = "cloud"; // whether every value fitted, and which way the data came together
  const take = (next) => { stored = replaceLocal(next) && stored; };
  if (owner && owner !== uid) {
    // This device held someone else's data. What of it never reached that account's cloud copy is put aside here,
    // never uploaded into this account, and merged back when that account signs in on this device again.
    const kept = isDirty() ? stashOf(local) : null;
    clearUserData();
    if (kept && !putStash(owner, kept)) console.warn("cloud sync: the previous account's unsent changes did not fit on this device");
    if (hasUserData(remote)) take(remote);
    setDirty(false);
  } else if (!owner && hasUserData(local)) {
    // guest data on this device joins the account
    kind = "guest";
    const merged = hasUserData(remote) ? merge(NO_HISTORY, local, remote, { preferRemote: true }) : local;
    if (!sameData(merged, local)) take(merged);
    setDirty(true);
  } else if (isDirty() && (hasBase() || getRaw(KEYS.owner) === uid) && hasUserData(remote)) {
    // Edits this device made before the cloud had them: merge instead of throwing them away (with no history left,
    // as after a guest's join that did not fit, the cloud's values win where both have one). Only a device upgraded
    // from the old app, with neither a base nor an owner mark, has nothing to merge on: there the cloud wins.
    kind = "merge";
    const merged = merge(loadBase(), local, remote, { renamed: renamed(), preferRemote: !hasBase() });
    if (!sameData(merged, local)) take(merged);
  } else if (hasUserData(remote)) {
    if (!sameData(remote, local)) take(remote);
    setDirty(false);
  } else {
    setDirty(hasUserData(local)); // a new account: whatever is here becomes its first cloud copy
  }
  setRaw(KEYS.owner, uid);
  remove(KEYS.joining);
  const held = localData(); // before the stash comes back: what of it did not fit must not count as common history
  stored = takeBackStash() && stored;
  if (stored) {
    // An empty cloud copy is a new account: an empty base, so what any device adds from now on counts as an
    // addition (without a base the cloud would win and could wipe the vacancies a guest brought in).
    saveBase(remote);
  } else {
    // A full storage refused part of it, and what did not fit is not common history: a merge keeps its old base, a
    // guest's join gets none, and a device that took the cloud copy shares only what it really holds, so the rest
    // still reads as the cloud's change. Dirty, so it is settled once there is room.
    if (kind === "guest") remove(KEYS.syncBase); else if (kind === "cloud") saveBase(held);
    setDirty(true);
  }
  applied = version;
  ready = true;
  if (isDirty()) schedule();
}

// An account's data put aside, with the history it shares with its cloud copy. A wallpaper that lives on this device
// only is not in that history: it is this device's own, and comes back as such.
function stashOf(local) {
  const base = loadBase(), keys = { ...base.keys };
  if (getRaw(KEYS.wallLocal) === "1") delete keys[KEYS.wallpaper];
  return { data: local, base: { ...base, keys } };
}

// Written into the room the account's own data has just left. Still too big: without what its cloud copy already
// holds unchanged, dropped from the data and the history together, so it does not read as deleted.
function putStash(owner, kept) {
  const all = getObject(KEYS.stash), old = all[owner];
  if (old && typeof old === "object" && old.data) {
    // changes already put aside for this account (a take-back that did not fit) are kept, merged with the new ones
    const oldBase = old.base && old.base.keys && old.base.jobs ? old.base : NO_HISTORY;
    kept = { data: merge(oldBase, kept.data, old.data), base: kept.base };
  }
  if (setJSON(KEYS.stash, { ...all, [owner]: kept })) return true;
  const keys = { ...kept.base.keys }, data = {};
  for (const [key, value] of Object.entries(kept.data)) {
    if (key !== KEYS.jobs && key !== KEYS.progress && keys[key] === hash(value)) { delete keys[key]; continue; }
    data[key] = value;
  }
  return setJSON(KEYS.stash, { ...all, [owner]: { data, base: { ...kept.base, keys } } });
}

// This account's changes put aside while another account used the device go on top of what is here now. False when
// they did not fit: then they stay put aside for the next time.
function takeBackStash() {
  const stash = getObject(KEYS.stash), kept = stash[uid];
  if (!kept || typeof kept !== "object" || !kept.data) return true;
  const base = kept.base && kept.base.keys && kept.base.jobs ? kept.base : NO_HISTORY;
  const now = localData();
  const merged = merge(base, kept.data, now);
  setDirty(true);
  if (!sameData(merged, now) && !replaceLocal(merged)) return false;
  delete stash[uid];
  if (Object.keys(stash).length) setJSON(KEYS.stash, stash); else remove(KEYS.stash);
  return true;
}

function onSnapshot(id, snap) {
  if (uid !== id || snap.metadata.hasPendingWrites) return;
  if (ready && deviceLeftAccount(id)) return;
  const d = snap.exists() ? snap.data() : null;
  const version = Number(d?.updated) || 0;
  if (!ready) {
    if (snap.metadata.fromCache) return;
    // another tab signed this account out before this tab's first sync: its data must not come back
    if ((getObject(KEYS.user).uid || "") !== id) return;
    seen = version;
    firstSync(readCloud(snap, localData())?.data || {}, version);
    return;
  }
  if (snap.metadata.fromCache) return;
  if (running) { if (!held || version >= held.version) held = { id, snap, version }; return; } // see pushNow
  if (version && version < seen) return; // older than a copy this device already has
  seen = Math.max(seen, version);
  // the echo of our own write, told by its version: another device can write the very same data later
  if (version && (version === lastPushed || version === inflight)) return;
  const local = localData();
  const copy = readCloud(snap, local);
  if (!copy) { setDirty(true); schedule(); return; } // not a copy at all: this device's data goes up over it
  const remote = copy.data;
  const next = isDirty() ? merge(loadBase(), local, remote, { renamed: renamed(), preferRemote: !hasBase() }) : remote;
  if (!sameData(next, local) && !replaceLocal(next)) return; // a full storage: this copy is not the common history
  saveBase(remote);
  applied = version;
  if (isDirty()) schedule();
}

export async function startSync(id) {
  if (uid === id) return;
  stopSync();
  uid = id;
  // signed in on this page: remembered, so a reload before the first sync still treats the data here as a guest's
  if (loadedUid !== id && !getRaw(KEYS.owner)) setRaw(KEYS.joining, id);
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
  held = null;
  uid = null;
  ready = false;
  seen = applied = lastPushed = inflight = 0;
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

// After signing out: drop this account's data from the device, but only if the cloud has it. A wallpaper too big
// for the cloud copy lives here only: it waits on the device for this account, like unsent changes (takeBackStash).
export function forgetAccountData() {
  const owner = getRaw(KEYS.owner), wall = getRaw(KEYS.wallLocal) === "1" ? getRaw(KEYS.wallpaper) : null;
  clearUserData();
  if (owner && wall) {
    const stash = getObject(KEYS.stash), kept = stash[owner] || { data: {}, base: NO_HISTORY };
    setJSON(KEYS.stash, { ...stash, [owner]: { ...kept, data: { ...kept.data, [KEYS.wallpaper]: wall } } });
  }
  remove(KEYS.owner);
  remove(KEYS.syncDirty);
}

// Leaving the tab or getting the connection back: send what is still waiting.
const pushIfDirty = () => { if (ready && isDirty()) pushNow(); }; // without waiting for the debounce
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") pushIfDirty(); });
window.addEventListener("online", pushIfDirty);
