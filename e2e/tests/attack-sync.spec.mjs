// Attack on cloud sync, accounts and tabs (services/sync.js, sync-merge.js, auth.js, data/user.js, main.js).
// Every test states the behaviour the app should have, so a failing test is a bug and the file stays as a
// regression test once it is fixed. The cloud copy is read and written straight in the Firestore emulator
// (REST with the emulator's "owner" token), so what a device uploaded is checked without another app instance.
import { test, expect } from "@playwright/test";
import { seedStorage, openApp, openWindow, register, signIn, signOut, freshEmail, confirmYes, PASSWORD } from "./helpers.mjs";

const EMULATOR = process.env.FIREBASE_EMULATOR_BROWSER_HOST || "127.0.0.1";
const DOC = (uid) => `http://${EMULATOR}:8086/v1/projects/demo-jobdesk2000/databases/(default)/documents/users/${uid}`;
const OWNER = { Authorization: "Bearer owner" };
const JOBS = "jobdesk2000_added_v1", PROGRESS = "jobdesk2000_v1", WALL = "jobdesk2000_wall_v1";

// The synced data of users/<uid> as { key: raw string }, or null when there is no document.
async function cloudData(uid) {
  const res = await fetch(DOC(uid), { headers: OWNER });
  if (res.status === 404) return null;
  const doc = await res.json();
  const text = doc.fields?.data?.stringValue;
  return text === undefined ? null : JSON.parse(text);
}

// Replaces users/<uid> with this raw "data" string, as a console edit or another client would.
async function writeCloudRaw(uid, dataText) {
  const res = await fetch(DOC(uid), {
    method: "PATCH",
    headers: { ...OWNER, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { data: { stringValue: dataText }, updated: { integerValue: String(Date.now()) } } }),
  });
  expect(res.ok, await res.text()).toBe(true);
}

const companiesIn = (data) => (data && data[JOBS] ? JSON.parse(data[JOBS]).map((j) => j.company) : []);
const progressIn = (data) => (data && data[PROGRESS] ? JSON.parse(data[PROGRESS]) : {});
const cloudCompanies = async (uid) => companiesIn(await cloudData(uid));

const uidOf = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("jobdesk2000_user_v1")).uid);
const localCompanies = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("jobdesk2000_added_v1") || "[]").map((j) => j.company));
const localProgress = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("jobdesk2000_v1") || "{}"));
const waitSynced = (page) => page.waitForFunction(() => !localStorage.getItem("jd2000_sync_dirty") && !!localStorage.getItem("jd2000_owner"), null, { timeout: 20_000 });

async function addByHand(page, title, company) {
  await openWindow(page, "vacancies");
  await page.locator("#btn-manual").click();
  await page.locator("#ev-title").fill(title);
  await page.locator("#ev-company").fill(company);
  await page.locator("#ev-save").click();
  await expect(page.locator(".jobcard", { hasText: company })).toHaveCount(1);
}
const cardOf = (page, company) => page.locator("#win-vacancies .jobcard", { hasText: company });

// A second device: its own browser context (own storage, own Firebase session).
async function newDevice(browser, seed = { jobdesk2000_welcomed: "1" }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await seedStorage(page, seed);
  await openApp(page);
  return { context, page };
}

// Cuts this page off the Firestore emulator (both the live watch and the writes); the app and Auth stay reachable.
const FIRESTORE = /:8086\//;
const cutFirestore = (page) => page.route(FIRESTORE, (route) => route.abort());
const restoreFirestore = (page) => page.unroute(FIRESTORE);
// Only the transaction requests (read + commit) fail: the device keeps receiving the live watch but cannot upload.
const TRANSACTIONS = /documents:(batchGet|commit)/;

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "flows-desktop", "the sync logic is engine-independent; one browser is enough");
});

/* ----- two devices, the same vacancy ----- */

