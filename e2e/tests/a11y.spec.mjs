// Accessibility of every screen in both themes: axe-core (the checker behind Lighthouse's accessibility score)
// with the WCAG 2.1 A and AA rules. Lighthouse only sees the first screen; this also opens the windows and dialogs.
import fs from "node:fs";
import { createRequire } from "node:module";
import { test, expect } from "@playwright/test";
import { seedVacancies, seedStorage, openApp, openWindow, closeWindow, register, freshEmail } from "./helpers.mjs";

const AXE = fs.readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const GUEST_WINDOWS = ["vacancies", "stats", "about", "valya", "readme"];
// Text on a gradient below AA by the owner's design, left to her (README, browser tests): measured, but not failed.
// The START menu header: white letters running into the mint end of its lavender-to-mint gradient.
const KNOWN_GRADIENTS = ["#startmenu .sm-head"];

// Checks what is on screen now. The script goes in through the debugger, so the page's content policy never sees it.
async function check(page, screen) {
  // a half-faded text has a lower contrast: wait for the windows, dialogs and the fairy to finish appearing
  // (looping decorations never finish and do not count)
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity), null, { timeout: 5000 }).catch(() => {});
  if (!(await page.evaluate(() => !!window.axe))) await page.evaluate(AXE);
  const { violations, gradients } = await page.evaluate(async (known) => {
    const result = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      resultTypes: ["violations", "incomplete"],
    });
    // axe cannot see a colour behind text on a gradient and leaves it "incomplete": measured here against every
    // colour stop, the worst one counts
    // the opaque colours of a background (translucent ones, such as the desktop's grid lines, only tint it)
    const rgb = (text) => (text.match(/rgba?\([^)]+\)/g) || []).map((c) => c.match(/[\d.]+/g).map(Number))
      .filter((c) => c.length < 4 || c[3] >= 0.99).map((c) => c.slice(0, 3));
    const lum = ([r, g, b]) => [r, g, b].map((v) => v / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    const gradients = [];
    for (const node of result.incomplete.filter((r) => r.id === "color-contrast").flatMap((r) => r.nodes)) {
      if (!node.any.some((c) => /bgGradient|bgImage/.test(c.data?.messageKey || ""))) continue;
      const el = document.querySelector(node.target[0]);
      let bg = el;
      while (bg && !/gradient/.test(getComputedStyle(bg).backgroundImage)) bg = bg.parentElement;
      if (!el || !bg) continue;
      const style = getComputedStyle(el), size = parseFloat(style.fontSize), bold = Number(style.fontWeight) >= 700;
      const needed = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      const stops = rgb(getComputedStyle(bg).backgroundImage);
      if (!stops.length) continue;
      const worst = Math.min(...stops.map((stop) => ratio(rgb(style.color)[0], stop)));
      if (worst < needed && !known.some((sel) => el.closest(sel))) gradients.push(`${node.target.join(" ")}: ${worst.toFixed(2)} at the worst stop, needs ${needed}`);
    }
    return {
      gradients,
      violations: result.violations.map((v) => ({
        rule: v.id,
        help: v.help,
        nodes: v.nodes.slice(0, 6).map((n) => n.target.join(" ") + ": " + (n.failureSummary || "").split("\n").slice(1).join(" ").slice(0, 200)),
      })),
    };
  }, KNOWN_GRADIENTS);
  expect.soft(violations, screen).toEqual([]);
  expect.soft(gradients, screen + ": text on a gradient").toEqual([]);
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

test("the keyboard follows the windows: Enter on an icon opens one, closing or minimising gives the focus back", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "flows-desktop", "phones have no Tab key");
  await seedVacancies(page);
  await openApp(page);
  const icon = page.locator('.d-icon[data-open="stats"]'), win = page.locator("#win-stats");
  const focusIn = () => page.evaluate(() => document.activeElement?.closest(".win")?.id || null);

  await icon.focus();
  await page.keyboard.press("Enter");
  await expect(win).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await focusIn(), "Tab goes on inside the window").toBe("win-stats");

  await win.locator('[data-close="stats"]').focus();
  await page.keyboard.press("Enter");
  await expect(win).not.toHaveClass(/open/);
  await expect(icon, "closing gives the focus back to the icon").toBeFocused();

  await page.keyboard.press("Enter");
  await expect(win).toBeFocused();
  await win.locator('[data-min="stats"]').focus();
  await page.keyboard.press("Enter");
  const task = page.locator('.tb-task[data-app="stats"]');
  await expect(task, "a minimised window leaves the focus on its taskbar button").toBeFocused();
  await page.keyboard.press("Enter");
  await expect(win, "the taskbar button brings the window back with the focus").toBeFocused();

  // a window that opens while the person types elsewhere does not take the keyboard away
  await openWindow(page, "vacancies");
  await page.locator("#f-search").focus();
  await page.keyboard.type("Acme");
  await openWindow(page, "about");
  await expect(page.locator("#f-search")).toBeFocused();
  await page.keyboard.type(" Studio");
  await expect(page.locator("#f-search")).toHaveValue("Acme Studio");
});
