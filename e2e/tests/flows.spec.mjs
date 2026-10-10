// User journeys, run on a desktop browser and on an iPhone 11 (see playwright.config.mjs).
// The dev server answers the AI with a deterministic mock and signs people in through the Firebase emulators.
import fs from "node:fs";
import { test, expect } from "@playwright/test";
import { seedStorage, seedVacancies, openApp, openWindow, closeWindow, register, signIn, signOut, setMock, freshEmail, confirmYes, watchCsp, cspViolations, PASSWORD } from "./helpers.mjs";

const VACANCY_TEXT = "Acme Studio шукає Senior Graphic Designer. Повна зайнятість, віддалено. Зарплата 1500-2000$. Досвід 3+ роки у Figma.";
const CV_TEXT = "Олена Тестенко. Графічна дизайнерка, 5 років брендингу: Figma, Illustrator, Photoshop. Айдентика для музичного лейблу.";

test("a guest adds vacancies by text, by link and by hand, edits, filters and removes them", async ({ page }) => {
  await watchCsp(page);
  await seedStorage(page, { jobdesk2000_welcomed: "1" });
  await openApp(page);
  await page.locator('.d-icon[data-open="vacancies"]').click();
  const win = page.locator("#win-vacancies");
  await expect(win).toHaveClass(/open/);
  await expect(win.locator("#board")).toContainText("Тут поки порожньо");

  // pasted text
  await win.locator("#btn-paste").click();
  await win.locator("#a-paste").fill(VACANCY_TEXT);
  await win.locator("#a-paste-url").fill("acme.example.com/jobs/42");
  await win.locator("#a-paste-go").click();
  await expect(win.locator("#add-url-msg")).toHaveText("Додано: Mock Studio ✦");
  await expect(win.locator(".jobcard")).toHaveCount(1);
  await expect(win.locator(".jlink").first()).toHaveAttribute("href", "https://acme.example.com/jobs/42");

  // a link the server refuses to fetch opens the paste route with the link filled in
  await win.locator("#add-url").fill("https://localhost/internal");
  await win.locator("#add-url").press("Enter");
  await expect(win.locator("#add-url-msg")).toContainText("Не вдалося відкрити сторінку");
  await expect(win.locator("#paste-box")).toBeVisible();
  await expect(win.locator("#a-paste-url")).toHaveValue("https://localhost/internal");

  // by hand, with markup and a javascript: link that must stay inert
  await win.locator("#btn-manual").click();
  const edit = page.locator("#edit-overlay");
  await expect(edit).toHaveClass(/open/);
  await edit.locator("#ev-title").fill('<img src=x onerror="window.__xss=1">Motion Designer');
  await edit.locator("#ev-company").fill("Label & Co");
  await edit.locator("#ev-url").fill("javascript:alert(1)");
  await edit.locator("#ev-prio").selectOption("Подумати");
  await edit.locator("#ev-save").click();
  await expect(edit).not.toHaveClass(/open/);
  const handmade = win.locator(".jobcard", { hasText: "Label & Co" });
  await expect(handmade.locator(".jt")).toHaveText('<img src=x onerror="window.__xss=1">Motion Designer');
  await expect(handmade.locator(".jlink")).toHaveAttribute("href", "#");
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();

  // edit: a rename keeps the card
  await handmade.locator(".jedit").click();
  await edit.locator("#ev-company").fill("Label Records");
  await edit.locator("#ev-save").click();
  await expect(win.locator(".jobcard", { hasText: "Label Records" })).toHaveCount(1);

  // status change stamps the date and feeds the statistics
  const first = win.locator(".jobcard").first();
  await first.locator(".st-sel").selectOption("applied");
  await expect(first.locator('input[data-k="date"]')).not.toHaveValue("");
  await openWindow(page, "stats");
  await expect(page.locator("#s-total")).toHaveText("2");
  await expect(page.locator("#s-applied")).toHaveText("1");
  await page.evaluate(() => window.jobdesk.closeWin("stats"));

  // filters
  await win.locator("#f-status").selectOption("applied");
  await expect(win.locator(".jobcard")).toHaveCount(1);
  await win.locator("#btn-reset").click();
  await expect(win.locator(".jobcard")).toHaveCount(2);

  // a note survives a reload
  await first.locator('textarea[data-k="note"]').fill("HR: Олена, дзвінок у пʼятницю");
  await page.reload();
  await openWindow(page, "vacancies");
  await expect(win.locator('textarea[data-k="note"]').first()).toHaveValue("HR: Олена, дзвінок у пʼятницю");

  // removal asks first, in the app's own dialog; "no" keeps the card
  await win.locator(".jobcard", { hasText: "Label Records" }).locator(".jdel").click();
  await expect(page.locator("#confirm-text")).toHaveText("Видалити «Label Records — <img src=x onerror=\"window.__xss=1\">Motion Designer» зі списку?");
  await page.keyboard.press("Escape");
  await expect(win.locator(".jobcard")).toHaveCount(2);
  await win.locator(".jobcard", { hasText: "Label Records" }).locator(".jdel").click();
  await confirmYes(page);
  await expect(win.locator(".jobcard")).toHaveCount(1);

  // a removal can be undone from the notice, with everything the card had
  await expect(page.locator("#toast")).toContainText("Вакансію прибрано");
  await page.locator("#toast .toast-act").click();
  await expect(win.locator(".jobcard")).toHaveCount(2);
  await expect(win.locator(".jobcard", { hasText: "Label Records" })).toHaveCount(1);

  // search looks through titles, companies and notes
  await win.locator("#f-search").fill("пʼятницю");
  await expect(win.locator(".jobcard")).toHaveCount(1);
  await win.locator("#f-search").fill("нема такого");
  await expect(win.locator("#board")).toContainText("Нічого не знайдено");
  await win.locator("#btn-reset").click();
  await expect(win.locator("#f-search")).toHaveValue("");
  await expect(win.locator(".jobcard")).toHaveCount(2);

  // a deadline tomorrow gets a badge at once, without redrawing the card
  const tomorrow = await page.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  });
  const card = win.locator(".jobcard", { hasText: "Label Records" });
  await card.locator('input[data-k="deadline"]').fill(tomorrow);
  await expect(card.locator(".jtag.dl")).toHaveText("⏳ дедлайн завтра");
  expect(await cspViolations(page)).toEqual([]);
});