test("a status changed offline on the laptop and a note typed on the phone for the same vacancy both survive", async ({ page, browser }, testInfo) => {
  const email = freshEmail(testInfo, "sync");
  await seedStorage(page, { jobdesk2000_welcomed: "1" });
  await openApp(page);
  await register(page, { name: "Олена", email });
  await addByHand(page, "Designer", "Same Co");
  await waitSynced(page);
  const uid = await uidOf(page);

  const phone = await newDevice(browser);
  await signIn(phone.page, email);
  await openWindow(phone.page, "vacancies");
  await expect(cardOf(phone.page, "Same Co")).toHaveCount(1);

  await page.context().setOffline(true);
  await cardOf(page, "Same Co").locator(".st-sel").selectOption("interview1");
  await cardOf(phone.page, "Same Co").locator('textarea[data-k="note"]').fill("HR: Олена, дзвінок у пʼятницю");
  await waitSynced(phone.page);

  await page.context().setOffline(false);
  await waitSynced(page);
  await expect.poll(async () => progressIn(await cloudData(uid))["Same Co|Designer"], { timeout: 20_000 })
    .toMatchObject({ status: "Перша співбесіда", note: "HR: Олена, дзвінок у пʼятницю" });
  await expect(cardOf(phone.page, "Same Co").locator('textarea[data-k="note"]')).toHaveValue("HR: Олена, дзвінок у пʼятницю");
  await expect(cardOf(phone.page, "Same Co").locator(".st-sel")).toHaveValue("interview1", { timeout: 15_000 });
  await phone.context.close();
});

test("renaming a vacancy on one device while the other changes its status leaves one card, not two", async ({ page, browser }, testInfo) => {
  const email = freshEmail(testInfo, "sync");
  await seedStorage(page, { jobdesk2000_welcomed: "1" });
  await openApp(page);
  await register(page, { name: "Олена", email });
  await addByHand(page, "Designer", "Typo Co");
  await waitSynced(page);
  const uid = await uidOf(page);

  const phone = await newDevice(browser);
  await signIn(phone.page, email);
  await openWindow(phone.page, "vacancies");
  await expect(cardOf(phone.page, "Typo Co")).toHaveCount(1);

  await page.context().setOffline(true);
  await cardOf(page, "Typo Co").locator(".jedit").click();
  await page.locator("#ev-company").fill("Typo Company");
  await page.locator("#ev-save").click();
  await cardOf(phone.page, "Typo Co").locator(".st-sel").selectOption("offer");
  await waitSynced(phone.page);

  await page.context().setOffline(false);
  await waitSynced(page);
  await page.waitForTimeout(2000);
  expect(await cloudCompanies(uid)).toHaveLength(1);
  await phone.context.close();
});

test("a vacancy deleted on one device while the other edits it offline comes back with the edit on both", async ({ page, browser }, testInfo) => {
  const email = freshEmail(testInfo, "sync");
  await seedStorage(page, { jobdesk2000_welcomed: "1" });
  await openApp(page);
  await register(page, { name: "Олена", email });
  await addByHand(page, "Designer", "Keep Co");
  await addByHand(page, "Motion", "Drop Co");
  await waitSynced(page);
  const uid = await uidOf(page);

  const phone = await newDevice(browser);
  await signIn(phone.page, email);
  await openWindow(phone.page, "vacancies");
  await expect(cardOf(phone.page, "Drop Co")).toHaveCount(1);

  await phone.context.setOffline(true);
  await cardOf(phone.page, "Drop Co").locator('textarea[data-k="note"]').fill("ще актуально");
  await cardOf(page, "Drop Co").locator(".jdel").click();
  await confirmYes(page);
  await waitSynced(page);
  expect(await cloudCompanies(uid)).toEqual(["Keep Co"]);

  await phone.context.setOffline(false);
  await waitSynced(phone.page);
  await expect.poll(() => cloudCompanies(uid), { timeout: 20_000 }).toEqual(["Keep Co", "Drop Co"]);
  expect(progressIn(await cloudData(uid))["Drop Co|Motion"].note).toBe("ще актуально");
  await expect(cardOf(page, "Drop Co").locator('textarea[data-k="note"]')).toHaveValue("ще актуально", { timeout: 15_000 });
  await phone.context.close();
});

