// Спільні утиліти для Netlify-функцій JobDesk 2000:
// CORS за списком дозволених сайтів, перевірка входу (Firebase ID token),
// виклики Gemini / Groq з таймаутами, простий rate limit і безпечне завантаження сторінок вакансій.
// Лежить поза netlify/functions, тому Netlify не робить із нього окрему функцію (esbuild вшиває його в кожну).
const crypto = require("crypto");
const dns = require("dns");
const net = require("net");
const http = require("http");
const https = require("https");
const zlib = require("zlib");

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "jobdesk2000";

// ===== CORS =====
// основний сайт + deploy previews / branch deploys (xxx--jobdeck2000.netlify.app) + localhost для розробки.
// Свій домен можна додати через змінну ALLOWED_ORIGINS (через кому).
const SITE_RE = /^https:\/\/([a-z0-9-]+--)?jobdeck2000\.netlify\.app$/;
const LOCAL_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
function allowedOrigin(origin) {
  if (!origin) return false;
  const extra = [process.env.URL, ...(process.env.ALLOWED_ORIGINS || "").split(",")].map((s) => (s || "").trim().replace(/\/$/, "")).filter(Boolean);
  return SITE_RE.test(origin) || LOCAL_RE.test(origin) || extra.includes(origin);
}
const hdr = (event, name) => ((event && event.headers) || {})[name] || "";

function corsHeaders(event) {
  const h = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Vary: "Origin" };
  const origin = hdr(event, "origin");
  if (allowedOrigin(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    h["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    h["Access-Control-Max-Age"] = "600";
  }
  return h;
}
const reply = (headers, statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });

// Preflight, метод і чужі сайти. Повертає готову відповідь або null (можна працювати далі).
function guard(event, headers) {
  const origin = hdr(event, "origin");
  if (origin && !allowedOrigin(origin)) return reply(headers, 403, { error: "Доступ заборонено" });
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return reply(headers, 405, { error: "Method not allowed" });
  return null;
}

function parseBody(event) {
  try { const b = JSON.parse(event.body || "{}"); return b && typeof b === "object" ? b : {}; } catch (e) { return null; }
}
const str = (v, max) => (v == null ? "" : String(v)).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").trim().slice(0, max);

// ===== ПРОСТИЙ RATE LIMIT =====
// Памʼять живе, доки «теплий» екземпляр функції; це запобіжник від циклів-спамерів, а не точний лічильник.
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return false; }
  arr.push(now);
  buckets.set(key, arr);
  if (buckets.size > 5000) buckets.clear();
  return true;
}
const clientIp = (event) => hdr(event, "x-nf-client-connection-ip") || (hdr(event, "x-forwarded-for").split(",")[0] || "").trim() || "unknown";

// ===== ПЕРЕВІРКА ВХОДУ: Firebase ID token (RS256, публічні сертифікати Google) =====
const CERTS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
let certCache = { certs: null, exp: 0, fetchedAt: 0 };
async function googleCerts(force) {
  if (!force && certCache.certs && Date.now() < certCache.exp) return certCache.certs;
  if (force && Date.now() - certCache.fetchedAt < 60000 && certCache.certs) return certCache.certs; // не смикаємо Google частіше разу на хвилину
  const r = await fetchTimeout(CERTS_URL, {}, 5000);
  if (!r.ok) throw new Error("certs HTTP " + r.status);
  const certs = await r.json();
  const m = /max-age=(\d+)/.exec(r.headers.get("cache-control") || "");
  certCache = { certs, exp: Date.now() + (m ? +m[1] : 3600) * 1000, fetchedAt: Date.now() };
  return certs;
}
const b64json = (s) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

async function verifyIdToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  let head, p;
  try { head = b64json(parts[0]); p = b64json(parts[1]); } catch (e) { return null; }
  if (!head || head.alg !== "RS256" || !head.kid || !p) return null;
  const now = Math.floor(Date.now() / 1000), skew = 60;
  if (p.aud !== PROJECT_ID || p.iss !== "https://securetoken.google.com/" + PROJECT_ID) return null;
  if (typeof p.sub !== "string" || !p.sub || p.sub.length > 128) return null;
  if (!(p.exp > now - skew) || !(p.iat <= now + skew) || (p.auth_time != null && p.auth_time > now + skew)) return null;
  let certs = await googleCerts(false);
  if (!certs[head.kid]) certs = await googleCerts(true); // ключі Google періодично ротуються
  const pem = certs[head.kid];
  if (!pem) return null;
  const ok = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), crypto.createPublicKey(pem), Buffer.from(parts[2], "base64url"));
  if (!ok) return null;
  return { uid: p.sub, email: p.email || "", emailVerified: !!p.email_verified };
}
// null = немає/недійсний токен; кидає помилку, лише якщо не вдалося отримати сертифікати Google
async function getUser(event) {
  const m = /^Bearer\s+(.+)$/i.exec(hdr(event, "authorization"));
  if (!m) return null;
  return verifyIdToken(m[1].trim());
}

