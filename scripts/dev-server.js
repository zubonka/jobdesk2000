// Local dev server, no dependencies: serves public/ the way Netlify does, runs
// netlify/functions/<name>.js on /.netlify/functions/<name> and applies [[headers]] from netlify.toml.
// Without AI keys (or with MOCK_AI=1) Gemini and Groq are answered by a deterministic mock.
// Env: PORT (8888), HOST (127.0.0.1), MOCK_AI=1, AUTH_TEST_CERTS=<certs.json>, FIREBASE_EMULATORS=1; ./.env is read too.

const http = require("http");
const { AsyncLocalStorage } = require("async_hooks");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const NETLIFY = path.join(ROOT, "netlify");

// KEY=VALUE lines; variables already set in the environment win, as with dotenv.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}
loadEnvFile(path.join(ROOT, ".env"));

// The functions accept the Auth emulator's unsigned tokens only when this flag is set, i.e. only under this server.
process.env.JOBDESK_LOCAL_DEV = "1";
// FIREBASE_EMULATORS=1: the app uses the local Firebase emulators (see EMULATOR_META below) and the
// functions verify tokens of the emulator's demo project.
if (process.env.FIREBASE_EMULATORS === "1") {
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
  process.env.FIREBASE_PROJECT_ID ||= "demo-jobdesk2000";
} else {
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
}

const PORT = Number(process.env.PORT) || 8888;
const HOST = process.env.HOST || "127.0.0.1";

// ===== AI mock =====
const MOCK = process.env.MOCK_AI === "1" || !(process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY);
const MOCK_MODES = ["ok", "busy", "slow", "empty", "truncated"];
const SLOW_MS = 6000;
let mockMode = "ok";
// A "jd_mock" cookie overrides the mode for that browser only, so parallel tests do not disturb each other.
const requestMock = new AsyncLocalStorage();
const currentMode = () => requestMock.getStore() || mockMode;

if (MOCK) {
  // the functions refuse to run without keys; these never leave the process because fetch is intercepted
  process.env.GEMINI_API_KEY ||= "mock";
  process.env.GROQ_API_KEY ||= "mock";
}

