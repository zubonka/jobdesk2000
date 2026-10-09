// Shared helpers for the browser tests.
import { expect } from "@playwright/test";

export const PASSWORD = "e2e-Test-2026";

// Three vacancies in the app's storage format (see public/js/core/storage.js), one per priority group.
export const SEED_JOBS = [
  { prio: "100% Податися", company: "Acme Studio", title: "Senior Graphic Designer", field: "Дизайн", emp: "Full-time", loc: "Віддалено", salary: "$1500-2000", url: "https://example.com/job/1" },
  { prio: "Податися", company: "Пікселька", title: "UI/UX дизайнерка", field: "IT", emp: "Part-time", loc: "Гібрид", salary: "—", url: "#" },
  { prio: "Подумати", company: "Label Records", title: "Motion Designer", field: "Музика", emp: "Freelance", loc: "—", salary: "30 000 грн", url: "https://example.com/job/3" },
];
export const SEED_PROGRESS = {
  "Acme Studio|Senior Graphic Designer": { status: "Подалася", date: "2026-10-01", deadline: "2026-10-20", note: "HR: Олена" },
  "Пікселька|UI/UX дизайнерка": { status: "Перша співбесіда", date: "2026-09-28", deadline: "", note: "" },
  "Label Records|Motion Designer": { status: "Не подавалася", date: "", deadline: "", note: "" },
};

