// Every screen of the app on every device of the layout matrix (see playwright.config.mjs).
// Each screen is checked with layoutProblems() and saved as a screenshot under test-results/screens/<device>/.
import fs from "node:fs";
import { test, expect } from "@playwright/test";
import { seedVacancies, seedStorage, openApp, openWindow, closeWindow, register, freshEmail, layoutProblems } from "./helpers.mjs";

const GUEST_WINDOWS = ["vacancies", "stats", "about", "valya", "readme"];

async function check(page, testInfo, screen) {
  await page.waitForTimeout(350); // let open/close animations settle
  const touch = !!testInfo.project.use.hasTouch;
  const device = testInfo.project.name.replace(/^layout-/, "");
  await page.screenshot({ path: `test-results/screens/${device}/${screen}.png` });
  const problems = await layoutProblems(page, { touch });
  if (problems.length) fs.writeFileSync(`test-results/screens/${device}/${screen}.problems.json`, JSON.stringify(problems, null, 1));
  expect.soft(problems, `${screen} on ${device}`).toEqual([]);
}

test.describe("@layout", () => {
  test("first visit: welcome dialog", async ({ page }, testInfo) => {
    await seedStorage(page, {});
    await openApp(page);
    await expect(page.locator("#welcome-overlay")).toHaveClass(/open/);
    await check(page, testInfo, "01-welcome");
  });

  test("guest desktop, windows, menus and dialogs", async ({ page }, testInfo) => {
    await seedVacancies(page);
    await openApp(page);
    await check(page, testInfo, "02-desktop");

    for (const app of GUEST_WINDOWS) {
      await openWindow(page, app);
      await check(page, testInfo, "03-window-" + app);
      await closeWindow(page, app);
    }

    await page.locator("#startbtn").click();
    await expect(page.locator("#startmenu")).toHaveClass(/open/);
    await check(page, testInfo, "04-start-menu");
    await page.keyboard.press("Escape");

    await openWindow(page, "vacancies");
    await page.locator(".jedit").first().click();
    await expect(page.locator("#edit-overlay")).toHaveClass(/open/);
    await check(page, testInfo, "05-edit-dialog");
    await page.keyboard.press("Escape");

    await page.locator(".jdel").first().click();
    await expect(page.locator("#confirm-overlay")).toHaveClass(/open/);
    await check(page, testInfo, "05b-confirm-dialog");
    await page.keyboard.press("Escape");

    // the undo notice after a removal
    await page.locator(".jdel").first().click();
    await page.locator("#confirm-ok").click();
    await expect(page.locator("#toast")).toBeVisible();
    await check(page, testInfo, "05c-undo-notice");
    await page.locator("#toast .toast-act").click();

    await page.locator("#btn-paste").click();
    await check(page, testInfo, "06-paste-box");
    await closeWindow(page, "vacancies");

    await page.locator('.d-icon[data-open="messenger"]').click();
    await expect(page.locator("#gate-overlay")).toHaveClass(/open/);
    await check(page, testInfo, "07-guest-gate");
    await page.locator("#gate-register").click();
    await page.locator('.auth-tab[data-tab="register"]').click();
    await check(page, testInfo, "08-register-dialog");
  });

  test("signed-in windows: messenger with a letter, my fairy, dark theme", async ({ page }, testInfo) => {
    await seedVacancies(page);
    await openApp(page);
    await register(page, { name: "Олена", email: freshEmail(testInfo) });

    await openWindow(page, "messenger");
    await page.locator("#cv-paste-toggle").click();
    await page.locator("#cv-paste").fill("Олена Тестенко. Графічна дизайнерка, 5 років брендингу: Figma, Illustrator, Photoshop. Айдентика для музичного лейблу.");
    await page.locator("#cv-paste-save").click();
    await page.locator("#cl-gen").click();
    await expect(page.locator("#cl-out .chat-letter")).toHaveCount(1);
    await check(page, testInfo, "09-messenger-letter");
    await closeWindow(page, "messenger");

    await openWindow(page, "fairy");
    await check(page, testInfo, "10-my-fairy");
    await closeWindow(page, "fairy");

    await page.locator("#btn-theme").click();
    await openWindow(page, "vacancies");
    await check(page, testInfo, "11-dark-vacancies");
    await closeWindow(page, "vacancies");

    await page.evaluate(() => window.jobdesk.say("Ти обкладинка цього дня ✦ гарна й помітна! Рекрутери ще не знають, як їм пощастило ✦", 1, 60000));
    await check(page, testInfo, "12-clippy");
  });
});
