// Attack tests for the AI flows: adding a vacancy by link or pasted text, the AI refill of the edit dialog, the CV
// (PDF or pasted) and the cover letter chat. Every mock mode at the steps that call the AI, double clicks and Enter
// spam, windows and dialogs closed mid-request, the vacancy or the CV changed meanwhile, signing out, markup in every
// field, long texts and broken PDFs. Each test asserts the correct behaviour, so a failing test is a bug.
import { test, expect } from "@playwright/test";
import { seedStorage, seedVacancies, openApp, openWindow, closeWindow, register, signOut, setMock, freshEmail, layoutProblems } from "./helpers.mjs";

const VACANCY_TEXT = "Acme Studio шукає Senior Graphic Designer. Повна зайнятість, віддалено. Зарплата 1500-2000$. Досвід 3+ роки у Figma.";
const OTHER_TEXT = "Beta Records шукає Motion Designer на проєкт. Гібрид, Київ. Ставка 30 000 грн. After Effects, Cinema 4D.";
const CV_TEXT = "Олена Тестенко. Графічна дизайнерка, 5 років брендингу: Figma, Illustrator, Photoshop. Айдентика для музичного лейблу.";
const ACME = "Acme Studio|Senior Graphic Designer";
const LABEL = "Label Records|Motion Designer";
const SLOW_WAIT = 15_000; // the mock's "slow" mode answers after 6 s
const BUSY_RETRIES_WAIT = 60_000; // three tries with 8 s and 12 s countdowns in between

const storedJobs = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("jobdesk2000_added_v1") || "[]"));
const storedCV = (page) => page.evaluate(() => localStorage.getItem("jobdesk2000_cv_v1"));

// Bodies of the requests the page sends to one function, in order.
function recordCalls(page, name) {
  const calls = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname === "/.netlify/functions/" + name) calls.push(req.postDataJSON());
  });
  return calls;
}

// The analysis answered by the test after `ms`, so the link route needs no real vacancy page on the internet.
async function slowAnalysis(page, answer, ms = 3000) {
  await page.route("**/.netlify/functions/analyze-vacancy", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.fulfill({ json: answer });
  });
}

const vacancyAnswer = (company, title) => ({ company, title, field: "Дизайн", emp: "Full-time", loc: "Віддалено", salary: "—" });

