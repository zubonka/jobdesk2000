const { test } = require("node:test");
const assert = require("node:assert/strict");
const { claims, signToken, b64, stranger, KID, CERTS, json, stubFetch, freshRequire } = require("./helpers");

stubFetch();
const { verifyIdToken, getUser } = freshRequire("lib/firebase-auth");

const now = () => Math.floor(Date.now() / 1000);
const tamper = (token, payload) => { const parts = token.split("."); parts[1] = b64(payload); return parts.join("."); };

test("a valid token gives the user", async () => {
  assert.deepEqual(await verifyIdToken(signToken()), { uid: "uid-1", email: "olena@example.com", emailVerified: true });
});

test("a token without email still gives the uid", async () => {
  assert.deepEqual(await verifyIdToken(signToken(claims({ email: undefined, email_verified: undefined }))), { uid: "uid-1", email: "", emailVerified: false });
});

const rejected = {
  "wrong aud": () => signToken(claims({ aud: "other-project" })),
  "wrong iss": () => signToken(claims({ iss: "https://securetoken.google.com/other-project" })),
  "expired": () => signToken(claims({ exp: now() - 120 })),
  "future iat": () => signToken(claims({ iat: now() + 600 })),
  "missing iat": () => signToken(claims({ iat: undefined })),
  "future auth_time": () => signToken(claims({ auth_time: now() + 600 })),
  "empty sub": () => signToken(claims({ sub: "" })),
  "numeric sub": () => signToken(claims({ sub: 42 })),
  "overlong sub": () => signToken(claims({ sub: "x".repeat(129) })),
  "bad signature": () => signToken(claims(), { key: stranger.privateKey }),
  "unknown kid": () => signToken(claims(), { header: { alg: "RS256", kid: "rotated-away" } }),
  "prototype kid": () => signToken(claims(), { header: { alg: "RS256", kid: "constructor" } }),
  "missing kid": () => signToken(claims(), { header: { alg: "RS256" } }),
  "alg none": () => b64({ alg: "none", kid: KID }) + "." + b64(claims()) + ".",
  "alg HS256": () => b64({ alg: "HS256", kid: KID }) + "." + b64(claims()) + ".c2lnbmF0dXJl",
  // validly signed, so only the header check can refuse it
  "alg RS512 header": () => signToken(claims(), { header: { alg: "RS512", kid: KID } }),
  "tampered payload": () => tamper(signToken(), claims({ sub: "admin" })),
  "null header": () => b64(null) + "." + b64(claims()) + ".x",
  "null payload": () => b64({ alg: "RS256", kid: KID }) + "." + b64(null) + ".x",
  "not base64 JSON": () => "abc.def.ghi",
  "two parts": () => "abc.def",
  "empty": () => "",
};

for (const [name, make] of Object.entries(rejected)) {
  test("rejects: " + name, async () => {
    assert.equal(await verifyIdToken(make()), null);
  });
}

test("allows a minute of clock skew on exp", async () => {
  assert.ok(await verifyIdToken(signToken(claims({ exp: now() - 30 }))));
  assert.equal(await verifyIdToken(signToken(claims({ exp: now() - 61 }))), null);
});

test("certs are cached for max-age, and an unknown kid refetches at most once a minute", async (t) => {
  const calls = stubFetch({ certs: () => json(200, CERTS, { "cache-control": "public, max-age=100" }) });
  t.after(() => stubFetch());
  const auth = freshRequire("lib/firebase-auth");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const certFetches = () => calls.filter((c) => c.engine === "certs").length;

  for (let i = 0; i < 3; i++) assert.ok(await auth.verifyIdToken(signToken()));
  assert.equal(certFetches(), 1);

  const unknown = signToken(claims(), { header: { alg: "RS256", kid: "new-key" } });
  assert.equal(await auth.verifyIdToken(unknown), null);
  assert.equal(await auth.verifyIdToken(unknown), null);
  assert.equal(certFetches(), 1, "the forced refresh is skipped while the cache is under a minute old");

  t.mock.timers.tick(61 * 1000);
  assert.equal(await auth.verifyIdToken(unknown), null);
  assert.equal(certFetches(), 2, "after a minute an unknown kid may refresh the certs");

  t.mock.timers.tick(101 * 1000);
  assert.ok(await auth.verifyIdToken(signToken(claims())));
  assert.equal(certFetches(), 3, "max-age expired");
});

test("a key rotated in after the cache was filled is picked up by the forced refresh", async (t) => {
  let certs = {};
  stubFetch({ certs: () => json(200, certs, { "cache-control": "max-age=3600" }) });
  t.after(() => stubFetch());
  const auth = freshRequire("lib/firebase-auth");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  assert.equal(await auth.verifyIdToken(signToken()), null);
  certs = CERTS;
  t.mock.timers.tick(61 * 1000);
  assert.ok(await auth.verifyIdToken(signToken(claims())));
});

test("getUser reads a Bearer token from the Authorization header", async () => {
  const token = signToken();
  const user = (authorization) => getUser({ headers: authorization === undefined ? {} : { authorization } });
  assert.equal(await user(undefined), null);
  assert.equal(await getUser({}), null);
  assert.equal((await user("Bearer " + token)).uid, "uid-1");
  assert.equal((await user("bearer   " + token + "  ")).uid, "uid-1");
  assert.equal(await user("Basic " + token), null);
  assert.equal(await user("Bearer"), null);
  assert.equal(await user(token), null);
  assert.equal(await user("Bearer " + signToken(claims({ aud: "x" }))), null);
});

test("getUser throws when Google's certs cannot be fetched, so callers can answer 503 instead of 401", async (t) => {
  stubFetch({ certs: () => json(500, {}) });
  t.after(() => stubFetch());
  const auth = freshRequire("lib/firebase-auth");
  await assert.rejects(auth.getUser({ headers: { authorization: "Bearer " + signToken() } }), /certs HTTP 500/);
  stubFetch();
  assert.ok(await auth.getUser({ headers: { authorization: "Bearer " + signToken() } }), "recovers once Google answers");
});
