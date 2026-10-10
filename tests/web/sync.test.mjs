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

/* ----- a wallpaper too big for the cloud copy ----- */

const WALL = "jobdesk2000_wall_v1";
const picture = (fill, kb) => "data:image/jpeg;base64," + fill.repeat(kb * 1024);

test("a wallpaper kept on one device for size is not overwritten by another device's older one, but a new one is", async () => {
  const start = { ...data([job("Acme")], { "Acme|Dev": fresh() }), [WALL]: picture("O", 1) };
  startCloud(start);
  const laptop = await synced("laptop", start), phone = await synced("phone", start);
  const big = picture("B", 950);
  laptop.store.setItem(WALL, big); // what My Fairy does with a big picture
  laptop.jobs.setJobField("Acme|Dev", "note", "laptop");
  await laptop.sync.flushSync();
  assert.equal(cloud.data("u1").jd2000_wall_omitted, "1");
  phone.deliver();
  for (const note of ["phone 1", "phone 2"]) { // edits that have nothing to do with the wallpaper
    phone.jobs.setJobField("Acme|Dev", "note", note);
    await phone.sync.flushSync();
    assert.equal(cloud.data("u1")[WALL], undefined, note + ": the phone's older wallpaper stays off the cloud");
    assert.equal(cloud.data("u1").jd2000_wall_omitted, "1");
    laptop.deliver();
    assert.equal(laptop.store.getItem(WALL), big, note);
  }
  const fresher = picture("N", 2);
  phone.store.setItem(WALL, fresher); // the phone picks a new wallpaper on purpose
  phone.jobs.setJobField("Acme|Dev", "note", "phone 3");
  await phone.sync.flushSync();
  assert.equal(cloud.data("u1")[WALL], fresher);
  laptop.deliver();
  assert.equal(laptop.store.getItem(WALL), fresher);
});

test("signing out keeps a wallpaper that lives on this device only, and it comes back with the account", async () => {
  const start = data([job("Acme")], { "Acme|Dev": fresh() });
  startCloud(start);
  const d = await synced("solo", start);
  const big = picture("B", 950);
  d.store.setItem(WALL, big);
  d.jobs.setJobField("Acme|Dev", "note", "x");
  assert.equal(await d.sync.flushSync(), true);
  assert.equal(d.store.getItem("jd2000_wall_local"), "1");
  d.sync.stopSync();
  d.sync.forgetAccountData();
  d.users.clearUser();
  assert.equal(d.store.getItem(WALL), null, "nothing of the account is left to see");
  d.users.setUser({ name: "Оля", email: "u1@example.com", gender: "f", uid: "u1" });
  await d.sync.startSync("u1");
  d.deliver();
  await d.sync.flushSync();
  assert.equal(d.store.getItem(WALL), big);
  assert.equal(d.store.getItem("jd2000_stash"), null);
});

/* ----- a full storage at the first sync, a late answer, the stash ----- */

// a store with a size limit in characters (key + value), like a browser's localStorage
class QuotaStorage extends MemoryStorage {
  quota = Infinity;
  used() { let n = 0; for (let i = 0; i < this.length; i++) { const k = this.key(i); n += k.length + this.getItem(k).length; } return n; }
  setItem(key, value) {
    const old = this.getItem(key);
    if (this.used() - (old === null ? 0 : key.length + old.length) + key.length + String(value).length > this.quota) throw new DOMException("full", "QuotaExceededError");
    super.setItem(key, value);
  }
}

