// Attack on windows, dialogs, keyboard and touch (key: ui). Every test states the correct behaviour, so a bug
// shows up as a failing test and the file turns into a regression test once it is fixed.
// Runs on flows-desktop (Chromium 1440x900; some tests narrow it to the phone layout) and flows-iphone (WebKit),
// plus a few layout-<device> projects for the phone-held-sideways checks.
import { test, expect } from "@playwright/test";
import {
  seedStorage, seedVacancies, openApp, openWindow, closeWindow, register, freshEmail, confirmYes, layoutProblems,
  setMock, SEED_JOBS, SEED_PROGRESS,
} from "./helpers.mjs";

const GUEST_APPS = ["vacancies", "stats", "about", "valya", "readme"];
const VACANCY_TEXT = "Acme Studio шукає Senior Graphic Designer. Повна зайнятість, віддалено. Зарплата 1500-2000$. Досвід 3+ роки у Figma.";
const LONG_SAY = "Ти обкладинка цього дня ✦ гарна й помітна! Рекрутери ще не знають, як їм пощастило ✦";

const isDesktopProject = (testInfo) => testInfo.project.name === "flows-desktop";
const isFlows = (testInfo) => testInfo.project.name.startsWith("flows-");
const isLayout = (testInfo) => testInfo.project.name.startsWith("layout-");

// The phone layout (max-width:760px) on the desktop project: a browser window snapped to half a laptop screen.
async function phoneLayout(page, testInfo) {
  if (isDesktopProject(testInfo)) await page.setViewportSize({ width: 700, height: 820 });
}

// The window whose pixels are on top at (x, y), or the id of whatever else is there.
const topAt = (page, x, y) => page.evaluate(([px, py]) => {
  const el = document.elementFromPoint(px, py);
  if (!el) return null;
  const win = el.closest(".win[data-app]");
  if (win) return win.dataset.app;
  const owner = el.closest("[id]");
  return owner ? "#" + owner.id : el.tagName.toLowerCase();
}, [x, y]);

const viewportCentre = (page) => page.evaluate(() => [Math.round(innerWidth / 2), Math.round(innerHeight / 3)]);

// Which dialog (overlay id) or region holds the keyboard focus.
const focusOwner = (page) => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return "body";
  const holder = a.closest(".overlay, .win[data-app], #taskbar, #startmenu, #icons, #clippy, #toast");
  return (holder ? (holder.id || holder.className) : "?") + " > " + (a.id || a.className || a.tagName);
});

const offscreen = (problems) => problems.filter((p) => p.includes("leaves the viewport"));

async function dragBy(page, locator, dx, dy, steps = 8) {
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps });
  await page.mouse.up();
}

/* ===================== phones: which window is in front ===================== */

test("on a phone the window opened last is the one in front, and the taskbar brings a window forward", async ({ page }, testInfo) => {
  test.skip(isLayout(testInfo));
  await phoneLayout(page, testInfo);
  await seedVacancies(page);
  await openApp(page);
  const [cx, cy] = await viewportCentre(page);

  await page.locator("#startbtn").click();
  await page.locator('#startmenu [data-sm="about"]').click();
  await expect.poll(() => topAt(page, cx, cy)).toBe("about");

  // the START menu opens the vacancies over "about": they are what the person asked for
  await page.locator("#startbtn").click();
  await page.locator('#startmenu [data-sm="vacancies"]').click();
  await expect(page.locator("#win-vacancies")).toHaveClass(/focused/);
  await expect.poll(() => topAt(page, cx, cy), { timeout: 3000, message: "the focused window must be the visible one" }).toBe("vacancies");

  // the taskbar button of a window that is behind brings it forward
  await page.locator('.tb-task[data-app="about"]').click();
  await expect.poll(() => topAt(page, cx, cy), { timeout: 3000 }).toBe("about");
  await page.locator('.tb-task[data-app="vacancies"]').click();
  await expect(page.locator("#win-vacancies")).toHaveClass(/open/); // it must come forward, not be minimised
  await expect.poll(() => topAt(page, cx, cy), { timeout: 3000 }).toBe("vacancies");
});

