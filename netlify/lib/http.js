// Request plumbing shared by the functions: CORS limited to our own sites, body parsing,
// input sanitising and a best-effort rate limit.
// netlify/lib sits outside netlify/functions, so Netlify does not deploy it as a function; esbuild bundles it in.

// The production site, its deploy previews and branch deploys (name--jobdeck2000.netlify.app),
// and localhost for development. A custom domain goes into ALLOWED_ORIGINS (comma-separated).
const SITE_RE = /^https:\/\/([a-z0-9-]+--)?jobdeck2000\.netlify\.app$/;
const LOCAL_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const header = (event, name) => (event.headers || {})[name] || "";

function extraOrigins() {
  return [process.env.URL, ...(process.env.ALLOWED_ORIGINS || "").split(",")]
    .map((s) => (s || "").trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function allowedOrigin(origin) {
  return !!origin && (SITE_RE.test(origin) || LOCAL_RE.test(origin) || extraOrigins().includes(origin));
}

function corsHeaders(event) {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Vary: "Origin" };
  const origin = header(event, "origin");
  if (allowedOrigin(origin)) {
    Object.assign(headers, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Max-Age": "600",
    });
  }
  return headers;
}

const reply = (headers, statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });

// Answers preflights, wrong methods and foreign sites. Returns a finished response, or null to carry on.
// Requests without an Origin header (curl, server to server) are let through: CORS only protects browsers.
function guard(event, headers) {
  const origin = header(event, "origin");
  if (origin && !allowedOrigin(origin)) return reply(headers, 403, { error: "Доступ заборонено" });
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return reply(headers, 405, { error: "Method not allowed" });
  return null;
}

// null when the body is not JSON; JSON that is not an object counts as an empty request
function parseBody(event) {
  try {
    const body = JSON.parse(event.body || "{}");
    return body && typeof body === "object" ? body : {};
  } catch (e) {
    return null;
  }
}

// Any client value as a trimmed string of at most max characters, without control characters
const str = (v, max) => (v == null ? "" : String(v)).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").trim().slice(0, max);

// Lives only as long as a warm function instance: a brake on runaway loops, not an exact quota.
const buckets = new Map();

function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const recent = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  const allowed = recent.length < max;
  if (allowed) recent.push(now);
  buckets.set(key, recent);
  if (buckets.size > 5000) buckets.clear();
  return allowed;
}

const clientIp = (event) =>
  header(event, "x-nf-client-connection-ip") || header(event, "x-forwarded-for").split(",")[0].trim() || "unknown";

module.exports = { allowedOrigin, corsHeaders, reply, guard, parseBody, str, rateLimit, clientIp };
