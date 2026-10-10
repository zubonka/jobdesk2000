// Extreme content on every screen size: 200-character names without spaces, 30 vacancies, long user and fairy
// names, a long cover letter in a chat of 20+ messages, statistics with every status, README.TXT, the START menu,
// the dark theme, the browser font at 200 % and a 200 % page zoom.
// The file name matches /layout\.spec/, so it runs on the layout-<device> projects of playwright.config.mjs.
// Every test asserts the correct behaviour: a failing check is a bug.
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { seedStorage, openApp, openWindow, closeWindow, layoutProblems } from "./helpers.mjs";

/* ----- extreme content ----- */

const long = (seed, n) => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
// 200 characters without a single space or hyphen (a pasted slug, a company written in one word)
const COMPANY_200 = long("МіжнароднаКорпораціяЦифровихІнновацій", 200);
const TITLE_200 = long("PrincipalSeniorLeadBrandIdentityDesigner", 200);
// the longest field and salary the analyser returns (netlify/functions/analyze-vacancy.js caps them at 60 and 80)
const FIELD_60 = "Інформаційні технології, розробка програмного забезпечення";
const SALARY_80 = "від 45 000 до 60 000 грн на місяць залежно від досвіду + щорічний бонус та опціон";
// the register form allows 30 characters; people type their handle, and a dot is no line break opportunity
const USER_30 = "elizabeth.zubenko.designer2026";
// the fairy name field allows 24 characters
const FAIRY_24 = "Найчарівнішапіксельфеєчк";
const PORTFOLIO = "https://www.behance.net/elizabeth-zubenko/projects/brand-identity-for-a-music-label-2026";

const DAY = 86400000;
const iso = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * DAY + 3 * 3600000); // Kyiv is UTC+2/+3; the date is close enough
  return d.toISOString().slice(0, 10);
};

// 30 vacancies: the first with 200-character names and the longest analyser fields, the rest realistic
// long names, spread over every priority and every status, with dates in the last 8 weeks and near deadlines.
const STATUS_LABELS = ["Не подавалася", "Подалася", "Перша співбесіда", "Тестове завдання", "Друга співбесіда", "Третя співбесіда", "Оффер", "Відмова"];
const PRIOS = ["100% Податися", "Податися", "Подумати"];
const COMPANIES = ["Товариство з обмеженою відповідальністю «Нова Пошта»", "Grammarly", "MacPaw", "Monobank", "Readdle", "Banda Agency", "Projector Institute", "Uklon", "Ajax Systems", "Preply"];
const TITLES = ["Senior Product Designer (Design Systems, B2B SaaS)", "Графічна дизайнерка / ілюстраторка для соцмереж", "Motion Designer", "Lead UI/UX Designer", "Brand Designer", "Junior Graphic Designer"];

function bigBoard(extreme) {
  const jobs = [], progress = {};
  if (extreme) {
    jobs.push({ prio: "100% Податися", company: COMPANY_200, title: TITLE_200, field: FIELD_60, emp: "Full-time", loc: "Віддалено", salary: SALARY_80, url: "https://example.com/job/0" });
    progress[COMPANY_200 + "|" + TITLE_200] = { status: "Подалася", date: iso(-2), deadline: iso(0), note: long("нотатка без пробілів ", 300) };
  }
  for (let i = 1; jobs.length < 30; i++) {
    const company = COMPANIES[i % COMPANIES.length] + (i >= COMPANIES.length ? " " + i : "");
    const title = TITLES[i % TITLES.length];
    jobs.push({ prio: PRIOS[i % 3], company, title, field: i % 2 ? FIELD_60 : "Дизайн", emp: i % 3 ? "Full-time" : "Part-time", loc: "Гібрид", salary: i % 4 ? SALARY_80 : "—", url: "https://example.com/job/" + i });
    // deadlines: passed, or 5-14 days ahead (badges on the cards, but no reminder from the fairy at start)
    progress[company + "|" + title] = { status: STATUS_LABELS[i % 8], date: i % 8 ? iso(-((i * 3) % 54)) : "", deadline: i % 5 === 0 ? iso([-2, 5, 12][i % 3]) : "", note: i % 2 ? "HR: Олена, дзвінок у пʼятницю" : "" };
  }
  return { jobs, progress };
}

