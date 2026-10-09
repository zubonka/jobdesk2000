const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const { SITE, claims, signToken, json, geminiReply, groqReply, overloaded, stubFetch, geminiPrompt, event, bodyOf } = require("./helpers");

// The handler takes fetchPage when it loads, so the stub must be in place before the require.
const page = require("../../netlify/lib/page");
const fetchPage = mock.method(page, "fetchPage", async () => { throw new Error("no page stubbed"); });
const { handler } = require("../../netlify/functions/analyze-vacancy");

const BUSY = "Сервіс зараз зайнятий ✦ спробуй ще раз за хвилину.";
const VACANCY = "Шукаємо Senior Product Designer 🎨 у студію Acme. Повна зайнятість, віддалено, зарплата від 2000$.";
// uk-UA groups thousands with a no-break space
const SALARY = "50\u00a0000–70\u00a0000 UAH / міс";
const CV = "Олена Коваль, продуктова дизайнерка. 6 років у брендингу та UX, Figma, дизайн-системи, ілюстрація.";

const servePage = (html) => fetchPage.mock.mockImplementation(async (url) => ({ html, url }));
const post = (body, extra) => handler(event({ body, ...extra }));
const answer = (data) => () => geminiReply(JSON.stringify(data));

const JOB_PAGE = "<html><head><title>Acme</title>" +
  '<script type="application/ld+json">' + JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [{ "@type": "WebPage", name: "Vacancy" }, {
      "@type": "JobPosting",
      title: "Senior Product Designer",
      hiringOrganization: { "@type": "Organization", name: "Acme &amp; Co" },
      baseSalary: { "@type": "MonetaryAmount", currency: "UAH", value: { "@type": "QuantitativeValue", minValue: 50000, maxValue: 70000, unitText: "MONTH" } },
      employmentType: "FULL_TIME",
      jobLocationType: "TELECOMMUTE",
      industry: "Design",
      description: "&lt;p&gt;Design systems and Figma&lt;/p&gt;",
    }],
  }) + "</script></head><body><nav>menu</nav></body></html>";

test("OPTIONS from an allowed origin: 204 with the origin echoed", async () => {
  for (const origin of [SITE, "https://deploy-preview-7--jobdeck2000.netlify.app", "http://localhost:8888"]) {
    const res = await handler(event({ method: "OPTIONS", origin }));
    assert.equal(res.statusCode, 204);
    assert.equal(res.body, "");
    assert.equal(res.headers["Access-Control-Allow-Origin"], origin);
    assert.equal(res.headers["Access-Control-Allow-Methods"], "POST, OPTIONS");
  }
});

test("a foreign Origin gets 403 and costs no AI call", async () => {
  const calls = stubFetch({ gemini: answer({}) });
  const res = await post({ text: VACANCY }, { origin: "https://evil.example" });
  assert.equal(res.statusCode, 403);
  assert.equal(res.headers["Access-Control-Allow-Origin"], undefined);
  assert.equal(calls.length, 0);
});

test("other methods get 405, broken JSON gets 400", async () => {
  assert.equal((await handler(event({ method: "GET" }))).statusCode, 405);
  const res = await post("{not json");
  assert.equal(res.statusCode, 400);
  assert.deepEqual(bodyOf(res), { error: "Некоректний запит" });
});

test("no text and no link: 400", async () => {
  for (const body of [{}, { text: "short" }, { url: "ftp://example.com/job" }, { url: "example.com/job" }]) {
    const res = await post(body);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(bodyOf(res), { error: "Дай посилання або встав текст вакансії" });
  }
});