// A minimal valid PDF, one page per entry; "" makes a page without any text (what a scan looks like to pdf.js).
function makePdf(pages) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", null, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids = [];
  for (const text of pages) {
    const stream = text ? `BT /F1 12 Tf 60 740 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET` : "";
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const contents = objects.length;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// one line that fits the page (pdf.js leaves out text drawn past the page edge)
const PDF_CV = "Olena Testenko. Graphic designer: Figma, Illustrator, Photoshop. Music label identity.";
const textPdf = () => ({ name: "cv.pdf", mimeType: "application/pdf", buffer: makePdf([PDF_CV]) });
const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/* ----- adding a vacancy ----- */

test.describe("adding a vacancy", () => {
  test.beforeEach(async ({ page }) => {
    await seedStorage(page, { jobdesk2000_welcomed: "1" });
  });

  test("a link typed while the previous one is analysed stays in the field", async ({ page }) => {
    await slowAnalysis(page, vacancyAnswer("First Co", "First Designer"));
    await openApp(page);
    await openWindow(page, "vacancies");
    const win = page.locator("#win-vacancies");
    await win.locator("#add-url").fill("https://jobs.example.com/first");
    await win.locator("#btn-url-add").click();
    await expect(win.locator("#btn-url-add")).toBeDisabled();
    // the next vacancy's link, typed while the fairy works on the first one
    await win.locator("#add-url").fill("https://jobs.example.com/second");
    await expect(win.locator("#add-url-msg")).toHaveText("Додано: First Co ✦");
    expect((await storedJobs(page)).map((j) => j.url)).toEqual(["https://jobs.example.com/first"]);
    await expect(win.locator("#add-url")).toHaveValue("https://jobs.example.com/second");
  });

  test("a pasted vacancy keeps the link it was sent with when the link field changes meanwhile", async ({ page, context, baseURL }) => {
    await setMock(context, "slow", baseURL);
    await openApp(page);
    await openWindow(page, "vacancies");
    const win = page.locator("#win-vacancies");
    await win.locator("#btn-paste").click();
    await win.locator("#a-paste").fill(VACANCY_TEXT);
    await win.locator("#a-paste-url").fill("https://jobs.example.com/acme");
    await win.locator("#a-paste-go").click();
    await expect(win.locator("#a-paste-go")).toBeDisabled();
    await win.locator("#a-paste-url").fill("https://jobs.example.com/beta");
    await expect(win.locator("#add-url-msg")).toHaveText("Додано: Mock Studio ✦", { timeout: SLOW_WAIT });
    expect((await storedJobs(page)).map((j) => j.url)).toEqual(["https://jobs.example.com/acme"]);
  });

  test("a vacancy text pasted while the previous one is analysed is not wiped", async ({ page, context, baseURL }) => {
    await setMock(context, "slow", baseURL);
    await openApp(page);
    await openWindow(page, "vacancies");
    const win = page.locator("#win-vacancies");
    await win.locator("#btn-paste").click();
    await win.locator("#a-paste").fill(VACANCY_TEXT);
    await win.locator("#a-paste-go").click();
    await expect(win.locator("#a-paste-go")).toBeDisabled();
    await win.locator("#a-paste").fill(OTHER_TEXT);
    await expect(win.locator("#add-url-msg")).toHaveText("Додано: Mock Studio ✦", { timeout: SLOW_WAIT });
    await expect(win.locator("#paste-box")).toBeVisible();
    await expect(win.locator("#a-paste")).toHaveValue(OTHER_TEXT);
  });

  test("a link typed without https:// is analysed as a link", async ({ page }) => {
    const calls = recordCalls(page, "analyze-vacancy");
    await openApp(page);
    await openWindow(page, "vacancies");
    const win = page.locator("#win-vacancies");
    await win.locator("#add-url").fill("jobs.example.com/vacancy/42");
    const answered = page.waitForResponse((r) => r.url().endsWith("/analyze-vacancy"), { timeout: 20_000 });
    await win.locator("#add-url").press("Enter");
    await answered;
    expect(calls.map((c) => c.url)).toEqual(["https://jobs.example.com/vacancy/42"]);
    await expect(win.locator("#add-url-msg")).not.toHaveText("Дай посилання або встав текст вакансії");
  });

  test("Enter spam and double clicks send one analysis per press of the button", async ({ page }) => {
    const calls = recordCalls(page, "analyze-vacancy");
    await slowAnalysis(page, vacancyAnswer("Spam Co", "Designer"), 2500);
    await openApp(page);
    await openWindow(page, "vacancies");
    const win = page.locator("#win-vacancies");
    await win.locator("#add-url").fill("https://jobs.example.com/spam");
    for (let i = 0; i < 6; i++) await win.locator("#add-url").press("Enter");
    await expect(win.locator("#add-url-msg")).toHaveText("Додано: Spam Co ✦");
    await win.locator("#btn-paste").click();
    await win.locator("#a-paste").fill(OTHER_TEXT);
    await win.locator("#a-paste-go").dblclick();
    await expect(win.locator("#add-url-msg")).toHaveText("Ця вакансія вже у списку ✦");
    await expect(win.locator("#a-paste-go")).toBeEnabled();
    expect(calls).toHaveLength(2);
    await expect(win.locator(".jobcard")).toHaveCount(1);
  });

  test("busy, empty and truncated AI answers end with a message, a usable button and no card", async ({ page, context, baseURL }) => {
    await openApp(page);
    await openWindow(page, "vacancies");
    const win = page.locator("#win-vacancies");
    await win.locator("#btn-paste").click();
    const cases = [
      ["busy", "Не вдалося розібрати ✦ Сервіс зараз зайнятий ✦ спробуй ще раз за хвилину."],
      ["empty", "Не вдалося розібрати ✦ Не вдалося розібрати вакансію"],
      ["truncated", "Не вдалося розібрати ✦ Не вдалося розібрати вакансію"],
    ];
    for (const [mode, message] of cases) {
      await setMock(context, mode, baseURL);
      await win.locator("#add-url-msg").evaluate((el) => { el.textContent = ""; });
      await win.locator("#a-paste").fill(VACANCY_TEXT);
      await win.locator("#a-paste-go").click();
      await expect(win.locator("#add-url-msg"), mode).toHaveText(message);
      await expect(win.locator("#a-paste-go"), mode).toBeEnabled();
      await expect(win.locator("#a-paste"), mode).toHaveValue(VACANCY_TEXT);
    }
    await expect(win.locator(".jobcard")).toHaveCount(0);
  });

  test("a text of only emoji or invisible characters is refused instead of becoming a vacancy", async ({ page, request, baseURL }) => {
    // 25 emoji are 50 UTF-16 units, so they pass the 40-character minimum, then the server strips them all
    for (const text of ["🎉".repeat(25), "​".repeat(45), "→".repeat(45)]) {
      const res = await request.post(baseURL + "/.netlify/functions/analyze-vacancy", { data: { text }, headers: { Cookie: "jd_mock=ok" } });
      const body = await res.json();
      expect.soft(body.title, "title for " + JSON.stringify(text.slice(0, 2))).toBeUndefined();
      expect.soft(body.error, "error for " + JSON.stringify(text.slice(0, 2))).toBeTruthy();
    }
    await openApp(page);
    await openWindow(page, "vacancies");
    const win = page.locator("#win-vacancies");
    await win.locator("#btn-paste").click();
    await win.locator("#a-paste").fill("​".repeat(45));
    const answered = page.waitForResponse((r) => r.url().endsWith("/analyze-vacancy"));
    await win.locator("#a-paste-go").click();
    await answered;
    await expect(win.locator("#a-paste-go")).toBeEnabled();
    await expect(win.locator(".jobcard")).toHaveCount(0);
  });

  test("markup and scripts in a pasted vacancy show as text", async ({ page }) => {
    await openApp(page);
    await openWindow(page, "vacancies");
    const win = page.locator("#win-vacancies");
    await win.locator("#btn-paste").click();
    // the mock takes the first three words as the title
    const title = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
    await win.locator("#a-paste").fill(title + " шукає дизайнера, повна зайнятість, віддалено, 2000$");
    await win.locator("#a-paste-go").click();
    await expect(win.locator("#add-url-msg")).toHaveText("Додано: Mock Studio ✦");
    await expect(win.locator(".jobcard .jt")).toHaveText(title);
    expect(await win.locator(".jobcard img, .jobcard script").count()).toBe(0);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });
});

/* ----- the AI refill of the edit dialog ----- */

test.describe("AI refill in the edit dialog", () => {
  test("closing the dialog mid-analysis: the next dialog's AI button works and its fields stay untouched", async ({ page, context, baseURL }) => {
    await seedVacancies(page);
    await setMock(context, "slow", baseURL);
    await openApp(page);
    await openWindow(page, "vacancies");
    const win = page.locator("#win-vacancies");
    const dialog = page.locator("#edit-overlay");
    await win.locator(".jobcard", { hasText: "Acme Studio" }).locator(".jedit").click();
    await dialog.locator("#ev-paste").fill(OTHER_TEXT);
    const late = page.waitForResponse((r) => r.url().endsWith("/analyze-vacancy"), { timeout: SLOW_WAIT });
    await dialog.locator("#ev-analyze").click();
    await expect(dialog.locator("#ev-msg")).toHaveText("Фея аналізує ✦...");
    await page.keyboard.press("Escape");
    await expect(dialog).not.toHaveClass(/open/);

    await win.locator(".jobcard", { hasText: "Пікселька" }).locator(".jedit").click();
    await expect(dialog.locator("#ev-title")).toHaveValue("UI/UX дизайнерка");
    await expect.soft(dialog.locator("#ev-analyze"), "the refill button of the new dialog").toBeEnabled({ timeout: 1500 });
    await late;
    await page.waitForTimeout(300);
    await expect(dialog.locator("#ev-title")).toHaveValue("UI/UX дизайнерка");
    await expect(dialog.locator("#ev-company")).toHaveValue("Пікселька");
    await expect(dialog.locator("#ev-msg")).toHaveText("");
    await expect(dialog.locator("#ev-analyze")).toBeEnabled();
  });

  test("busy, empty and truncated answers end with a message, an enabled button and the fields as they were", async ({ page, context, baseURL }) => {
    await seedVacancies(page);
    await openApp(page);
    await openWindow(page, "vacancies");
    const dialog = page.locator("#edit-overlay");
    const cases = [
      ["busy", "Не вдалося ✦ Сервіс зараз зайнятий ✦ спробуй ще раз за хвилину."],
      ["empty", "Не вдалося ✦ Не вдалося розібрати вакансію"],
      ["truncated", "Не вдалося ✦ Не вдалося розібрати вакансію"],
    ];
    for (const [mode, message] of cases) {
      await setMock(context, mode, baseURL);
      await page.locator(".jobcard", { hasText: "Acme Studio" }).locator(".jedit").click();
      await dialog.locator("#ev-paste").fill(OTHER_TEXT);
      await dialog.locator("#ev-analyze").click();
      await expect(dialog.locator("#ev-msg"), mode).toHaveText(message);
      await expect(dialog.locator("#ev-analyze"), mode).toBeEnabled();
      await expect(dialog.locator("#ev-title"), mode).toHaveValue("Senior Graphic Designer");
      await expect(dialog.locator("#ev-company"), mode).toHaveValue("Acme Studio");
      await page.keyboard.press("Escape");
      await expect(dialog).not.toHaveClass(/open/);
    }
  });
});

/* ----- the CV and the cover letter chat ----- */

async function openMessenger(page, testInfo, extra = {}) {
  await seedVacancies(page, extra);
  await openApp(page);
  await register(page, { name: "Олена", email: freshEmail(testInfo, "ai") });
  await openWindow(page, "messenger");
  const win = page.locator("#win-messenger");
  await expect(win).toHaveClass(/open/);
  return win;
}

async function pasteCV(win, text = CV_TEXT) {
  await win.locator("#cv-paste-toggle").click();
  await win.locator("#cv-paste").fill(text);
  await win.locator("#cv-paste-save").click();
  await expect(win.locator("#cv-txt")).toContainText("Резюме завантажено ✦");
}

async function messengerWithCV(page, testInfo, extra) {
  const win = await openMessenger(page, testInfo, extra);
  await pasteCV(win);
  return win;
}

const letters = (win) => win.locator(".chat-letter");
const lastFairyLine = (win) => win.locator(".chat-msg.fairy").last();

async function send(win, text) {
  await win.locator("#cl-edit").fill(text);
  await win.locator("#cl-edit").press("Enter");
}

test.describe("cover letters", () => {
  test("busy to the end: once the automatic retries are used up, the fairy does not promise another one", async ({ page, context, baseURL }, testInfo) => {
    const win = await messengerWithCV(page, testInfo);
    const calls = recordCalls(page, "cover-letter");
    await setMock(context, "busy", baseURL);
    await win.locator("#cl-gen").click();
    await expect(win.locator("#cl-status")).toContainText("автоматично пробую ще раз");
    await expect(win.locator("#cl-gen")).toBeEnabled({ timeout: BUSY_RETRIES_WAIT });
    expect(calls).toHaveLength(3);
    await expect(win.locator("#cl-status")).toHaveText(/^✕ /);
    await expect.soft(win.locator("#cl-status")).not.toContainText("пробую ще раз автоматично");
    await expect.soft(lastFairyLine(win)).not.toContainText("пробую ще раз автоматично");
  });

  test("a wish typed before the first letter reaches the fairy instead of being dropped", async ({ page }, testInfo) => {
    const win = await messengerWithCV(page, testInfo);
    const calls = recordCalls(page, "cover-letter");
    await send(win, "напиши англійською й згадай Figma");
    await expect(win.locator(".chat-msg.me")).toHaveText(["напиши англійською й згадай Figma"]);
    await expect(letters(win)).toHaveCount(1);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).toContain("напиши англійською й згадай Figma");
  });

  test("a CV removed after the letter is not sent with the next revision", async ({ page }, testInfo) => {
    const win = await messengerWithCV(page, testInfo);
    const calls = recordCalls(page, "cover-letter");
    await win.locator("#cl-gen").click();
    await expect(letters(win)).toHaveCount(1);
    await win.locator("#cv-remove").click();
    await expect(win.locator("#cv-txt")).toContainText("Резюме не завантажено.");
    expect(await storedCV(page)).toBeNull();
    await send(win, "зроби коротшим");
    await page.waitForTimeout(1500);
    await expect(win.locator("#cl-gen")).toBeEnabled();
    const withRemovedCV = calls.slice(1).filter((c) => String(c.cv || "").includes("Олена Тестенко"));
    expect(withRemovedCV, "requests sent after the CV was removed that still carry it").toEqual([]);
  });

  test("switching the vacancy while a letter is written: the letter, the reply and the revision stay with the first vacancy", async ({ page, context, baseURL }, testInfo) => {
    const win = await messengerWithCV(page, testInfo);
    await win.locator("#cl-job").selectOption(ACME);
    await setMock(context, "slow", baseURL);
    await win.locator("#cl-gen").click();
    await expect(win.locator("#cl-status")).toHaveText("Фея пише ✦...");
    await win.locator("#cl-job").selectOption(LABEL);
    await expect(letters(win)).toHaveCount(1, { timeout: SLOW_WAIT });
    await expect(letters(win).first()).toContainText("Шановна командо Acme Studio!");
    await expect(lastFairyLine(win)).toHaveText("Ось твій лист під Acme Studio ✦ Напиши, що підправити 👇");
    await expect(win.locator("#cl-status")).toHaveText("Готово ✦");
    await expect(win.locator("#cl-job")).toHaveValue(LABEL);

    await setMock(context, "ok", baseURL);
    await send(win, "коротше");
    await expect(letters(win)).toHaveCount(2);
    await expect(letters(win).last()).toContainText("Шановна командо Acme Studio!");
    await expect(letters(win).last()).toContainText("Оновлено за правкою: «коротше»");
    await expect(win.locator("#cl-status")).toHaveText("Оновлено ✦");
  });

  test("double clicks and Enter spam start one letter and one revision", async ({ page, context, baseURL }, testInfo) => {
    const win = await messengerWithCV(page, testInfo);
    const calls = recordCalls(page, "cover-letter");
    await setMock(context, "slow", baseURL);
    await win.locator("#cl-gen").dblclick();
    await win.locator("#cl-edit").fill("зроби коротшим");
    for (let i = 0; i < 4; i++) await win.locator("#cl-edit").press("Enter");
    await expect(win.locator("#cl-edit")).toHaveValue("зроби коротшим"); // nothing is taken while she writes
    await expect(letters(win)).toHaveCount(1, { timeout: SLOW_WAIT });
    expect(calls).toHaveLength(1);
    for (let i = 0; i < 4; i++) await win.locator("#cl-edit").press("Enter");
    await expect(letters(win)).toHaveCount(2, { timeout: SLOW_WAIT });
    await page.waitForTimeout(500);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ action: "revise", request: "зроби коротшим" });
    await expect(win.locator(".chat-msg.me")).toHaveCount(1);
  });

  test("closing the messenger mid-letter: the letter is there when it opens again", async ({ page, context, baseURL }, testInfo) => {
    const win = await messengerWithCV(page, testInfo);
    await setMock(context, "slow", baseURL);
    await win.locator("#cl-gen").click();
    await expect(win.locator("#cl-status")).toHaveText("Фея пише ✦...");
    const answered = page.waitForResponse((r) => r.url().endsWith("/cover-letter"), { timeout: SLOW_WAIT });
    await closeWindow(page, "messenger");
    await expect(win).not.toHaveClass(/open/);
    await answered;
    await openWindow(page, "messenger");
    await expect(letters(win)).toHaveCount(1);
    await expect(win.locator("#cl-status")).toHaveText("Готово ✦");
    await expect(win.locator("#cl-gen")).toBeEnabled();
  });

  test("empty and truncated answers: a clear message, or a letter cut at a full sentence and signed", async ({ page, context, baseURL }, testInfo) => {
    const win = await messengerWithCV(page, testInfo);
    await setMock(context, "empty", baseURL);
    await win.locator("#cl-gen").click();
    await expect(lastFairyLine(win)).toHaveText("Ой ✦ Порожня відповідь (можливо, спрацював фільтр безпеки)");
    await expect(win.locator("#cl-status")).toHaveText("✕ Порожня відповідь (можливо, спрацював фільтр безпеки)");
    await expect(win.locator("#cl-gen")).toBeEnabled();

    await setMock(context, "truncated", baseURL);
    await win.locator("#cl-gen").click();
    await expect(letters(win)).toHaveCount(1);
    expect(await letters(win).last().textContent()).toMatch(/[.!?]\n\nЗ повагою,\nОлена$/);
    await send(win, "коротше");
    await expect(letters(win)).toHaveCount(2);
    expect(await letters(win).last().textContent()).toMatch(/[.!?]\n\nЗ повагою,\nОлена$/);
    await win.locator("#cl-lang").selectOption("English");
    await win.locator("#cl-gen").click();
    await expect(letters(win)).toHaveCount(3);
    expect(await letters(win).last().textContent()).toMatch(/[.!?]\n\nKind regards,\nОлена$/);
    await expect(win.locator("#cl-status")).toHaveText("Готово ✦");
  });

  test("markup in a vacancy, a revision request and the letters shows as text", async ({ page }, testInfo) => {
    const evil = { prio: "Податися", company: '<img src=x onerror="window.__xss=1">', title: "<script>window.__xss=2</script>Designer", field: "—", emp: "—", loc: "—", salary: "—", url: "#" };
    const win = await messengerWithCV(page, testInfo, { jobdesk2000_added_v1: [evil] });
    await expect(win.locator("#cl-job option")).toHaveText(['[Податися] <img src=x onerror="window.__xss=1"> — <script>window.__xss=2</script>Designer']);
    await win.locator("#cl-gen").click();
    await expect(letters(win)).toHaveCount(1);
    await expect(letters(win).first()).toContainText('Шановна командо <img src=x onerror="window.__xss=1">!');
    await send(win, '<b>жирніше</b><img src=x onerror="window.__xss=3">');
    await expect(win.locator(".chat-msg.me .b").last()).toHaveText('<b>жирніше</b><img src=x onerror="window.__xss=3">');
    await expect(letters(win)).toHaveCount(2);
    expect(await win.locator("#cl-out img, #cl-out script, #cl-out b:not(.cv-ok)").count()).toBe(0);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });

  test("a long link in a revision request stays inside its chat bubble", async ({ page }, testInfo) => {
    const win = await messengerWithCV(page, testInfo);
    await win.locator("#cl-gen").click();
    await expect(letters(win)).toHaveCount(1);
    await send(win, "додай посилання на портфоліо https://www.behance.net/gallery/187654321/Brand-Identity-for-Label-Records-Music-Festival-2026-Kyiv");
    await expect(letters(win)).toHaveCount(2);
    const spill = await page.evaluate(() => [...document.querySelectorAll("#cl-out .chat-msg .b")]
      .filter((b) => b.scrollWidth > b.clientWidth + 1)
      .map((b) => `${b.scrollWidth} > ${b.clientWidth}: ${b.textContent.slice(0, 40)}`));
    expect.soft(spill, "chat bubbles whose text runs out of them").toEqual([]);
    const sideways = await page.evaluate(() => { const o = document.getElementById("cl-out"); return o.scrollWidth - o.clientWidth; });
    expect.soft(sideways, "the chat scrolls sideways by").toBeLessThanOrEqual(1);
    expect(await layoutProblems(page, { touch: testInfo.project.name.includes("iphone") })).toEqual([]);
  });

  test("the busy countdown keeps a selection in an earlier letter and the reader's scroll position", async ({ page, context, baseURL }, testInfo) => {
    const win = await messengerWithCV(page, testInfo);
    await win.locator("#cl-gen").click();
    await expect(letters(win)).toHaveCount(1);
    await win.locator("#cl-gen").click();
    await expect(letters(win)).toHaveCount(2);
    await setMock(context, "busy", baseURL);
    await win.locator("#cl-gen").click();
    await expect(win.locator("#cl-status")).toContainText("автоматично пробую ще раз");
    // the reader scrolls up and selects the first letter to copy a paragraph from it
    const picked = await page.evaluate(() => {
      const out = document.getElementById("cl-out");
      out.style.scrollBehavior = "auto";
      out.scrollTop = 0;
      const range = document.createRange();
      range.selectNodeContents(out.querySelector(".chat-letter"));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return getSelection().toString().length;
    });
    expect(picked).toBeGreaterThan(100);
    await page.waitForTimeout(2500); // two ticks of the countdown
    const after = await page.evaluate(() => ({ selected: getSelection().toString().length, top: document.getElementById("cl-out").scrollTop }));
    expect.soft(after.selected, "characters still selected").toBe(picked);
    expect.soft(after.top, "scroll position of the chat").toBeLessThan(40);
    await expect(win.locator("#cl-gen")).toBeEnabled({ timeout: BUSY_RETRIES_WAIT });
  });

  test("a session that ended meanwhile: the fairy asks to sign in again and nothing stays busy", async ({ page }, testInfo) => {
    const win = await messengerWithCV(page, testInfo);
    await page.route("**/.netlify/functions/cover-letter", (route) => {
      const headers = { ...route.request().headers() };
      delete headers.authorization;
      return route.continue({ headers });
    });
    await win.locator("#cl-gen").click();
    await expect(lastFairyLine(win)).toHaveText("Ой ✦ Сесія завершилась ✦ увійди ще раз, щоб фея писала листи");
    await expect(page.locator("#auth-overlay")).toHaveClass(/open/);
    await expect(win.locator("#cl-gen")).toBeEnabled();
    await expect(win.locator("#cl-status")).toHaveText("✕ Сесія завершилась ✦ увійди ще раз, щоб фея писала листи");
  });

  test("signing out while a letter is written ends in a clean guest desktop", async ({ page, context, baseURL }, testInfo) => {
    const win = await messengerWithCV(page, testInfo);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await setMock(context, "slow", baseURL);
    await win.locator("#cl-gen").click();
    await expect(win.locator("#cl-status")).toHaveText("Фея пише ✦...");
    await signOut(page);
    await expect(page.locator("#win-messenger")).not.toHaveClass(/open/);
    await page.locator('.d-icon[data-open="messenger"]').click();
    await expect(page.locator("#gate-overlay")).toHaveClass(/open/);
    expect(errors).toEqual([]);
  });

  test("a 60 000-character vacancy text and CV still give a vacancy and a letter", async ({ page }, testInfo) => {
    const win = await openMessenger(page, testInfo);
    const longCV = CV_TEXT + " " + "Проєкт: айдентика, упаковка, вебдизайн, моушн. ".repeat(1200);
    await pasteCV(win, longCV.slice(0, 60_000));
    await expect(win.locator("#cv-txt")).toContainText("слів");
    await openWindow(page, "vacancies");
    await page.locator("#btn-paste").click();
    await page.locator("#a-paste").fill(OTHER_TEXT + " " + "Обовʼязки: макети, презентації, анімація. ".repeat(1400));
    await page.locator("#a-paste-go").click();
    await expect(page.locator("#add-url-msg")).toHaveText("Додано: Mock Studio ✦");
    await openWindow(page, "messenger");
    await win.locator("#cl-job").selectOption({ label: "[Податися] Mock Studio — Beta Records шукає" });
    await win.locator("#cl-gen").click();
    await expect(letters(win)).toHaveCount(1);
    await expect(letters(win).first()).toContainText("Шановна командо Mock Studio!");
  });

  test("the profession analysis when the AI is busy: the fairy falls back to her own guess", async ({ page, context, baseURL }, testInfo) => {
    const win = await openMessenger(page, testInfo);
    await setMock(context, "busy", baseURL);
    await pasteCV(win);
    await expect(page.locator("#clippy-say")).toContainText("Резюме завантажено ✦ обери вакансію!");
  });
});