// ===== LLM =====
function fetchTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}
const csv = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);

// Моделі можна перевизначити змінними GEMINI_MODELS_FAST / GEMINI_MODELS_WRITE (через кому).
const MODELS = {
  fast: csv(process.env.GEMINI_MODELS_FAST).length ? csv(process.env.GEMINI_MODELS_FAST) : ["gemini-3.5-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-flash"],
  write: csv(process.env.GEMINI_MODELS_WRITE).length ? csv(process.env.GEMINI_MODELS_WRITE) : ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
};
const GROQ_MODELS = csv(process.env.GROQ_MODELS).length ? csv(process.env.GROQ_MODELS) : ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];

// Мінімальне «мислення»: воно повільне й зʼїдає maxOutputTokens (через нього раніше обрізались відповіді).
// 2.5 Flash: thinkingBudget 0 вимикає; 3.x: thinkingLevel (у Flash-Lite є "minimal", у Flash безпечно "low").
function thinkingFor(model) {
  if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
  if (/^gemini-3[\d.]*-flash-lite/.test(model)) return { thinkingLevel: "minimal" };
  if (/^gemini-3/.test(model)) return { thinkingLevel: "low" };
  return null;
}

class AIError extends Error {
  constructor(msg, busy) { super(msg); this.busy = !!busy; }
}

// Пробує моделі Gemini по черзі, потім Groq. opts: {kind:'fast'|'write', system, user, schema, maxTokens, temperature, deadline, perTry}
async function generate(opts) {
  const geminiKey = process.env.GEMINI_API_KEY, groqKey = process.env.GROQ_API_KEY;
  if (!geminiKey && !groqKey) throw new AIError("AI-ключі не налаштовані на сервері", false);
  const deadline = opts.deadline || Date.now() + 20000;
  const groqReserve = groqKey ? Math.min(8000, opts.groqReserve || 8000) : 0;
  let busy = false;

  for (const model of geminiKey ? MODELS[opts.kind || "fast"] : []) {
    const left = deadline - groqReserve - Date.now();
    if (left < 2500) break;
    const gc = { temperature: opts.temperature ?? 0.4, maxOutputTokens: opts.maxTokens || 1024 };
    const th = thinkingFor(model);
    if (th) gc.thinkingConfig = th;
    if (opts.schema) { gc.responseMimeType = "application/json"; gc.responseSchema = opts.schema; }
    try {
      const r = await fetchTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
        body: JSON.stringify({
          systemInstruction: opts.system ? { parts: [{ text: opts.system }] } : undefined,
          contents: [{ role: "user", parts: [{ text: opts.user }] }],
          generationConfig: gc,
        }),
      }, Math.min(left, opts.perTry || 25000));
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = (d.error && d.error.message) || "";
        if (r.status === 429 || r.status >= 500 || /overload|quota|exhausted|unavailable|rate/i.test(msg)) busy = true;
        console.log(`gemini ${model} HTTP ${r.status}: ${msg.slice(0, 200)}`);
        continue;
      }
      const cand = (d.candidates || [])[0] || {};
      const text = ((cand.content || {}).parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("").trim();
      if (!text) { console.log(`gemini ${model} empty, finish=${cand.finishReason}, block=${(d.promptFeedback || {}).blockReason || ""}`); continue; }
      console.log(`gemini ${model} ok finish=${cand.finishReason} chars=${text.length}`);
      return { text, model, truncated: cand.finishReason === "MAX_TOKENS" };
    } catch (e) {
      busy = true;
      console.log(`gemini ${model} ${e && e.name === "AbortError" ? "timeout" : "threw " + (e && e.message)}`);
    }
  }

  for (const gm of groqKey ? GROQ_MODELS : []) {
    const left = deadline - Date.now();
    if (left < 2500) break;
    try {
      const messages = [];
      if (opts.system) messages.push({ role: "system", content: opts.system });
      messages.push({ role: "user", content: opts.user + (opts.schema ? "\n\nПоверни ВИКЛЮЧНО валідний JSON-обʼєкт." : "") });
      const r = await fetchTimeout("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + groqKey },
        body: JSON.stringify({ model: gm, temperature: opts.temperature ?? 0.4, max_tokens: opts.maxTokens || 1024, messages, ...(opts.schema ? { response_format: { type: "json_object" } } : {}) }),
      }, Math.min(left, 15000));
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 429 || r.status >= 500) busy = true;
        console.log(`groq ${gm} HTTP ${r.status}: ${((d.error && d.error.message) || "").slice(0, 200)}`);
        continue;
      }
      const ch = (d.choices || [])[0] || {};
      const text = ((ch.message || {}).content || "").trim();
      if (!text) continue;
      console.log(`groq ${gm} ok chars=${text.length}`);
      return { text, model: "groq:" + gm, truncated: ch.finish_reason === "length" };
    } catch (e) {
      busy = true;
      console.log(`groq ${gm} ${e && e.name === "AbortError" ? "timeout" : "threw " + (e && e.message)}`);
    }
  }
  throw new AIError(busy ? "Фея зараз перевантажена ✦ спробуй ще раз за хвилину." : "Фея не змогла відповісти ✦ спробуй ще раз.", busy);
}

