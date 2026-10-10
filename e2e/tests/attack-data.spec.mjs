// Attacks on the stored data and the vacancy model: corrupted or hand-edited localStorage, a full storage quota,
// "|" inside names, Unicode, long texts, many vacancies, impossible dates, undo, backups and the CSV table.
// Every test asserts the CORRECT behaviour: a test that fails here is a bug, and passes once it is fixed.
import fs from "node:fs";
import { test, expect } from "@playwright/test";
import { seedStorage, seedVacancies, openWindow, confirmYes, layoutProblems, SEED_JOBS, SEED_PROGRESS } from "./helpers.mjs";

const JOBS_KEY = "jobdesk2000_added_v1";
const PROGRESS_KEY = "jobdesk2000_v1";
const WALL_KEY = "jobdesk2000_wall_v1";

// Page errors (uncaught exceptions) of this page, collected for an assertion at the end.
function trackErrors(page) {
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

// Like openApp(), but fails fast with a clear message instead of waiting for the whole test timeout.
async function boot(page) {
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => !!window.jobdesk), { timeout: 8000, message: "the app did not start (window.jobdesk never appeared)" }).toBe(true);
}

const stored = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), key);
// cards on screen: search and filters hide the others
const cards = (page) => page.locator("#win-vacancies .jobcard:visible");
const card = (page, text) => page.locator("#win-vacancies .jobcard:visible", { hasText: text });