test("a page opened on a nearly full storage does not count the cloud copy it could not take as common history", async () => {
  const start = { ...data([job("Acme"), job("Beta")], { "Acme|Dev": fresh(), "Beta|Dev": fresh() }), [WALL]: picture("W", 300) };
  startCloud(start);
  const phone = await synced("phone", start);
  phone.jobs.setJobField("Acme|Dev", "status", "offer");
  phone.jobs.setJobField("Acme|Dev", "note", "offer letter, answer by Friday");
  await phone.sync.flushSync();
  const store = new QuotaStorage();
  const laptop = await device("laptop", { store, seed: { ...start, jd2000_owner: "u1", jd2000_sync_base: JSON.stringify(fingerprint(start)) } });
  store.quota = store.used() + 20; // the phone's bigger progress map does not fit
  await laptop.sync.startSync("u1");
  laptop.deliver();
  store.removeItem(WALL); // what the storage-full notice suggests, then an ordinary edit
  laptop.jobs.setJobField("Beta|Dev", "note", "after freeing space");
  await laptop.sync.flushSync();
  const p = progress(cloud.data("u1"));
  assert.equal(p["Acme|Dev"].status, "Оффер");
  assert.equal(p["Acme|Dev"].note, "offer letter, answer by Friday");
});

test("a wallpaper too big for a nearly full device is not deleted everywhere by that device's next edit", async () => {
  const start = data([job("Acme")], { "Acme|Dev": fresh() });
  startCloud(start);
  const phone = await synced("phone", start);
  const wall = picture("P", 400);
  phone.store.setItem(WALL, wall);
  phone.jobs.setJobField("Acme|Dev", "note", "new wallpaper");
  await phone.sync.flushSync();
  const store = new QuotaStorage();
  const laptop = await device("laptop", { store, seed: { ...start, jd2000_owner: "u1", jd2000_sync_base: JSON.stringify(fingerprint(start)) } });
  store.quota = store.used() + 4000; // room for edits, not for the picture
  await laptop.sync.startSync("u1");
  laptop.deliver();
  laptop.jobs.setJobField("Acme|Dev", "note", "an edit on the laptop");
  await laptop.sync.flushSync();
  assert.equal(cloud.data("u1")[WALL], wall);
  assert.equal(progress(cloud.data("u1"))["Acme|Dev"].note, "an edit on the laptop");
});

test("a guest joining on a full storage keeps every vacancy of the account and the guest's own", async () => {
  startCloud(data([job("Account Co"), job("Account Two")], { "Account Co|Dev": fresh("account note"), "Account Two|Dev": fresh("two") }));
  const store = new QuotaStorage();
  const page = await device("page", { store, seed: { [JOBS]: JSON.stringify([job("Guest Co")]), [PROGRESS]: JSON.stringify({ "Guest Co|Dev": fresh("guest") }), [WALL]: picture("G", 200) } });
  page.users.setUser({ name: "Оля", email: "u1@example.com", gender: "f", uid: "u1" });
  store.quota = store.used() + 40; // the joined list does not fit
  await page.sync.startSync("u1");
  page.deliver();
  await page.sync.flushSync();
  assert.deepEqual(companies(cloud.data("u1")).sort(), ["Account Co", "Account Two", "Guest Co"]);
});

for (const late of [false, true]) {
  test(`an edit made on top of this device's write wins even when the write's answer comes late (late: ${late})`, async () => {
    const start = data([job("Acme")], { "Acme|Dev": fresh("n0") });
    startCloud(start);
    const laptop = await synced("laptop", start), phone = await synced("phone", start);
    laptop.jobs.setJobField("Acme|Dev", "note", "laptop");
    const release = late ? cloud.holdCommit(laptop.id) : () => {};
    const pushing = laptop.sync.flushSync();
    await sleep(20);
    phone.deliver(); // the phone sees the laptop's note...
    assert.equal(progress(phone.local())["Acme|Dev"].note, "laptop");
    phone.jobs.setJobField("Acme|Dev", "note", "phone"); // ...and replaces it on purpose
    await phone.sync.flushSync();
    laptop.deliver();
    release();
    await pushing;
    await laptop.sync.flushSync();
    phone.deliver();
    laptop.deliver();
    assert.equal(progress(cloud.data("u1"))["Acme|Dev"].note, "phone");
    assert.equal(progress(laptop.local())["Acme|Dev"].note, "phone");
  });
}