const between = (text, tag) => (new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`).exec(text) || [])[1] || "";
const lineValue = (text, label) => (new RegExp(`^${label}: (.+)$`, "m").exec(text) || [])[1] || "";

const MOCK_ANSWERS = {
  vacancy(prompt) {
    // the first words of the vacancy become the title, so different vacancies are not duplicates
    const first = between(prompt, "vacancy").split("\n")[0].replace(/^Посада:\s*/, "");
    const title = first.split(/\s+/).slice(0, 3).join(" ") || "Graphic Designer";
    return JSON.stringify({ company: "Mock Studio", title, field: "Дизайн", emp: "Full-time", loc: "Віддалено", salary: "$1500-2000" });
  },
  profile() {
    // the last phrase carries a tag on purpose: it must show up as text, never as markup
    const phrases = ["Твої макети сяють ✦", "Портфоліо: твоя суперсила ✦", "Рекрутери оцінять твій смак ✦ <b>цей тег має бути видно як текст</b>"];
    return JSON.stringify({ role: "графічна дизайнерка", summary: "Створює айдентику й ілюстрації.", phrases });
  },
  letter(prompt) {
    const vacancy = between(prompt, "vacancy");
    const company = lineValue(vacancy, "Компанія") || "Mock Studio";
    const title = lineValue(vacancy, "Посада") || "Graphic Designer";
    const name = (/Кандидат\(ка\): ([^.\n]+)\./.exec(prompt) || [])[1] || "Тест";
    const request = between(prompt, "request");
    const opening = request
      ? `(Оновлено за правкою: «${request}») Я досі дуже хочу долучитися до вас на посаду ${title}.`
      : `Мене звати ${name}, і я хочу долучитися до вас на посаду ${title}. Маю досвід, що відповідає вашим задачам.`;
    return `Шановна командо ${company}!\n\n${opening}\n\nУ попередній ролі мені вдалося підняти впізнаваність бренду музичного лейблу.\n\nІз задоволенням поспілкуюся.\n\nЗ повагою,\n${name}`;
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonResponse = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// { text, truncated } for the current mode; "busy" is answered before this by each engine
async function mockAnswer(kind, prompt) {
  const mode = currentMode();
  if (mode === "slow") await sleep(SLOW_MS);
  if (mode === "empty") return { text: "", truncated: false };
  const text = MOCK_ANSWERS[kind](prompt);
  if (mode === "truncated") return { text: text.slice(0, Math.floor(text.length * 0.6)), truncated: true };
  return { text, truncated: false };
}

async function mockGemini(url, body) {
  if (currentMode() === "busy") return jsonResponse(503, { error: { code: 503, message: "The model is overloaded. Please try again later." } });
  const prompt = body.contents.flatMap((c) => c.parts).map((p) => p.text || "").join("\n");
  const props = body.generationConfig?.responseSchema?.properties || {};
  const kind = props.company ? "vacancy" : props.role ? "profile" : "letter";
  const { text, truncated } = await mockAnswer(kind, prompt);
  const model = (/models\/([^:]+):/.exec(url) || [])[1];
  return jsonResponse(200, { candidates: [{ content: { parts: [{ text }] }, finishReason: truncated ? "MAX_TOKENS" : "STOP" }], modelVersion: model });
}

async function mockGroq(body) {
  if (currentMode() === "busy") return jsonResponse(429, { error: { message: "Rate limit reached" } });
  const prompt = body.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
  const kind = body.response_format ? (/"company"/.test(prompt) ? "vacancy" : "profile") : "letter";
  const { text, truncated } = await mockAnswer(kind, prompt);
  return jsonResponse(200, { model: body.model, choices: [{ message: { content: text }, finish_reason: truncated ? "length" : "stop" }] });
}

const CERTS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const testCerts = process.env.AUTH_TEST_CERTS ? JSON.parse(fs.readFileSync(process.env.AUTH_TEST_CERTS, "utf8")) : null;
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (MOCK && url.startsWith("https://generativelanguage.googleapis.com/")) return mockGemini(url, JSON.parse(init.body));
  if (MOCK && url.startsWith("https://api.groq.com/")) return mockGroq(JSON.parse(init.body));
  if (testCerts && url === CERTS_URL) {
    return new Response(JSON.stringify(testCerts), { headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" } });
  }
  return realFetch(input, init);
};

// ===== netlify.toml [[headers]] =====
// Just enough TOML for header rules: for = "..." and [headers.values] with one-line string values.
// Read on every request, so header edits apply without a restart.
function headerRules() {
  const file = path.join(ROOT, "netlify.toml");
  const rules = [];
  let rule = null, inValues = false;
  for (const raw of fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : []) {
    const line = raw.trim();
    if (line === "[[headers]]") { rule = { pattern: "", values: {} }; rules.push(rule); inValues = false; continue; }
    if (line === "[headers.values]") { inValues = rule !== null; continue; }
    if (line.startsWith("[")) { rule = null; inValues = false; continue; }
    const m = /^"?([\w.-]+)"?\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(line);
    if (!m || !rule) continue;
    const value = m[3] ?? JSON.parse(`"${m[2]}"`);
    if (inValues) rule.values[m[1]] = value;
    else if (m[1] === "for") rule.pattern = value;
  }
  return rules.filter((r) => r.pattern);
}

const patternRe = (pattern) => new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/:\w+/g, "[^/]+") + "$");

function headersFor(urlPath) {
  const out = {};
  for (const rule of headerRules()) if (patternRe(rule.pattern).test(urlPath)) Object.assign(out, rule.values);
  return out;
}

// ===== static files =====
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".ico": "image/x-icon", ".webp": "image/webp", ".mp3": "audio/mpeg", ".woff2": "font/woff2",
};

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch (err) { return false; }
}

// public/<path> when it is a file inside public/, otherwise null
function publicFile(urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch (err) { return null; }
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.join(PUBLIC, rel);
  return file.startsWith(PUBLIC + path.sep) && isFile(file) ? file : null;
}

// With FIREBASE_EMULATORS=1 every page carries <meta name="jobdesk-emulators" content="<host>">, which makes the
// app use the Firebase emulators on that host. The browser reaches them on 127.0.0.1 unless
// FIREBASE_EMULATOR_BROWSER_HOST says otherwise (in Docker the e2e browser uses the "firebase" service).
const EMULATOR_BROWSER_HOST = process.env.FIREBASE_EMULATOR_BROWSER_HOST || "127.0.0.1";
const EMULATOR_META = process.env.FIREBASE_EMULATORS === "1"
  ? `<meta name="jobdesk-emulators" content="${EMULATOR_BROWSER_HOST}">`
  : "";

// The content policy allows the real Firebase hosts only; with the emulators the page also talks to them.
function devHeaders(urlPath) {
  const headers = headersFor(urlPath);
  const name = "Content-Security-Policy-Report-Only";
  if (EMULATOR_META && headers[name]) {
    const emulators = [9099, 8086].map((port) => `http://${EMULATOR_BROWSER_HOST}:${port}`).join(" ");
    headers[name] = headers[name].replace("connect-src ", `connect-src ${emulators} `);
  }
  return headers;
}

