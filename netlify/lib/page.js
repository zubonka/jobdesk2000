// Fetches vacancy pages named by users and turns their HTML into text and fields.
// The URL comes from the client, so the fetch is locked down: http(s) on standard ports only, public IPs only
// (checked when connecting, so DNS rebinding cannot slip past), redirects followed by hand and checked again,
// capped size and time. Every failure is a FetchError and the client gets one generic message for all of them.
const dns = require("dns");
const net = require("net");
const http = require("http");
const https = require("https");
const { pipeline } = require("stream");
const zlib = require("zlib");

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_HOPS = 5;
const REQUEST_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; JobDesk2000/1.0; +https://jobdeck2000.netlify.app)",
  Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
  "Accept-Language": "uk,en;q=0.8,ru;q=0.5",
  "Accept-Encoding": "gzip, deflate, br",
};

class FetchError extends Error {}

function isPrivateIPv4(ip) {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

// A dotted IPv4-mapped address (::ffff:1.2.3.4) is judged by its IPv4 part.
function isPrivateIPv6(ip) {
  const s = ip.toLowerCase();
  if (s === "::" || s === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return isPrivateIp(mapped[1]);
  // any other "::..." form: IPv4-mapped in hex, or the deprecated IPv4-compatible ::/96
  if (s.startsWith("::")) return true;
  return /^(64:ff9b:|100::|2001:db8|fc|fd|fe[89ab]|ff)/.test(s);
}

// Anything that is not a valid IP address counts as private.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true;
}

// dns.lookup for http.request that refuses to connect when any resolved address is private.
function safeLookup(hostname, options, cb) {
  if (typeof options === "function") { cb = options; options = {}; }
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
      return cb(Object.assign(new Error("blocked address"), { code: "EBLOCKED" }));
    }
    if (options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

// An IP literal never reaches safeLookup (Node connects to it directly), so it is checked here.
function checkUrl(u) {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new FetchError("protocol");
  if (u.username || u.password) throw new FetchError("credentials");
  if (u.port && u.port !== "80" && u.port !== "443") throw new FetchError("port");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isPrivateIp(host)) throw new FetchError("private ip");
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new FetchError("local host");
}

function decoderFor(res) {
  const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
  if (encoding === "gzip" || encoding === "x-gzip") return zlib.createGunzip();
  if (encoding === "deflate") return zlib.createInflate();
  if (encoding === "br") return zlib.createBrotliDecompress();
  return null;
}

// pipeline, not pipe: a connection dropped mid-body must reach the decoder as an "error" event (getOnce
// listens there), or the read never settles because req "close" has already cleared the deadline timer.
function decompress(res) {
  const decoder = decoderFor(res);
  return decoder ? pipeline(res, decoder, () => {}) : res;
}

// One GET without following redirects: resolves to {redirect} or {buf, type}.
// A body over MAX_BYTES is cut short rather than refused: the analysis only uses the start of the text anyway.
function getOnce(u, deadline) {
  return new Promise((resolve, reject) => {
    // Checked before the request exists: a request destroyed before its error listener is attached
    // emits "socket hang up" with nobody listening, which crashes the function.
    const left = deadline - Date.now();
    if (left <= 0) return reject(new FetchError("timeout"));
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, { method: "GET", lookup: safeLookup, headers: REQUEST_HEADERS }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: res.headers.location });
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new FetchError("status " + res.statusCode));
      }
      const type = String(res.headers["content-type"] || "");
      if (type && !/text\/html|xhtml|text\/plain|xml/i.test(type)) {
        res.resume();
        return reject(new FetchError("type " + type));
      }
      const chunks = [];
      let size = 0;
      const stream = decompress(res);
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          req.destroy();
          resolve({ buf: Buffer.concat(chunks), type });
        } else {
          chunks.push(chunk);
        }
      });
      stream.on("end", () => resolve({ buf: Buffer.concat(chunks), type }));
      stream.on("error", (e) => reject(new FetchError("decode " + e.message)));
    });
    const timer = setTimeout(() => req.destroy(new FetchError("timeout")), left);
    req.on("close", () => clearTimeout(timer));
    req.on("error", (e) => reject(e instanceof FetchError ? e : new FetchError(e.code || e.message)));
    req.end();
  });
}

