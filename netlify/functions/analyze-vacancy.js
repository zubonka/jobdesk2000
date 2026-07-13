// Аналізує вакансію за URL: завантажує сторінку й структурує через Gemini.
exports.handler = async (event) => {
  const CORS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "GEMINI_API_KEY не налаштовано" }) };

  let url = "", pastedText = "";
  try { const body = JSON.parse(event.body || "{}"); url = (body.url || "").toString(); pastedText = (body.text || "").toString(); } catch (e) {}

  let text = "";
  if (pastedText && pastedText.trim().length > 40) {
    // режим вставленого тексту — не завантажуємо сторінку
    text = pastedText.replace(/\s+/g, " ").trim().slice(0, 8000);
  } else {
    if (!url || !/^https?:\/\//.test(url)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Дай посилання або встав текст вакансії" }) };
    let html = "";
    try {
      const _ctrl = new AbortController(); const _t = setTimeout(() => _ctrl.abort(), 6000);
      const pageResp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; JobDeskBot/1.0)" }, redirect: "follow", signal: _ctrl.signal }).finally(() => clearTimeout(_t));
      if (!pageResp.ok) return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: "Сторінка недоступна (HTTP " + pageResp.status + ")" }) };
      html = await pageResp.text();
    } catch (e) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: "Не вдалося завантажити сторінку (сайт міг заблокувати)" }) };
    }
    text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 8000);
    if (text.length < 80) return { statusCode: 422, headers: CORS, body: JSON.stringify({ error: "Замало тексту на сторінці (потрібен логін?)" }) };
  }

  // 3. Структуруємо через Gemini
  const prompt =
    "Ось текст сторінки вакансії. Витягни структуровані дані й поверни СУВОРО як JSON без markdown, без пояснень, з полями: " +
    '{"company","title","field","emp","salary"}. ' +
    "company — назва компанії; title — посада; field — сфера/галузь; emp — тип зайнятості (напр. Full-time · Remote); salary — зарплата якщо є, інакше \"—\". " +
    "Якщо якогось поля нема — став \"—\". Текст:\n\n" + text;

  const models = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-flash-latest"];
  let lastErr = "unknown";
  for (const model of models) {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 400 } }) }
      );
      const data = await resp.json();
      if (!resp.ok) { lastErr = (data.error && data.error.message) || ("HTTP " + resp.status); continue; }
      let out = (((data.candidates || [])[0] || {}).content || {}).parts?.map((p) => p.text || "").join("").trim() || "";
      out = out.replace(/```json/gi, "").replace(/```/g, "").trim();
      let parsed;
      try { parsed = JSON.parse(out); } catch (e) { lastErr = "Не вдалося розпарсити відповідь"; continue; }
      return { statusCode: 200, headers: CORS, body: JSON.stringify(parsed) };
    } catch (err) { lastErr = String(err && err.message ? err.message : err); }
  }
  return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: lastErr }) };
};