/* ----- the CV as a PDF ----- */

test.describe("CV from a PDF", () => {
  // readPdf() clears the file input once it is done with a file
  const readDone = (win) => expect.poll(() => win.locator("#cv-file").evaluate((el) => el.files.length), { timeout: 30_000 }).toBe(0);

  test("not a PDF, an empty file and a scan each end with their note, a text PDF loads", async ({ page }, testInfo) => {
    const win = await openMessenger(page, testInfo);
    const file = win.locator("#cv-file");
    await file.setInputFiles({ name: "photo.pdf", mimeType: "application/pdf", buffer: PNG_BYTES });
    await readDone(win);
    await expect(win.locator("#cv-txt")).toHaveText("Помилка PDF.");
    await file.setInputFiles({ name: "empty.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(0) });
    await readDone(win);
    await expect(win.locator("#cv-txt")).toHaveText("Помилка PDF.");
    await file.setInputFiles({ name: "scan.pdf", mimeType: "application/pdf", buffer: makePdf(["", ""]) });
    await readDone(win);
    await expect(win.locator("#cv-txt")).toHaveText("Не зчиталось. Схоже, це скан.");
    expect(await storedCV(page)).toBeNull();
    await file.setInputFiles(textPdf());
    await readDone(win);
    await expect(win.locator("#cv-txt")).toContainText("Резюме завантажено ✦");
    expect(await storedCV(page)).toBe(PDF_CV);
  });

  test("a pdf.js download that stalls does not leave 'Читаю резюме...' forever, and the next PDF still loads", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const win = await openMessenger(page, testInfo);
    await page.route("**/ajax/libs/pdf.js/**", () => { /* a stalled CDN connection: no answer at all */ });
    await win.locator("#cv-file").setInputFiles(textPdf());
    await expect(win.locator("#cv-txt")).toHaveText("Читаю резюме...");
    await expect.soft(win.locator("#cv-txt"), "the note one minute later").not.toHaveText("Читаю резюме...", { timeout: 60_000 });
    await page.unroute("**/ajax/libs/pdf.js/**");
    await win.locator("#cv-file").setInputFiles(textPdf());
    await expect(win.locator("#cv-txt")).toContainText("Резюме завантажено ✦", { timeout: 30_000 });
  });

  test("a CV pasted while a PDF is still being read is not replaced by the PDF afterwards", async ({ page }, testInfo) => {
    const win = await openMessenger(page, testInfo);
    // a slow connection: pdf.js takes a few seconds to arrive on its first use
    await page.route("**/ajax/libs/pdf.js/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      await route.continue();
    });
    await win.locator("#cv-file").setInputFiles(textPdf());
    await expect(win.locator("#cv-txt")).toHaveText("Читаю резюме...");
    await pasteCV(win);
    expect(await storedCV(page)).toBe(CV_TEXT);
    await readDone(win);
    await page.waitForTimeout(300);
    expect(await storedCV(page)).toBe(CV_TEXT);
    await expect(win.locator("#cv-txt")).toContainText("Резюме завантажено ✦");
  });
});