test("on a phone the minimise button hides the window and its taskbar button brings it back", async ({ page }, testInfo) => {
  test.skip(isLayout(testInfo));
  await phoneLayout(page, testInfo);
  await seedVacancies(page);
  await openApp(page);
  await openWindow(page, "stats");
  await page.locator('#win-stats [data-min="stats"]').click();
  await expect(page.locator("#win-stats")).toBeHidden();
  await expect(page.locator("body")).not.toHaveClass(/win-open/);
  await page.locator('.tb-task[data-app="stats"]').click();
  await expect(page.locator("#win-stats")).toBeVisible();
});

/* ===================== phones: the fairy strip pushes dialogs off the screen ===================== */

test("on a phone a dialog stays on screen while the fairy talks over an open window", async ({ page }, testInfo) => {
  test.skip(isLayout(testInfo));
  await phoneLayout(page, testInfo);
  await seedVacancies(page);
  await openApp(page);
  await register(page, { name: "Олена", email: freshEmail(testInfo, "ui") });
  await openWindow(page, "vacancies");
  await expect(page.locator("#win-vacancies .jobcard").first()).toBeVisible();

  // the edit dialog, then the fairy starts talking (her idle phrase comes every 50 s by itself)
  await page.locator("#win-vacancies .jedit").first().click();
  await expect(page.locator("#edit-overlay")).toHaveClass(/open/);
  await page.evaluate((text) => window.jobdesk.say(text, 0, 60000), LONG_SAY);
  await expect(page.locator("body")).toHaveClass(/clippy-on/);
  await page.waitForTimeout(600);
  const dialog = await page.locator("#edit-overlay .dialog").boundingBox();
  const closeBtn = await page.locator("#edit-close").boundingBox();
  expect.soft(dialog.y, "the edit dialog's top edge must stay on screen").toBeGreaterThanOrEqual(0);
  expect.soft(closeBtn.y, "the dialog's ✕ must stay on screen").toBeGreaterThanOrEqual(0);
  expect.soft(offscreen(await layoutProblems(page, { touch: false }))).toEqual([]);
  await page.locator("#ev-cancel").click();

  // the same with the confirmation of a removal
  await page.locator("#win-vacancies .jdel").first().click();
  await expect(page.locator("#confirm-overlay")).toHaveClass(/open/);
  await page.evaluate((text) => window.jobdesk.say(text, 0, 60000), LONG_SAY);
  await page.waitForTimeout(600);
  const confirmBox = await page.locator("#confirm-overlay .dialog").boundingBox();
  expect.soft(confirmBox.y, "the confirmation's top edge must stay on screen").toBeGreaterThanOrEqual(0);
  expect.soft(offscreen(await layoutProblems(page, { touch: false }))).toEqual([]);
});

/* ===================== tile mode ===================== */

test("tile mode switched on at desktop size can still be left once the browser gets narrow", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo), "the tile button exists at desktop size only");
  await seedVacancies(page);
  await openApp(page);
  await page.locator("#btn-tile").click();
  await expect(page.locator("body")).toHaveClass(/tile-mode/);

  // the browser is snapped to half the screen: the phone layout takes over
  await page.setViewportSize({ width: 700, height: 820 });
  for (const app of GUEST_APPS) await closeWindow(page, app);
  await expect(page.locator(".tb-task")).toHaveCount(0);
  // with every window closed the desktop must show its icons again, or offer the way out of tile mode
  const iconsShown = await page.locator('.d-icon[data-open="vacancies"]').isVisible();
  const tileButtonShown = await page.locator("#btn-tile").isVisible();
  expect(iconsShown || tileButtonShown, "an empty desktop with no icons and no tile button").toBe(true);
});

test("leaving tile mode after the viewport changed puts every window back on screen", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo));
  await seedVacancies(page);
  await openApp(page);
  await openWindow(page, "vacancies");
  await dragBy(page, page.locator("#win-vacancies .win-head .ti"), 700, 300);
  await page.locator("#btn-tile").click();
  await expect(page.locator("#tilewrap .win")).toHaveCount(5);
  await page.setViewportSize({ width: 1024, height: 640 });
  await page.locator("#btn-tile").click();
  await expect(page.locator("body")).not.toHaveClass(/tile-mode/);
  await page.waitForTimeout(400);
  expect(offscreen(await layoutProblems(page))).toEqual([]);
  for (const app of GUEST_APPS) {
    const btn = await page.locator(`#win-${app} [data-close]`).boundingBox();
    expect.soft(btn && btn.x + btn.width <= 1024 && btn.y >= 0 && btn.y + btn.height <= 640, `${app} ✕ on screen`).toBe(true);
  }
});