function backupFile(data) {
  const doc = { app: "JobDesk 2000", format: 1, exported: "2026-10-01T10:00:00.000Z", data };
  return { name: "copy.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) };
}

async function addByHand(page, { title, company, loc }) {
  await page.locator("#btn-manual").click();
  await expect(page.locator("#edit-overlay")).toHaveClass(/open/);
  await page.locator("#ev-title").fill(title);
  await page.locator("#ev-company").fill(company);
  if (loc) await page.locator("#ev-loc").selectOption(loc);
  await page.locator("#ev-save").click();
}

/* ----- corrupted or hand-edited storage ----- */

test("the app starts and lists every vacancy when one progress entry is null", async ({ page }) => {
  const errors = trackErrors(page);
  await seedVacancies(page, { [PROGRESS_KEY]: { ...SEED_PROGRESS, "Пікселька|UI/UX дизайнерка": null } });
  await boot(page);
  await openWindow(page, "vacancies");
  await expect(cards(page)).toHaveCount(3);
  await expect(card(page, "Пікселька").locator(".st-sel")).toHaveValue("not_applied");
  expect(errors).toEqual([]);
});

for (const bad of [5, true]) {
  test(`the app starts when the stored icon positions are ${JSON.stringify(bad)}`, async ({ page }) => {
    const errors = trackErrors(page);
    await seedVacancies(page, { jobdesk2000_iconpos_v2: bad });
    await boot(page);
    await openWindow(page, "vacancies");
    await expect(cards(page)).toHaveCount(3);
    expect(errors).toEqual([]);
  });
}

for (const bad of [true, []]) {
  test(`folding a card works and survives a reload when the stored folds are ${JSON.stringify(bad)}`, async ({ page }) => {
    const errors = trackErrors(page);
    await seedVacancies(page, { jobdesk2000_collapsed: bad });
    await boot(page);
    await openWindow(page, "vacancies");
    const acme = card(page, "Acme Studio");
    await expect(acme.locator("textarea")).toHaveCount(1);
    await acme.locator(".jcol").click();
    await expect(acme.locator("textarea"), "the card did not fold").toHaveCount(0);
    await page.reload();
    await openWindow(page, "vacancies");
    await expect(card(page, "Acme Studio").locator("textarea"), "the fold was not saved").toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("statuses saved in another grammatical gender read back and are rewritten in the user's form", async ({ page }) => {
  // a guest (neutral forms) opens data written by a masculine and a feminine profile, plus a status key and junk
  await seedVacancies(page, {
    [PROGRESS_KEY]: {
      "Acme Studio|Senior Graphic Designer": { status: "Подався", date: "2026-10-01", deadline: "", note: 42 },
      "Пікселька|UI/UX дизайнерка": { status: "Не подавалася", date: 20261001, deadline: null, note: "ok" },
      "Label Records|Motion Designer": { status: "offer", date: "", deadline: "", note: "" },
    },
  });
  await boot(page);
  await openWindow(page, "vacancies");
  await expect(card(page, "Acme Studio").locator(".st-sel")).toHaveValue("applied");
  await expect(card(page, "Пікселька").locator(".st-sel")).toHaveValue("not_applied");
  await expect(card(page, "Label Records").locator(".st-sel")).toHaveValue("offer");
  await card(page, "Label Records").locator('textarea[data-k="note"]').fill("x");
  const progress = await stored(page, PROGRESS_KEY);
  expect(progress["Acme Studio|Senior Graphic Designer"]).toEqual({ status: "Подалися", date: "2026-10-01", deadline: "", note: "" });
  expect(progress["Пікселька|UI/UX дизайнерка"]).toEqual({ status: "Не подавалися", date: "", deadline: "", note: "ok" });
  expect(progress["Label Records|Motion Designer"].status).toBe("Оффер");
});

/* ----- storage quota ----- */

// Fills localStorage with a wallpaper that leaves only `free` characters, like a multi-MB picture from an old copy.
async function fillWithWallpaper(page, free) {
  return page.evaluate(({ key, free }) => {
    const head = "data:image/jpeg;base64,";
    let lo = 0, hi = 12 * 1024 * 1024;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      try { localStorage.setItem(key, head + "A".repeat(mid)); lo = mid; } catch (e) { hi = mid - 1; }
    }
    localStorage.setItem(key, head + "A".repeat(Math.max(0, lo - free)));
    return lo;
  }, { key: WALL_KEY, free });
}

// When the browser's storage is full nothing can be saved; the app must say so instead of losing the change silently.
test("a vacancy that cannot be saved because storage is full is reported at once", async ({ page }) => {
  await seedVacancies(page);
  await boot(page);
  await openWindow(page, "vacancies");
  const capacity = await fillWithWallpaper(page, 64);
  expect(capacity).toBeGreaterThan(1_000_000);

  await addByHand(page, { title: "Quota Designer", company: "Quota Co" });
  await expect(page.locator("#toast"), "the refused save went unreported").toContainText("забракло місця");
});

test("a note that stops being saved because storage is full is reported", async ({ page }) => {
  await seedVacancies(page);
  await boot(page);
  await openWindow(page, "vacancies");
  await fillWithWallpaper(page, 40);
  const note = "Дзвінок з HR у пʼятницю о 15:00, взяти портфоліо, спитати про тестове й зарплатну вилку ✦";
  await card(page, "Label Records").locator('textarea[data-k="note"]').pressSequentially(note);
  await expect(card(page, "Label Records").locator('textarea[data-k="note"]')).toHaveValue(note);
  await expect(page.locator("#toast"), "the note stopped being saved without a word").toContainText("забракло місця");
});

/* ----- the edit dialog ----- */

test("editing one field keeps a location that is not one of the three options", async ({ page }) => {
  const jobs = [{ ...SEED_JOBS[0], loc: "Київ, Поділ" }, SEED_JOBS[1], SEED_JOBS[2]];
  await seedVacancies(page, { [JOBS_KEY]: jobs });
  await boot(page);
  await openWindow(page, "vacancies");
  await expect(card(page, "Acme Studio")).toContainText("📍 Київ, Поділ");
  await card(page, "Acme Studio").locator(".jedit").click();
  await page.locator("#ev-salary").fill("$2500");
  await page.locator("#ev-save").click();
  await expect(card(page, "Acme Studio")).toContainText("$2500");
  await expect(card(page, "Acme Studio"), "saving the salary dropped the location").toContainText("📍 Київ, Поділ");
  expect((await stored(page, JOBS_KEY))[0].loc).toBe("Київ, Поділ");
});

test("editing one field keeps an employment type that is not one of the options", async ({ page }) => {
  const jobs = [{ ...SEED_JOBS[0], emp: "Повна зайнятість, 40 год" }, SEED_JOBS[1], SEED_JOBS[2]];
  await seedVacancies(page, { [JOBS_KEY]: jobs });
  await boot(page);
  await openWindow(page, "vacancies");
  await card(page, "Acme Studio").locator(".jedit").click();
  await page.locator("#ev-salary").fill("$2500");
  await page.locator("#ev-save").click();
  await expect(card(page, "Acme Studio")).toContainText("Повна зайнятість, 40 год");
});

/* ----- ids made of company + "|" + title ----- */

test("two different vacancies whose names contain '|' both load", async ({ page }) => {
  const jobs = [
    { ...SEED_JOBS[0], company: "Acme|Kyiv", title: "Designer" },
    { ...SEED_JOBS[1], company: "Acme", title: "Kyiv|Designer" },
  ];
  await seedVacancies(page, { [JOBS_KEY]: jobs, [PROGRESS_KEY]: {} });
  await boot(page);
  await openWindow(page, "vacancies");
  await expect(cards(page), "one of two different vacancies vanished (and is deleted from storage at the next save)").toHaveCount(2);
});

test("a vacancy whose name contains '|' can be added next to a different one with the same joined name", async ({ page }) => {
  await seedVacancies(page, { [JOBS_KEY]: [{ ...SEED_JOBS[0], company: "Acme|Kyiv", title: "Designer" }], [PROGRESS_KEY]: {} });
  await boot(page);
  await openWindow(page, "vacancies");
  await addByHand(page, { title: "Kyiv|Designer", company: "Acme" });
  await expect(page.locator("#ev-msg")).not.toHaveText("Така вакансія вже є ✦");
  await expect(cards(page)).toHaveCount(2);
});

/* ----- Unicode, long texts, search ----- */

test("filter options are in Ukrainian alphabetical order", async ({ page }) => {
  const fields = ["Ґеймдев", "Дизайн", "IT", "Їжа", "Архітектура", "Єдиноборства", "Іграшки"];
  await seedVacancies(page, { [JOBS_KEY]: fields.map((field, i) => ({ ...SEED_JOBS[0], title: "T" + i, field })), [PROGRESS_KEY]: {} });
  await boot(page);
  await openWindow(page, "vacancies");
  const options = await page.locator("#f-field option").evaluateAll((els) => els.slice(1).map((o) => o.value));
  const expected = await page.evaluate((list) => [...list].sort(new Intl.Collator("uk").compare), fields);
  expect(options).toEqual(expected);
});

test("search finds a word whatever apostrophe or Unicode form it was written in", async ({ page }) => {
  const jobs = [
    { ...SEED_JOBS[0], company: "Київстар".normalize("NFD"), title: "Product Designer" }, // pasted from a macOS PDF
    SEED_JOBS[1], SEED_JOBS[2],
  ];
  await seedVacancies(page, {
    [JOBS_KEY]: jobs,
    [PROGRESS_KEY]: { "Пікселька|UI/UX дизайнерка": { status: "Подалася", date: "", deadline: "", note: "дзвінок у пʼятницю" } },
  });
  await boot(page);
  await openWindow(page, "vacancies");
  const search = page.locator("#f-search");
  for (const query of ["пʼятницю", "п'ятницю", "п’ятницю"]) {
    await search.fill(query);
    await expect(cards(page), `search "${query}"`).toHaveCount(1);
  }
  await search.fill("київстар");
  await expect(cards(page), "search for an NFC word in NFD text").toHaveCount(1);
});

test("emoji, RTL text and markup in every field render as text and survive an edit and a reload", async ({ page }) => {
  const errors = trackErrors(page);
  const job = {
    prio: "Подумати", company: "שלום Studio 👩‍💻", title: "مصمم <b>UI</b> 🧚‍♀️", field: "Дизайн 🎨", emp: "Full-time",
    loc: "Віддалено", salary: "₴ 50 000 — 70 000", url: "https://example.com/جاب?q=1&x=\"2\"",
  };
  await seedVacancies(page, { [JOBS_KEY]: [job], [PROGRESS_KEY]: { [job.company + "|" + job.title]: { status: "Оффер", date: "2026-10-01", deadline: "", note: "‮reversed‬ 👍🏽" } } });
  await boot(page);
  await openWindow(page, "vacancies");
  const c = cards(page).first();
  await expect(c.locator(".jt")).toHaveText(job.title);
  await expect(c.locator(".jc")).toHaveText(job.company);
  await expect(c.locator(".st-sel")).toHaveValue("offer");
  await c.locator(".jedit").click();
  await page.locator("#ev-field").fill("Дизайн 🎨✨");
  await page.locator("#ev-save").click();
  await page.reload();
  await openWindow(page, "vacancies");
  await expect(cards(page).first().locator(".jt")).toHaveText(job.title);
  await expect(cards(page).first().locator(".st-sel")).toHaveValue("offer");
  await expect(cards(page).first().locator('textarea[data-k="note"]')).toHaveValue("‮reversed‬ 👍🏽");
  expect((await stored(page, JOBS_KEY))[0]).toMatchObject({ company: job.company, title: job.title, field: "Дизайн 🎨✨", url: job.url });
  expect(errors).toEqual([]);
});

test("a long unbroken company or title stays inside the card", async ({ page }) => {
  const long = "https://jobs.example.com/companies/very-long-company-name/vacancies/1234567890?utm_source=linkedin";
  const jobs = [{ ...SEED_JOBS[0], company: long, title: "СтаршийДизайнерІнтерфейсівМобільнихЗастосунків" }];
  await seedVacancies(page, { [JOBS_KEY]: jobs, [PROGRESS_KEY]: {} });
  await boot(page);
  await openWindow(page, "vacancies");
  await expect(cards(page)).toHaveCount(1);
  expect(await layoutProblems(page)).toEqual([]);
});

/* ----- another tab ----- */

test("a change made in one tab never saves over what another tab of the browser saved a moment before", async ({ page }) => {
  await seedVacancies(page);
  await boot(page);
  await openWindow(page, "vacancies");
  // the other tab's write: a page hears of its own writes through no event, so this tab still holds the older list
  await page.evaluate(() => {
    const list = JSON.parse(localStorage.getItem("jobdesk2000_added_v1"));
    list.push({ prio: "Податися", company: "Other Tab Co", title: "QA", field: "—", emp: "—", loc: "—", salary: "—", url: "#" });
    localStorage.setItem("jobdesk2000_added_v1", JSON.stringify(list));
  });
  await card(page, "Acme Studio").locator('textarea[data-k="note"]').fill("typed in this tab");
  expect(await stored(page, JOBS_KEY).then((list) => list.map((j) => j.company))).toContain("Other Tab Co");
  expect((await stored(page, PROGRESS_KEY))["Acme Studio|Senior Graphic Designer"].note).toBe("typed in this tab");
  await expect(card(page, "Other Tab Co")).toHaveCount(1);
  await expect(card(page, "Acme Studio").locator('textarea[data-k="note"]')).toHaveValue("typed in this tab");
});

/* ----- many vacancies ----- */

function manyJobs(n, noteChars) {
  const jobs = [], progress = {};
  const statuses = ["Не подавалася", "Подалася", "Перша співбесіда", "Відмова"];
  const prios = ["100% Податися", "Податися", "Подумати"];
  const filler = "Опис вакансії, вимоги, контакти HR, нотатки після дзвінка. ";
  for (let i = 0; i < n; i++) {
    const job = { prio: prios[i % 3], company: "Company " + i, title: "Designer " + i, field: "Field " + (i % 12), emp: "Full-time", loc: "Віддалено", salary: "$" + (1000 + i), url: "https://example.com/" + i };
    jobs.push(job);
    progress[job.company + "|" + job.title] = { status: statuses[i % 4], date: "2026-09-" + String(1 + (i % 28)).padStart(2, "0"), deadline: "", note: (i + " " + filler.repeat(Math.ceil(noteChars / filler.length))).slice(0, noteChars) };
  }
  return { jobs, progress };
}

test("300 vacancies with long notes: search, a status change and typing a note stay quick", async ({ page }, testInfo) => {
  const { jobs, progress } = manyJobs(300, 3000);
  await seedVacancies(page, { [JOBS_KEY]: jobs, [PROGRESS_KEY]: progress });
  await boot(page);
  const openMs = await page.evaluate(() => { const t = performance.now(); window.jobdesk.openWin("vacancies"); document.body.offsetHeight; return performance.now() - t; });
  await expect(cards(page)).toHaveCount(300);

  // one keystroke in the search box redraws the board
  const searchMs = await page.evaluate(() => {
    const el = document.getElementById("f-search");
    const times = [];
    for (const q of ["d", "de", "des", "desi", ""]) {
      const t = performance.now();
      el.value = q;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      document.body.offsetHeight;
      times.push(performance.now() - t);
    }
    return times.sort((a, b) => a - b)[2]; // the middle one, see the note keystrokes below
  });
  // one keystroke in a note saves the whole list
  const noteMs = await page.evaluate(() => {
    const el = document.querySelector('#board textarea[data-k="note"]');
    const times = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      el.value += "x";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      times.push(performance.now() - t);
    }
    return times.sort((a, b) => a - b)[2]; // the middle one: a slow app slows every keystroke, a busy test machine one
  });
  // a status change redraws its card and the statistics; three changes, the middle one counts
  const statusMs = await page.evaluate(() => {
    const times = [];
    for (const value of ["test", "interview1", "reject"]) {
      const el = document.querySelector("#board select.st-sel"); // the card is redrawn, so its select is new
      const t = performance.now();
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      document.body.offsetHeight;
      times.push(performance.now() - t);
    }
    return times.sort((a, b) => a - b)[1];
  });
  const timings = { openMs, searchMs, noteMs, statusMs };
  testInfo.annotations.push({ type: "timings", description: JSON.stringify(timings) });
  console.log("300 vacancies:", JSON.stringify(timings));
  // 100 ms is where a keystroke starts to feel laggy
  expect(searchMs, "one search keystroke").toBeLessThan(100);
  // a keystroke saves the whole list (900 KB here), which a busy test machine may stretch a little
  expect(noteMs, "one note keystroke").toBeLessThan(150);
  expect(statusMs, "one status change").toBeLessThan(250); // it redraws one card; the rest is saving 900 KB
});

/* ----- dates ----- */

const isoIn = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()];
};