test("registration, a cover letter, a revision, a busy retry and copying", async ({ page, browserName, context, baseURL }, testInfo) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await watchCsp(page);
  await seedStorage(page, { jobdesk2000_welcomed: "1" });
  await openApp(page);
  await register(page, { name: "Олена", email: freshEmail(testInfo) });
  await expect(page.locator("#clippy-say")).toContainText("Вітаю, Олена!");

  await openWindow(page, "vacancies");
  await page.locator("#btn-paste").click();
  await page.locator("#a-paste").fill(VACANCY_TEXT);
  await page.locator("#a-paste-go").click();
  await expect(page.locator("#win-vacancies .jobcard")).toHaveCount(1);
  await page.evaluate(() => window.jobdesk.closeWin("vacancies"));

  await page.locator('.d-icon[data-open="messenger"]').click();
  const win = page.locator("#win-messenger");
  await expect(win).toHaveClass(/open/);
  await win.locator("#cl-gen").click();
  await expect(page.locator("#clippy-say")).toHaveText("Спершу завантаж резюме (PDF) ✦");

  await win.locator("#cv-paste-toggle").click();
  await win.locator("#cv-paste").fill(CV_TEXT);
  await win.locator("#cv-paste-save").click();
  await expect(win.locator("#cv-txt")).toContainText("Резюме завантажено ✦");
  await expect(page.locator("#clippy-say")).toContainText("Бачу, ти графічна дизайнерка");

  await win.locator("#cl-gen").click();
  await expect(win.locator(".chat-letter")).toHaveCount(1);
  await expect(win.locator(".chat-letter").first()).toContainText("Мене звати Олена");
  await expect(win.locator("#cl-status")).toHaveText("Готово ✦");

  await win.locator("#cl-edit").fill("зроби коротшим");
  await win.locator("#cl-edit").press("Enter");
  await expect(win.locator(".chat-letter")).toHaveCount(2);
  await expect(win.locator(".chat-letter").last()).toContainText("Оновлено за правкою: «зроби коротшим»");

  // the AI is busy: the fairy counts down and retries by herself
  await setMock(context, "busy", baseURL);
  await win.locator("#cl-gen").click();
  await expect(win.locator("#cl-status")).toContainText("автоматично пробую ще раз");
  await setMock(context, "ok", baseURL);
  await expect(win.locator(".chat-letter")).toHaveCount(3, { timeout: 20_000 });
  await expect(win.locator("#cl-gen")).toBeEnabled();

  if (browserName === "chromium") {
    await win.locator(".letter-copy").last().click();
    await expect(win.locator(".letter-copy").last()).toHaveText("✓ скопійовано");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Шановна командо");
  }
  expect(await cspViolations(page)).toEqual([]); // sign-in, Firestore and the AI calls all stay inside the policy
});