test("tile mode: closing, reopening from START and leaving keep the taskbar right", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo));
  await seedVacancies(page);
  await openApp(page);
  await page.locator("#btn-tile").click();
  await expect(page.locator(".tb-task")).toHaveCount(5);
  await page.locator("#win-about [data-close]").click();
  await expect(page.locator("#tilewrap #win-about")).toHaveCount(0);
  await expect(page.locator('.tb-task[data-app="about"]')).toHaveCount(0);
  await expect(page.locator("#win-about")).toBeHidden();
  await page.locator("#startbtn").click();
  await page.locator('#startmenu [data-sm="about"]').click();
  await expect(page.locator("#tilewrap #win-about")).toHaveCount(1);
  await expect(page.locator("#win-about")).toBeVisible();
  await page.locator("#btn-theme").click();
  await page.locator("#btn-tile").click();
  await expect(page.locator("#tilewrap .win")).toHaveCount(0);
  await expect(page.locator(".d-icon").first()).toBeVisible();
});

/* ===================== resizing and dragging windows, then the viewport changes ===================== */

test("a window resized to full height comes back above the taskbar when the viewport gets shorter", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo));
  await seedVacancies(page);
  await openApp(page);
  await openWindow(page, "readme");
  await dragBy(page, page.locator("#win-readme .win-resize"), 0, 400);
  const tall = await page.locator("#win-readme").boundingBox();
  expect(tall.y + tall.height, "the grip pulled the window down to the taskbar").toBeGreaterThan(830);

  await page.setViewportSize({ width: 1280, height: 600 });
  await page.waitForTimeout(400);
  const desk = await page.evaluate(() => document.getElementById("desktop").clientHeight);
  const r = await page.locator("#win-readme").boundingBox();
  expect.soft(r.y + r.height, "the window must end above the taskbar").toBeLessThanOrEqual(desk + 1);
  const grip = await page.locator("#win-readme .win-resize").boundingBox();
  expect.soft(grip.y + grip.height, "the resize grip must stay reachable").toBeLessThanOrEqual(desk + 1);
  expect.soft(offscreen(await layoutProblems(page))).toEqual([]);
});

test("a window resized to full width keeps its ✕ on screen when the viewport gets narrower", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo));
  await seedVacancies(page);
  await openApp(page);
  await openWindow(page, "readme");
  const grip = await page.locator("#win-readme .win-resize").boundingBox();
  await dragBy(page, page.locator("#win-readme .win-resize"), 1438 - (grip.x + grip.width / 2), 0);
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForTimeout(400);
  const close = await page.locator("#win-readme [data-close]").boundingBox();
  expect.soft(close.x + close.width, "the ✕ must stay inside the 900 px viewport").toBeLessThanOrEqual(900);
  expect.soft(offscreen(await layoutProblems(page))).toEqual([]);
});

test("windows dragged off the right and bottom edges come back into view when the viewport shrinks", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo));
  await seedVacancies(page);
  await openApp(page);
  await openWindow(page, "stats");
  await dragBy(page, page.locator("#win-stats .win-head .ti"), 1500, 1500);
  // while dragged out, the title bar stays reachable
  const head = await page.locator("#win-stats .win-head").boundingBox();
  expect(head.x).toBeLessThan(1440 - 100);
  expect(head.y + head.height).toBeLessThanOrEqual(900);
  await page.setViewportSize({ width: 1100, height: 650 });
  await page.waitForTimeout(400);
  expect(offscreen(await layoutProblems(page))).toEqual([]);

  // dragged off the left edge: after a resize the title bar and the ✕ are still there to grab
  await openWindow(page, "about");
  await dragBy(page, page.locator("#win-about .win-head .ti"), -1500, -100);
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.waitForTimeout(300);
  const head2 = await page.locator("#win-about .win-head").boundingBox();
  expect(head2.x + head2.width).toBeGreaterThanOrEqual(100);
  const close = await page.locator("#win-about [data-close]").boundingBox();
  expect(close.x).toBeGreaterThanOrEqual(0);
});