test("an impossible calendar date shows no deadline badge while the date field shows nothing", async ({ page }) => {
  // the 3rd day from now written as day 30+ of the month before ("2026-09-43"), the way a hand edit or another app could store it
  const [y, m, d] = isoIn(3);
  const prevMonthDays = new Date(y, m - 1, 0).getDate();
  const prev = m === 1 ? [y - 1, 12] : [y, m - 1];
  const impossible = `${prev[0]}-${String(prev[1]).padStart(2, "0")}-${String(d + prevMonthDays).padStart(2, "0")}`;
  await seedVacancies(page, { [PROGRESS_KEY]: { ...SEED_PROGRESS, "Label Records|Motion Designer": { status: "Не подавалася", date: "", deadline: impossible, note: "" } } });
  await boot(page);
  await openWindow(page, "vacancies");
  const c = card(page, "Label Records");
  await expect(c.locator('input[data-k="deadline"]')).toHaveValue("");
  await expect(c.locator(".jtag.dl"), `deadline "${impossible}" is not a date, but the card counts down to it`).toHaveCount(0);
});

test("deadline badges count calendar days across the end of summer time and the turn of the year", async ({ page }) => {
  // Kyiv leaves summer time on the last Sunday of October; the browser runs in Europe/Kyiv
  await page.clock.setFixedTime(new Date("2026-10-24T23:30:00+03:00"));
  await seedVacancies(page, {
    [PROGRESS_KEY]: {
      "Acme Studio|Senior Graphic Designer": { status: "Подалася", date: "", deadline: "2026-10-26", note: "" },
      "Пікселька|UI/UX дизайнерка": { status: "Подалася", date: "", deadline: "2026-10-25", note: "" },
      "Label Records|Motion Designer": { status: "Подалася", date: "", deadline: "2026-11-07", note: "" },
    },
  });
  await boot(page);
  await openWindow(page, "vacancies");
  await expect(card(page, "Acme Studio").locator(".jtag.dl")).toHaveText("⏳ до дедлайну 2 дні");
  await expect(card(page, "Пікселька").locator(".jtag.dl")).toHaveText("⏳ дедлайн завтра");
  await expect(card(page, "Label Records").locator(".jtag.dl")).toHaveText("⏳ до дедлайну 14 днів");
});