test("cloud sync: signing out clears the device, signing in restores it, a second device follows live", async ({ page, browser }, testInfo) => {
  const email = freshEmail(testInfo);
  await seedStorage(page, { jobdesk2000_welcomed: "1" });
  await openApp(page);
  await register(page, { name: "Олена", email });
  await openWindow(page, "vacancies");
  await page.locator("#btn-manual").click();
  await page.locator("#ev-title").fill("Brand Designer");
  await page.locator("#ev-company").fill("Sync Studio");
  await page.locator("#ev-save").click();
  await expect(page.locator(".jobcard", { hasText: "Sync Studio" })).toHaveCount(1);
  await page.waitForTimeout(2000); // the cloud write is debounced

  await signOut(page);
  expect(await page.evaluate(() => localStorage.getItem("jobdesk2000_added_v1"))).toBeNull();

  await signIn(page, email);
  await openWindow(page, "vacancies");
  await expect(page.locator(".jobcard", { hasText: "Sync Studio" })).toHaveCount(1);

  // a second device
  const other = await browser.newContext();
  const page2 = await other.newPage();
  await seedStorage(page2, { jobdesk2000_welcomed: "1" });
  await openApp(page2);
  await signIn(page2, email);
  await openWindow(page2, "vacancies");
  await expect(page2.locator(".jobcard", { hasText: "Sync Studio" })).toHaveCount(1);

  await page.locator(".jobcard", { hasText: "Sync Studio" }).locator(".st-sel").selectOption("offer");
  await expect(page2.locator(".jobcard", { hasText: "Sync Studio" }).locator(".st-sel")).toHaveValue("offer", { timeout: 15_000 });
  await other.close();
});