test("pasted text: the model's answer is normalised for the tracker", async () => {
  const calls = stubFetch({ gemini: answer({ company: "Acme", title: "Senior Product Designer", field: "Дизайн", emp: "full time", loc: "remote", salary: "null" }) });
  const pageFetches = fetchPage.mock.callCount();
  const res = await post({ text: VACANCY });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(bodyOf(res), { company: "Acme", title: "Senior Product Designer", field: "Дизайн", emp: "Full-time", loc: "Віддалено", salary: "—" });

  const prompt = geminiPrompt(calls[0]);
  assert.match(prompt, /<vacancy>\nШукаємо Senior Product Designer у студію Acme\. Повна зайнятість/, "emoji stripped, whitespace flattened");
  assert.ok(prompt.endsWith("\n</vacancy>"));
  assert.match(calls[0].body.systemInstruction.parts[0].text, /^Ти — уважний помічник/);
  assert.equal(calls[0].body.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(calls[0].body.generationConfig.responseSchema.properties.loc.enum, ["Віддалено", "Гібрид", "Офіс", "—"]);
  assert.equal(fetchPage.mock.callCount(), pageFetches, "pasted text needs no page");
});

test("an incomplete model answer falls back to tracker defaults", async () => {
  stubFetch({ gemini: answer({ company: "", title: "", emp: "contract", loc: "в офісі" }) });
  assert.deepEqual(bodyOf(await post({ text: VACANCY })), { company: "—", title: "Вакансія", field: "—", emp: "Project / Контракт", loc: "Офіс", salary: "—" });
});

test("busy engines: the original wording and retry", async () => {
  stubFetch({ gemini: () => overloaded(), groq: () => json(429, {}) });
  assert.deepEqual(bodyOf(await post({ text: VACANCY })), { error: BUSY, retry: true });
});

test("an answer that is not JSON: the original failure text", async () => {
  stubFetch({ gemini: () => geminiReply("Sorry, I cannot help"), groq: () => groqReply("") });
  assert.deepEqual(bodyOf(await post({ text: VACANCY })), { error: "Не вдалося розібрати вакансію" });
});

test("no API keys: the original configuration error", async (t) => {
  const saved = { GEMINI_API_KEY: process.env.GEMINI_API_KEY, GROQ_API_KEY: process.env.GROQ_API_KEY };
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY;
  t.after(() => Object.assign(process.env, saved));
  const res = await post({ text: VACANCY });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(bodyOf(res), { error: "Не налаштовано ключ (GEMINI_API_KEY або GROQ_API_KEY)" });
});

test("a page that cannot be fetched: 502 with page flag and no upstream details", async () => {
  fetchPage.mock.mockImplementation(async () => { throw new page.FetchError("status 403"); });
  const calls = stubFetch({});
  const res = await post({ url: "https://jobs.example.com/1" });
  assert.equal(res.statusCode, 502);
  assert.deepEqual(bodyOf(res), { error: "Не вдалося завантажити сторінку (сайт міг заблокувати)", page: true });
  assert.equal(calls.length, 0);
});

test("a page with almost no text and no JobPosting: 422", async () => {
  servePage("<html><body><a>Login</a></body></html>");
  const res = await post({ url: "https://jobs.example.com/2" });
  assert.equal(res.statusCode, 422);
  assert.deepEqual(bodyOf(res), { error: "Замало тексту на сторінці (потрібен логін?)", page: true });
});

test("a plain page: the model reads meta tags and the <main> text, not the menu", async () => {
  servePage("<html><head><title>Designer &amp; Co</title><meta name=\"description\" content=\"Шукаємо дизайнера\"></head>" +
    "<body><nav>Головна Вакансії Увійти</nav><main><h1>Designer</h1><p>Офіс у Києві, повна зайнятість, досвід Figma понад три роки.</p></main></body></html>");
  const calls = stubFetch({ gemini: answer({ company: "Acme", title: "Designer", field: "Дизайн", emp: "Full-time", loc: "Офіс", salary: "—" }) });
  const res = await post({ url: "https://jobs.example.com/3" });
  assert.equal(bodyOf(res).loc, "Офіс");
  const prompt = geminiPrompt(calls[0]);
  assert.match(prompt, /<vacancy>\nDesigner & Co\nШукаємо дизайнера\nDesigner\nОфіс у Києві/);
  assert.doesNotMatch(prompt, /Увійти/);
  assert.equal(fetchPage.mock.calls.at(-1).arguments[0], "https://jobs.example.com/3");
});

test("a JobPosting page: the model gets its fields and gaps are filled from it", async () => {
  servePage(JOB_PAGE);
  const calls = stubFetch({ gemini: answer({ company: "—", title: "Product Designer", field: "", emp: "—", loc: "—", salary: "—" }) });
  const res = await post({ url: "https://jobs.example.com/4" });
  assert.deepEqual(bodyOf(res), { company: "Acme & Co", title: "Product Designer", field: "Design", emp: "Full-time", loc: "Віддалено", salary: SALARY });
  assert.equal(geminiPrompt(calls[0]).split("<vacancy>\n")[1],
    "Посада: Senior Product Designer\nКомпанія: Acme & Co\nЗарплата: " + SALARY + "\nЗайнятість: Full-time\n" +
    "Локація: віддалено \nГалузь: Design\nОпис: Design systems and Figma\n</vacancy>");
});

test("all engines down and a JobPosting page: the fields come from JSON-LD alone", async () => {
  servePage(JOB_PAGE);
  stubFetch({ gemini: () => overloaded(), groq: () => overloaded() });
  const res = await post({ url: "https://jobs.example.com/5" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(bodyOf(res), { company: "Acme & Co", title: "Senior Product Designer", field: "Design", emp: "Full-time", loc: "Віддалено", salary: SALARY });
});

test("profile without a token: 401 with the auth flag and no AI call", async () => {
  const calls = stubFetch({ gemini: answer({}) });
  const res = await post({ mode: "profile", cv: CV });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(bodyOf(res), { error: "Увійди, щоб фея проаналізувала профіль ✦", auth: true });
  assert.equal(calls.filter((c) => c.engine !== "certs").length, 0);
});

test("profile with an invalid or foreign token: 401", async () => {
  stubFetch({});
  for (const token of ["not.a.token", signToken(claims({ aud: "someone-else" })), signToken(claims({ exp: 1 }))]) {
    assert.equal((await post({ mode: "profile", cv: CV }, { token })).statusCode, 401);
  }
});

test("profile with a valid token: role, summary and at most four non-empty phrases", async () => {
  const calls = stubFetch({ gemini: answer({ role: "продуктова дизайнерка", summary: "Робить зручні інтерфейси", phrases: ["Твої макети сяють ✦", "", "Фігма тебе любить ✦", "3", "4", "5"] }) });
  const res = await post({ mode: "profile", cv: CV }, { token: signToken() });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(bodyOf(res), { role: "продуктова дизайнерка", summary: "Робить зручні інтерфейси", phrases: ["Твої макети сяють ✦", "Фігма тебе любить ✦", "3"] });
  const gemini = calls.find((c) => c.engine === "gemini");
  assert.ok(geminiPrompt(gemini).endsWith("<cv>\n" + CV + "\n</cv>"));
  assert.deepEqual(gemini.body.generationConfig.responseSchema.required, ["role", "phrases"]);
});

test("profile: too little text, busy engines, an answer without role or phrases", async () => {
  const token = signToken();
  stubFetch({ gemini: answer({}) });
  assert.deepEqual(bodyOf(await post({ mode: "profile", cv: "коротко" }, { token })), { error: "замало тексту" });
  assert.deepEqual(bodyOf(await post({ mode: "profile", cv: CV }, { token })), { error: "Не вдалося визначити фах" });
  stubFetch({ gemini: () => overloaded(), groq: () => overloaded() });
  assert.deepEqual(bodyOf(await post({ mode: "profile", text: CV }, { token })), { error: BUSY, retry: true });
});
