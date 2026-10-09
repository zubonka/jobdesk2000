// Text generation: Gemini models in order, then Groq as the fallback engine, all within one time budget.
// Each model gets a single quick try because a function has a hard time limit; retrying is up to the client.
// API keys come from GEMINI_API_KEY / GROQ_API_KEY and travel in headers, never in a URL.

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_RESERVE = 8000;
const MIN_TRY = 2500;

function fetchTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// Model lists can be changed without a code deploy: GEMINI_MODELS_FAST, GEMINI_MODELS_WRITE, GROQ_MODELS (comma-separated).
function modelsFromEnv(name, defaults) {
  const list = (process.env[name] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : defaults;
}

const MODELS = {
  fast: modelsFromEnv("GEMINI_MODELS_FAST", ["gemini-3.5-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-flash"]),
  write: modelsFromEnv("GEMINI_MODELS_WRITE", ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash", "gemini-2.5-flash-lite"]),
};
// Groq retired the Llama 3.x models on 2026-08-16 (free and developer tiers); gpt-oss is its recommended successor.
const GROQ_MODELS = modelsFromEnv("GROQ_MODELS", ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
// Reasoning models spend completion tokens on thinking first, so they get extra room and the lowest effort.
const GROQ_REASONING_EXTRA = 1024;
const isGroqReasoning = (model) => /gpt-oss|qwen3/i.test(model);

// Thinking is slow and eats maxOutputTokens (it used to cut answers short), so keep it minimal.
// 2.5 Flash switches it off with thinkingBudget 0; 3.x takes thinkingLevel, and only Flash-Lite accepts "minimal".
function thinkingFor(model) {
  if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
  if (/^gemini-3[\d.]*-flash-lite/.test(model)) return { thinkingLevel: "minimal" };
  if (/^gemini-3/.test(model)) return { thinkingLevel: "low" };
  return null;
}

// reason: "keys" when no API key is configured; otherwise the worst outcome over all tried models:
// "busy" (rate limit, overload or timeout, so a retry may work), "empty" (answers without text) or "failed".
class AIError extends Error {
  constructor(reason) {
    super("AI " + reason);
    this.reason = reason;
  }
}

const isBusyStatus = (status) => status === 429 || status >= 500;
// "rate" alone would match "generateContent" in Gemini's not-found message
const BUSY_TEXT = /overload|quota|exhausted|unavailable|rate.?limit/i;
const BUSY_CODES = ["RESOURCE_EXHAUSTED", "UNAVAILABLE", "DEADLINE_EXCEEDED"];

async function askGemini(model, opts, key, ms) {
  const config = { temperature: opts.temperature ?? 0.4, maxOutputTokens: opts.maxTokens || 1024 };
  const thinking = thinkingFor(model);
  if (thinking) config.thinkingConfig = thinking;
  if (opts.schema) Object.assign(config, { responseMimeType: "application/json", responseSchema: opts.schema });
  const res = await fetchTimeout(GEMINI_URL + model + ":generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: opts.system ? { parts: [{ text: opts.system }] } : undefined,
      contents: [{ role: "user", parts: [{ text: opts.user }] }],
      generationConfig: config,
    }),
  }, ms);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data.error || {};
    const msg = err.message || "";
    console.log(`gemini ${model} HTTP ${res.status}: ${msg.slice(0, 200)}`);
    return { failure: isBusyStatus(res.status) || BUSY_CODES.includes(err.status) || BUSY_TEXT.test(msg) ? "busy" : "failed" };
  }
  const cand = (data.candidates || [])[0] || {};
  const text = ((cand.content || {}).parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("").trim();
  if (!text) {
    console.log(`gemini ${model} empty, finish=${cand.finishReason}, block=${(data.promptFeedback || {}).blockReason || ""}`);
    return { failure: "empty" };
  }
  console.log(`gemini ${model} ok finish=${cand.finishReason} chars=${text.length}`);
  return { text, model, truncated: cand.finishReason === "MAX_TOKENS" };
}

async function askGroq(model, opts, key, ms) {
  const messages = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.user + (opts.schema ? "\n\nПоверни ВИКЛЮЧНО валідний JSON-обʼєкт." : "") });
  const reasoning = isGroqReasoning(model);
  const res = await fetchTimeout(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({
      model,
      temperature: opts.temperature ?? 0.4,
      max_tokens: (opts.maxTokens || 1024) + (reasoning ? GROQ_REASONING_EXTRA : 0),
      messages,
      response_format: opts.schema ? { type: "json_object" } : undefined,
      ...(reasoning ? { reasoning_effort: "low", include_reasoning: false } : {}),
    }),
  }, ms);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log(`groq ${model} HTTP ${res.status}: ${((data.error && data.error.message) || "").slice(0, 200)}`);
    return { failure: isBusyStatus(res.status) ? "busy" : "failed" };
  }
  const choice = (data.choices || [])[0] || {};
  const text = ((choice.message || {}).content || "").trim();
  if (!text) return { failure: "empty" };
  console.log(`groq ${model} ok chars=${text.length}`);
  return { text, model: "groq:" + model, truncated: choice.finish_reason === "length" };
}

// Network errors and timeouts count as a busy engine.
async function tryModel(ask, engine, model, key, opts, ms) {
  try {
    return await ask(model, opts, key, ms);
  } catch (err) {
    console.log(`${engine} ${model} ${err.name === "AbortError" ? "timeout" : "threw " + err.message}`);
    return { failure: "busy" };
  }
}

// opts: {kind: "fast"|"write", system, user, schema, maxTokens, temperature, deadline, perTry}
// Resolves to {text, model, truncated}; throws AIError when no model produced text.
async function generate(opts) {
  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  if (!geminiKey && !groqKey) throw new AIError("keys");
  const deadline = opts.deadline || Date.now() + 20000;
  // Gemini stops early enough to leave Groq time for its own try.
  const reserve = groqKey ? GROQ_RESERVE : 0;
  const failures = new Set();

  for (const model of geminiKey ? MODELS[opts.kind || "fast"] : []) {
    const left = deadline - reserve - Date.now();
    if (left < MIN_TRY) break;
    const result = await tryModel(askGemini, "gemini", model, geminiKey, opts, Math.min(left, opts.perTry || 25000));
    if (!result.failure) return result;
    failures.add(result.failure);
  }
  for (const model of groqKey ? GROQ_MODELS : []) {
    const left = deadline - Date.now();
    if (left < MIN_TRY) break;
    const result = await tryModel(askGroq, "groq", model, groqKey, opts, Math.min(left, 15000));
    if (!result.failure) return result;
    failures.add(result.failure);
  }
  throw new AIError(failures.has("busy") ? "busy" : failures.has("empty") ? "empty" : "failed");
}

const tryParse = (s) => { try { return JSON.parse(s); } catch (e) { return undefined; } };

// Models sometimes wrap the JSON in a markdown fence or put words around it.
function parseJSONLoose(text) {
  const t = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const whole = tryParse(t);
  if (whole !== undefined) return whole;
  const braces = t.match(/\{[\s\S]*\}/);
  return (braces && tryParse(braces[0])) ?? null;
}

module.exports = { fetchTimeout, MODELS, thinkingFor, generate, AIError, parseJSONLoose };
