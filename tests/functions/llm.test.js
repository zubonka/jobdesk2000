const { test } = require("node:test");
const assert = require("node:assert/strict");
const { json, geminiReply, groqReply, overloaded, stubFetch, freshRequire } = require("./helpers");
const { MODELS, thinkingFor, generate, AIError, parseJSONLoose } = require("../../netlify/lib/llm");

const SCHEMA = { type: "OBJECT", properties: { role: { type: "STRING" } }, required: ["role"] };
const ask = (extra) => generate({ kind: "fast", system: "SYSTEM TEXT", user: "USER TEXT", ...extra });

async function failure(promise) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof AIError, String(err));
    return err.reason;
  }
  assert.fail("generate should have thrown");
}

function withKeys(t, keys) {
  const saved = { GEMINI_API_KEY: process.env.GEMINI_API_KEY, GROQ_API_KEY: process.env.GROQ_API_KEY };
  for (const [name, value] of Object.entries(keys)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  t.after(() => Object.assign(process.env, saved));
}

test("thinkingFor picks the switch each model family accepts", () => {
  assert.deepEqual(thinkingFor("gemini-2.5-flash"), { thinkingBudget: 0 });
  assert.deepEqual(thinkingFor("gemini-2.5-flash-lite"), { thinkingBudget: 0 });
  assert.deepEqual(thinkingFor("gemini-3.5-flash-lite"), { thinkingLevel: "minimal" });
  assert.deepEqual(thinkingFor("gemini-3-flash-lite"), { thinkingLevel: "minimal" });
  assert.deepEqual(thinkingFor("gemini-3.5-flash"), { thinkingLevel: "low" });
  assert.deepEqual(thinkingFor("gemini-3-pro"), { thinkingLevel: "low" });
  assert.equal(thinkingFor("gemini-2.5-pro"), null);
  assert.equal(thinkingFor("gemini-flash-latest"), null);
  assert.equal(thinkingFor("gemini-2.0-flash"), null);
});

test("model lists can be overridden from the environment", (t) => {
  process.env.GEMINI_MODELS_FAST = " gemini-a , ,gemini-b ";
  t.after(() => { delete process.env.GEMINI_MODELS_FAST; });
  const fresh = freshRequire("lib/llm");
  assert.deepEqual(fresh.MODELS.fast, ["gemini-a", "gemini-b"]);
  assert.deepEqual(fresh.MODELS.write, MODELS.write);
});

test("the first Gemini model that answers wins", async () => {
  const calls = stubFetch({ gemini: () => geminiReply("Hello") });
  assert.deepEqual(await ask(), { text: "Hello", model: MODELS.fast[0], truncated: false });
  assert.equal(calls.length, 1);
});

test("Gemini 503 moves on to the next model", async () => {
  const calls = stubFetch({ gemini: (model) => (model === MODELS.fast[0] ? overloaded() : geminiReply("from second")) });
  const r = await ask();
  assert.equal(r.text, "from second");
  assert.equal(r.model, MODELS.fast[1]);
  assert.deepEqual(calls.map((c) => c.model), MODELS.fast.slice(0, 2));
});

test("when every Gemini model fails, Groq answers", async () => {
  const calls = stubFetch({ gemini: () => overloaded(), groq: () => groqReply("from groq") });
  const r = await ask({ kind: "write" });
  assert.deepEqual(r, { text: "from groq", model: "groq:llama-3.3-70b-versatile", truncated: false });
  assert.deepEqual(calls.map((c) => c.engine + ":" + c.model), [...MODELS.write.map((m) => "gemini:" + m), "groq:llama-3.3-70b-versatile"]);
});

test("Gemini request: key in a header, system instruction, thinking config, sampling settings", async () => {
  const calls = stubFetch({ gemini: () => geminiReply("ok") });
  await ask({ maxTokens: 333, temperature: 0.9 });
  const { url, headers, body } = calls[0];
  assert.equal(headers["x-goog-api-key"], "test-gemini-key");
  assert.ok(!url.includes("key="), "the API key must never be in the URL");
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "SYSTEM TEXT" }] });
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "USER TEXT" }] }]);
  assert.deepEqual(body.generationConfig, { temperature: 0.9, maxOutputTokens: 333, thinkingConfig: thinkingFor(MODELS.fast[0]) });
});

test("Gemini request defaults and no systemInstruction without a system text", async () => {
  const calls = stubFetch({ gemini: () => geminiReply("ok") });
  await generate({ user: "only user" });
  assert.equal(calls[0].model, MODELS.fast[0]);
  assert.equal("systemInstruction" in calls[0].body, false);
  assert.equal(calls[0].body.generationConfig.temperature, 0.4);
  assert.equal(calls[0].body.generationConfig.maxOutputTokens, 1024);
});

test("a schema turns on JSON mode for Gemini and for Groq", async () => {
  const calls = stubFetch({ gemini: () => overloaded(), groq: () => groqReply('{"role":"x"}') });
  await ask({ schema: SCHEMA });
  const gemini = calls.find((c) => c.engine === "gemini").body.generationConfig;
  assert.equal(gemini.responseMimeType, "application/json");
  assert.deepEqual(gemini.responseSchema, SCHEMA);
  const groq = calls.find((c) => c.engine === "groq");
  assert.equal(groq.headers.Authorization, "Bearer test-groq-key");
  assert.deepEqual(groq.body.response_format, { type: "json_object" });
  assert.deepEqual(groq.body.messages, [
    { role: "system", content: "SYSTEM TEXT" },
    { role: "user", content: "USER TEXT\n\nПоверни ВИКЛЮЧНО валідний JSON-обʼєкт." },
  ]);
});