test("minimising keeps the window on the taskbar, and its button restores it where it was", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo));
  await seedVacancies(page);
  await openApp(page);
  await openWindow(page, "about");
  await dragBy(page, page.locator("#win-about .win-head .ti"), -200, -40);
  const before = await page.locator("#win-about").boundingBox();
  await page.locator('#win-about [data-min="about"]').click();
  await expect(page.locator("#win-about")).toBeHidden();
  await expect(page.locator('.tb-task[data-app="about"]'), "a minimised window keeps its taskbar button").toHaveCount(1, { timeout: 2000 });
  await page.locator('.tb-task[data-app="about"]').click();
  await expect(page.locator("#win-about")).toBeVisible();
  const after = await page.locator("#win-about").boundingBox();
  expect(after).toEqual(before);
});

/* ===================== desktop icons ===================== */

test("a dragged icon follows the pointer without jumping and a small nudge keeps its cell", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo));
  await seedVacancies(page);
  await openApp(page);
  const icon = page.locator('.d-icon[data-open="stats"]');
  const start = await icon.boundingBox();
  const x = start.x + start.width / 2, y = start.y + start.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 6, y, { steps: 3 });
  const during = await icon.boundingBox();
  expect.soft(during.x - start.x, "the icon must move by as much as the pointer did").toBeCloseTo(6, 0);
  expect.soft(during.y - start.y, "a horizontal drag must not move the icon down").toBeCloseTo(0, 0);
  // 40 px is well under half of the 100 px cell
  await page.mouse.move(x + 40, y, { steps: 4 });
  await page.mouse.up();
  const end = await icon.boundingBox();
  expect.soft(end.x, "a nudge of 40 px snaps back to the same column").toBeCloseTo(start.x, 0);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("jobdesk2000_iconpos_v2")).stats);
  expect.soft(saved).toEqual({ x: 14, y: 122 });
  // and the window does not open from the click that ends a drag
  await expect(page.locator("#win-stats")).toBeHidden();
});

test("a moment in a narrow browser does not rearrange the icons for good", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo));
  await seedVacancies(page, { jobdesk2000_iconpos_v2: { readme: { x: 1214, y: 14 } } });
  await openApp(page);
  const icon = page.locator('.d-icon[data-open="readme"]');
  const placed = await icon.boundingBox();
  await page.setViewportSize({ width: 980, height: 900 });
  await page.waitForTimeout(200);
  // in the narrow window it comes into view...
  const narrow = await icon.boundingBox();
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(980);
  // ...and goes back to where the person put it once there is room again
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(200);
  const back = await icon.boundingBox();
  expect.soft(back.x, "the icon returns to its own cell").toBeCloseTo(placed.x, 0);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("jobdesk2000_iconpos_v2")).readme);
  expect.soft(saved, "the stored (and cloud-synced) position is the person's, not the narrow window's").toEqual({ x: 1214, y: 14 });
});

test("dragging an icon onto the screen edge and resizing keeps every icon on screen and apart", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo));
  await seedVacancies(page);
  await openApp(page);
  await dragBy(page, page.locator('.d-icon[data-open="valya"]'), 2000, 2000, 12);
  await dragBy(page, page.locator('.d-icon[data-open="about"]'), 2000, 0, 12);
  expect(await layoutProblems(page)).toEqual([]);
  for (const size of [{ width: 900, height: 560 }, { width: 1280, height: 720 }, { width: 800, height: 600 }]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(200);
    expect.soft(await layoutProblems(page), `${size.width}x${size.height}`).toEqual([]);
  }
});

/* ===================== keyboard: focus and Tab inside dialogs ===================== */