for (const first of ["laptop", "phone"]) {
  test(`offline edits on both devices all survive when the ${first} reconnects first`, async ({ page, browser }, testInfo) => {
    const email = freshEmail(testInfo, "sync");
    await seedStorage(page, { jobdesk2000_welcomed: "1" });
    await openApp(page);
    await register(page, { name: "Олена", email });
    await addByHand(page, "Designer", "One Co");
    await addByHand(page, "Motion", "Two Co");
    await waitSynced(page);
    const uid = await uidOf(page);

    const phone = await newDevice(browser);
    await signIn(phone.page, email);
    await openWindow(phone.page, "vacancies");
    await expect(cardOf(phone.page, "Two Co")).toHaveCount(1);

    await page.context().setOffline(true);
    await phone.context.setOffline(true);
    await cardOf(page, "One Co").locator(".st-sel").selectOption("applied");
    await addByHand(page, "Illustrator", "Laptop Co");
    await cardOf(phone.page, "Two Co").locator('textarea[data-k="note"]').fill("з телефона");
    await addByHand(phone.page, "3D", "Phone Co");

    const order = first === "laptop" ? [page, phone.page] : [phone.page, page];
    for (const device of order) {
      await device.context().setOffline(false);
      await waitSynced(device);
    }
    const want = ["One Co", "Two Co", "Laptop Co", "Phone Co"];
    await expect.poll(async () => (await cloudCompanies(uid)).sort(), { timeout: 20_000 }).toEqual([...want].sort());
    const progress = progressIn(await cloudData(uid));
    expect(progress["One Co|Designer"].status).toBe("Подалася");
    expect(progress["Two Co|Motion"].note).toBe("з телефона");
    for (const device of [page, phone.page]) {
      await expect.poll(async () => (await localCompanies(device)).sort(), { timeout: 15_000 }).toEqual([...want].sort());
    }
    await phone.context.close();
  });
}

/* ----- typing while sync works ----- */

test("typing a note while another device's change arrives keeps the focus and every keystroke", async ({ page, browser }, testInfo) => {
  const email = freshEmail(testInfo, "sync");
  await seedStorage(page, { jobdesk2000_welcomed: "1" });
  await openApp(page);
  await register(page, { name: "Олена", email });
  await addByHand(page, "Designer", "Typing Co");
  await addByHand(page, "Motion", "Other Co");
  await waitSynced(page);

  const phone = await newDevice(browser);
  await signIn(phone.page, email);
  await openWindow(phone.page, "vacancies");
  await expect(cardOf(phone.page, "Other Co")).toHaveCount(1);

  const note = cardOf(page, "Typing Co").locator('textarea[data-k="note"]');
  await note.click();
  await page.keyboard.type("дзвінок ");
  await cardOf(phone.page, "Other Co").locator(".st-sel").selectOption("offer");
  await expect(cardOf(page, "Other Co").locator(".st-sel")).toHaveValue("offer", { timeout: 15_000 });
  await page.keyboard.type("у пʼятницю");
  await expect(cardOf(page, "Typing Co").locator('textarea[data-k="note"]')).toHaveValue("дзвінок у пʼятницю");
  await phone.context.close();
});