async function serveStatic(req, res, url) {
  const file = publicFile(url.pathname);
  const shown = file || path.join(PUBLIC, "404.html");
  let body = req.method === "HEAD" ? undefined : await fs.promises.readFile(shown);
  if (body && EMULATOR_META && shown.endsWith(".html")) body = body.toString("utf8").replace("<head>", "<head>\n" + EMULATOR_META);
  // Netlify's headers first; a dev server must never hand out stale code, so caching is always off
  res.writeHead(file ? 200 : 404, { ...devHeaders(url.pathname), "Content-Type": TYPES[path.extname(shown)] || "application/octet-stream", "Cache-Control": "no-cache" });
  res.end(body);
}

// ===== functions =====
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function invoke(file, event) {
  // drop the cached function and netlify/lib, so edits apply without a restart
  for (const key of Object.keys(require.cache)) if (key.startsWith(NETLIFY + path.sep)) delete require.cache[key];
  try {
    const result = await require(file).handler(event, {});
    if (!result || !result.statusCode) throw new Error("the handler returned no statusCode");
    return result;
  } catch (err) {
    console.error(err);
    return { statusCode: 502, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "Function crashed: " + err.message };
  }
}

async function runFunction(name, req, res, url) {
  const file = path.join(NETLIFY, "functions", name + ".js");
  if (!isFile(file)) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Function not found"); return; }
  const event = {
    httpMethod: req.method,
    path: url.pathname,
    rawUrl: `http://${req.headers.host}${req.url}`,
    headers: { ...req.headers, "x-nf-client-connection-ip": req.socket.remoteAddress },
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: await readBody(req),
    isBase64Encoded: false,
  };
  const started = Date.now();
  const cookieMode = (/(?:^|;\s*)jd_mock=(\w+)/.exec(req.headers.cookie || "") || [])[1];
  const result = await requestMock.run(MOCK_MODES.includes(cookieMode) ? cookieMode : undefined, () => invoke(file, event));
  console.log(`${new Date().toLocaleTimeString("en-GB")} ${req.method} ${name} -> ${result.statusCode} in ${Date.now() - started} ms${MOCK ? ` [mock ${MOCK_MODES.includes(cookieMode) ? cookieMode : mockMode}]` : ""}`);
  res.writeHead(result.statusCode, result.headers || {});
  res.end(result.body || "");
}

function switchMock(res, url) {
  const mode = url.searchParams.get("mode");
  const known = !mode || MOCK_MODES.includes(mode);
  if (mode && known) mockMode = mode;
  res.writeHead(known ? 200 : 400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(known ? { mode: mockMode, modes: MOCK_MODES } : { error: "unknown mode", modes: MOCK_MODES }));
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const fn = /^\/\.netlify\/functions\/([\w-]+)\/?$/.exec(url.pathname);
  if (fn) return runFunction(fn[1], req, res, url);
  if (MOCK && url.pathname === "/__mock") return switchMock(res, url);
  return serveStatic(req, res, url);
}

http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (res.headersSent) res.destroy();
    else { res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Internal error"); }
  });
}).listen(PORT, HOST, () => {
  const ai = MOCK ? "mock (switch with /__mock?mode=" + MOCK_MODES.join("|") + ")" : "real keys";
  console.log(`JobDesk 2000 dev server on http://${HOST}:${PORT}  AI: ${ai}${testCerts ? "  auth certs: " + process.env.AUTH_TEST_CERTS : ""}`);
});