const CV = "Олена Тестенко. Графічна дизайнерка, 5 років брендингу: Figma, Illustrator, Photoshop. Айдентика для музичного лейблу.";
const LONG_LETTER = [
  "Шановна командо " + COMPANY_200 + "!",
  long("Мене звати Олена, і я хочу долучитися до вас на посаду графічної дизайнерки. Маю пʼять років досвіду в брендингу. ", 1400),
  "Портфоліо: " + PORTFOLIO,
  long("У попередній ролі мені вдалося підняти впізнаваність бренду музичного лейблу. ", 900),
  "З повагою,\n" + USER_30,
].join("\n\n");

/* ----- set-up ----- */

// A signed-in user as the UI knows it (data/user.js), without Firebase: the SDK is refused, so nothing signs the
// user out, and the functions are answered here. Every screen looks exactly as for a real account.
async function seedSignedIn(page, { extreme = false, ...extra } = {}) {
  await page.route("https://www.gstatic.com/firebasejs/**", (route) => route.abort());
  await page.route("**/.netlify/functions/cover-letter", (route) => route.fulfill({ json: { text: LONG_LETTER } }));
  await page.route("**/.netlify/functions/analyze-vacancy", (route) => route.fulfill({ json: { role: "", summary: "", phrases: [] } }));
  const { jobs, progress } = bigBoard(extreme);
  await seedStorage(page, {
    jobdesk2000_welcomed: "1",
    // the follow-up nudge has been said today: like the deadlines, it must not bring the fairy over a check
    jd2000_followup: new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date()),
    jobdesk2000_user_v1: { name: USER_30, email: "elizabeth.zubenko.designer2026@example.com", gender: "f", uid: "layout-attack" },
    jobdesk2000_fairy_v1: { name: FAIRY_24, current: "type1", type1: {}, type2: {} },
    jobdesk2000_cv_v1: CV,
    jobdesk2000_added_v1: jobs,
    jobdesk2000_v1: progress,
    ...extra,
  });
}

// The browser's default font size at 200 % (Chrome: Settings -> Appearance -> Customize fonts -> 32).
// Every size in app.css is in rem, so this is what the user's setting does to the page.
const bigFont = (page) => page.addInitScript(() => {
  const apply = () => { if (!document.documentElement) return false; document.documentElement.style.fontSize = "32px"; return true; };
  if (!apply()) new MutationObserver((_, obs) => { if (apply()) obs.disconnect(); }).observe(document, { childList: true });
});

// The fairy and toasts come and go on timers; screens without them must not depend on that timing.
async function quiet(page) {
  await page.evaluate(() => { window.jobdesk.hide(); document.getElementById("toast").hidden = true; });
  await page.waitForTimeout(550);
}

// Opens the app and lets the greeting (1 s after start) come and go.
async function start(page) {
  await openApp(page);
  await page.locator("#clippy.show").waitFor({ timeout: 4000 }).catch(() => {});
  await quiet(page);
}

/* ----- checks beyond layoutProblems() ----- */

