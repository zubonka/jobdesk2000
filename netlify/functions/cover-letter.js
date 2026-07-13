// Netlify serverless function: генерує cover letter через Gemini API.
// Ключ береться зі змінної середовища GEMINI_API_KEY (у Netlify, НЕ в коді).

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
  if (!apiKey) {
    console.log("ERROR: GEMINI_API_KEY is missing");
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "GEMINI_API_KEY не налаштовано в Netlify" }) };
  }

  let prompt = "";
  try {
    const body = JSON.parse(event.body || "{}");
    prompt = (body.prompt || "").toString();
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Некоректний запит" }) };
  }
  if (!prompt) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Порожній prompt" }) };

  // Актуальні моделі станом на 2026 (1.5 і 2.0 вимкнено). Пробуємо по черзі.
  const models = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-flash-latest"];
  let lastErr = "unknown";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    // до 3 спроб на модель — Gemini іноді відповідає "high demand" (503), це тимчасово
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.8, maxOutputTokens: 1200 },
          }),
        });

        const data = await resp.json();

        if (!resp.ok) {
          lastErr = (data && data.error && data.error.message) ? data.error.message : ("HTTP " + resp.status);
          const overloaded = resp.status === 503 || resp.status === 429 || /demand|overload|try again|rate/i.test(lastErr);
          console.log(`Model ${model} attempt ${attempt} failed:`, lastErr);
          if (overloaded && attempt < 2) { await sleep(800 * (attempt + 1)); continue; } // почекати й повторити
          break; // інша помилка — до наступної моделі
        }

        const text =
          (((data.candidates || [])[0] || {}).content || {}).parts
            ?.map((p) => p.text || "").join("").trim() || "";

        if (!text) {
          lastErr = "Порожня відповідь (можливо, спрацював фільтр безпеки)";
          console.log(`Model ${model} empty:`, JSON.stringify(data).slice(0, 400));
          break;
        }

        console.log(`Model ${model} OK, chars:`, text.length);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ text, model }) };
      } catch (err) {
        lastErr = String(err && err.message ? err.message : err);
        console.log(`Model ${model} attempt ${attempt} threw:`, lastErr);
        if (attempt < 2) { await sleep(800 * (attempt + 1)); continue; }
      }
    }
  }

  console.log("ALL MODELS FAILED:", lastErr);
  // дружнє повідомлення при перевантаженні
  const friendly = /demand|overload|try again|rate|503|429/i.test(lastErr)
    ? "Gemini зараз перевантажений (багато запитів). Спробуй ще раз за хвилинку ✦"
    : lastErr;
  return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: friendly }) };
};