test("a wallpaper kept on this device only comes back with its account after another account used the device", async () => {
  const startA = data([job("A Co")], { "A Co|Dev": fresh() }, "uA");
  startCloud(startA, "uA");
  startCloud(data([job("B Co")], { "B Co|Dev": fresh() }, "uB"), "uB");
  const store = new MemoryStorage();
  const a = await device("pageA", { store, seed: { ...startA, jd2000_owner: "uA", jd2000_sync_base: JSON.stringify(fingerprint(startA)) } });
  await a.sync.startSync("uA");
  a.deliver();
  const big = picture("B", 950);
  store.setItem(WALL, big);
  a.jobs.setJobField("A Co|Dev", "note", "x");
  assert.equal(await a.sync.flushSync(), true);
  assert.equal(store.getItem("jd2000_wall_local"), "1");
  a.users.setUser({ name: "Богдана", email: "b@example.com", gender: "f", uid: "uB" }); // B signs in over A's page
  a.sync.stopSync();
  const b = await device("pageB", { store });
  await b.sync.startSync("uB");
  b.deliver();
  assert.equal(await b.sync.flushSync(), true);
  b.sync.stopSync();
  b.sync.forgetAccountData();
  b.users.clearUser();
  const back = await device("pageA2", { store });
  back.users.setUser({ name: "Андрій", email: "a@example.com", gender: "m", uid: "uA" });
  await back.sync.startSync("uA");
  back.deliver();
  await back.sync.flushSync();
  assert.equal(store.getItem(WALL), big);
  assert.equal(cloud.data("uA").jd2000_wall_omitted, "1", "the cloud copy still says the wallpaper lives on a device");
});

test("the previous account's unsent changes are put aside even when two copies of its data would not fit", async () => {
  const startA = { ...data([job("A Synced Co")], { "A Synced Co|Dev": fresh() }, "uA"), [WALL]: picture("W", 600), jobdesk2000_cv_v1: "Резюме ".repeat(40000) };
  startCloud(startA, "uA");
  startCloud(data([job("B Co")], { "B Co|Dev": fresh() }, "uB"), "uB");
  const store = new QuotaStorage();
  const a = await device("pageA", { store, seed: { ...startA, jd2000_owner: "uA", jd2000_sync_base: JSON.stringify(fingerprint(startA)) } });
  store.quota = Math.round(store.used() * 1.6); // fits once, not twice
  a.jobs.addJob({ company: "A Unsent Co", title: "Dev" }); // made offline
  a.users.setUser({ name: "Богдана", email: "b@example.com", gender: "f", uid: "uB" });
  a.sync.stopSync();
  const b = await device("pageB", { store });
  await b.sync.startSync("uB");
  b.deliver();
  await b.sync.flushSync();
  assert.ok((store.getItem("jd2000_stash") || "").includes("A Unsent Co"), "A's unsent vacancy waits on the device");
  assert.ok(!JSON.stringify(cloud.data("uB")).includes("A Unsent"), "and never reaches B");
});

/* ----- a full storage after the first sync ----- */

const ACCOUNT_TWO = () => data([job("Account Co"), job("Account Two")], { "Account Co|Dev": fresh("account note"), "Account Two|Dev": fresh("two") });
const GUEST_SEED = () => ({ [JOBS]: JSON.stringify([job("Guest Co")]), [PROGRESS]: JSON.stringify({ "Guest Co|Dev": fresh("guest") }), [WALL]: picture("G", 200) });

test("a guest's join that did not fit survives another device's write before its first push", async () => {
  startCloud(ACCOUNT_TWO());
  const phone = await synced("phone", ACCOUNT_TWO());
  const store = new QuotaStorage();
  const page = await device("page", { store, seed: GUEST_SEED() });
  page.users.setUser({ name: "Оля", email: "u1@example.com", gender: "f", uid: "u1" });
  store.quota = store.used() + 40;
  await page.sync.startSync("u1");
  page.deliver();
  phone.jobs.setJobField("Account Co|Dev", "note", "phone edit"); // within the page's debounce
  await phone.sync.flushSync();
  page.deliver();
  await page.sync.flushSync();
  assert.ok(companies(cloud.data("u1")).includes("Guest Co"));
  assert.equal(progress(cloud.data("u1"))["Account Co|Dev"].note, "phone edit");
});