// Text that runs out of the box it belongs to (a word too long for its line), where layoutProblems() only looks at
// element boxes; the taskbar and START button squeezed; floating windows that reach under the taskbar.
function moreProblems(page) {
  return page.evaluate(() => {
    const out = [];
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const name = (el) => (el.id ? "#" + el.id : el.tagName.toLowerCase() + (typeof el.className === "string" && el.className ? "." + el.className.split(" ").filter(Boolean).slice(0, 2).join(".") : "")) + (el.textContent ? ` "${el.textContent.trim().slice(0, 30)}"` : "");
    const visible = (el) => {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || +s.opacity === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const roots = [...document.querySelectorAll(".win.open, .overlay.open .dialog, #startmenu.open, #clippy.show .bubble, #toast:not([hidden]), #taskbar")].filter(visible);
    const flagged = new Set();
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent.trim()) continue;
        const p = n.parentElement;
        if (!p || p.closest("select, textarea, .ti, .sr-only, [hidden]") || !visible(p)) continue;
        let block = p;
        while (block && getComputedStyle(block).display === "inline") block = block.parentElement;
        if (!block || flagged.has(block)) continue;
        if (getComputedStyle(block).textOverflow === "ellipsis") continue; // cut short on purpose, with "…"
        const b = block.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) {
          const by = Math.max(r.right - b.right, b.left - r.left);
          if (r.width > 0 && by > 4) { flagged.add(block); out.push(`text spills out of ${name(block)} by ${Math.round(by)}px`); break; }
        }
      }
    }

    const bar = document.getElementById("taskbar").getBoundingClientRect();
    for (const el of document.querySelectorAll("#startbtn, #tb-offline, #btn-account, #btn-tile, #btn-theme, #clock")) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.left < -1 || r.right > vw + 1) out.push(`taskbar: ${name(el)} is off screen [${Math.round(r.left)}..${Math.round(r.right)}] in ${vw}`);
    }
    const start = document.getElementById("startbtn");
    const lines = new Set([...(() => { const rg = document.createRange(); rg.selectNodeContents(start); return rg.getClientRects(); })()].map((r) => Math.round(r.top)));
    if (lines.size > 1) out.push(`taskbar: the START button wraps onto ${lines.size} lines`);
    const tasks = document.getElementById("tb-tasks");
    if (tasks.children.length && tasks.clientWidth < 40) out.push(`taskbar: no room for the open windows' buttons (${tasks.clientWidth}px)`);

    if (!document.body.classList.contains("tile-mode")) {
      for (const w of document.querySelectorAll(".win.open:not(.dialog)")) {
        const r = w.getBoundingClientRect();
        if (visible(w) && r.bottom > bar.top + 1) out.push(`${name(w).split(" ")[0]} reaches ${Math.round(r.bottom - bar.top)}px under the taskbar`);
      }
    }
    return [...new Set(out)];
  });
}