test("every dialog takes the keyboard focus when it opens and gives it back when it closes", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo), "keyboard focus is a desktop concern");
  await seedStorage(page, { jobdesk2000_added_v1: SEED_JOBS, jobdesk2000_v1: SEED_PROGRESS });
  await openApp(page);

  // first visit: the welcome
  await expect(page.locator("#welcome-overlay")).toHaveClass(/open/);
  expect.soft(await focusOwner(page), "welcome").toMatch(/^welcome-overlay/);
  await page.keyboard.press("Escape");

  await openWindow(page, "vacancies");
  // edit, opened from the keyboard
  const edit = page.locator("#win-vacancies .jedit").first();
  await edit.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#edit-overlay")).toHaveClass(/open/);
  expect.soft(await focusOwner(page), "edit dialog").toMatch(/^edit-overlay/);
  await page.keyboard.press("Escape");
  await expect(page.locator("#edit-overlay")).not.toHaveClass(/open/);

  // confirm takes the focus (it does), and must give it back to the 🗑 that asked
  const del = page.locator("#win-vacancies .jdel").first();
  await del.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#confirm-overlay")).toHaveClass(/open/);
  expect.soft(await focusOwner(page), "confirm").toMatch(/^confirm-overlay/);
  await page.keyboard.press("Escape");
  await expect(page.locator("#confirm-overlay")).not.toHaveClass(/open/);
  expect.soft(await del.evaluate((el) => el === document.activeElement), "focus back on the 🗑 after the confirm").toBe(true);

  // sign-in dialog from the account button
  await page.locator("#btn-account").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#auth-overlay")).toHaveClass(/open/);
  expect.soft(await focusOwner(page), "sign-in dialog").toMatch(/^auth-overlay/);
  await page.keyboard.press("Escape");

  // guest gate from a desktop icon
  await page.locator('.d-icon[data-open="fairy"]').focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#gate-overlay")).toHaveClass(/open/);
  expect.soft(await focusOwner(page), "guest gate").toMatch(/^gate-overlay/);
  await page.keyboard.press("Escape");
  await expect(page.locator("#gate-overlay")).not.toHaveClass(/open/);
});

test("Tab and Shift+Tab stay inside an open dialog", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo));
  await seedVacancies(page);
  await openApp(page);
  await openWindow(page, "vacancies");

  for (const [opener, overlay] of [[".jedit", "edit-overlay"], [".jdel", "confirm-overlay"]]) {
    await page.locator(`#win-vacancies ${opener}`).first().click();
    await expect(page.locator("#" + overlay)).toHaveClass(/open/);
    await page.locator(`#${overlay} .win-body button`).first().focus();
    const escaped = [];
    for (const key of ["Tab", "Shift+Tab"]) {
      for (let i = 0; i < 22; i++) {
        await page.keyboard.press(key);
        const owner = await focusOwner(page);
        if (!owner.startsWith(overlay)) escaped.push(`${key} #${i + 1}: ${owner}`);
      }
    }
    expect.soft(escaped.slice(0, 4), `${overlay}: focus left the modal dialog`).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.locator("#" + overlay)).not.toHaveClass(/open/);
  }

  // what that leak allows: Tab out of the confirmation onto a ✏️ behind it, Enter, and the edit dialog opens
  // underneath the confirmation (z-index 10000 < 10500) while Escape now closes that hidden one first
  await page.locator("#win-vacancies .jdel").first().click();
  await expect(page.locator("#confirm-overlay")).toHaveClass(/open/);
  let onEdit = false;
  for (let i = 0; i < 40 && !onEdit; i++) {
    await page.keyboard.press("Tab");
    onEdit = await page.evaluate(() => !!document.activeElement?.matches("#win-vacancies .jedit"));
  }
  if (onEdit) {
    await page.keyboard.press("Enter");
    const stacked = await page.locator("#edit-overlay").evaluate((el) => el.classList.contains("open"));
    expect.soft(stacked, "the keyboard opened the edit dialog behind the confirmation").toBe(false);
    if (stacked) {
      await page.keyboard.press("Escape");
      // Escape must close what the person sees (the confirmation), not the edit dialog hidden under it
      expect.soft(await page.locator("#confirm-overlay").evaluate((el) => el.classList.contains("open")), "Escape left the visible confirmation open and closed the hidden edit dialog").toBe(false);
    }
  }
});

