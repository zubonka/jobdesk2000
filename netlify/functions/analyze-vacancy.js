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

  
  // прибирає емодзі та проблемні символи, що ламають JSON/аналіз
  const stripEmoji = (t) => (t || "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u200D]/gu, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "GEMINI_API_KEY не налаштовано" }) };

  let url = "", pastedText = "", mode = "vacancy", cvText = "";
  try { const body = JSON.parse(event.body || "{}"); url = (body.url || "").toString(); pastedText = (body.text || "").toString(); mode = (body.mode || "vacancy").toString(); cvText = (body.cv || "").toString(); } catch (e) {}

  // ===== РЕЖИМ ПРОФІЛЮ: фея аналізує, хто людина за фахом, і дає персональні фрази =====
  if (mode === "profile") {
    const src = stripEmoji(cvText || pastedText || "").replace(/\s+/g, " ").trim().slice(0, 6000);
    if (src.length < 40) return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: "замало тексту" }) };
    const g = (event.gender || ""); // не використовується, рід підставляє фронтенд
    const pPrompt =
      "Ось резюме або опис вакансії людини. Визнач, хто вона за фахом, і поверни РІВНО один JSON-обʼєкт такої структури:\n" +
      '{"role":"стисла назва фаху українською, напр. графічний дизайнер","summary":"1 коротке речення, чим людина займається","phrases":["3 короткі підбадьорливі фрази українською саме під цей фах, кожна ≤90 символів, з ✦"]}\n' +
      "Фрази — теплі, мотивуючі, звертайся на «ти». Не вигадуй фактів. ТЕКСТ:\n" + src;
    const pSchema = { type: "OBJECT", properties: { role: { type: "STRING" }, summary: { type: "STRING" }, phrases: { type: "ARRAY", items: { type: "STRING" } } }, required: ["role", "phrases"] };
    const models0 = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-flash-latest"];
    let e0 = "unknown";
    for (const model of models0) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
            body: JSON.stringify({ contents: [{ parts: [{ text: pPrompt }] }], generationConfig: { temperature: 0.5, maxOutputTokens: 400, responseMimeType: "application/json", responseSchema: pSchema } }) });
        const d = await r.json();
        if (!r.ok) { e0 = (d.error && d.error.message) || ("HTTP " + r.status); continue; }
        let o = (((d.candidates || [])[0] || {}).content || {}).parts?.map((p) => p.text || "").join("").trim() || "";
        o = o.replace(/```json/gi, "").replace(/```/g, "").trim();
        let pj = null; try { pj = JSON.parse(o); } catch (e) { const m = o.match(/\{[\s\S]*\}/); if (m) { try { pj = JSON.parse(m[0]); } catch (e) {} } }
        if (pj && (pj.role || (pj.phrases && pj.phrases.length))) {
          return { statusCode: 200, headers: CORS, body: JSON.stringify({ role: (pj.role || "").toString().slice(0, 80), summary: (pj.summary || "").toString().slice(0, 200), phrases: (pj.phrases || []).slice(0, 4).map((x) => x.toString().slice(0, 120)) }) };
        }
        e0 = "неструктуровано";
      } catch (err) { e0 = String(err && err.message ? err.message : err); }
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: e0 }) };
  }

  let text = "";
  if (pastedText && pastedText.trim().length > 40) {
    // режим вставленого тексту — не завантажуємо сторінку
    text = stripEmoji(pastedText).replace(/\s+/g, " ").trim().slice(0, 8000);
  } else {
    if (!url || !/^https?:\/\//.test(url)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Дай посилання або встав текст вакансії" }) };
    let html = "";
    try {
      const pageResp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; JobDeskBot/1.0)" }, redirect: "follow" });
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
    "Проаналізуй текст вакансії нижче й поверни РІВНО один JSON-обʼєкт (без пояснень, без markdown) точно такої структури:\n" +
    '{"company":"назва компанії","title":"посада","field":"сфера або галузь","emp":"тип зайнятості напр. Full-time · Remote","salary":"зарплата або —"}\n' +
    "Правила: усі значення — рядки. Якщо якогось даного немає в тексті, постав \"—\". Не вигадуй. " +
    "Відповідай тією мовою, якою написана вакансія.\n\nТЕКСТ ВАКАНСІЇ:\n" + text;

  const schema = {
    type: "OBJECT",
    properties: {
      company: { type: "STRING" },
      title: { type: "STRING" },
      field: { type: "STRING" },
      emp: { type: "STRING" },
      salary: { type: "STRING" },
    },
    required: ["company", "title", "field", "emp", "salary"],
  };

  const models = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-flash-latest"];
  let lastErr = "unknown";
  for (const model of models) {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 800, responseMimeType: "application/json", responseSchema: schema } }) }
      );
      const data = await resp.json();
      if (!resp.ok) { lastErr = (data.error && data.error.message) || ("HTTP " + resp.status); console.log(`${model} HTTP fail:`, lastErr); continue; }
      const cand = (data.candidates || [])[0] || {};
      const finish = cand.finishReason || "";
      let out = ((cand.content || {}).parts || []).map((p) => p.text || "").join("").trim();
      console.log(`${model} finish=${finish} len=${out.length}`);
      if (finish === "SAFETY" || finish === "RECITATION") { lastErr = "Gemini заблокував відповідь"; continue; }
      if (!out) { lastErr = "Порожня відповідь від Gemini"; continue; }
      out = out.replace(/```json/gi, "").replace(/```/g, "").trim();
      let parsed = null;
      try { parsed = JSON.parse(out); } catch (e) {}
      // якщо відповідь обрізана (MAX_TOKENS) — витягуємо/лагодимо JSON-обʼєкт
      if (!parsed) {
        let frag = out;
        const start = frag.indexOf("{");
        if (start >= 0) {
          frag = frag.slice(start);
          const end = frag.lastIndexOf("}");
          if (end >= 0) frag = frag.slice(0, end + 1);
          else frag = frag + '"}'; // грубо закриваємо обірваний рядок
          try { parsed = JSON.parse(frag); } catch (e) {}
          // остання спроба: витягнути поля регулярками
          if (!parsed) {
            const grab = (k) => { const mm = out.match(new RegExp('"' + k + '"\\s*:\\s*"([^"]*)"')); return mm ? mm[1] : ""; };
            const c = grab("company"), t = grab("title");
            if (c || t) parsed = { company: c, title: t, field: grab("field"), emp: grab("emp"), salary: grab("salary") };
          }
        }
      }
      if (!parsed || typeof parsed !== "object") { lastErr = "Gemini повернув неструктуровану відповідь"; console.log(`${model} unparseable:`, out.slice(0, 300)); continue; }
      const clean = {
        company: (parsed.company || "—").toString().slice(0, 120),
        title: (parsed.title || "Вакансія").toString().slice(0, 160),
        field: (parsed.field || "—").toString().slice(0, 120),
        emp: (parsed.emp || parsed.employment || "—").toString().slice(0, 120),
        salary: (parsed.salary || "—").toString().slice(0, 80),
      };
      return { statusCode: 200, headers: CORS, body: JSON.stringify(clean) };
    } catch (err) { lastErr = String(err && err.message ? err.message : err); console.log(`${model} threw:`, lastErr); }
  }
  const friendly = /overload|demand|503|429|rate|quota/i.test(lastErr)
    ? "Gemini зараз перевантажений ✦ спробуй ще раз за хвилину."
    : lastErr;
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: friendly || "Не вдалося розібрати вакансію" }) };
};