// Every control of what is in front (the focused window, an open dialog, the START menu, the taskbar) can be
// reached: scrolled into view by the user (only boxes that scroll count) and then not covered by anything.
function unreachable(page) {
  return page.evaluate(() => {
    const out = [];
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const name = (el) => (el.id ? "#" + el.id : el.tagName.toLowerCase() + (typeof el.className === "string" && el.className ? "." + el.className.split(" ").filter(Boolean).slice(0, 2).join(".") : "")) + (el.textContent ? ` "${el.textContent.trim().slice(0, 30)}"` : "");
    const visible = (el) => {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || +s.opacity === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const dialog = document.querySelector(".overlay.open .dialog");
    const menu = document.querySelector("#startmenu.open");
    const roots = dialog ? [dialog] : menu ? [menu, document.getElementById("taskbar")] : [document.querySelector(".win.open.focused"), document.getElementById("taskbar")];
    for (const root of roots.filter(Boolean)) {
      for (const el of root.querySelectorAll("button, a[href], input, select, textarea, label.pal-btn")) {
        if (!visible(el) || el.closest("[hidden]")) continue;
        const locked = [];
        for (let p = el.parentElement; p; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (p === document.body || p === document.documentElement || /hidden|clip/.test(s.overflowX + s.overflowY)) locked.push([p, p.scrollLeft, p.scrollTop]);
        }
        el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        let forced = false;
        for (const [p, left, top] of locked) {
          if (p.scrollLeft !== left || p.scrollTop !== top) { forced = true; p.scrollLeft = left; p.scrollTop = top; }
        }
        const r = el.getBoundingClientRect();
        if (forced) { out.push(`${name(el)} is cut off: only a box the user cannot scroll would show it`); continue; }
        const x = Math.min(Math.max(r.left + r.width / 2, 1), vw - 1), y = Math.min(Math.max(r.top + r.height / 2, 1), vh - 1);
        if (r.right < 1 || r.left > vw - 1 || r.bottom < 1 || r.top > vh - 1) { out.push(`${name(el)} is off screen`); continue; }
        const hit = document.elementFromPoint(x, y);
        if (!hit || !(hit === el || el.contains(hit))) out.push(`${name(el)} is covered by ${hit ? name(hit) : "nothing (off screen)"}`);
      }
    }
    return [...new Set(out)];
  });
}

/* ----- one screen ----- */

const OUT = process.env.ATTACK_OUT || "test-results/attack-layout";

async function check(page, testInfo, screen, { reach = true, fairy = false } = {}) {
  if (fairy) await page.waitForTimeout(350); // open/close animations
  else await quiet(page);
  const touch = !!testInfo.project.use.hasTouch;
  const device = testInfo.project.name.replace(/^layout-/, "");
  const dir = path.join(OUT, device);
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${screen}.png`) });
  const problems = [...await layoutProblems(page, { touch }), ...await moreProblems(page)];
  if (reach) problems.push(...await unreachable(page));
  if (problems.length) fs.writeFileSync(path.join(dir, `${screen}.problems.json`), JSON.stringify(problems, null, 1));
  expect.soft(problems, `${screen} on ${device}`).toEqual([]);
}

const ALL_WINDOWS = ["vacancies", "stats", "messenger", "fairy", "about", "valya", "readme"];

/* ----- tests ----- */

test.describe("@layout extreme content", () => {
  test("A: 200-character company and title without spaces on every screen that shows them", async ({ page }, testInfo) => {
    await seedSignedIn(page, { extreme: true });
    await start(page);
    // 12 s after start the fairy names the vacancy that is due today
    await expect(page.locator("#clippy-say")).toContainText("дедлайн", { timeout: 16000 });
    await check(page, testInfo, "a00-deadline-reminder", { fairy: true, reach: false });

    await openWindow(page, "vacancies");
    const win = page.locator("#win-vacancies");
    await expect(win.locator(".jobcard")).toHaveCount(30);
    const extreme = win.locator(".jobcard").first();
    await expect(extreme.locator(".jt")).toHaveText(TITLE_200);
    await extreme.scrollIntoViewIfNeeded();
    await check(page, testInfo, "a01-extreme-card");

    await extreme.locator(".jedit").click();
    await expect(page.locator("#edit-overlay")).toHaveClass(/open/);
    await check(page, testInfo, "a02-edit-dialog");
    await page.keyboard.press("Escape");

    await extreme.locator(".jdel").click();
    await expect(page.locator("#confirm-overlay")).toHaveClass(/open/);
    await check(page, testInfo, "a03-remove-question");
    await page.keyboard.press("Escape");
    await closeWindow(page, "vacancies");

    // the messenger: the vacancy list and the fairy's reply that names the company
    await openWindow(page, "messenger");
    await check(page, testInfo, "a04-messenger-vacancy-list");
    await page.locator("#cl-gen").click();
    await expect(page.locator("#cl-out .chat-letter")).toHaveCount(1);
    await check(page, testInfo, "a05-messenger-reply");
  });

  test("B: 30 vacancies with the longest fields the analyser returns: board, filters, end of the list", async ({ page }, testInfo) => {
    await seedSignedIn(page);
    await start(page);
    await openWindow(page, "vacancies");
    const win = page.locator("#win-vacancies");
    await expect(win.locator(".jobcard")).toHaveCount(30);
    await check(page, testInfo, "b01-board-top");
    // the field filter offers the 60-character field
    await win.locator("#f-field").selectOption(FIELD_60);
    await check(page, testInfo, "b02-filter-long-field");
    await win.locator("#btn-reset").click();
    await win.locator(".jobcard").last().scrollIntoViewIfNeeded();
    await check(page, testInfo, "b03-board-bottom");
  });

  test("C: statistics with every status, deadlines and busy weeks", async ({ page }, testInfo) => {
    await seedSignedIn(page);
    await start(page);
    await openWindow(page, "stats");
    await expect(page.locator("#s-total")).toHaveText("30");
    await expect(page.locator("#prog i")).toHaveCount(8);
    await check(page, testInfo, "c01-stats");
    // the week labels under the bars must not run into each other
    const crowded = await page.evaluate(() => {
      const labels = [...document.querySelectorAll("#weeks .wk-d")].map((el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect(); });
      const out = [];
      for (let i = 1; i < labels.length; i++) if (labels[i].left < labels[i - 1].right - 1) out.push(`week label ${i} runs into label ${i - 1} by ${Math.round(labels[i - 1].right - labels[i].left)}px`);
      return out;
    });
    expect.soft(crowded, "week labels of the statistics").toEqual([]);
  });

  test("D: a 30-character user name and a 24-character fairy name: greeting, taskbar, START menu, sign-out question", async ({ page }, testInfo) => {
    await seedSignedIn(page);
    await openApp(page);
    // greet() one second after start: "<fairy name> вітає тебе ✦ ..."
    await expect(page.locator("#clippy-say")).toContainText(FAIRY_24, { timeout: 5000 });
    await check(page, testInfo, "d01-greeting", { fairy: true, reach: false });

    for (const app of ALL_WINDOWS) await openWindow(page, app);
    await check(page, testInfo, "d02-taskbar-all-windows");

    await page.locator("#startbtn").click();
    await expect(page.locator("#startmenu")).toHaveClass(/open/);
    await expect(page.locator("#sm-user")).toHaveText(USER_30);
    await check(page, testInfo, "d03-start-menu");
    await page.keyboard.press("Escape");

    await page.locator("#btn-account").click();
    await expect(page.locator("#confirm-overlay")).toHaveClass(/open/);
    await check(page, testInfo, "d04-sign-out-question");
    await page.keyboard.press("Escape");

    await openWindow(page, "fairy");
    await check(page, testInfo, "d05-my-fairy");
    // the fairy saves herself with her name: "<name> готова допомагати ✦ Полетіли!"
    await page.locator("#fairy-save").click();
    await check(page, testInfo, "d06-fairy-saved", { fairy: true, reach: false });
  });

  test("E: messenger with a long cover letter and a chat of 21 messages", async ({ page }, testInfo) => {
    await seedSignedIn(page);
    await start(page);
    await openWindow(page, "messenger");
    await page.locator("#cl-gen").click();
    await expect(page.locator("#cl-out .chat-letter")).toHaveCount(1);
    await check(page, testInfo, "e01-first-letter");
    const edits = ["зроби коротшим", "додай посилання на портфоліо " + PORTFOLIO, "більше про брендинг", "тепліше", "додай про AI-досвід", "прибери останній абзац"];
    for (const [i, edit] of edits.entries()) {
      await page.locator("#cl-edit").fill(edit);
      await page.locator("#cl-send").click();
      await expect(page.locator("#cl-out .chat-letter")).toHaveCount(i + 2);
    }
    await expect(page.locator("#cl-out > *")).toHaveCount(21);
    await check(page, testInfo, "e02-chat-21-messages");
    await page.locator("#cl-out .chat-msg.me").nth(1).scrollIntoViewIfNeeded();
    await check(page, testInfo, "e03-chat-portfolio-request");
  });

  test("F: phones: a dialog keeps its place while the fairy talks", async ({ page }, testInfo) => {
    await seedSignedIn(page);
    await start(page);
    await openWindow(page, "vacancies");
    await page.locator("#win-vacancies .jedit").first().click();
    const dialog = page.locator("#edit-overlay .dialog");
    await expect(dialog).toBeVisible();
    const before = await dialog.boundingBox();
    // what the idle timer does every 50 s (ui/clippy.js scheduleIdle): a phrase while the user fills the form
    await page.evaluate(() => window.jobdesk.say("Ти ближче до мрії, ніж думаєш ✦", 0, 60000));
    await page.waitForTimeout(600);
    const during = await dialog.boundingBox();
    expect.soft(Math.round(during.y), "the edit dialog moved when the fairy started talking").toBe(Math.round(before.y));
    await check(page, testInfo, "f01-edit-dialog-while-fairy-talks", { fairy: true });
    await page.keyboard.press("Escape");

    await page.locator("#win-vacancies .jdel").first().click();
    await expect(page.locator("#confirm-overlay")).toHaveClass(/open/);
    await page.evaluate(() => window.jobdesk.say("Кожне «ні» наближає твоє «так» ✦", 0, 60000));
    await check(page, testInfo, "f02-remove-question-while-fairy-talks", { fairy: true });
  });

  for (const [key, label, prepare] of [
    ["G", "the browser font at 200 %", (page) => bigFont(page)],
    ["H", "a 200 % page zoom", async (page) => { const v = page.viewportSize(); await page.setViewportSize({ width: Math.round(v.width / 2), height: Math.round(v.height / 2) }); }],
  ]) {
    test(`${key}: every window, dialog and the START menu with ${label}`, async ({ page, browserName }, testInfo) => {
      test.skip(key === "G" && browserName === "webkit", "Safari has no default font size setting; its page zoom is test H");
      // 200 % text on a phone narrower than 400 px, or a zoom that leaves less than 320 px, is a layout narrower
      // than the 320 px WCAG reflow asks for (and than any phone sold today): left out on purpose
      const { width, height } = page.viewportSize();
      test.skip(key === "G" && width < 400, "200 % text on a phone this narrow is a layout of under 200 px");
      test.skip(key === "H" && (width / 2 < 320 || height / 2 < 256), "a 200 % zoom here leaves less than WCAG reflow asks for (320 px wide, 256 px high)");
      const tag = key.toLowerCase();
      await prepare(page);
      await seedSignedIn(page);
      await start(page);
      await check(page, testInfo, tag + "00-desktop");
      for (const app of ALL_WINDOWS) {
        await openWindow(page, app);
        await check(page, testInfo, `${tag}01-window-${app}`);
        await closeWindow(page, app);
      }
      await page.locator("#startbtn").click();
      await expect(page.locator("#startmenu")).toHaveClass(/open/);
      await check(page, testInfo, tag + "02-start-menu");
      await page.keyboard.press("Escape");

      await openWindow(page, "vacancies");
      await page.locator("#win-vacancies .jedit").first().click();
      await check(page, testInfo, tag + "03-edit-dialog");
      await page.keyboard.press("Escape");
      await closeWindow(page, "vacancies");

      await page.evaluate(() => window.jobdesk.emit("auth:open", "register"));
      await check(page, testInfo, tag + "04-register-dialog");
      await page.keyboard.press("Escape");
    });
  }

  for (const theme of ["dark", "light"]) {
    test(`I: ${theme} theme: text keeps a readable contrast on every window and the taskbar`, async ({ page }, testInfo) => {
      await seedSignedIn(page, { jobdesk2000_theme: theme });
      await start(page);
      const results = [];
      for (const app of ALL_WINDOWS) {
        await openWindow(page, app);
        if (theme === "dark") await check(page, testInfo, "i01-dark-" + app);
        // WCAG contrast of every text on a plain background; 3:1 is the floor even for large text
        results.push(...await page.evaluate(() => {
          const parse = (c) => { const m = c.match(/[\d.]+/g); return m ? m.map(Number) : null; };
          const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
          const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
          const bgOf = (el) => {
            for (let p = el; p; p = p.parentElement) {
              const s = getComputedStyle(p);
              if (s.backgroundImage !== "none") return null; // gradients and pictures are not measured
              const c = parse(s.backgroundColor);
              if (c && (c.length < 4 || c[3] > 0.95)) return c;
              if (c && c[3] > 0.05) return null; // translucent layers are not measured
            }
            return null;
          };
          const out = [];
          for (const root of document.querySelectorAll(".win.open.focused, #taskbar")) {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
              const text = n.textContent.trim();
              if (text.length < 2 || /^[\p{Extended_Pictographic}\p{Emoji_Presentation}\s✦◈▦‍️]+$/u.test(text)) continue;
              const p = n.parentElement;
              const s = getComputedStyle(p);
              if (p.closest("[hidden], select, .sr-only") || s.display === "none" || s.visibility === "hidden") continue;
              const r = p.getBoundingClientRect();
              if (!r.width || !r.height) continue;
              const bg = bgOf(p), fg = parse(s.color);
              if (!bg || !fg || (fg.length > 3 && fg[3] < 0.95)) continue;
              const k = ratio(fg.slice(0, 3), bg.slice(0, 3));
              const where = p.id ? "#" + p.id : p.className ? "." + String(p.className).split(" ").join(".") : p.tagName.toLowerCase();
              if (k < 3) out.push(`${where}: contrast ${k.toFixed(2)}:1 (${s.color} on rgb(${bg.slice(0, 3).join(", ")}))`);
            }
          }
          return out;
        }));
        await closeWindow(page, app);
      }
      expect.soft([...new Set(results)], `${theme} theme contrast`).toEqual([]);
    });
  }
});