test("the / shortcut does not reach the search box behind a dialog", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo));
  await seedVacancies(page);
  await openApp(page);
  await openWindow(page, "vacancies");

  await page.locator("#win-vacancies .jdel").first().click();
  await expect(page.locator("#confirm-overlay")).toHaveClass(/open/);
  await page.keyboard.press("/");
  await page.keyboard.type("zzz");
  expect.soft(await page.locator("#f-search").inputValue(), "typing in a confirmation lands in the search behind it").toBe("");
  await page.keyboard.press("Escape");
  await expect(page.locator("#confirm-overlay")).not.toHaveClass(/open/);
  await expect.soft(page.locator("#win-vacancies .jobcard")).toHaveCount(3);

  await page.locator("#btn-reset").click();
  await page.locator("#win-vacancies .jedit").first().click();
  await expect(page.locator("#edit-overlay")).toHaveClass(/open/);
  await page.keyboard.press("/");
  expect.soft(await focusOwner(page), "/ inside the edit dialog").not.toMatch(/f-search/);
  await page.keyboard.press("Escape");

  // and the shortcut itself still works with no dialog open
  await page.locator("#win-vacancies .win-head .ti").click();
  await page.keyboard.press("/");
  await expect(page.locator("#f-search")).toBeFocused();
});

test("the START menu opened from the keyboard can be walked with Tab", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo));
  await seedVacancies(page);
  await openApp(page);
  await page.locator("#startbtn").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#startmenu")).toHaveClass(/open/);
  await page.keyboard.press("Tab");
  expect(await focusOwner(page), "Tab after opening START goes into the menu").toMatch(/^startmenu/);
});

/* ===================== Escape and close buttons in each state ===================== */

test("auth over the gate: one Escape closes one dialog and nothing is left behind", async ({ page }, testInfo) => {
  test.skip(isLayout(testInfo));
  await seedVacancies(page);
  await openApp(page);
  await page.locator('.d-icon[data-open="messenger"]').click();
  await expect(page.locator("#gate-overlay")).toHaveClass(/open/);
  await expect(page.locator("#gate-text")).toContainText("cover letter");
  await page.locator("#gate-register").click();
  await expect(page.locator("#gate-overlay")).not.toHaveClass(/open/);
  await expect(page.locator("#auth-overlay")).toHaveClass(/open/);
  await page.locator('.auth-tab[data-tab="register"]').click();
  await page.locator("#auth-name").fill("Олена");
  await page.keyboard.press("Escape");
  await expect(page.locator("#auth-overlay")).not.toHaveClass(/open/);
  await expect(page.locator(".overlay.open")).toHaveCount(0);
  // reopened, it is the login form again and empty
  await page.locator("#btn-account").click();
  await expect(page.locator("#auth-title")).toHaveText("✦ Вхід");
  await expect(page.locator("#auth-name")).toHaveValue("");
  await page.locator("#auth-close").click();
  await expect(page.locator(".overlay.open")).toHaveCount(0);
  await expect(page.locator("#win-messenger")).toBeHidden();
});

test("an edit dialog closed during its AI refill opens fresh for the next vacancy", async ({ page, context, baseURL }, testInfo) => {
  test.skip(!isDesktopProject(testInfo));
  await setMock(context, "slow", baseURL);
  await seedVacancies(page);
  await openApp(page);
  await openWindow(page, "vacancies");
  await page.locator("#win-vacancies .jedit").first().click();
  await page.locator("#ev-paste").fill(VACANCY_TEXT);
  await page.locator("#ev-analyze").click();
  await expect(page.locator("#ev-msg")).toHaveText("Фея аналізує ✦...");
  await page.keyboard.press("Escape");

  await page.locator("#win-vacancies .jedit").nth(1).click();
  await expect(page.locator("#edit-overlay")).toHaveClass(/open/);
  await expect(page.locator("#ev-title")).toHaveValue("UI/UX дизайнерка");
  await expect.soft(page.locator("#ev-analyze"), "the refill button of a fresh dialog is usable").toBeEnabled({ timeout: 1000 });
  // the first dialog's late answer must not land in this one
  await page.waitForTimeout(7000);
  await expect(page.locator("#ev-title")).toHaveValue("UI/UX дизайнерка");
  await expect(page.locator("#ev-company")).toHaveValue("Пікселька");
  await expect(page.locator("#ev-msg")).toHaveText("");
});