// Charset from the Content-Type header, else from a <meta> tag near the top, else UTF-8.
function decodeBody(buf, type) {
  const charset = (/charset=["']?([\w-]+)/i.exec(type) ||
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString("latin1")) || [])[1];
  try {
    return new TextDecoder((charset || "utf-8").toLowerCase()).decode(buf);
  } catch (e) {
    return new TextDecoder("utf-8").decode(buf);
  }
}

// Both the client's URL and a site's Location header can be malformed.
function parseUrl(raw, base) {
  try { return new URL(raw, base); } catch (e) { throw new FetchError("bad url"); }
}

async function fetchPage(rawUrl, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 9000);
  let u = parseUrl(rawUrl);
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    checkUrl(u);
    const r = await getOnce(u, deadline);
    if (!r.redirect) return { html: decodeBody(r.buf, r.type), url: u.href };
    u = parseUrl(r.redirect, u);
  }
  throw new FetchError("too many redirects");
}

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", laquo: "«", raquo: "»",
  hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", bull: "•", middot: "·", euro: "€", hryvnia: "₴",
};

function decodeEntity(match, name) {
  if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? match;
  const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
  try { return String.fromCodePoint(code); } catch (e) { return " "; }
}

// One pass, so "&amp;lt;" becomes "&lt;" and not "<".
const decodeEntities = (s) => String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity);

// The page is untrusted and can be up to MAX_BYTES, so nothing below may backtrack: block removal scans with
// indexOf, and tag patterns cannot run past the next "<". A crafted page costs one pass, not one pass per tag.

// Index of the next "<tag" that is really that tag (not "<scripts" for "script"), or -1.
function findTag(lower, tag, from) {
  for (let i = lower.indexOf("<" + tag, from); i >= 0; i = lower.indexOf("<" + tag, i + 1)) {
    if (!/[a-z0-9-]/.test(lower[i + tag.length + 1] || "")) return i;
  }
  return -1;
}

// Replaces every <tag>...</tag> block with a space; an unclosed block drops the rest of the page.
function dropBlocks(html, tags) {
  for (const tag of tags) {
    const lower = html.toLowerCase();
    let out = "", pos = 0;
    for (let start = findTag(lower, tag, 0); start >= 0; start = findTag(lower, tag, pos)) {
      out += html.slice(pos, start) + " ";
      const end = lower.indexOf("</" + tag, start);
      pos = end < 0 ? html.length : lower.indexOf(">", end) + 1 || html.length;
    }
    html = out + html.slice(pos);
  }
  return html;
}

function dropComments(html) {
  let out = "", pos = 0;
  for (let start = html.indexOf("<!--"); start >= 0; start = html.indexOf("<!--", pos)) {
    out += html.slice(pos, start) + " ";
    const end = html.indexOf("-->", start + 4);
    pos = end < 0 ? html.length : end + 3;
  }
  return out + html.slice(pos);
}

// Inner HTML of the first <tag>...</tag>, or "" when there is none.
function firstBlock(html, tag) {
  const lower = html.toLowerCase();
  const start = findTag(lower, tag, 0);
  if (start < 0) return "";
  const open = lower.indexOf(">", start);
  const end = lower.indexOf("</" + tag, open);
  return open < 0 || end < 0 ? "" : html.slice(open + 1, end);
}

function htmlToText(html) {
  return decodeEntities(dropBlocks(dropComments(String(html || "")), ["script", "style", "noscript", "svg", "template", "iframe", "head"])
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|section|article|header|footer)>/gi, "\n")
    .replace(/<[^<>]*>/g, " "))
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n[\s]*/g, "\n")
    .trim();
}

// Walks the <meta tags one at a time. A tag ends at its ">" before the next "<"; one without it is skipped.
// The segments between "<" never overlap, so the page is read once however it is built.
function metaContent(html, key) {
  const lower = html.toLowerCase();
  const attr = new RegExp("(?:property|name)=[\"']" + key + "[\"']", "i");
  for (let i = findTag(lower, "meta", 0); i >= 0; i = findTag(lower, "meta", i + 1)) {
    const next = lower.indexOf("<", i + 1);
    const segment = lower.slice(i, next < 0 ? lower.length : next);
    const close = segment.indexOf(">");
    if (close >= 0) {
      const tag = html.slice(i, i + close + 1);
      // the value ends at the quote that opened it: "комп'ютер" inside double quotes is one word
      if (attr.test(tag)) { const m = /content=(?:"([^"]*)"|'([^']*)')/i.exec(tag); return decodeEntities((m && (m[1] ?? m[2])) || "").trim(); }
    }
    if (next < 0) break;
    i = next - 1;
  }
  return "";
}