test("a guest's join that did not fit survives a reload before its first push", async () => {
  startCloud(ACCOUNT_TWO());
  const store = new QuotaStorage();
  const page = await device("page", { store, seed: GUEST_SEED() });
  page.users.setUser({ name: "Оля", email: "u1@example.com", gender: "f", uid: "u1" });
  store.quota = store.used() + 40;
  await page.sync.startSync("u1");
  page.deliver();
  page.sync.stopSync(); // closed before the push
  const again = await device("page2", { store });
  await again.sync.startSync("u1");
  again.deliver();
  await again.sync.flushSync();
  assert.ok(companies(cloud.data("u1")).includes("Guest Co"));
});

test("a device that cannot hold the cloud's wallpaper settles, and its old edit never overwrites a newer one", async () => {
  const start = data([job("Acme"), job("Beta")], { "Acme|Dev": fresh(), "Beta|Dev": fresh() });
  startCloud(start);
  const phone = await synced("phone", start);
  phone.store.setItem(WALL, picture("P", 400));
  phone.jobs.setJobField("Acme|Dev", "note", "new wallpaper");
  await phone.sync.flushSync();
  const store = new QuotaStorage();
  const laptop = await device("laptop", { store, seed: { ...start, jd2000_owner: "u1", jd2000_sync_base: JSON.stringify(fingerprint(start)) } });
  store.quota = store.used() + 4000; // room for edits, not for the picture
  await laptop.sync.startSync("u1");
  laptop.deliver();
  laptop.jobs.setJobField("Acme|Dev", "note", "laptop");
  assert.equal(await laptop.sync.flushSync(), true, "the device settles");
  phone.deliver();
  phone.jobs.setJobField("Acme|Dev", "note", "phone, later");
  await phone.sync.flushSync();
  laptop.deliver();
  laptop.jobs.setJobField("Beta|Dev", "note", "unrelated laptop edit");
  await laptop.sync.flushSync();
  const p = progress(cloud.data("u1"));
  assert.equal(p["Acme|Dev"].note, "phone, later");
  assert.equal(p["Beta|Dev"].note, "unrelated laptop edit");
  assert.equal(cloud.data("u1")[WALL], picture("P", 400));
});

test("changes put aside that did not fit when their account came back are not lost when another account signs in", async () => {
  const startA = data([job("A Synced Co")], { "A Synced Co|Dev": fresh() }, "uA");
  startCloud(startA, "uA");
  startCloud(data([job("B Co")], { "B Co|Dev": fresh() }, "uB"), "uB");
  const keptData = data([job("A Synced Co"), job("A Unsent Co")], { "A Synced Co|Dev": fresh(), "A Unsent Co|Dev": fresh("x".repeat(3000)) }, "uA");
  const store = new QuotaStorage();
  const page = await device("page", { store, seed: { jd2000_stash: JSON.stringify({ uA: { data: keptData, base: fingerprint(startA) } }) } });
  page.users.setUser({ name: "Андрій", email: "a@example.com", gender: "m", uid: "uA" });
  store.quota = store.used() + 2500; // the stash's long note does not fit back in
  await page.sync.startSync("uA");
  page.deliver();
  await page.sync.flushSync();
  page.users.setUser({ name: "Богдана", email: "b@example.com", gender: "f", uid: "uB" });
  page.sync.stopSync();
  store.quota = Infinity;
  const b = await device("pageB", { store });
  await b.sync.startSync("uB");
  b.deliver();
  await b.sync.flushSync();
  assert.ok((store.getItem("jd2000_stash") || "").includes("A Unsent Co"), "A's unsent vacancy still waits on the device");
  assert.ok(JSON.parse(store.getItem("jd2000_stash")).uA.data[PROGRESS].includes("x".repeat(3000)), "with its note, the part that did not fit");
  assert.ok(!JSON.stringify(cloud.data("uB")).includes("A Unsent"));
});

