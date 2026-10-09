const { test } = require("node:test");
const assert = require("node:assert/strict");
const { event, bodyOf, SITE } = require("./helpers");
const { allowedOrigin, corsHeaders, guard, parseBody, str, rateLimit, clientIp } = require("../../netlify/lib/http");

test("allowedOrigin accepts the site, its deploy previews and localhost only", () => {
  for (const origin of [SITE, "https://deploy-preview-12--jobdeck2000.netlify.app", "https://main--jobdeck2000.netlify.app", "http://localhost:8888", "http://127.0.0.1:5173", "http://localhost"]) {
    assert.equal(allowedOrigin(origin), true, origin);
  }
  for (const origin of ["", undefined, "https://evil.example", "http://jobdeck2000.netlify.app", "https://jobdeck2000.netlify.app.evil.example",
    "https://evil--jobdeck2000.netlify.app.example", "https://jobdeck2000.netlify.app/", "http://localhost.evil.example", "null"]) {
    assert.equal(allowedOrigin(origin), false, String(origin));
  }
});

test("allowedOrigin also trusts URL and ALLOWED_ORIGINS from the environment", (t) => {
  process.env.URL = "https://jobdesk.example/";
  process.env.ALLOWED_ORIGINS = " https://a.example , https://b.example/";
  t.after(() => { delete process.env.URL; delete process.env.ALLOWED_ORIGINS; });
  assert.equal(allowedOrigin("https://jobdesk.example"), true);
  assert.equal(allowedOrigin("https://a.example"), true);
  assert.equal(allowedOrigin("https://b.example"), true);
  assert.equal(allowedOrigin("https://c.example"), false);
});

test("corsHeaders echo an allowed origin and say nothing to a foreign one", () => {
  const own = corsHeaders(event({ origin: SITE }));
  assert.equal(own["Access-Control-Allow-Origin"], SITE);
  assert.equal(own["Access-Control-Allow-Headers"], "Content-Type, Authorization");
  assert.equal(own.Vary, "Origin");
  assert.equal(own["Cache-Control"], "no-store");
  const foreign = corsHeaders(event({ origin: "https://evil.example" }));
  assert.equal(foreign["Access-Control-Allow-Origin"], undefined);
  assert.equal(foreign["Content-Type"], "application/json; charset=utf-8");
});

test("guard: 403 for a foreign site, 204 for a preflight, 405 for other methods, null to go on", () => {
  const foreign = event({ origin: "https://evil.example" });
  const denied = guard(foreign, corsHeaders(foreign));
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(bodyOf(denied), { error: "Доступ заборонено" });

  const preflight = event({ method: "OPTIONS" });
  assert.deepEqual(guard(preflight, corsHeaders(preflight)), { statusCode: 204, headers: corsHeaders(preflight), body: "" });

  const get = event({ method: "GET" });
  assert.equal(guard(get, corsHeaders(get)).statusCode, 405);

  assert.equal(guard(event(), {}), null);
  assert.equal(guard(event({ origin: null }), {}), null, "requests without Origin are not browsers, CORS does not apply");
});

test("parseBody: null for broken JSON, {} for JSON that is not an object", () => {
  assert.equal(parseBody({ body: "{broken" }), null);
  assert.deepEqual(parseBody({ body: "" }), {});
  assert.deepEqual(parseBody({ body: "null" }), {});
  assert.deepEqual(parseBody({ body: "42" }), {});
  assert.deepEqual(parseBody({ body: '{"a":1}' }), { a: 1 });
});

test("str trims, caps the length and blanks out control characters", () => {
  assert.equal(str("  hello  ", 10), "hello");
  assert.equal(str("abcdef", 3), "abc");
  assert.equal(str(null, 5), "");
  assert.equal(str(undefined, 5), "");
  assert.equal(str(12, 5), "12");
  assert.equal(str("a\u0000b\u0007c\nd\te", 20), "a b c\nd\te");
});

test("rateLimit allows max calls per window and keys are independent", () => {
  for (let i = 0; i < 3; i++) assert.equal(rateLimit("test:a", 3, 60000), true);
  assert.equal(rateLimit("test:a", 3, 60000), false);
  assert.equal(rateLimit("test:b", 3, 60000), true);
});

test("rateLimit forgets calls older than the window", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  assert.equal(rateLimit("test:window", 1, 1000), true);
  assert.equal(rateLimit("test:window", 1, 1000), false);
  t.mock.timers.tick(1001);
  assert.equal(rateLimit("test:window", 1, 1000), true);
});

test("clientIp prefers Netlify's header, then the first X-Forwarded-For hop", () => {
  assert.equal(clientIp(event({ headers: { "x-nf-client-connection-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8" } })), "1.2.3.4");
  assert.equal(clientIp(event({ headers: { "x-forwarded-for": " 5.6.7.8 , 10.0.0.1" } })), "5.6.7.8");
  assert.equal(clientIp(event()), "unknown");
});