test("my fairy: type, colours, name, wallpaper and matching colours", async ({ page }, testInfo) => {
  await seedStorage(page, { jobdesk2000_welcomed: "1" });
  await openApp(page);
  await register(page, { name: "Олена", email: freshEmail(testInfo) });
  await page.locator('.d-icon[data-open="fairy"]').click();
  const win = page.locator("#win-fairy");
  await expect(win).toHaveClass(/open/);

  await win.locator('.type-btn[data-type="type2"]').click();
  await expect(win.locator('.type-btn[data-type="type2"]')).toHaveClass(/sel/);
  await win.locator("#cc-dress").evaluate((el) => { el.value = "#2b8fff"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await win.locator("#fairy-name").fill("Піксі");
  await win.locator("#fairy-save").click();
  await expect(page.locator("#clippy-say")).toHaveText("Піксі готова допомагати ✦ Полетіли!");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("jobdesk2000_fairy_v1")));
  expect(saved).toMatchObject({ name: "Піксі", current: "type2", type2: { dress: "#2b8fff" } });

  // wallpaper: a generated picture, then colours matched to it
  const png = await page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 1600; c.height = 900;
    const x = c.getContext("2d"); x.fillStyle = "#3a1d7a"; x.fillRect(0, 0, 1600, 900); x.fillStyle = "#39ffd0"; x.fillRect(800, 200, 500, 500);
    return c.toDataURL("image/png").split(",")[1];
  });
  await win.locator("#wall-file").setInputFiles({ name: "wall.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await expect(page.locator("#desktop")).toHaveClass(/has-wall/);
  await expect(win.locator("#wall-remove")).toBeVisible();
  await win.locator("#fairy-match").click();
  await expect(page.locator("#clippy-say")).toHaveText("Фею перефарбовано під фон ✦");
  await win.locator("#wall-remove").click();
  await expect(page.locator("#desktop")).not.toHaveClass(/has-wall/);
});

test("theme, tile mode and the keyboard", async ({ page }) => {
  await seedStorage(page, {});
  await openApp(page);
  await expect(page.locator("#welcome-overlay")).toHaveClass(/open/);
  await page.keyboard.press("Escape");
  await expect(page.locator("#welcome-overlay")).not.toHaveClass(/open/);

  await page.locator("#btn-theme").click();
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/theme-dark/);
  await expect(page.locator("#btn-theme")).toHaveText("🌙");

  if (await page.locator("#btn-tile").isVisible()) {
    await page.locator("#btn-tile").click();
    await expect(page.locator("body")).toHaveClass(/tile-mode/);
    await page.locator("#btn-theme").click(); // used to break tile mode
    await expect(page.locator("body")).toHaveClass(/tile-mode/);
    await expect(page.locator("#tilewrap .win")).toHaveCount(5); // the guest windows, README.TXT included
    await expect(page.locator("#win-messenger")).toBeHidden();
    await page.locator("#btn-tile").click();
  }

  await page.locator('.d-icon[data-open="fairy"]').click();
  await expect(page.locator("#gate-overlay")).toHaveClass(/open/);
  await page.keyboard.press("Escape");
  await expect(page.locator("#gate-overlay")).not.toHaveClass(/open/);
});

test("offline: the analysis reports a busy service instead of hanging", async ({ page, context }) => {
  await seedStorage(page, { jobdesk2000_welcomed: "1" });
  await openApp(page);
  await openWindow(page, "vacancies");
  await page.locator("#btn-paste").click();
  await page.locator("#a-paste").fill(VACANCY_TEXT);
  await context.setOffline(true);
  await page.locator("#a-paste-go").click();
  await expect(page.locator("#add-url-msg")).toContainText("Сервіс зараз зайнятий");
  await context.setOffline(false);
  await expect(page.locator("#a-paste-go")).toBeEnabled();
});

test("a wrong password says so, and a missing page shows the 404", async ({ page }, testInfo) => {
  await seedStorage(page, { jobdesk2000_welcomed: "1" });
  await openApp(page);
  await register(page, { name: "Олена", email: freshEmail(testInfo) });
  const email = await page.evaluate(() => JSON.parse(localStorage.getItem("jobdesk2000_user_v1")).email);
  await signOut(page);
  await page.evaluate(() => window.jobdesk.emit("auth:open", "login"));
  await page.locator("#auth-email").fill(email);
  await page.locator("#auth-pass").fill(PASSWORD + "x");
  await page.locator("#auth-pass").press("Enter");
  await expect(page.locator("#auth-msg")).toHaveText("Невірна пошта або пароль ✦");

  const res = await page.goto("/no-such-page");
  expect(res.status()).toBe(404);
  await expect(page.locator("h1")).toHaveText("Сторінку не знайдено ✦");
});