test("changes put aside that came back in part are not put aside again over newer edits", async () => {
  const CV = "jobdesk2000_cv_v1";
  const startA = { ...data([job("A Synced Co")], { "A Synced Co|Dev": fresh() }, "uA"), [CV]: "CV v0 ".repeat(20) };
  startCloud(startA, "uA");
  startCloud(data([job("B Co")], { "B Co|Dev": fresh() }, "uB"), "uB");
  const keptData = { ...data([job("A Synced Co"), job("A Unsent Co")], { "A Synced Co|Dev": fresh(), "A Unsent Co|Dev": fresh("x".repeat(3000)) }, "uA"), [CV]: "CV v1 ".repeat(20) };
  const store = new QuotaStorage();
  const page = await device("page", { store, seed: { jd2000_stash: JSON.stringify({ uA: { data: keptData, base: fingerprint(startA) } }) } });
  page.users.setUser({ name: "Андрій", email: "a@example.com", gender: "m", uid: "uA" });
  store.quota = store.used() + 2500; // the CV fits back in, the long note does not
  await page.sync.startSync("uA");
  page.deliver();
  await page.sync.flushSync();
  assert.equal(cloud.data("uA")[CV], "CV v1 ".repeat(20), "what came back goes up");

  const fromCloud = cloud.data("uA"); // A's phone replaces the CV later
  const phone = await device("phone", { seed: { ...fromCloud, jd2000_owner: "uA", jd2000_sync_base: JSON.stringify(fingerprint(fromCloud)) } });
  await phone.sync.startSync("uA");
  phone.deliver();
  phone.store.setItem(CV, "CV v2 ".repeat(20));
  phone.jobs.setJobField("A Synced Co|Dev", "note", "phone");
  await phone.sync.flushSync();
  page.deliver();
  page.users.setUser({ name: "Богдана", email: "b@example.com", gender: "f", uid: "uB" });
  page.sync.stopSync();
  store.quota = Infinity;
  const b = await device("pageB", { store });
  await b.sync.startSync("uB");
  b.deliver();
  await b.sync.flushSync();
  b.sync.stopSync();
  b.sync.forgetAccountData();
  b.users.clearUser();
  const back = await device("pageA2", { store });
  back.users.setUser({ name: "Андрій", email: "a@example.com", gender: "m", uid: "uA" });
  await back.sync.startSync("uA");
  back.deliver();
  await back.sync.flushSync();
  assert.equal(cloud.data("uA")[CV], "CV v2 ".repeat(20), "the phone's newer CV stays");
  assert.equal(progress(cloud.data("uA"))["A Unsent Co|Dev"].note, "x".repeat(3000), "and the part that did not fit arrives at last");
});

/* ----- the vacancy list and its progress, written as one record ----- */

const LONG_NOTE = "опис вакансії, вимоги, умови. ".repeat(40);
const syncedIn = (store) => Object.fromEntries([...Array(store.length).keys()].map((i) => store.key(i)).filter((k) => k.startsWith("jobdesk2000")).map((k) => [k, store.getItem(k)]));
// room for the cloud's longer vacancy list and the history that goes with it, not for the progress with a long note
const roomForListOnly = (store) => {
  const list = cloud.data("u1")[JOBS];
  const base = JSON.stringify(fingerprint({ ...syncedIn(store), [JOBS]: list })).length - store.getItem("jd2000_sync_base").length;
  return list.length - store.getItem(JOBS).length + base + 60;
};

// a laptop on a size-limited storage, then the phone adds vacancy Gamma with a long note
async function phoneAddsGamma(start) {
  startCloud(start);
  const phone = await synced("phone", start);
  const store = new QuotaStorage();
  const laptop = await synced("laptop", start, { store });
  phone.jobs.addJob({ company: "Gamma", title: "Dev" });
  phone.jobs.setJobField("Gamma|Dev", "status", "applied");
  phone.jobs.setJobField("Gamma|Dev", "note", LONG_NOTE);
  await phone.sync.flushSync();
  return { phone, laptop, store };
}

