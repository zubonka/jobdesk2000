// Netlify serverless function: генерує cover letter через Gemini API.
// Ключ береться зі змінної середовища GEMINI_API_KEY (у Netlify, НЕ в коді).
// Важливо: безкоштовний Netlify обриває функцію на ~10с, тож НЕ робимо довгих ретраїв тут —
// пробуємо моделі швидко, по разу, з таймаутом на кожен запит. Повтори — на боці фронтенду.

exports.handler = async (event) => {
  const CORS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "GEMINI_API_KEY не налаштовано в Netlify" }) };

  let prompt = "";
  try { prompt = (JSON.parse(event.body || "{}").prompt || "").toString(); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Некоректний запит" }) }; }
  if (!prompt) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Порожній prompt" }) };

  const models = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-flash-latest"];
  let lastErr = "unknown", overloaded = false;
  const deadline = Date.now() + 8500; // загальний бюджет < 10с ліміту Netlify

  // fetch із таймаутом, щоб один повільний запит не з'їв увесь ліміт функції
  async function fetchTimeout(url, opts, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
    finally { clearTimeout(t); }
  }

  for (const model of models) {
    const budget = deadline - Date.now();
    if (budget < 1500) break; // не встигаємо ще один запит — виходимо з дружньою помилкою
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    try {
      const resp = await fetchTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.8, maxOutputTokens: 1200 },
        }),
      }, Math.min(budget, 7000));

      const data = await resp.json();

      if (!resp.ok) {
        lastErr = (data && data.error && data.error.message) ? data.error.message : ("HTTP " + resp.status);
        if (resp.status === 503 || resp.status === 429 || /demand|overload|rate|quota/i.test(lastErr)) overloaded = true;
        console.log(`Model ${model} failed:`, lastErr);
        continue; // одразу наступна модель, без пауз
      }

      const text =
        (((data.candidates || [])[0] || {}).content || {}).parts
          ?.map((p) => p.text || "").join("").trim() || "";

      if (!text) { lastErr = "Порожня відповідь (можливо, спрацював фільтр безпеки)"; console.log(`Model ${model} empty`); continue; }

      console.log(`Model ${model} OK, chars:`, text.length);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ text, model }) };
    } catch (err) {
      lastErr = (err && err.name === "AbortError") ? "Gemini не відповів вчасно" : String(err && err.message ? err.message : err);
      console.log(`Model ${model} threw:`, lastErr);
    }
  }

  console.log("ALL MODELS FAILED:", lastErr);
  const friendly = overloaded
    ? "Gemini зараз перевантажений ✦ натисни «Написати листа» ще раз за 10–20 секунд."
    : lastErr;
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: friendly, retry: overloaded }) };
};