/* ----- cloud sync edge cases (merge, offline, tabs) ----- */

async function addByHand(page, title, company) {
  await openWindow(page, "vacancies");
  await page.locator("#btn-manual").click();
  await page.locator("#ev-title").fill(title);
  await page.locator("#ev-company").fill(company);
  await page.locator("#ev-save").click();
  await expect(page.locator(".jobcard", { hasText: company })).toHaveCount(1);
}
const cardsOf = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("jobdesk2000_added_v1") || "[]").map((j) => j.company));
const waitSynced = (page) => page.waitForFunction(() => !localStorage.getItem("jd2000_sync_dirty"), null, { timeout: 15_000 });

test("an edit made offline merges with another device's change instead of overwriting it", async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name !== "flows-desktop", "one browser engine is enough for the sync logic");
  const email = freshEmail(testInfo);
  await seedStorage(page, { jobdesk2000_welcomed: "1" });
  await openApp(page);
  await register(page, { name: "Олена", email });
  await addByHand(page, "Designer", "Base Co");
  await waitSynced(page);

  const phoneCtx = await browser.newContext();
  const phone = await phoneCtx.newPage();
  await seedStorage(phone, { jobdesk2000_welcomed: "1" });
  await openApp(phone);
  await signIn(phone, email);
  await openWindow(phone, "vacancies");
  await expect(phone.locator(".jobcard", { hasText: "Base Co" })).toHaveCount(1);

  // the laptop goes offline and changes a status; meanwhile the phone adds a vacancy
  await page.context().setOffline(true);
  await page.locator(".jobcard", { hasText: "Base Co" }).locator(".st-sel").selectOption("interview1");
  await addByHand(phone, "Illustrator", "Phone Co");
  await waitSynced(phone);

  await page.context().setOffline(false);
  await expect.poll(() => cardsOf(page), { timeout: 20_000 }).toEqual(["Base Co", "Phone Co"]);
  await waitSynced(page);
  await expect(phone.locator(".jobcard", { hasText: "Base Co" }).locator(".st-sel")).toHaveValue("interview1", { timeout: 15_000 });
  await expect(phone.locator(".jobcard", { hasText: "Phone Co" })).toHaveCount(1);
  await phoneCtx.close();
});

test("an edit in a tab closed right away is not lost, and two tabs do not overwrite each other", async ({ context }, testInfo) => {
  test.skip(testInfo.project.name !== "flows-desktop", "one browser engine is enough for the sync logic");
  const tab1 = await context.newPage();
  await seedStorage(tab1, { jobdesk2000_welcomed: "1" });
  await openApp(tab1);
  await register(tab1, { name: "Олена", email: freshEmail(testInfo) });
  await addByHand(tab1, "Designer", "Tab One");
  await waitSynced(tab1);

  const tab2 = await context.newPage();
  await openApp(tab2);
  await openWindow(tab2, "vacancies");
  await expect(tab2.locator(".jobcard", { hasText: "Tab One" })).toHaveCount(1);

  // tab 1 adds a vacancy; tab 2 must see it before its own next save
  await addByHand(tab1, "Motion", "Tab Two Co");
  await expect(tab2.locator(".jobcard", { hasText: "Tab Two Co" })).toHaveCount(1);
  await tab2.locator(".jobcard", { hasText: "Tab One" }).locator(".st-sel").selectOption("offer");
  await expect.poll(() => cardsOf(tab1)).toEqual(["Tab One", "Tab Two Co"]);

  // a change, then the tab closes at once (inside the 800 ms debounce)
  await tab2.locator(".jobcard", { hasText: "Tab Two Co" }).locator('textarea[data-k="note"]').fill("закрила вкладку одразу");
  await tab2.close();
  await tab1.close();
  const again = await context.newPage();
  await openApp(again);
  await openWindow(again, "vacancies");
  await waitSynced(again);
  await again.reload();
  await openWindow(again, "vacancies");
  await expect(again.locator(".jobcard", { hasText: "Tab Two Co" }).locator('textarea[data-k="note"]')).toHaveValue("закрила вкладку одразу");
  await expect(again.locator(".jobcard", { hasText: "Tab One" }).locator(".st-sel")).toHaveValue("offer");
});

