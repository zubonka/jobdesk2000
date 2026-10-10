// Accessibility of every screen in both themes: axe-core (the checker behind Lighthouse's accessibility score)
// with the WCAG 2.1 A and AA rules. Lighthouse only sees the first screen; this also opens the windows and dialogs.
import fs from "node:fs";
import { createRequire } from "node:module";
import { test, expect } from "@playwright/test";
import { seedVacancies, seedStorage, openApp, openWindow, closeWindow, register, freshEmail } from "./helpers.mjs";

const AXE = fs.readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const GUEST_WINDOWS = ["vacancies", "stats", "about", "valya", "readme"];

// Checks what is on screen now. The script goes in through the debugger, so the page's content policy never sees it.
async function check(page, screen) {
  await page.waitForTimeout(350); // let open/close animations settle: a half-faded text has a lower contrast
  if (!(await page.evaluate(() => !!window.axe))) await page.evaluate(AXE);
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      resultTypes: ["violations"],
    });
    return result.violations.map((v) => ({
      rule: v.id,
      help: v.help,
      nodes: v.nodes.slice(0, 6).map((n) => n.target.join(" ") + ": " + (n.failureSummary || "").split("\n").slice(1).join(" ").slice(0, 200)),
    }));
  });
  expect.soft(violations, screen).toEqual([]);
}

async function setTheme(page, theme) {
  const now = await page.evaluate(() => (document.documentElement.classList.contains("theme-dark") ? "dark" : "light"));
  if (now !== theme) await page.locator("#btn-theme").click();
}

test("first visit: the welcome dialog", async ({ page }) => {
  await seedStorage(page, {});
  await openApp(page);
  await expect(page.locator("#welcome-overlay")).toHaveClass(/open/);
  await check(page, "welcome");
});

for (const theme of ["light", "dark"]) {
  test(`guest screens, ${theme} theme`, async ({ page }) => {
    await seedVacancies(page);
    await openApp(page);
    await setTheme(page, theme);
    await check(page, `${theme}: desktop`);

    for (const app of GUEST_WINDOWS) {
      await openWindow(page, app);
      await check(page, `${theme}: ${app} window`);
      if (app !== "vacancies") await closeWindow(page, app);
    }
    await check(page, `${theme}: taskbar with an open window`);

    await page.locator(".jedit").first().click();
    await expect(page.locator("#edit-overlay")).toHaveClass(/open/);
    await check(page, `${theme}: edit dialog`);
    await page.keyboard.press("Escape");

    await page.locator(".jdel").first().click();
    await expect(page.locator("#confirm-overlay")).toHaveClass(/open/);
    await check(page, `${theme}: confirm dialog`);
    await page.keyboard.press("Escape");

    await page.locator("#btn-paste").click();
    await check(page, `${theme}: paste box`);
    await closeWindow(page, "vacancies");

    await page.locator("#startbtn").click();
    await expect(page.locator("#startmenu")).toHaveClass(/open/);
    await check(page, `${theme}: START menu`);
    await page.keyboard.press("Escape");

    await page.locator('.d-icon[data-open="messenger"]').click();
    await expect(page.locator("#gate-overlay")).toHaveClass(/open/);
    await check(page, `${theme}: guest gate`);
    await page.locator("#gate-register").click();
    await page.locator('.auth-tab[data-tab="register"]').click();
    await check(page, `${theme}: register dialog`);
  });

  test(`signed-in screens, ${theme} theme`, async ({ page }, testInfo) => {
    await seedVacancies(page);
    await openApp(page);
    await setTheme(page, theme);
    await register(page, { name: "Олена", email: freshEmail(testInfo, theme) });

    await openWindow(page, "messenger");
    await check(page, `${theme}: messenger`);
    await page.locator("#cv-paste-toggle").click();
    await page.locator("#cv-paste").fill("Олена Тестенко. Графічна дизайнерка, 5 років брендингу: Figma, Illustrator, Photoshop. Айдентика для музичного лейблу.");
    await page.locator("#cv-paste-save").click();
    await page.locator("#cl-gen").click();
    await expect(page.locator("#cl-out .chat-letter")).toHaveCount(1);
    await check(page, `${theme}: messenger with a letter`);
    await closeWindow(page, "messenger");

    await openWindow(page, "fairy");
    await check(page, `${theme}: my fairy`);
    await closeWindow(page, "fairy");

    await page.evaluate(() => window.jobdesk.say("Ти обкладинка цього дня ✦ гарна й помітна! Рекрутери ще не знають, як їм пощастило ✦", 1, 60000));
    await check(page, `${theme}: the fairy speaking`);
  });
}