test("the START menu: every item does its job and the menu closes after it", async ({ page }, testInfo) => {
  test.skip(isLayout(testInfo));
  await seedVacancies(page);
  await openApp(page);
  const menu = page.locator("#startmenu");
  const choose = async (sel) => {
    await page.locator("#startbtn").click();
    await expect(menu).toHaveClass(/open/);
    await menu.locator(sel).click();
    await expect(menu).not.toHaveClass(/open/);
  };
  for (const app of ["vacancies", "about", "valya", "readme"]) {
    await choose(`[data-sm="${app}"]`);
    await expect(page.locator("#win-" + app)).toHaveClass(/focused/);
    await closeWindow(page, app);
  }
  for (const app of ["messenger", "fairy"]) {
    await choose(`[data-sm="${app}"]`);
    await expect(page.locator("#gate-overlay")).toHaveClass(/open/);
    await page.locator("#gate-cancel").click();
    await expect(page.locator("#win-" + app)).toBeHidden();
  }
  const [copy] = await Promise.all([page.waitForEvent("download"), choose('[data-action="backup"]')]);
  expect(copy.suggestedFilename()).toMatch(/^jobdesk2000-backup-/);
  await expect(page.locator("#toast")).toContainText("Копію збережено");
  const [table] = await Promise.all([page.waitForEvent("download"), choose('[data-action="table"]')]);
  expect(table.suggestedFilename()).toMatch(/\.csv$/);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), choose('[data-action="restore"]')]);
  expect(chooser.isMultiple()).toBe(false);
  await choose("#sm-auth");
  await expect(page.locator("#auth-overlay")).toHaveClass(/open/);
  await page.locator("#auth-close").click();

  // Escape and a click outside close it
  await page.locator("#startbtn").click();
  await page.keyboard.press("Escape");
  await expect(menu).not.toHaveClass(/open/);
  await page.locator("#startbtn").click();
  await page.locator("#clock").click();
  await expect(menu).not.toHaveClass(/open/);
});

/* ===================== the notice, the fairy and START on a phone ===================== */

test("on a phone the undo notice does not cover the START menu", async ({ page }, testInfo) => {
  test.skip(isLayout(testInfo));
  await phoneLayout(page, testInfo);
  await seedVacancies(page);
  await openApp(page);
  await openWindow(page, "vacancies");
  await page.locator("#win-vacancies .jdel").first().click();
  await confirmYes(page);
  await expect(page.locator("#toast")).toBeVisible();
  await page.locator("#startbtn").click();
  await expect(page.locator("#startmenu")).toHaveClass(/open/);
  const m = await page.locator("#startmenu").boundingBox();
  // the bottom row of the menu (where the account item sits) must be the menu's, not the notice's
  const hits = [];
  for (const fx of [0.2, 0.5, 0.8]) hits.push(await topAt(page, m.x + m.width * fx, m.y + m.height - 14));
  expect(hits.filter((h) => h !== "#startmenu" && !String(h).startsWith("#sm-"))).toEqual([]);
});

test("theme switch with windows open keeps them where they are", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo));
  await seedVacancies(page);
  await openApp(page);
  for (const app of ["vacancies", "stats", "readme"]) await openWindow(page, app);
  const before = await page.evaluate(() => [...document.querySelectorAll(".win.open")].map((w) => w.id + ":" + JSON.stringify(w.getBoundingClientRect())));
  await page.locator("#btn-theme").click();
  await expect(page.locator("html")).toHaveClass(/theme-dark/);
  await page.locator("#btn-theme").click();
  const after = await page.evaluate(() => [...document.querySelectorAll(".win.open")].map((w) => w.id + ":" + JSON.stringify(w.getBoundingClientRect())));
  expect(after).toEqual(before);
  await expect(page.locator('.tb-task[data-app="readme"]')).toHaveClass(/active/);
});

