// Cloud sync (services/sync.js) between simulated devices and tabs over a fake Firestore (fake-firebase.mjs), with
// each device's own copy of the app modules and storage (sync-hooks.mjs). The test decides when snapshots arrive,
// so the orders that real networks produce now and then are replayed exactly; the browser specs
// (e2e/tests/attack-sync.spec.mjs) cover the same ground against the Firebase emulators.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./sync-hooks.mjs", import.meta.url);

// what the modules touch while they load
globalThis.document ??= { addEventListener() {}, visibilityState: "visible" };
globalThis.window ??= { addEventListener() {} };

const { fingerprint } = await import("../../public/js/services/sync-merge.js?device=helpers");
await import("./fake-firebase.mjs");
const cloud = globalThis.__cloud;

class MemoryStorage {
  #items = new Map();
  get length() { return this.#items.size; }
  key(i) { return [...this.#items.keys()][i] ?? null; }
  getItem(key) { return this.#items.has(key) ? this.#items.get(key) : null; }
  setItem(key, value) { this.#items.set(key, String(value)); }
  removeItem(key) { this.#items.delete(key); }
}
globalThis.__stores = {};

const JOBS = "jobdesk2000_added_v1", PROGRESS = "jobdesk2000_v1", USER = "jobdesk2000_user_v1";
const job = (company, title = "Dev") => ({ prio: "Податися", company, title, field: "—", emp: "—", loc: "—", salary: "—", url: "#" });
const fresh = (note = "", status = "Не подавалася") => ({ status, date: "", deadline: "", note });
const user = (uid, name = "Оля") => JSON.stringify({ name, email: uid + "@example.com", gender: "f", uid });
const data = (jobs, progress, uid = "u1") => ({ [USER]: user(uid), [JOBS]: JSON.stringify(jobs), [PROGRESS]: JSON.stringify(progress) });
const companies = (d) => JSON.parse(d?.[JOBS] || "[]").map((j) => j.company);
const progress = (d) => JSON.parse(d?.[PROGRESS] || "{}");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let run = 0;
beforeEach(() => { cloud.reset(); run++; });

// A device (or tab) of the app with its own module graph. `store` is shared to make two tabs of one browser.
async function device(name, { store = new MemoryStorage(), seed = {} } = {}) {
  const id = name + "-" + run;
  for (const [key, value] of Object.entries(seed)) store.setItem(key, value);
  globalThis.__stores[id] = store;
  const at = (path) => import(`../../public/js/${path}?device=${id}`);
  const [jobs, events, users, sync] = await Promise.all([at("data/jobs.js"), at("core/events.js"), at("data/user.js"), at("services/sync.js")]);
  events.on("state", () => { users.reloadUser(); jobs.loadJobs(); }); // what main.js does on "state"
  jobs.loadJobs();
  const local = () => Object.fromEntries([JOBS, PROGRESS].map((key) => [key, store.getItem(key)]));
  return { id, store, jobs, users, sync, local, deliver: () => cloud.deliver(id) };
}

// A device signed in to u1 that already shares `start` with the cloud.
async function synced(name, start, extra = {}) {
  const seed = { ...start, jd2000_owner: "u1", jd2000_sync_base: JSON.stringify(fingerprint(start)) };
  const d = await device(name, { seed, ...extra });
  await d.sync.startSync("u1");
  d.deliver();
  return d;
}

function startCloud(start, uid = "u1") {
  cloud.docs.set("users/" + uid, { data: JSON.stringify(start), updated: 1000 });
}

test("a copy another device writes that equals this device's last push is applied, not taken for an echo", async () => {
  const start = data([job("Acme"), job("Beta")], { "Acme|Dev": fresh(), "Beta|Dev": fresh("call HR", "Подалася") });
  startCloud(start);
  const laptop = await synced("laptop", start), phone = await synced("phone", start);
  const both = () => { laptop.deliver(); phone.deliver(); };

  laptop.jobs.setJobField("Acme|Dev", "note", "hello");
  await laptop.sync.flushSync();
  both();
  const removed = phone.jobs.removeJob("Beta|Dev");
  await phone.sync.flushSync();
  both();
  assert.deepEqual(companies(laptop.local()), ["Acme"]);
  phone.jobs.restoreJob(removed); // the undo on the phone writes the laptop's last copy again
  await phone.sync.flushSync();
  both();
  assert.deepEqual(companies(laptop.local()), ["Acme", "Beta"]);
  assert.equal(progress(laptop.local())["Beta|Dev"].note, "call HR");
});

test("a push answered after a newer copy was applied keeps that copy's history, so the other device's last edit wins", async () => {
  const start = data([job("Acme")], { "Acme|Dev": fresh("n0") });
  startCloud(start);
  const laptop = await synced("laptop", start), phone = await synced("phone", start);

  laptop.jobs.setJobField("Acme|Dev", "status", "applied");
  const release = cloud.holdCommit(laptop.id);
  const pushing = laptop.sync.flushSync(); // committed, but the answer is held back
  await sleep(20);
  phone.deliver();
  phone.jobs.setJobField("Acme|Dev", "note", "n2");
  await phone.sync.flushSync();
  laptop.deliver(); // the phone's newer copy reaches the laptop before its own commit answer
  release();
  await pushing;
  phone.deliver();
  phone.jobs.setJobField("Acme|Dev", "note", "n3");
  await phone.sync.flushSync();
  laptop.deliver();
  await laptop.sync.flushSync();
  phone.deliver();
  assert.equal(progress(cloud.data("u1"))["Acme|Dev"].note, "n3");
  assert.equal(progress(laptop.local())["Acme|Dev"].note, "n3");
  assert.match(progress(cloud.data("u1"))["Acme|Dev"].status, /^Подал/);
});

test("an older copy delivered after this device's own push does not take back what the push merged in", async () => {
  const start = data([job("Acme")], { "Acme|Dev": fresh() });
  startCloud(start);
  const laptop = await synced("laptop", start), phone = await synced("phone", start);
  const older = cloud.snap(cloud.doc("u1"));

  phone.jobs.addJob({ company: "Phone Co", title: "QA" });
  await phone.sync.flushSync();
  laptop.jobs.addJob({ company: "Laptop Co", title: "QA" });
  await laptop.sync.flushSync(); // merges the phone's vacancy in
  cloud.deliverSnap(laptop.id, older); // a reconnecting watch hands over a copy from before both writes
  laptop.deliver();
  assert.deepEqual(companies(laptop.local()).sort(), ["Acme", "Laptop Co", "Phone Co"]);
});

test("a tab typing right after another tab applied a cloud change saves on top of it, not over it", async () => {
  const start = data([job("Acme")], { "Acme|Dev": fresh() });
  startCloud(start);
  const shared = new MemoryStorage();
  const tabA = await synced("tabA", start, { store: shared });
  const tabB = await synced("tabB", start, { store: shared });
  const phone = await synced("phone", start);

  phone.jobs.addJob({ company: "Phone Co", title: "QA" });
  await phone.sync.flushSync();
  tabB.deliver(); // tab B writes the phone's vacancy into the shared storage; tab A has not heard of it yet
  tabA.jobs.setJobField("Acme|Dev", "note", "typed in tab A");
  tabA.deliver();
  await tabA.sync.flushSync();
  await tabB.sync.flushSync();
  assert.deepEqual(companies(cloud.data("u1")).sort(), ["Acme", "Phone Co"]);
  assert.equal(progress(cloud.data("u1"))["Acme|Dev"].note, "typed in tab A");
});

test("a tab whose first sync is still pending does not bring back an account another tab signed out", async () => {
  const start = data([job("Private Co")], { "Private Co|Dev": fresh("salary 5000") });
  startCloud(start);
  const shared = new MemoryStorage();
  const seed = { ...start, jd2000_owner: "u1", jd2000_sync_base: JSON.stringify(fingerprint(start)) };
  const tab1 = await device("tab1", { store: shared, seed });
  const tab2 = await device("tab2", { store: shared });
  await tab1.sync.startSync("u1");
  tab1.deliver();
  await tab2.sync.startSync("u1"); // its first snapshot has not arrived yet

  assert.equal(await tab1.sync.flushSync(), true); // tab 1 signs out (services/auth.js signOutUser)
  tab1.sync.stopSync();
  tab1.sync.forgetAccountData();
  tab1.users.clearUser();
  tab2.deliver();
  assert.equal(shared.getItem(JOBS), null);
  assert.equal(shared.getItem("jd2000_owner"), null);
});

test("a guest's vacancies still join the account when the page reloads before the first sync ran", async () => {
  startCloud(data([job("Account Co")], { "Account Co|Dev": fresh("account") }));
  const store = new MemoryStorage();
  const page1 = await device("page1", { store, seed: { [JOBS]: JSON.stringify([job("Guest Co")]), [PROGRESS]: JSON.stringify({ "Guest Co|Dev": fresh("guest") }) } });
  page1.users.setUser({ name: "Оля", email: "u1@example.com", gender: "f", uid: "u1" }); // signed in on this page...
  await page1.sync.startSync("u1"); // ...and closed before the first snapshot came
  page1.sync.stopSync();

  const page2 = await device("page2", { store }); // the next page load: signed in from the start
  await page2.sync.startSync("u1");
  page2.deliver();
  await page2.sync.flushSync();
  assert.deepEqual(companies(page2.local()).sort(), ["Account Co", "Guest Co"]);
  assert.deepEqual(companies(cloud.data("u1")).sort(), ["Account Co", "Guest Co"]);
  assert.equal(store.getItem("jd2000_joining"), null);
});

test("another account signing in puts aside the previous account's unsent changes, and they come back with it", async () => {
  const startA = data([job("A Synced Co")], { "A Synced Co|Dev": fresh() }, "uA");
  startCloud(startA, "uA");
  startCloud(data([job("B Co")], { "B Co|Dev": fresh() }, "uB"), "uB");
  const store = new MemoryStorage();
  const seed = { ...startA, jd2000_owner: "uA", jd2000_sync_base: JSON.stringify(fingerprint(startA)) };
  const d = await device("shared", { store, seed });
  d.jobs.addJob({ company: "A Unsent Co", title: "Dev" }); // made while the cloud was out of reach
  assert.equal(store.getItem("jd2000_sync_dirty"), "1");

  d.users.setUser({ name: "Богдана", email: "b@example.com", gender: "f", uid: "uB" });
  await d.sync.startSync("uB");
  d.deliver();
  await d.sync.flushSync();
  assert.deepEqual(companies(d.local()), ["B Co"]);
  assert.ok(!JSON.stringify(cloud.data("uB")).includes("A Unsent"), "nothing of A reaches B");

  d.sync.stopSync();
  d.sync.forgetAccountData();
  d.users.setUser({ name: "Андрій", email: "a@example.com", gender: "m", uid: "uA" });
  await d.sync.startSync("uA");
  d.deliver();
  await d.sync.flushSync();
  assert.deepEqual(companies(cloud.data("uA")).sort(), ["A Synced Co", "A Unsent Co"]);
  assert.equal(store.getItem("jd2000_stash"), null);
});

test("a cloud copy that a full storage could not take is not counted as common history", async () => {
  const start = data([job("Acme"), job("Beta")], { "Acme|Dev": fresh(), "Beta|Dev": fresh() });
  startCloud(start);
  const laptop = await synced("laptop", start), phone = await synced("phone", start);
  phone.jobs.setJobField("Acme|Dev", "status", "offer");
  phone.jobs.setJobField("Acme|Dev", "note", "offer letter, answer by Friday");
  phone.jobs.addJob({ company: "Gamma", title: "Dev" });
  phone.jobs.setJobField("Gamma|Dev", "status", "applied");
  await phone.sync.flushSync();

  const setItem = laptop.store.setItem.bind(laptop.store);
  laptop.store.setItem = (key, value) => { if (key === PROGRESS) throw new DOMException("full", "QuotaExceededError"); setItem(key, value); };
  laptop.deliver(); // the bigger progress map does not fit
  laptop.store.setItem = setItem; // space is freed later
  laptop.jobs.setJobField("Beta|Dev", "note", "an unrelated edit on the laptop");
  await laptop.sync.flushSync();
  const p = progress(cloud.data("u1"));
  assert.equal(p["Acme|Dev"].status, "Оффер");
  assert.equal(p["Acme|Dev"].note, "offer letter, answer by Friday");
  assert.match(p["Gamma|Dev"].status, /^Подал/);
  assert.equal(p["Beta|Dev"].note, "an unrelated edit on the laptop");
});