/* ----- undo ----- */

test("undoing a removal after the same vacancy was added again keeps one card and loses no notes silently", async ({ page }) => {
  await seedVacancies(page);
  await boot(page);
  await openWindow(page, "vacancies");
  await card(page, "Acme Studio").locator(".jdel").click();
  await confirmYes(page);
  await expect(cards(page)).toHaveCount(2);
  const undo = page.locator("#toast .toast-act");
  await expect(undo).toBeVisible();
  // the same vacancy comes back by hand before the notice is gone
  await addByHand(page, { title: "Senior Graphic Designer", company: "Acme Studio" });
  await expect(cards(page)).toHaveCount(3);
  await undo.click();
  await expect(cards(page)).toHaveCount(3);
});

test("undoing a reset brings back the progress of every vacancy, including one renamed meanwhile", async ({ page }) => {
  await seedVacancies(page);
  await boot(page);
  await openWindow(page, "vacancies");
  await page.locator("#btn-clear").click();
  await confirmYes(page);
  await expect(card(page, "Acme Studio").locator(".st-sel")).toHaveValue("not_applied");
  const undo = page.locator("#toast .toast-act");
  await expect(undo).toBeVisible();
  // a quick rename before pressing undo
  await card(page, "Acme Studio").locator(".jedit").click();
  await page.locator("#ev-title").fill("Lead Graphic Designer");
  await page.locator("#ev-save").click();
  await expect(card(page, "Lead Graphic Designer")).toHaveCount(1);
  await undo.click();
  await expect(card(page, "Пікселька").locator(".st-sel")).toHaveValue("interview1");
  await expect(card(page, "Lead Graphic Designer").locator(".st-sel"), "the renamed vacancy lost its status").toHaveValue("applied");
  await expect(card(page, "Lead Graphic Designer").locator('textarea[data-k="note"]'), "the renamed vacancy lost its note").toHaveValue("HR: Олена");
});