function assertGammaWhole(where, d, date) {
  const g = progress(d)["Gamma|Dev"];
  assert.ok(g, where + ": Gamma has its progress");
  assert.match(g.status, /^Подал/, where);
  assert.equal(g.date, date, where);
  assert.equal(g.note, LONG_NOTE, where);
}

for (const typing of [false, true]) {
  test(`another device's new vacancy keeps its status, date and note when only its list entry would fit here (typing on: ${typing})`, async () => {
    const start = data([job("Acme"), job("Beta")], { "Acme|Dev": fresh(), "Beta|Dev": fresh() });
    const { phone, laptop, store } = await phoneAddsGamma(start);
    const date = progress(cloud.data("u1"))["Gamma|Dev"].date;
    laptop.jobs.setJobField("Acme|Dev", "note", "laptop");
    if (typing) {
      const release = cloud.holdCommit(laptop.id);
      const pushing = laptop.sync.flushSync();
      await sleep(20); // the transaction ran, its answer is slow
      laptop.jobs.setJobField("Acme|Dev", "note", "laptop, typing on");
      store.quota = store.used() + roomForListOnly(store);
      release();
      await pushing;
    } else {
      store.quota = store.used() + roomForListOnly(store);
      assert.equal(await laptop.sync.flushSync(), true, "the device settles");
    }
    assert.ok(!companies(laptop.local()).includes("Gamma"), "the list is not taken without its progress");
    store.quota = Infinity; // space is freed later
    laptop.jobs.setJobField("Beta|Dev", "note", "unrelated laptop edit");
    await laptop.sync.flushSync();
    await laptop.sync.flushSync();
    phone.deliver();
    assertGammaWhole("cloud", cloud.data("u1"), date);
    assertGammaWhole("phone", phone.local(), date);
    assertGammaWhole("laptop", laptop.local(), date);
    assert.equal(progress(cloud.data("u1"))["Acme|Dev"].note, typing ? "laptop, typing on" : "laptop");
  });
}

for (const reload of [false, true]) {
  test(`a guest's join that did not fit keeps the account's values on a vacancy both have (reload: ${reload})`, async () => {
    startCloud(data([{ ...job("Account Co"), salary: "3000$" }, job("Account Two")],
      { "Account Co|Dev": { status: "Оффер", date: "2026-09-01", deadline: "", note: "account note" }, "Account Two|Dev": fresh("two") }));
    const store = new QuotaStorage();
    const seed = {
      [JOBS]: JSON.stringify([job("Guest Co"), { ...job("Account Co"), salary: "1000$" }]),
      [PROGRESS]: JSON.stringify({ "Guest Co|Dev": fresh("guest"), "Account Co|Dev": { status: "Подалася", date: "2026-08-01", deadline: "", note: "guest note" } }),
      [WALL]: picture("G", 200),
    };
    let page = await device("page", { store, seed });
    page.users.setUser({ name: "Оля", email: "u1@example.com", gender: "f", uid: "u1" });
    store.quota = store.used() + 40; // the joined list does not fit
    await page.sync.startSync("u1");
    page.deliver();
    if (reload) {
      page.sync.stopSync(); // closed before the push; room is freed before the next page load
      store.quota = Infinity;
      page = await device("page2", { store });
      await page.sync.startSync("u1");
      page.deliver();
    }
    await page.sync.flushSync();
    const c = cloud.data("u1");
    const p = progress(c)["Account Co|Dev"], listed = JSON.parse(c[JOBS]).find((j) => j.company === "Account Co");
    assert.deepEqual([p.status, p.date, listed.salary], ["Оффер", "2026-09-01", "3000$"]);
    assert.ok(companies(c).includes("Guest Co"));
  });
}