// JSON із відповіді моделі (на випадок markdown-огортки або зайвого тексту довкола)
function parseJSONLoose(text) {
  const t = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(t); } catch (e) {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}

// ===== БЕЗПЕЧНЕ ЗАВАНТАЖЕННЯ СТОРІНКИ ВАКАНСІЇ =====
// Лише http(s) на стандартних портах, лише публічні IP (перевірка на момент зʼєднання, тож DNS-rebinding не проходить),
// редиректи вручну з повторною перевіркою, ліміт розміру й часу. Усі збої дають одну загальну помилку.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return true;
    const v4 = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4) return isPrivateIp(v4[1]);
    return /^(::ffff:|64:ff9b:|100::|2001:db8|fc|fd|fe[89ab]|ff)/.test(s);
  }
  return true;
}
function safeLookup(hostname, options, cb) {
  if (typeof options === "function") { cb = options; options = {}; }
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) return cb(Object.assign(new Error("blocked address"), { code: "EBLOCKED" }));
    if (options && options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}
class FetchError extends Error {}
function checkUrl(u) {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new FetchError("protocol");
  if (u.username || u.password) throw new FetchError("credentials");
  if (u.port && u.port !== "80" && u.port !== "443") throw new FetchError("port");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isPrivateIp(host)) throw new FetchError("private ip");
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new FetchError("local host");
}
function getOnce(u, deadline, maxBytes) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, {
      method: "GET",
      lookup: safeLookup,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; JobDesk2000/1.0; +https://jobdeck2000.netlify.app)",
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "Accept-Language": "uk,en;q=0.8,ru;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve({ redirect: res.headers.location }); }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return reject(new FetchError("status " + res.statusCode)); }
      const type = String(res.headers["content-type"] || "");
      if (type && !/text\/html|xhtml|text\/plain|xml/i.test(type)) { res.resume(); return reject(new FetchError("type " + type)); }
      const enc = String(res.headers["content-encoding"] || "").toLowerCase();
      let stream = res;
      if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
      else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = []; let size = 0;
      stream.on("data", (c) => { size += c.length; if (size > maxBytes) { req.destroy(); resolve({ buf: Buffer.concat(chunks), type }); } else chunks.push(c); });
      stream.on("end", () => resolve({ buf: Buffer.concat(chunks), type }));
      stream.on("error", (e) => reject(new FetchError("decode " + e.message)));
    });
    const left = deadline - Date.now();
    if (left <= 0) { req.destroy(); return reject(new FetchError("timeout")); }
    const timer = setTimeout(() => req.destroy(new FetchError("timeout")), left);
    req.on("close", () => clearTimeout(timer));
    req.on("error", (e) => reject(e instanceof FetchError ? e : new FetchError(e.code || e.message)));
    req.end();
  });
}
function decodeBody(buf, type) {
  let cs = (/charset=["']?([\w-]+)/i.exec(type) || [])[1];
  if (!cs) cs = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString("latin1")) || [])[1];
  try { return new TextDecoder((cs || "utf-8").toLowerCase()).decode(buf); } catch (e) { return new TextDecoder("utf-8").decode(buf); }
}
async function fetchPage(rawUrl, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 9000);
  let u;
  try { u = new URL(rawUrl); } catch (e) { throw new FetchError("bad url"); }
  for (let hop = 0; hop < 5; hop++) {
    checkUrl(u);
    const r = await getOnce(u, deadline, 2 * 1024 * 1024);
    if (r.redirect) { u = new URL(r.redirect, u); continue; }
    return { html: decodeBody(r.buf, r.type), url: u.href };
  }
  throw new FetchError("too many redirects");
}