/* ----- backups ----- */

test("restoring a copy with one null progress entry adds every vacancy", async ({ page }) => {
  const errors = trackErrors(page);
  await seedStorage(page, { jobdesk2000_welcomed: "1" });
  await boot(page);
  await openWindow(page, "vacancies");
  const copy = backupFile({
    [JOBS_KEY]: JSON.stringify(SEED_JOBS),
    [PROGRESS_KEY]: JSON.stringify({ ...SEED_PROGRESS, "Пікселька|UI/UX дизайнерка": null }),
  });
  await page.locator("#backup-file").setInputFiles(copy);
  await confirmYes(page);
  await expect(page.locator("#toast")).toContainText("додано вакансій: 3");
  await expect(cards(page)).toHaveCount(3);
  expect((await stored(page, JOBS_KEY)) || []).toHaveLength(3);
  expect(errors).toEqual([]);
});

test("restoring the same copy twice adds nothing the second time and keeps local edits", async ({ page }) => {
  await seedVacancies(page);
  await boot(page);
  await openWindow(page, "vacancies");
  const copy = backupFile({ [JOBS_KEY]: JSON.stringify(SEED_JOBS), [PROGRESS_KEY]: JSON.stringify(SEED_PROGRESS) });
  await card(page, "Acme Studio").locator(".st-sel").selectOption("offer");
  for (let i = 0; i < 2; i++) {
    await page.locator("#backup-file").setInputFiles(copy);
    await confirmYes(page);
    await expect(page.locator("#toast")).toContainText("Усе з цієї копії вже тут");
  }
  await expect(cards(page)).toHaveCount(3);
  await expect(card(page, "Acme Studio").locator(".st-sel")).toHaveValue("offer");
});

