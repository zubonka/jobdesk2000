// Verifies Firebase ID tokens: RS256 JWTs signed with Google's rotating securetoken keys.
// Done by hand so the functions need no Admin SDK and no service account.
const crypto = require("crypto");

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "jobdesk2000";
const ISSUER = "https://securetoken.google.com/" + PROJECT_ID;
const CERTS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const CLOCK_SKEW = 60;

let cache = { certs: null, expires: 0, fetchedAt: 0 };

// force: the token names a key we do not have, as happens right after Google rotates its keys.
// Even then Google is asked at most once a minute, so junk tokens cannot make us hammer it.
async function googleCerts(force) {
  const fresh = force ? Date.now() - cache.fetchedAt < 60000 : Date.now() < cache.expires;
  if (cache.certs && fresh) return cache.certs;
  const res = await fetch(CERTS_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error("certs HTTP " + res.status);
  const certs = await res.json();
  const maxAge = /max-age=(\d+)/.exec(res.headers.get("cache-control") || "");
  cache = { certs, expires: Date.now() + (maxAge ? +maxAge[1] : 3600) * 1000, fetchedAt: Date.now() };
  return certs;
}

const decodePart = (s) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

function decode(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try {
    return { header: decodePart(parts[0]), payload: decodePart(parts[1]), signed: parts[0] + "." + parts[1], signature: parts[2] };
  } catch (e) {
    return null;
  }
}

function validClaims(p) {
  const now = Math.floor(Date.now() / 1000);
  return p.aud === PROJECT_ID && p.iss === ISSUER &&
    typeof p.sub === "string" && p.sub.length > 0 && p.sub.length <= 128 &&
    p.exp > now - CLOCK_SKEW && p.iat <= now + CLOCK_SKEW &&
    (p.auth_time == null || p.auth_time <= now + CLOCK_SKEW);
}

// Local development only: the Firebase Auth emulator signs nothing (alg "none"). Such tokens count only under
// scripts/dev-server.js (JOBDESK_LOCAL_DEV) with FIREBASE_AUTH_EMULATOR_HOST set, the switch the Admin SDK uses
// too. Netlify sets neither, so production never accepts them.
const emulatorTokensAllowed = () => process.env.JOBDESK_LOCAL_DEV === "1" && !!process.env.FIREBASE_AUTH_EMULATOR_HOST;

const userOf = (p) => ({ uid: p.sub, email: p.email || "", emailVerified: !!p.email_verified });

// Own keys only: a kid such as "constructor" must not pick up an Object.prototype member.
const certFor = (certs, kid) => (Object.hasOwn(certs, kid) ? certs[kid] : null);

// {uid, email, emailVerified} for a valid token, otherwise null
async function verifyIdToken(token) {
  const t = decode(token);
  if (!t || !t.header || !t.payload || !validClaims(t.payload)) return null;
  if (t.header.alg === "none" && emulatorTokensAllowed()) return userOf(t.payload);
  if (t.header.alg !== "RS256" || !t.header.kid) return null;
  let certs = await googleCerts(false);
  if (!certFor(certs, t.header.kid)) certs = await googleCerts(true);
  const pem = certFor(certs, t.header.kid);
  if (!pem) return null;
  const ok = crypto.verify("RSA-SHA256", Buffer.from(t.signed), crypto.createPublicKey(pem), Buffer.from(t.signature, "base64url"));
  return ok ? userOf(t.payload) : null;
}

// null for a missing or invalid token. Throws only when Google's keys cannot be fetched.
async function getUser(event) {
  const m = /^Bearer\s+(.+)$/i.exec((event.headers || {}).authorization || "");
  return m ? verifyIdToken(m[1].trim()) : null;
}

module.exports = { googleCerts, verifyIdToken, getUser };