// ===== HTML -> ТЕКСТ =====
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", laquo: "«", raquo: "»", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", bull: "•", middot: "·", euro: "€", hryvnia: "₴" };
function decodeEntities(s) {
  return String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch (x) { return " "; } }
    return ENT[e.toLowerCase()] ?? m;
  });
}
function htmlToText(html) {
  return decodeEntities(String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|section|article|header|footer)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n[\s]*/g, "\n")
    .trim();
}
function metaContent(html, key) {
  const re = new RegExp('<meta[^>]+(?:property|name)=["\']' + key + '["\'][^>]*>', "i");
  const tag = (re.exec(html) || [])[0];
  return tag ? decodeEntities((/content=["']([^"']*)["']/i.exec(tag) || [])[1] || "").trim() : "";
}

// schema.org JobPosting (є на work.ua, robota.ua, djinni, LinkedIn, Indeed та багатьох кар'єрних сторінках)
function findJobPosting(html) {
  const re = /<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data = null;
    try { data = JSON.parse(m[1].trim()); } catch (e) { try { data = JSON.parse(decodeEntities(m[1]).trim()); } catch (e2) { continue; } }
    const stack = [data];
    while (stack.length) {
      const x = stack.pop();
      if (!x || typeof x !== "object") continue;
      if (Array.isArray(x)) { stack.push(...x); continue; }
      const t = x["@type"];
      if (t === "JobPosting" || (Array.isArray(t) && t.includes("JobPosting"))) return x;
      if (x["@graph"]) stack.push(x["@graph"]);
    }
  }
  return null;
}
const EMP_MAP = { FULL_TIME: "Full-time", PART_TIME: "Part-time", CONTRACTOR: "Project / Контракт", TEMPORARY: "Project / Контракт", INTERN: "Стажування", PER_DIEM: "Project / Контракт" };
function jobPostingFields(jp) {
  const org = jp.hiringOrganization;
  const company = typeof org === "string" ? org : (org && org.name) || "";
  let salary = "";
  const bs = jp.baseSalary || jp.estimatedSalary;
  const b = Array.isArray(bs) ? bs[0] : bs;
  if (b && typeof b === "object") {
    const v = b.value && typeof b.value === "object" ? b.value : b;
    const fmt = (n) => (typeof n === "number" ? n.toLocaleString("uk-UA") : String(n));
    if (v.minValue != null || v.maxValue != null) salary = [v.minValue, v.maxValue].filter((x) => x != null && x !== "").map(fmt).join("–");
    else if (v.value != null && typeof v.value !== "object") salary = fmt(v.value);
    const unit = { MONTH: "міс", YEAR: "рік", HOUR: "год", DAY: "день", WEEK: "тиждень" }[String(v.unitText || "").toUpperCase()];
    if (salary) salary = (salary + " " + (b.currency || v.currency || "")).trim() + (unit ? " / " + unit : "");
  } else if (typeof bs === "string" || typeof bs === "number") salary = String(bs);
  const emp = [].concat(jp.employmentType || []).map((e) => EMP_MAP[String(e).toUpperCase()] || "").find(Boolean) || "";
  const addr = (l) => { const a = l && l.address; if (!a) return ""; if (typeof a === "string") return a; const c = a.addressCountry; return [a.addressLocality, a.addressRegion, c && (c.name || c)].filter((x) => x && typeof x === "string").join(", "); };
  return {
    title: decodeEntities(jp.title || jp.name || "").trim(),
    company: decodeEntities(company).trim(),
    salary,
    emp,
    remote: /TELECOMMUTE/i.test(JSON.stringify(jp.jobLocationType || "")),
    location: [].concat(jp.jobLocation || []).map(addr).filter(Boolean).join("; "),
    industry: [].concat(jp.industry || jp.occupationalCategory || []).filter((x) => typeof x === "string").join(", "),
    desc: htmlToText(decodeEntities(String(jp.description || ""))).slice(0, 6000),
  };
}

module.exports = {
  PROJECT_ID, allowedOrigin, corsHeaders, reply, guard, parseBody, str, rateLimit, clientIp,
  verifyIdToken, getUser, googleCerts, generate, AIError, parseJSONLoose, thinkingFor, MODELS,
  fetchPage, FetchError, isPrivateIp, checkUrl, htmlToText, decodeEntities, metaContent, findJobPosting, jobPostingFields,
};