test("the restore question counts only the vacancies the copy can really add", async ({ page }) => {
  await seedStorage(page, { jobdesk2000_welcomed: "1" });
  await boot(page);
  await openWindow(page, "vacancies");
  const list = [SEED_JOBS[0], SEED_JOBS[0], null, "junk", 7, SEED_JOBS[1]];
  await page.locator("#backup-file").setInputFiles(backupFile({ [JOBS_KEY]: JSON.stringify(list) }));
  await expect(page.locator("#confirm-text")).toContainText("вакансій: 2");
});

test("a copy cannot point the wallpaper at a remote address the app then fetches", async ({ page }) => {
  const hits = [];
  await page.route("https://tracker.example/**", (route) => { hits.push(route.request().url()); return route.fulfill({ status: 204 }); });
  await seedStorage(page, { jobdesk2000_welcomed: "1" });
  await boot(page);
  await page.locator("#backup-file").setInputFiles(backupFile({
    [JOBS_KEY]: JSON.stringify([SEED_JOBS[0]]),
    [WALL_KEY]: "https://tracker.example/pixel.png?who=me",
  }));
  await confirmYes(page);
  await expect(page.locator("#toast")).toContainText("додано вакансій: 1");
  await page.reload();
  await page.waitForTimeout(1000);
  expect(hits, "the restored wallpaper made the app call another server").toEqual([]);
  const wall = await page.evaluate((k) => localStorage.getItem(k), WALL_KEY);
  expect(wall === null || wall.startsWith("data:image/"), "the wallpaper must be a picture, got " + wall).toBe(true);
});