test("a guest saves a copy of the data, loses it and gets it back from the copy; README.TXT explains it all", async ({ page }) => {
  await seedVacancies(page);
  await openApp(page);

  // README.TXT opens from the desktop and from START
  await page.locator('.d-icon[data-open="readme"]').click();
  await expect(page.locator("#win-readme")).toHaveClass(/open/);
  await expect(page.locator("#win-readme")).toContainText("Копія даних");
  await closeWindow(page, "readme");
  await page.locator("#startbtn").click();
  await page.locator('#startmenu [data-sm="readme"]').click();
  await expect(page.locator("#win-readme")).toHaveClass(/open/);
  await closeWindow(page, "readme");

  // the copy and the table
  await page.locator("#startbtn").click();
  const [copy] = await Promise.all([page.waitForEvent("download"), page.locator('#startmenu [data-action="backup"]').click()]);
  expect(copy.suggestedFilename()).toMatch(/^jobdesk2000-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const copyText = fs.readFileSync(await copy.path(), "utf8");
  expect(JSON.parse(copyText).app).toBe("JobDesk 2000");
  await page.locator("#startbtn").click();
  const [table] = await Promise.all([page.waitForEvent("download"), page.locator('#startmenu [data-action="table"]').click()]);
  const csv = fs.readFileSync(await table.path(), "utf8");
  expect(csv.split("\r\n")[1]).toContain("Acme Studio;Senior Graphic Designer");

  // everything is gone, then comes back from the file
  await page.evaluate(() => { localStorage.removeItem("jobdesk2000_added_v1"); localStorage.removeItem("jobdesk2000_v1"); });
  await page.reload();
  await openWindow(page, "vacancies");
  await expect(page.locator(".jobcard")).toHaveCount(0);
  await page.locator("#backup-file").setInputFiles({ name: "copy.json", mimeType: "application/json", buffer: Buffer.from(copyText) });
  await expect(page.locator("#confirm-text")).toContainText("вакансій: 3");
  await confirmYes(page);
  await expect(page.locator(".jobcard")).toHaveCount(3);
  await expect(page.locator("#toast")).toContainText("додано вакансій: 3");
  await expect(page.locator('.jobcard textarea[data-k="note"]').first()).toHaveValue("HR: Олена");

  // a file that is not a copy is refused
  await page.locator("#backup-file").setInputFiles({ name: "x.json", mimeType: "application/json", buffer: Buffer.from('{"hello":1}') });
  await expect(page.locator("#toast")).toContainText("не схоже на копію");
});

test.describe("installed or offline", () => {
  test.use({ serviceWorkers: "allow" });

  test("the app opens without a connection after one visit, with the vacancies and the offline badge", async ({ page, context }, testInfo) => {
    test.skip(testInfo.project.name !== "flows-desktop", "Chromium's service worker is enough here");
    await seedVacancies(page);
    await openApp(page);
    await page.evaluate(() => navigator.serviceWorker.ready);
    // the worker caches what this first visit loaded
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).length && (await (await caches.open((await caches.keys())[0])).keys()).length), { timeout: 15_000 }).toBeGreaterThan(10);

    await context.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => !!window.jobdesk);
    await expect(page.locator("#tb-offline")).toBeVisible();
    await openWindow(page, "vacancies");
    await expect(page.locator(".jobcard")).toHaveCount(3);
    await openWindow(page, "readme");
    await expect(page.locator("#win-readme")).toContainText("README.TXT");
    await context.setOffline(false);
    await expect(page.locator("#tb-offline")).toBeHidden();
  });
});