test("fast edits while a push is running all reach the cloud, and so does the other device's vacancy", async ({ page, browser }, testInfo) => {
  const email = freshEmail(testInfo, "sync");
  await seedStorage(page, { jobdesk2000_welcomed: "1" });
  await openApp(page);
  await register(page, { name: "Олена", email });
  await addByHand(page, "Designer", "Busy Co");
  await waitSynced(page);
  const uid = await uidOf(page);

  const phone = await newDevice(browser);
  await signIn(phone.page, email);
  await openWindow(phone.page, "vacancies");
  await expect(cardOf(phone.page, "Busy Co")).toHaveCount(1);

  const note = () => cardOf(page, "Busy Co").locator('textarea[data-k="note"]');
  let text = "";
  for (let i = 0; i < 24; i++) {
    text += String.fromCharCode(0x430 + (i % 32));
    await note().fill(text);
    if (i === 6) await addByHand(phone.page, "Illustrator", "Phone Co");
    await page.waitForTimeout(170 + (i % 3) * 120); // around the 800 ms debounce and the transaction
  }
  await waitSynced(page);
  await waitSynced(phone.page);
  await expect.poll(() => cloudCompanies(uid), { timeout: 20_000 }).toEqual(["Busy Co", "Phone Co"]);
  expect(progressIn(await cloudData(uid))["Busy Co|Designer"].note).toBe(text);
  await expect(cardOf(phone.page, "Busy Co").locator('textarea[data-k="note"]')).toHaveValue(text, { timeout: 15_000 });
  expect(await localCompanies(page)).toEqual(["Busy Co", "Phone Co"]);
  await phone.context.close();
});

test("leaving the tab right after an edit sends it at once instead of waiting for the debounce", async ({ page }, testInfo) => {
  await seedStorage(page, { jobdesk2000_welcomed: "1" });
  await openApp(page);
  await register(page, { name: "Олена", email: freshEmail(testInfo, "sync") });
  await addByHand(page, "Designer", "Leave Co");
  await waitSynced(page);

  const sent = [];
  page.on("request", (req) => { if (TRANSACTIONS.test(req.url())) sent.push(Date.now()); });
  await cardOf(page, "Leave Co").locator('textarea[data-k="note"]').fill("і вийшла з вкладки");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hiddenAt = Date.now();
  await expect.poll(() => sent.length, { timeout: 5000 }).toBeGreaterThan(0);
  expect(sent[0] - hiddenAt, "ms from leaving the tab to the upload").toBeLessThan(400);
});

/* ----- a new account and its first upload ----- */

test("vacancies a guest brings into a new account survive the other device's write that lands before this device's first upload", async ({ page, browser }, testInfo) => {
  const email = freshEmail(testInfo, "sync");
  await seedStorage(page, {
    jobdesk2000_welcomed: "1",
    jobdesk2000_added_v1: [{ prio: "Податися", company: "Guest Co", title: "Designer", field: "—", emp: "—", loc: "—", salary: "—", url: "#" }],
    jobdesk2000_v1: { "Guest Co|Designer": { status: "Подалися", date: "2026-10-01", deadline: "", note: "із гостьового режиму" } },
  });
  await openApp(page);
  // this device's uploads do not get through for a while (flaky network); the live watch still does
  await page.route(TRANSACTIONS, (route) => route.abort());
  await register(page, { name: "Олена", email });
  await page.waitForFunction(() => !!localStorage.getItem("jd2000_owner"), null, { timeout: 20_000 });
  const uid = await uidOf(page);

  const phone = await newDevice(browser);
  await signIn(phone.page, email);
  await addByHand(phone.page, "Illustrator", "Phone Co");
  await waitSynced(phone.page);
  await expect.poll(() => localCompanies(page), { timeout: 15_000 }).toContain("Phone Co");
  expect(await localCompanies(page)).toContain("Guest Co");

  await page.unroute(TRANSACTIONS);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitSynced(page);
  await expect.poll(async () => (await cloudCompanies(uid)).sort(), { timeout: 20_000 }).toEqual(["Guest Co", "Phone Co"]);
  await phone.context.close();
});