// Some sites HTML-escape the JSON inside the script tag.
function parseLdJson(raw) {
  try { return JSON.parse(raw.trim()); } catch (e) { /* try the unescaped form */ }
  try { return JSON.parse(decodeEntities(raw).trim()); } catch (e) { return null; }
}

function findJobPostingIn(data) {
  const stack = [data];
  while (stack.length) {
    const x = stack.pop();
    if (!x || typeof x !== "object") continue;
    if (Array.isArray(x)) { stack.push(...x); continue; }
    const type = x["@type"];
    if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) return x;
    if (x["@graph"]) stack.push(x["@graph"]);
  }
  return null;
}

// Bodies of the <script type="application/ld+json"> blocks.
function* ldJsonBlocks(html) {
  const lower = html.toLowerCase();
  for (let start = findTag(lower, "script", 0); start >= 0; start = findTag(lower, "script", start + 1)) {
    const open = lower.indexOf(">", start);
    if (open < 0) return;
    // not JSON-LD: carry on after this tag, so no stretch of the page is searched twice
    if (!/type=["']?application\/ld\+json/.test(lower.slice(start, Math.min(open, start + 500)))) { start = open; continue; }
    const end = lower.indexOf("</script", open);
    if (end < 0) return;
    yield html.slice(open + 1, end);
    start = end;
  }
}

// schema.org JobPosting, published by work.ua, robota.ua, djinni, LinkedIn, Indeed and many career pages
function findJobPosting(html) {
  for (const raw of ldJsonBlocks(html)) {
    const found = findJobPostingIn(parseLdJson(raw));
    if (found) return found;
  }
  return null;
}

const EMPLOYMENT = {
  FULL_TIME: "Full-time", PART_TIME: "Part-time", CONTRACTOR: "Project / Контракт", TEMPORARY: "Project / Контракт",
  INTERN: "Стажування", PER_DIEM: "Project / Контракт",
};
const SALARY_UNITS = { MONTH: "міс", YEAR: "рік", HOUR: "год", DAY: "день", WEEK: "тиждень" };
const formatAmount = (n) => (typeof n === "number" ? n.toLocaleString("uk-UA") : String(n));

function salaryText(jp) {
  const raw = jp.baseSalary || jp.estimatedSalary;
  if (typeof raw === "string" || typeof raw === "number") return String(raw);
  const b = Array.isArray(raw) ? raw[0] : raw;
  if (!b || typeof b !== "object") return "";
  const v = b.value && typeof b.value === "object" ? b.value : b;
  let amount = "";
  if (v.minValue != null || v.maxValue != null) {
    amount = [v.minValue, v.maxValue].filter((x) => x != null && x !== "").map(formatAmount).join("–");
  } else if (v.value != null && typeof v.value !== "object") {
    amount = formatAmount(v.value);
  }
  if (!amount) return "";
  const unit = SALARY_UNITS[String(v.unitText || "").toUpperCase()];
  return (amount + " " + (b.currency || v.currency || "")).trim() + (unit ? " / " + unit : "");
}

function placeText(place) {
  const a = place && place.address;
  if (!a) return "";
  if (typeof a === "string") return a;
  const country = a.addressCountry;
  return [a.addressLocality, a.addressRegion, country && (country.name || country)]
    .filter((x) => x && typeof x === "string")
    .join(", ");
}

function jobPostingFields(jp) {
  const org = jp.hiringOrganization;
  const company = typeof org === "string" ? org : (org && org.name) || "";
  return {
    title: decodeEntities(jp.title || jp.name || "").trim(),
    company: decodeEntities(company).trim(),
    salary: salaryText(jp),
    emp: [].concat(jp.employmentType || []).map((e) => EMPLOYMENT[String(e).toUpperCase()] || "").find(Boolean) || "",
    remote: /TELECOMMUTE/i.test(JSON.stringify(jp.jobLocationType || "")),
    location: [].concat(jp.jobLocation || []).map(placeText).filter(Boolean).join("; "),
    industry: [].concat(jp.industry || jp.occupationalCategory || []).filter((x) => typeof x === "string").join(", "),
    desc: htmlToText(decodeEntities(String(jp.description || ""))).slice(0, 6000),
  };
}

module.exports = {
  isPrivateIp, checkUrl, fetchPage, FetchError, decodeEntities, htmlToText, firstBlock, metaContent, findJobPosting, jobPostingFields,
};
