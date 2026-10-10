// A small in-memory Firestore standing in for services/firebase.js in sync.test.mjs (see sync-hooks.mjs).
// The cloud is shared by every simulated device through globalThis.__cloud. A test decides when each device
// receives its snapshots (deliver), can hand a device an older copy (deliverSnap), and can hold back the answer to a
// device's commit (holdCommit), so the orders that real networks produce now and then can be replayed exactly.

const cloud = (globalThis.__cloud ??= {
  docs: new Map(),     // path -> { data, updated }
  rev: 0,              // bumps on every write: a transaction that read an older revision runs again
  listeners: [],       // { device, path, next, queue }
  holds: new Map(),    // device -> promise its commit answers wait for

  reset() { this.docs.clear(); this.rev = 0; this.listeners = []; this.holds.clear(); },
  snap(doc, fromCache = false) {
    const copy = doc ? { ...doc } : null;
    return { exists: () => !!copy, data: () => (copy ? { ...copy } : undefined), metadata: { hasPendingWrites: false, fromCache } };
  },
  doc(uid) { return this.docs.get("users/" + uid) || null; },
  data(uid) { const d = this.doc(uid); return d ? JSON.parse(d.data) : null; },
  put(path, doc) {
    this.docs.set(path, doc);
    this.rev++;
    for (const l of this.listeners) if (l.path === path) l.queue.push(this.snap(doc));
  },
  // a write by another device running the current app (updated above the version it read)
  write(uid, data) {
    const read = Number(this.doc(uid)?.updated) || 0;
    this.put("users/" + uid, { data: JSON.stringify(data), updated: Math.max(Date.now(), read + 1) });
  },
  deliver(device) {
    for (const l of this.listeners.filter((x) => x.device === device)) while (l.queue.length) l.next(l.queue.shift());
  },
  deliverSnap(device, snap) { for (const l of this.listeners.filter((x) => x.device === device)) l.next(snap); },
  holdCommit(device) {
    let release;
    this.holds.set(device, new Promise((resolve) => { release = resolve; }));
    return () => { this.holds.delete(device); release(); };
  },
});

const DEVICE = new URL(import.meta.url).searchParams.get("device") || "main";

const F = {
  doc: (db, collection, id) => ({ path: collection + "/" + id }),
  onSnapshot(ref, options, next) {
    const listener = { device: DEVICE, path: ref.path, next, queue: [cloud.snap(cloud.docs.get(ref.path))] };
    cloud.listeners.push(listener);
    return () => { cloud.listeners = cloud.listeners.filter((x) => x !== listener); };
  },
  async runTransaction(db, fn) {
    for (let attempt = 0; attempt < 5; attempt++) {
      let readRev = null, write = null;
      const tx = {
        get: async (ref) => { readRev = cloud.rev; return cloud.snap(cloud.docs.get(ref.path)); },
        set: (ref, value) => { write = [ref.path, value]; },
      };
      const result = await fn(tx);
      if (readRev !== cloud.rev) continue; // someone wrote meanwhile: Firestore runs the function again
      if (write) cloud.put(write[0], { ...(cloud.docs.get(write[0]) || {}), ...write[1] });
      await cloud.holds.get(DEVICE); // the answer to the commit is slow to come back
      return result;
    }
    throw Object.assign(new Error("too much contention"), { code: "aborted" });
  },
};

const fb = { A: {}, F, auth: {}, db: {} };
export const loadFirebase = async () => fb;
export const firebaseNow = () => fb;