test("a guest with vacancies signing in to an account that has some keeps both sets, on both devices", async ({ page, browser }, testInfo) => {
  const email = freshEmail(testInfo, "sync");
  await seedStorage(page, { jobdesk2000_welcomed: "1" });
  await openApp(page);
  await register(page, { name: "Олена", email });
  await addByHand(page, "Designer", "Account Co");
  await waitSynced(page);
  const uid = await uidOf(page);

  const guest = await newDevice(browser, {
    jobdesk2000_welcomed: "1",
    jobdesk2000_added_v1: [{ prio: "Подумати", company: "Guest Co", title: "Motion", field: "—", emp: "—", loc: "—", salary: "—", url: "#" }],
    jobdesk2000_v1: { "Guest Co|Motion": { status: "Подалися", date: "2026-10-02", deadline: "", note: "гість" } },
  });
  await signIn(guest.page, email);
  await waitSynced(guest.page);
  await expect.poll(async () => (await cloudCompanies(uid)).sort(), { timeout: 20_000 }).toEqual(["Account Co", "Guest Co"]);
  expect(progressIn(await cloudData(uid))["Guest Co|Motion"]).toMatchObject({ status: expect.stringMatching(/^Подал/), note: "гість" });
  await expect.poll(async () => (await localCompanies(page)).sort(), { timeout: 15_000 }).toEqual(["Account Co", "Guest Co"]);
  await guest.context.close();
});

/* ----- accounts on one device ----- */

test("account A then account B on the same device: B's device and cloud copy get nothing of A's", async ({ page }, testInfo) => {
  const emailA = freshEmail(testInfo, "synca"), emailB = freshEmail(testInfo, "syncb");
  await seedStorage(page, { jobdesk2000_welcomed: "1" });
  await openApp(page);
  await register(page, { name: "Андрій", email: emailA, gender: "m" });
  await addByHand(page, "Secret role", "A Secret Co");
  await cardOf(page, "A Secret Co").locator('textarea[data-k="note"]').fill("зарплата A: 5000");
  await page.evaluate(async () => {
    const storage = await import("/js/core/storage.js");
    storage.setRaw(storage.KEYS.cv, "Андрій, резюме A: досвід, телефон +380000000000, і ще трохи тексту для довжини");
  });
  await waitSynced(page);
  await signOut(page);
  for (const key of [JOBS, PROGRESS, "jobdesk2000_cv_v1", "jd2000_owner", "jd2000_sync_base"]) {
    expect(await page.evaluate((k) => localStorage.getItem(k), key), key).toBeNull();
  }

  await register(page, { name: "Богдана", email: emailB, gender: "f" });
  await waitSynced(page);
  const uidB = await uidOf(page);
  await page.waitForTimeout(1500);
  const cloudB = await cloudData(uidB);
  const textB = JSON.stringify(cloudB || {});
  expect(textB).not.toContain("A Secret Co");
  expect(textB).not.toContain("зарплата A");
  expect(textB).not.toContain("резюме A");
  expect(textB).not.toContain("Андрій");
  expect(await localCompanies(page)).toEqual([]);
});

test("account A signs out while the cloud is unreachable, then account B signs in: nothing of A reaches B", async ({ page }, testInfo) => {
  const emailA = freshEmail(testInfo, "synca"), emailB = freshEmail(testInfo, "syncb");
  await seedStorage(page, { jobdesk2000_welcomed: "1" });
  await openApp(page);
  await register(page, { name: "Андрій", email: emailA, gender: "m" });
  await addByHand(page, "Secret role", "A Synced Co");
  await waitSynced(page);
  const uidA = await uidOf(page);

  await cutFirestore(page);
  await addByHand(page, "Late role", "A Unsynced Co");
  await signOut(page); // the flush gives up after a few seconds; the data stays on the device
  expect(await localCompanies(page)).toEqual(["A Synced Co", "A Unsynced Co"]);
  await restoreFirestore(page);

  await register(page, { name: "Богдана", email: emailB, gender: "f" });
  await waitSynced(page);
  const uidB = await uidOf(page);
  await page.waitForTimeout(1500);
  const textB = JSON.stringify((await cloudData(uidB)) || {});
  expect(textB).not.toContain("A Synced Co");
  expect(textB).not.toContain("A Unsynced Co");
  expect(await localCompanies(page)).toEqual([]);
  expect(await cloudCompanies(uidA)).toEqual(["A Synced Co"]);
});