test("a backup of another app, broken JSON and a non-copy are refused without touching the vacancies", async ({ page }) => {
  await seedVacancies(page);
  await boot(page);
  await openWindow(page, "vacancies");
  const files = [
    { name: "other.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ app: "JobDesk 3000", data: { [JOBS_KEY]: "[]" } })) },
    { name: "broken.json", mimeType: "application/json", buffer: Buffer.from('{"app":"JobDesk 2000","data":{') },
    { name: "array.json", mimeType: "application/json", buffer: Buffer.from("[1,2,3]") },
  ];
  for (const file of files) {
    await page.locator("#backup-file").setInputFiles(file);
    await expect(page.locator("#toast")).toContainText("не схоже на копію");
    await expect(page.locator("#confirm-overlay")).not.toHaveClass(/open/);
  }
  // a JobDesk copy whose vacancy list is not a list adds nothing and breaks nothing
  await page.locator("#backup-file").setInputFiles(backupFile({ [JOBS_KEY]: '{"0":{"company":"X","title":"Y"}}', [PROGRESS_KEY]: "null" }));
  await confirmYes(page);
  await expect(page.locator("#toast")).toContainText("Усе з цієї копії вже тут");
  await expect(cards(page)).toHaveCount(3);
});

/* ----- CSV ----- */

test("the CSV table neutralises formulas and keeps quotes, semicolons and line breaks in their cells", async ({ page }) => {
  const jobs = [
    { prio: "Податися", company: '=HYPERLINK("https://evil.example","click")', title: '+cmd|" /C calc"!A0', field: "-2+3", emp: "@SUM(1)", loc: "\tTab", salary: "1;000", url: "https://example.com/a;b" },
  ];
  await seedVacancies(page, { [JOBS_KEY]: jobs, [PROGRESS_KEY]: { [jobs[0].company + "|" + jobs[0].title]: { status: "Подалася", date: "2026-10-01", deadline: "", note: 'рядок 1\r\nрядок "2"; =3' } } });
  await boot(page);
  await page.locator("#startbtn").click();
  const [table] = await Promise.all([page.waitForEvent("download"), page.locator('#startmenu [data-action="table"]').click()]);
  const csv = fs.readFileSync(await table.path(), "utf8");
  expect(csv.startsWith("﻿")).toBe(true);
  // a minimal RFC 4180 reader with ";" as the separator
  const rows = [];
  let row = [], cell = "", quoted = false;
  const text = csv.slice(1);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ";") { row.push(cell); cell = ""; }
    else if (ch === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
    else cell += ch;
  }
  expect(rows).toHaveLength(2);
  const [cells] = rows.slice(1);
  expect(cells).toHaveLength(12);
  for (const value of cells) expect(value, "a cell starts like a formula").not.toMatch(/^[=+\-@\t\r]/);
  expect(cells[1]).toBe("'" + jobs[0].company);
  expect(cells[6]).toBe("1;000");
  expect(cells[10]).toBe("рядок 1\r\nрядок \"2\"; =3");
  expect(cells[11]).toBe("https://example.com/a;b");
});