test("without a schema there is no JSON mode", async () => {
  const calls = stubFetch({ gemini: () => overloaded(), groq: () => groqReply("text") });
  await ask();
  assert.equal("responseMimeType" in calls[0].body.generationConfig, false);
  const groq = calls.find((c) => c.engine === "groq").body;
  assert.equal("response_format" in groq, false);
  assert.equal(groq.messages[1].content, "USER TEXT");
});

test("thought parts are not part of the answer", async () => {
  stubFetch({ gemini: () => json(200, { candidates: [{ content: { parts: [{ thought: true, text: "thinking..." }, { text: " answer " }] }, finishReason: "STOP" }] }) });
  assert.equal((await ask()).text, "answer");
});

test("a cut-off answer is flagged as truncated", async () => {
  stubFetch({ gemini: () => geminiReply("partial", "MAX_TOKENS") });
  assert.equal((await ask()).truncated, true);
  stubFetch({ gemini: () => overloaded(), groq: () => groqReply("partial", "length") });
  assert.equal((await ask()).truncated, true);
});

test("an empty Gemini answer moves on to the next model", async () => {
  const calls = stubFetch({ gemini: (model) => (model === MODELS.fast[0] ? geminiReply("", "SAFETY") : geminiReply("second")) });
  assert.equal((await ask()).text, "second");
  assert.equal(calls.length, 2);
});

test("reason keys: no API key at all, and nothing is called", async (t) => {
  withKeys(t, { GEMINI_API_KEY: undefined, GROQ_API_KEY: undefined });
  const calls = stubFetch({});
  assert.equal(await failure(ask()), "keys");
  assert.equal(calls.length, 0);
});

test("only a Groq key: Gemini is skipped", async (t) => {
  withKeys(t, { GEMINI_API_KEY: undefined });
  const calls = stubFetch({ groq: () => groqReply("groq only") });
  assert.equal((await ask()).text, "groq only");
  assert.deepEqual(calls.map((c) => c.engine), ["groq"]);
});

test("only a Gemini key: Groq is not tried", async (t) => {
  withKeys(t, { GROQ_API_KEY: undefined });
  const calls = stubFetch({ gemini: () => overloaded() });
  assert.equal(await failure(ask()), "busy");
  assert.deepEqual(calls.map((c) => c.engine), MODELS.fast.map(() => "gemini"));
});

test("reason busy: overload, rate limits, quota messages and network errors", async () => {
  stubFetch({ gemini: () => overloaded(), groq: () => json(429, { error: { message: "Rate limit reached" } }) });
  assert.equal(await failure(ask()), "busy");
  stubFetch({ gemini: () => json(400, { error: { message: "Quota exceeded for metric" } }), groq: () => json(400, {}) });
  assert.equal(await failure(ask()), "busy");
  stubFetch({ gemini: () => { throw new TypeError("fetch failed"); }, groq: () => json(400, {}) });
  assert.equal(await failure(ask()), "busy");
});

test("reason empty: every engine answered without text", async () => {
  stubFetch({ gemini: () => geminiReply("", "SAFETY"), groq: () => groqReply("") });
  assert.equal(await failure(ask()), "empty");
});

test("reason failed: plain client errors such as a bad key", async () => {
  stubFetch({ gemini: () => json(400, { error: { message: "API key not valid" } }), groq: () => json(401, { error: { message: "Invalid API Key" } }) });
  assert.equal(await failure(ask()), "failed");
});

test("busy outranks empty, and empty outranks failed", async () => {
  stubFetch({ gemini: (model) => (model === MODELS.fast[0] ? geminiReply("") : overloaded()), groq: () => json(400, {}) });
  assert.equal(await failure(ask()), "busy");
  stubFetch({ gemini: () => geminiReply(""), groq: () => json(400, {}) });
  assert.equal(await failure(ask()), "empty");
});

test("a spent time budget tries nothing", async () => {
  const calls = stubFetch({ gemini: () => geminiReply("late"), groq: () => groqReply("late") });
  assert.equal(await failure(ask({ deadline: Date.now() + 1000 })), "failed");
  assert.equal(calls.length, 0);
});

test("Gemini leaves time for Groq: a short budget goes straight to Groq", async () => {
  const calls = stubFetch({ gemini: () => geminiReply("gemini"), groq: () => groqReply("groq") });
  assert.equal((await ask({ deadline: Date.now() + 9000 })).text, "groq");
  assert.deepEqual(calls.map((c) => c.engine), ["groq"]);
});

test("parseJSONLoose copes with fences and surrounding words", () => {
  assert.deepEqual(parseJSONLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJSONLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJSONLoose('Here you go: {"a":{"b":2}} hope it helps'), { a: { b: 2 } });
  assert.deepEqual(parseJSONLoose("[1,2]"), [1, 2]);
  assert.equal(parseJSONLoose("no json"), null);
  assert.equal(parseJSONLoose('{"a":'), null);
  assert.equal(parseJSONLoose(""), null);
  assert.equal(parseJSONLoose(undefined), null);
});