test("signing out with an unsynced edit keeps it on the device and signing back in uploads it", async ({ page }, testInfo) => {
  const email = freshEmail(testInfo, "sync");
  await seedStorage(page, { jobdesk2000_welcomed: "1" });
  await openApp(page);
  await register(page, { name: "Олена", email });
  await addByHand(page, "Designer", "Saved Co");
  await waitSynced(page);
  const uid = await uidOf(page);

  await cutFirestore(page);
  await cardOf(page, "Saved Co").locator(".st-sel").selectOption("offer");
  await signOut(page);
  await restoreFirestore(page);
  await signIn(page, email);
  await waitSynced(page);
  await expect.poll(async () => progressIn(await cloudData(uid))["Saved Co|Designer"]?.status, { timeout: 20_000 }).toBe("Оффер");
});

/* ----- two tabs of one account ----- */

test("signing out in one tab while another tab is open leaves none of the account's data on the device", async ({ context }, testInfo) => {
  const tab1 = await context.newPage();
  await seedStorage(tab1, { jobdesk2000_welcomed: "1" });
  await openApp(tab1);
  await register(tab1, { name: "Олена", email: freshEmail(testInfo, "sync") });
  await addByHand(tab1, "Designer", "Private Co");
  await waitSynced(tab1);

  const tab2 = await context.newPage();
  await openApp(tab2);
  await openWindow(tab2, "vacancies");
  await expect(cardOf(tab2, "Private Co")).toHaveCount(1);

  // an edit just before signing out: the sign-out sends it first, and the other tab sees that write come in
  await cardOf(tab1, "Private Co").locator('textarea[data-k="note"]').fill("остання правка");
  const tab2Reload = tab2.waitForEvent("load", { timeout: 20_000 });
  await signOut(tab1);
  await tab2Reload;
  await tab2.waitForTimeout(3000);

  const check = await context.newPage();
  await openApp(check);
  expect(await check.evaluate(() => localStorage.getItem("jobdesk2000_added_v1"))).toBeNull();
  expect(await check.evaluate(() => localStorage.getItem("jobdesk2000_v1"))).toBeNull();
});

/* ----- the 900 KB limit and the wallpaper ----- */

// A deterministic noise picture whose JPEG (the app re-encodes at 0.8) is about `chars` characters as a data: URL.
// Returns the picture as PNG bytes for the file input.
async function noisePicture(page, chars) {
  const png = await page.evaluate((target) => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed & 255; };
    const draw = (h) => {
      seed = 7;
      const c = document.createElement("canvas"); c.width = 1280; c.height = h;
      const x = c.getContext("2d"); const img = x.createImageData(1280, h);
      for (let i = 0; i < img.data.length; i += 4) { img.data[i] = rnd(); img.data[i + 1] = rnd(); img.data[i + 2] = rnd(); img.data[i + 3] = 255; }
      x.putImageData(img, 0, 0);
      return c;
    };
    let lo = 16, hi = 2000;
    while (hi - lo > 2) {
      const mid = (lo + hi) >> 1;
      if (draw(mid).toDataURL("image/jpeg", 0.8).length < target) lo = mid; else hi = mid;
    }
    return draw(lo).toDataURL("image/png").split(",")[1];
  }, chars);
  return Buffer.from(png, "base64");
}

async function uploadWallpaper(page, buffer) {
  await openWindow(page, "fairy");
  await page.locator("#wall-file").setInputFiles({ name: "wall.png", mimeType: "image/png", buffer });
  await expect(page.locator("#desktop")).toHaveClass(/has-wall/);
  return page.evaluate(() => localStorage.getItem("jobdesk2000_wall_v1").length);
}

test("a big wallpaper is compressed to fit the cloud copy and is back after signing out and in again", async ({ page }, testInfo) => {
  const email = freshEmail(testInfo, "sync");
  await seedStorage(page, { jobdesk2000_welcomed: "1" });
  await openApp(page);
  await register(page, { name: "Олена", email });
  const size = await uploadWallpaper(page, await noisePicture(page, 1_100_000));
  expect(size, "the picture shrank to leave room for the vacancies").toBeLessThanOrEqual(600 * 1024);
  await waitSynced(page);
  const uid = await uidOf(page);
  expect(await cloudData(uid)).toHaveProperty(WALL);

  await signOut(page);
  await signIn(page, email);
  await waitSynced(page);
  await expect(page.locator("#desktop")).toHaveClass(/has-wall/);
});