test("PROFILE-TEMP board render cost breakdown", async ({ page }) => {
  await seedStorage(page, { jobdesk2000_welcomed: "1" });
  await boot(page);
  const out = {};
  for (const [n, chars] of [[300, 0], [300, 300], [300, 3000], [50, 3000], [100, 0]]) {
    const { jobs, progress } = manyJobs(n, chars);
    await page.evaluate(({ jobs, progress }) => { localStorage.setItem("jobdesk2000_added_v1", JSON.stringify(jobs)); localStorage.setItem("jobdesk2000_v1", JSON.stringify(progress)); }, { jobs, progress });
    await page.reload();
    await page.waitForFunction(() => !!window.jobdesk);
    await openWindow(page, "vacancies");
    await page.waitForTimeout(300);
    out[n + "x" + chars] = await page.evaluate(() => {
      const el = document.getElementById("f-search");
      const r = [];
      for (const q of ["d", ""]) {
        const t0 = performance.now();
        el.value = q;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        const t1 = performance.now();
        document.body.offsetHeight;
        const t2 = performance.now();
        r.push({ js: Math.round(t1 - t0), layout: Math.round(t2 - t1) });
      }
      // the same markup without the app: innerHTML alone, and with the textareas emptied
      const board = document.getElementById("board");
      const markup = board.innerHTML;
      const t3 = performance.now(); board.innerHTML = ""; board.innerHTML = markup; const t4 = performance.now(); document.body.offsetHeight; const t5 = performance.now();
      const noSelects = markup.replace(/<select[\s\S]*?<\/select>/g, "<span></span>");
      const t6 = performance.now(); board.innerHTML = noSelects; document.body.offsetHeight; const t7 = performance.now();
      const noAreas = markup.replace(/<textarea([^>]*)>[\s\S]*?<\/textarea>/g, "<textarea$1></textarea>");
      const t8 = performance.now(); board.innerHTML = noAreas; document.body.offsetHeight; const t9 = performance.now();
      return { search: r, markupKB: Math.round(markup.length / 1024), inner: Math.round(t4 - t3), innerLayout: Math.round(t5 - t4), withoutSelects: Math.round(t7 - t6), withEmptyTextareas: Math.round(t9 - t8), cards: board.querySelectorAll(".jobcard").length };
    });
  }
  console.log("PROFILE", JSON.stringify(out, null, 1));
});