/* ===================== touch: dragging an icon on a tablet ===================== */

test("on a touch tablet an icon dragged with a finger lands in a free cell", async ({ browser, baseURL }, testInfo) => {
  test.skip(!isDesktopProject(testInfo), "needs Chromium's CDP touch input");
  const context = await browser.newContext({ baseURL, viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, serviceWorkers: "block" });
  const page = await context.newPage();
  await seedVacancies(page);
  await openApp(page);
  expect(await page.evaluate(() => window.matchMedia("(max-width:760px), (max-height:500px) and (hover:none)").matches)).toBe(false);
  const icon = page.locator('.d-icon[data-open="valya"]');
  const b = await icon.boundingBox();
  const cdp = await context.newCDPSession(page);
  const x0 = b.x + b.width / 2, y0 = b.y + b.height / 2;
  await page.evaluate(() => { window.__cancel = 0; document.addEventListener("pointercancel", () => window.__cancel++, true); });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y: y0 }] });
  for (let i = 1; i <= 12; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + i * 30, y: y0 }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(300);
  const end = await icon.boundingBox();
  const cancelled = await page.evaluate(() => window.__cancel);
  expect.soft(cancelled, "the browser took the finger away from the icon (pointercancel)").toBe(0);
  expect.soft(end.x - b.x, "the icon followed the finger to another column").toBeGreaterThan(250);
  const left = await icon.evaluate((el) => parseFloat(el.style.left));
  expect.soft((left - 14) % 100, "the icon sits on a grid cell").toBe(0);
  expect.soft(await layoutProblems(page, { touch: true }).then((p) => p.filter((x) => x.includes("overlaps")))).toEqual([]);
  await context.close();
});

/* ===================== phones held sideways and small phones: fairy, notice and dialogs at once ===================== */

test("@layout fairy, notice and dialogs at once on a phone", async ({ page }, testInfo) => {
  test.skip(!isLayout(testInfo) || !/iphone-11|galaxy/.test(testInfo.project.name));
  const touch = !!testInfo.project.use.hasTouch;
  await seedVacancies(page);
  await openApp(page);
  await register(page, { name: "Олена", email: freshEmail(testInfo, "ui") });
  await openWindow(page, "vacancies");
  await page.evaluate((text) => window.jobdesk.say(text, 0, 60000), LONG_SAY);
  await page.waitForTimeout(700);
  expect.soft(await layoutProblems(page, { touch }), "window + fairy strip").toEqual([]);

  // a removal with its undo notice while she talks
  await page.locator("#win-vacancies .jdel").first().click();
  await page.locator("#confirm-ok").click();
  await expect(page.locator("#toast")).toBeVisible();
  await page.evaluate((text) => window.jobdesk.say(text, 0, 60000), LONG_SAY);
  await page.waitForTimeout(400);
  const toastBox = await page.locator("#toast").boundingBox();
  const bubble = await page.locator("#clippy .bubble").boundingBox();
  const overlap = Math.min(toastBox.x + toastBox.width, bubble.x + bubble.width) - Math.max(toastBox.x, bubble.x) > 2
    && Math.min(toastBox.y + toastBox.height, bubble.y + bubble.height) - Math.max(toastBox.y, bubble.y) > 2;
  expect.soft(overlap, "the notice covers the fairy's bubble").toBe(false);
  const vp = page.viewportSize();
  expect.soft(toastBox.y >= 0 && toastBox.y + toastBox.height <= vp.height && toastBox.x >= 0 && toastBox.x + toastBox.width <= vp.width, "notice on screen").toBe(true);
  expect.soft(await layoutProblems(page, { touch }), "window + fairy + notice").toEqual([]);

  // a dialog while she talks
  await page.locator("#win-vacancies .jedit").first().click();
  await expect(page.locator("#edit-overlay")).toHaveClass(/open/);
  await page.evaluate((text) => window.jobdesk.say(text, 0, 60000), LONG_SAY);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `test-results/attack-ui/screens/${testInfo.project.name}-edit-while-fairy.png` });
  expect.soft(offscreen(await layoutProblems(page, { touch })), "edit dialog while the fairy talks").toEqual([]);
});