test("a long note on one device does not take the shared wallpaper away from the other device", async ({ page, browser }, testInfo) => {
  const email = freshEmail(testInfo, "sync");
  await seedStorage(page, { jobdesk2000_welcomed: "1" });
  await openApp(page);
  await register(page, { name: "Олена", email });
  await addByHand(page, "Designer", "Wall Co");
  const size = await uploadWallpaper(page, await noisePicture(page, 860_000));
  expect(size).toBeLessThanOrEqual(600 * 1024);
  await waitSynced(page);
  const uid = await uidOf(page);
  expect(await cloudData(uid)).toHaveProperty(WALL);

  const phone = await newDevice(browser);
  await signIn(phone.page, email);
  await expect(phone.page.locator("#desktop")).toHaveClass(/has-wall/, { timeout: 15_000 });

  // the laptop writes a long note: the whole copy passes 900 KB and the wallpaper is left out of the cloud
  // ~180 thousand characters, ~330 KB in UTF-8: with the wallpaper the copy passes the 900 KB limit
  const long = "Кандидатка, нотатка до співбесіди. ".repeat(5200);
  await cardOf(page, "Wall Co").locator('textarea[data-k="note"]').fill(long);
  await waitSynced(page);
  await openWindow(phone.page, "vacancies");
  await expect(cardOf(phone.page, "Wall Co").locator('textarea[data-k="note"]')).toHaveValue(long, { timeout: 15_000 });
  await expect(phone.page.locator("#desktop")).toHaveClass(/has-wall/);
  expect(await phone.page.evaluate(() => localStorage.getItem("jobdesk2000_wall_v1"))).not.toBeNull();
  await phone.context.close();
});

/* ----- a corrupted cloud document ----- */

for (const [what, value] of [["null", null], ["an array", ["x"]]]) {
  test(`a cloud value that is ${what} instead of a string does not stop this device from syncing`, async ({ page }, testInfo) => {
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await seedStorage(page, { jobdesk2000_welcomed: "1" });
    await openApp(page);
    await register(page, { name: "Олена", email: freshEmail(testInfo, "sync") });
    await addByHand(page, "Designer", "Broken Co");
    await waitSynced(page);
    const uid = await uidOf(page);

    const data = await cloudData(uid);
    await writeCloudRaw(uid, JSON.stringify({ ...data, jobdesk2000_theme: value }));
    await page.waitForTimeout(1500);
    await cardOf(page, "Broken Co").locator(".st-sel").selectOption("offer");
    await expect.poll(async () => progressIn(await cloudData(uid))["Broken Co|Designer"]?.status, { timeout: 15_000 }).toBe("Оффер");
    expect(errors).toEqual([]);
  });
}

test("a cloud document that is not an object never deletes the vacancies on this device", async ({ page }, testInfo) => {
  await seedStorage(page, { jobdesk2000_welcomed: "1" });
  await openApp(page);
  await register(page, { name: "Олена", email: freshEmail(testInfo, "sync") });
  await addByHand(page, "Designer", "First Co");
  await addByHand(page, "Motion", "Second Co");
  await waitSynced(page);
  const uid = await uidOf(page);

  await writeCloudRaw(uid, JSON.stringify("corrupted"));
  await page.waitForTimeout(1500);
  await cardOf(page, "First Co").locator(".st-sel").selectOption("applied");
  await page.waitForTimeout(3000);
  expect(await localCompanies(page)).toEqual(["First Co", "Second Co"]);
  await expect.poll(() => cloudCompanies(uid), { timeout: 15_000 }).toEqual(["First Co", "Second Co"]);
});
