// Netlify serverless function: генерує cover letter через Gemini API.
// Ключ береться зі змінної середовища GEMINI_API_KEY (у Netlify, НЕ в коді).
// Важливо: безкоштовний Netlify обриває функцію на ~10с, тож НЕ робимо довгих ретраїв тут —
// пробуємо моделі швидко, по разу, з таймаутом на кожен запит. Повтори — на боці фронтенду.

// Чистить лист від уламків промпту/інструкцій, якщо модель "забалакала"
// Якщо лист обірвано на середині — обрізаємо до останнього завершеного речення
// й додаємо коротку кінцівку з підписом, щоб він виглядав цілим.
function finishCleanly(t) {
  if (!t) return t;
  let s = t.trim();
  // якщо вже є підпис — лишаємо як є
  if (/(З повагою|Щиро|З найкращими|Дякую за розгляд)/i.test(s)) return s;
  // знаходимо останній розділовий знак кінця речення
  const lastEnd = Math.max(s.lastIndexOf("."), s.lastIndexOf("!"), s.lastIndexOf("?"));
  if (lastEnd > 40) s = s.slice(0, lastEnd + 1); // відрізаємо незавершений "хвіст"
  s += "\n\nБуду рада можливості обговорити свою кандидатуру детальніше. Дякую за ваш час!\n\nЗ повагою.";
  return s;
}

function cleanLetter(t) {
  if (!t) return "";
  // прибираємо markdown-огортку
  t = t.replace(/```[a-z]*\n?/gi, "").replace(/```/g, "");
  // рядки, що явно є службовими інструкціями, а не текстом листа
  const badLine = /(passive\/noun|past tense|feminine forms?|Ensure correct|Length:|Output:|ONLY text|paragraphs?\b.*:|^\s*\d+\.\s*\*\*|Ref\b|instructions?:|prompt:|системн|інструкці)/i;
  // якщо у відповіді є нормальний лист + хвіст інструкцій — відрізаємо хвіст
  const lines = t.split(/\n/);
  const kept = [];
  for (const ln of lines) {
    if (badLine.test(ln)) break; // з цього рядка починається "балаканина" — стоп
    kept.push(ln);
  }
  let out = kept.join("\n").trim();
  // якщо після обрізання лишилось замало — повертаємо оригінал без markdown (краще щось, ніж нічого)
  if (out.length < 40) out = t.trim();
  return out.trim();
}

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
          generationConfig: { temperature: 0.8, maxOutputTokens: 1800 },
        }),
      }, Math.min(budget, 8000));

      const data = await resp.json();

      if (!resp.ok) {
        lastErr = (data && data.error && data.error.message) ? data.error.message : ("HTTP " + resp.status);
        if (resp.status === 503 || resp.status === 429 || /demand|overload|rate|quota/i.test(lastErr)) overloaded = true;
        console.log(`Model ${model} failed:`, lastErr);
        continue; // одразу наступна модель, без пауз
      }

      const cand = (data.candidates || [])[0] || {};
      let text =
        (cand.content || {}).parts
          ?.map((p) => p.text || "").join("").trim() || "";

      // Прибираємо уламки інструкцій, якщо Gemini "забалакав"
      text = cleanLetter(text);

      if (!text || text.length < 40) { lastErr = "Порожня відповідь (можливо, спрацював фільтр безпеки)"; console.log(`Model ${model} empty/short`); continue; }

      // Якщо лист обірвався (скінчились токени) — акуратно завершуємо на останньому цілому реченні + підпис
      if (cand.finishReason === "MAX_TOKENS") {
        text = finishCleanly(text);
        console.log(`Model ${model} was truncated -> tidied`);
      }

      console.log(`Model ${model} OK, chars:`, text.length);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ text, model }) };
    } catch (err) {
      if (err && err.name === "AbortError") { lastErr = "Gemini не відповів вчасно"; overloaded = true; } // таймаут -> дозволяємо авто-повтор
      else lastErr = String(err && err.message ? err.message : err);
      console.log(`Model ${model} threw:`, lastErr);
    }
  }

  console.log("ALL MODELS FAILED:", lastErr);
  const friendly = overloaded
    ? "Gemini зараз зайнятий ✦ пробую ще раз автоматично..."
    : lastErr;
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: friendly, retry: overloaded }) };
};
