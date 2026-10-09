// Shared fixtures for the Netlify function tests: a fake Firebase signing key, token minting,
// a recording fetch stub for Google certs, Gemini and Groq, and Netlify event builders.
// Require it before any netlify module: it pins the environment those modules read at load time.
const crypto = require("node:crypto");
const path = require("node:path");

const NETLIFY = path.join(__dirname, "../../netlify");
const PROJECT = "jobdesk2000";
const KID = "test-kid";
const SITE = "https://jobdeck2000.netlify.app";

process.env.FIREBASE_PROJECT_ID = PROJECT;
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.GROQ_API_KEY = "test-groq-key";
for (const name of ["GEMINI_MODELS_FAST", "GEMINI_MODELS_WRITE", "GROQ_MODELS", "URL", "ALLOWED_ORIGINS"]) delete process.env[name];

// The functions log every model attempt; that would bury the test report.
console.log = () => {};

const signer = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
// Google serves X.509 certificates; createPublicKey takes an SPKI public key PEM just the same.
const CERTS = { [KID]: signer.publicKey.export({ type: "spki", format: "pem" }) };

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

function claims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://securetoken.google.com/" + PROJECT, aud: PROJECT, sub: "uid-1",
    iat: now - 10, exp: now + 3600, auth_time: now - 100, email: "olena@example.com", email_verified: true,
    ...overrides,
  };
}

function signToken(payload = claims(), { header = { alg: "RS256", kid: KID, typ: "JWT" }, key = signer.privateKey } = {}) {
  const data = b64(header) + "." + b64(payload);
  return data + "." + crypto.sign("RSA-SHA256", Buffer.from(data), key).toString("base64url");
}

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const certsReply = () => json(200, CERTS, { "cache-control": "public, max-age=3600" });
const geminiReply = (text, finishReason = "STOP") => json(200, { candidates: [{ content: { parts: [{ text }] }, finishReason }] });
const groqReply = (content, finishReason = "stop") => json(200, { choices: [{ message: { content }, finish_reason: finishReason }] });
const overloaded = () => json(503, { error: { code: 503, message: "The model is overloaded. Please try again later." } });

const GEMINI_RE = /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/([^:/]+):generateContent$/;

// Replaces global fetch. handlers: {gemini(model, body), groq(body), certs()}, each returning a Response.
// Returns the list of calls, each {engine, url, model, headers, body}; a missing handler fails the call.
function stubFetch(handlers = {}) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const href = String(url);
    if (href.includes("securetoken@system.gserviceaccount.com")) {
      calls.push({ engine: "certs", url: href });
      return (handlers.certs || certsReply)();
    }
    const body = opts.body ? JSON.parse(opts.body) : null;
    const gemini = GEMINI_RE.exec(href);
    const engine = gemini ? "gemini" : href === "https://api.groq.com/openai/v1/chat/completions" ? "groq" : null;
    if (!engine) throw new Error("unexpected fetch " + href);
    const model = gemini ? gemini[1] : body.model;
    calls.push({ engine, url: href, model, headers: opts.headers, body });
    if (!handlers[engine]) throw new Error("no " + engine + " stub");
    return engine === "gemini" ? handlers.gemini(model, body) : handlers.groq(body);
  };
  return calls;
}

const geminiPrompt = (call) => call.body.contents[0].parts[0].text;

function event({ method = "POST", body = {}, origin = SITE, token, headers = {} } = {}) {
  const all = { ...headers };
  if (origin) all.origin = origin;
  if (token) all.authorization = "Bearer " + token;
  return { httpMethod: method, headers: all, body: typeof body === "string" ? body : JSON.stringify(body) };
}

const bodyOf = (res) => JSON.parse(res.body);

// A module from netlify/ loaded anew together with everything it requires, so caches start empty.
function freshRequire(relPath) {
  for (const key of Object.keys(require.cache)) if (key.startsWith(NETLIFY)) delete require.cache[key];
  return require(path.join(NETLIFY, relPath));
}

module.exports = {
  NETLIFY, PROJECT, KID, SITE, CERTS, stranger,
  claims, signToken, b64, json, certsReply, geminiReply, groqReply, overloaded, stubFetch, geminiPrompt, event, bodyOf, freshRequire,
};
