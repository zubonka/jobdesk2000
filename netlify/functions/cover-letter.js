// Netlify serverless function: генерує cover letter через Gemini API.
// Ключ береться зі змінної середовища GEMINI_API_KEY (налаштовується в Netlify, НЕ в коді).

exports.handler = async (event) => {
  const CORS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  // preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "GEMINI_API_KEY не налаштовано в Netlify" }) };
  }

  let prompt = "";
  try {
    const body = JSON.parse(event.body || "{}");
    prompt = (body.prompt || "").toString();
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Некоректний запит" }) };
  }
  if (!prompt) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Порожній prompt" }) };
  }

  // Gemini 1.5 Flash — швидка й безкоштовна на free tier модель
  const model = "gemini-1.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  try {
    const geminiResp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 1200 },
      }),
    });

    const data = await geminiResp.json();

    if (!geminiResp.ok) {
      const msg = (data && data.error && data.error.message) ? data.error.message : "Gemini error";
      return { statusCode: geminiResp.status, headers: CORS, body: JSON.stringify({ error: msg }) };
    }

    const text =
      (((data.candidates || [])[0] || {}).content || {}).parts
        ?.map((p) => p.text || "")
        .join("")
        .trim() || "";

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ text }) };
  } catch (err) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: "Не вдалося звʼязатися з Gemini" }) };
  }
};