// Writes localStorage before the app's scripts run. `values`: { key: value } (objects are JSON-encoded).
export async function seedStorage(page, values) {
  await page.addInitScript((entries) => {
    if (sessionStorage.getItem("e2e-seeded")) return; // only on the first load of this tab
    localStorage.clear();
    for (const [key, value] of entries) localStorage.setItem(key, value);
    sessionStorage.setItem("e2e-seeded", "1");
  }, Object.entries(values).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
}

export const seedVacancies = (page, extra = {}) => seedStorage(page, {
  jobdesk2000_welcomed: "1",
  jobdesk2000_added_v1: SEED_JOBS,
  jobdesk2000_v1: SEED_PROGRESS,
  ...extra,
});

// A fresh, unique emulator account per test, so tests never share data.
export function freshEmail(testInfo, tag = "user") {
  const slug = (testInfo.project.name + "-" + testInfo.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  return `${tag}-${slug}-${testInfo.retry}-${testInfo.workerIndex}-${Date.now() % 1e9}@example.com`;
}

// The dev server's AI mock reads its mode from this cookie, so each browser context gets its own mode.
export async function setMock(context, mode, baseURL) {
  await context.addCookies([{ name: "jd_mock", value: mode, url: baseURL }]);
}

// The app's own test handle (window.jobdesk in public/js/main.js).
export const openWindow = (page, app) => page.evaluate((a) => window.jobdesk.openWin(a), app);
export const closeWindow = (page, app) => page.evaluate((a) => window.jobdesk.closeWin(a), app);

export async function openApp(page) {
  await page.goto("/");
  await page.waitForFunction(() => !!window.jobdesk);
}

// Registers through the real dialog; leaves the user signed in with the welcome clippy shown.
export async function register(page, { name, email, gender = "f" }) {
  await page.evaluate(() => window.jobdesk.emit("auth:open", "register"));
  const dialog = page.locator("#auth-overlay");
  await expect(dialog).toHaveClass(/open/);
  await dialog.locator("#auth-name").fill(name);
  await dialog.locator("#auth-email").fill(email);
  await dialog.locator("#auth-pass").fill(PASSWORD);
  await dialog.locator(`.gender-btn[data-g="${gender}"]`).click();
  await dialog.locator("#auth-submit").click();
  await expect(dialog).not.toHaveClass(/open/);
  await expect(page.locator("#acc-label")).toHaveText(name);
}

export async function signIn(page, email) {
  await page.evaluate(() => window.jobdesk.emit("auth:open", "login"));
  const dialog = page.locator("#auth-overlay");
  await dialog.locator("#auth-email").fill(email);
  await dialog.locator("#auth-pass").fill(PASSWORD);
  await dialog.locator("#auth-pass").press("Enter");
  await expect(dialog).not.toHaveClass(/open/);
}

// Signs out through the account button and accepts the confirmation.
export async function signOut(page) {
  page.once("dialog", (d) => d.accept());
  await Promise.all([page.waitForEvent("load"), page.locator("#btn-account").click()]);
  await expect(page.locator("#acc-label")).toHaveText("Гість");
}

/* ----- layout checks ----- */

// Runs in the page. Returns human-readable problems for everything currently on screen.
export function layoutProblems(page, { touch = false } = {}) {
  return page.evaluate((touchDevice) => {
    const problems = [];
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const name = (el) => (el.id ? "#" + el.id : el.className && typeof el.className === "string" ? el.tagName.toLowerCase() + "." + el.className.split(" ").filter(Boolean).slice(0, 2).join(".") : el.tagName.toLowerCase()) + (el.textContent ? ` "${el.textContent.trim().slice(0, 30)}"` : "");
    const visible = (el) => {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || +s.opacity === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    if (document.documentElement.scrollWidth > vw + 1) problems.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${vw}`);

    // surfaces that must sit inside the viewport
    const surfaces = [...document.querySelectorAll(".win.open, .overlay.open .dialog, #startmenu.open, #clippy.show .bubble, #taskbar, .d-icon")].filter(visible);
    for (const el of surfaces) {
      const r = el.getBoundingClientRect();
      if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1) {
        problems.push(`${name(el)} leaves the viewport: [${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.right)}x${Math.round(r.bottom)}] in ${vw}x${vh}`);
      }
    }

    // content of windows and dialogs: no sideways scrolling, nothing sticking out, readable, tappable
    const containers = [...document.querySelectorAll(".win.open, .overlay.open .dialog, #startmenu.open")].filter(visible);
    for (const box of containers) {
      const boxRect = box.getBoundingClientRect();
      for (const body of box.querySelectorAll(".win-body, .sm-body")) {
        if (body.scrollWidth > body.clientWidth + 2) problems.push(`${name(box)} scrolls sideways inside (${body.scrollWidth} > ${body.clientWidth})`);
      }
      for (const el of box.querySelectorAll("*")) {
        if (!visible(el) || el.closest(".sr-only")) continue;
        const r = el.getBoundingClientRect();
        const scroller = el.closest(".win-body, .sm-body, .chat-log, .chat-letter, select");
        const clip = scroller && scroller !== el ? scroller.getBoundingClientRect() : boxRect;
        if (r.right > clip.right + 2 && !el.closest(".ti")) problems.push(`${name(el)} sticks out of ${name(box)} by ${Math.round(r.right - clip.right)}px`);
        const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (hasText) {
          const size = parseFloat(getComputedStyle(el).fontSize);
          if (size < 11) problems.push(`${name(el)} text is ${size}px`);
        }
        if (touchDevice && el.matches("button, a.btn, select, input:not([type=color]):not([type=file]), textarea, .pal-btn")) {
          if (r.height < 30 || r.width < 30) problems.push(`${name(el)} is ${Math.round(r.width)}x${Math.round(r.height)}, small for a finger`);
        }
      }
    }

    // desktop icons must not cover each other
    const icons = [...document.querySelectorAll(".d-icon")].filter(visible).map((el) => [el, el.getBoundingClientRect()]);
    for (let i = 0; i < icons.length; i++) {
      for (let j = i + 1; j < icons.length; j++) {
        const [a, ra] = icons[i], [b, rb] = icons[j];
        const overlap = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left) > 2 && Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top) > 2;
        if (overlap) problems.push(`${name(a)} overlaps ${name(b)}`);
      }
    }

    // taskbar items must not cover each other
    const bar = [...document.querySelectorAll("#taskbar > *, .tb-right > *, .tb-task")].filter(visible).map((el) => [el, el.getBoundingClientRect()]);
    for (let i = 0; i < bar.length; i++) {
      for (let j = i + 1; j < bar.length; j++) {
        const [a, ra] = bar[i], [b, rb] = bar[j];
        if (a.contains(b) || b.contains(a)) continue;
        if (Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left) > 1 && Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top) > 1) problems.push(`taskbar: ${name(a)} overlaps ${name(b)}`);
      }
    }
    return [...new Set(problems)];
  }, touch);
}
