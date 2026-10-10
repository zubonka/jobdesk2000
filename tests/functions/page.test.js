const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const dns = require("node:dns");
const http = require("node:http");
const zlib = require("node:zlib");
require("./helpers");
const {
  isPrivateIp, checkUrl, fetchPage, FetchError, decodeEntities, htmlToText, firstBlock, metaContent, findJobPosting, jobPostingFields,
} = require("../../netlify/lib/page");

const NBSP = "\u00a0";

test("isPrivateIp: loopback, RFC 1918, link-local, CGNAT, multicast and reserved IPv4", () => {
  for (const ip of ["127.0.0.1", "127.255.255.254", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "100.127.255.255", "192.0.0.8", "198.18.0.1", "198.19.255.255", "224.0.0.1", "255.255.255.255"]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "169.255.0.1", "193.0.0.1"]) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test("isPrivateIp: IPv6 loopback, unspecified, ULA, link-local, mapped and NAT64", () => {
  for (const ip of ["::1", "::", "fd00::1", "fc00::1", "fe80::1", "FE80::1", "febf::1", "ff02::1", "2001:db8::1", "100::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1"]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ["2001:4860:4860::8888", "2a00:1450:4001::1", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test("isPrivateIp treats anything that is not an IP as private", () => {
  for (const value of ["", "localhost", "example.com", "1.2.3", "999.1.1.1"]) assert.equal(isPrivateIp(value), true, value);
});

const refusal = (url) => {
  try {
    checkUrl(new URL(url));
    return null;
  } catch (err) {
    assert.ok(err instanceof FetchError, url);
    return err.message;
  }
};

test("checkUrl accepts public http(s) URLs on standard ports", () => {
  for (const url of ["https://jobs.dou.ua/vacancies/123/", "http://example.com/", "https://example.com:443/x", "http://example.com:80/", "https://[2001:4860:4860::8888]/"]) {
    assert.equal(refusal(url), null, url);
  }
});

test("checkUrl refuses private IPs in every spelling the URL parser normalises", () => {
  for (const url of ["http://127.0.0.1/", "http://2130706433/", "http://0x7f000001/", "http://127.1/", "http://0177.0.0.1/",
    "http://10.0.0.5/", "http://192.168.0.1/", "http://169.254.169.254/latest/meta-data/", "http://100.64.0.1/",
    "http://[::1]/", "http://[fd00::1]/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/", "http://0.0.0.0/"]) {
    assert.equal(refusal(url), "private ip", url);
  }
});

test("checkUrl refuses other protocols, credentials, non-standard ports and local names", () => {
  assert.equal(refusal("ftp://example.com/file"), "protocol");
  assert.equal(refusal("file:///etc/passwd"), "protocol");
  assert.equal(refusal("javascript:alert(1)"), "protocol");
  assert.equal(refusal("http://user:pass@example.com/"), "credentials");
  assert.equal(refusal("http://user@example.com/"), "credentials");
  assert.equal(refusal("http://example.com:8080/"), "port");
  assert.equal(refusal("https://example.com:22/"), "port");
  assert.equal(refusal("http://localhost/"), "local host");
  assert.equal(refusal("http://LOCALHOST/"), "local host");
  assert.equal(refusal("http://printer.local/"), "local host");
  assert.equal(refusal("http://metadata.google.internal/"), "local host");
});

// A real server on 127.0.0.1 that counts the requests reaching it.
async function localServer(t) {
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; res.end("<html>secret</html>"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { port: server.address().port, hits: () => hits };
}

const fetchError = async (url) => {
  try {
    await fetchPage(url, 3000);
  } catch (err) {
    assert.ok(err instanceof FetchError, String(err));
    return err.message;
  }
  assert.fail("fetchPage should have refused " + url);
};

test("fetchPage refuses a local HTTP server", async (t) => {
  const server = await localServer(t);
  assert.equal(await fetchError(`http://127.0.0.1:${server.port}/`), "port");
  assert.equal(await fetchError(`http://localhost:${server.port}/`), "port");
  assert.equal(await fetchError("http://127.0.0.1/"), "private ip");
  assert.equal(await fetchError("http://localhost/"), "local host");
  assert.equal(server.hits(), 0);
});

test("fetchPage refuses a public-looking hostname that resolves to a private address", async (t) => {
  const lookups = [];
  t.mock.method(dns, "lookup", (host, options, cb) => {
    lookups.push({ host, options });
    cb(null, host === "rebind.example.com" ? [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]);
  });
  assert.equal(await fetchError("http://intranet.example.com/"), "EBLOCKED");
  assert.equal(await fetchError("https://rebind.example.com/"), "EBLOCKED", "one private address among public ones is enough to refuse");
  assert.deepEqual(lookups.map((l) => l.host), ["intranet.example.com", "rebind.example.com"]);
  assert.deepEqual(lookups[0].options, { all: true, verbatim: true });
});

test("fetchPage rejects a malformed URL with a FetchError", async () => {
  assert.equal(await fetchError("not a url"), "bad url");
});

// Serves routes on 127.0.0.1 and sends every request fetchPage makes there, keeping the path. The address
// checks still see the public URL, so the real HTTP client, redirects and decoding run without a network.
async function routed(t, routes) {
  const server = http.createServer((req, res) => routes[req.url](req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const requested = [];
  const realRequest = http.request;
  t.mock.method(http, "request", (u, options, onResponse) => {
    requested.push(u.href);
    return realRequest(new URL(u.pathname, base), options, onResponse);
  });
  return requested;
}

const redirect = (location) => (req, res) => { res.writeHead(302, { location }); res.end(); };
const JOBS = "http://jobs.example.com";

test("fetchPage follows redirects and checks every target again", async (t) => {
  const targets = {
    "http://127.0.0.1/admin": "private ip", "http://169.254.169.254/latest/meta-data/": "private ip", "http://[::1]/": "private ip",
    "ftp://example.com/file": "protocol", "http://example.com:8080/": "port", "http://localhost/": "local host", "http://[broken": "bad url",
  };
  const routes = { "/page": (req, res) => res.end("<html>vacancy</html>"), "/relative": redirect("/page") };
  for (const [i, target] of Object.keys(targets).entries()) routes["/r" + i] = redirect(target);
  const requested = await routed(t, routes);

  assert.deepEqual(await fetchPage(JOBS + "/relative", 3000), { html: "<html>vacancy</html>", url: JOBS + "/page" });
  for (const [i, [target, reason]] of Object.entries(targets).entries()) {
    assert.equal(await fetchError(JOBS + "/r" + i), reason, target);
  }
  assert.deepEqual(requested, [JOBS + "/relative", JOBS + "/page", ...Object.keys(targets).map((_, i) => JOBS + "/r" + i)],
    "a refused target is never requested");
});

test("a redirect that arrives after the deadline ends the fetch without another request", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const requested = await routed(t, {
    "/slow": (req, res) => { t.mock.timers.tick(5000); redirect("/page")(req, res); },
    "/page": (req, res) => res.end("<html>late</html>"),
  });
  assert.equal(await fetchError(JOBS + "/slow"), "timeout");
  assert.deepEqual(requested, [JOBS + "/slow"]);
});

const noisyGzip = zlib.gzipSync(crypto.randomBytes(100000).toString("hex"));

test("fetchPage decodes compressed pages, caps their size and honours the charset", async (t) => {
  const MAX = 2 * 1024 * 1024;
  await routed(t, {
    "/gzip": (req, res) => { res.writeHead(200, { "content-encoding": "gzip" }); res.end(zlib.gzipSync("<p>Привіт</p>")); },
    "/br": (req, res) => { res.writeHead(200, { "content-encoding": "br" }); res.end(zlib.brotliCompressSync("<p>Вакансія</p>")); },
    "/bomb": (req, res) => { res.writeHead(200, { "content-encoding": "gzip" }); res.end(zlib.gzipSync(Buffer.alloc(8 * MAX, 97))); },
    // "Привіт" in windows-1251, still common on older Ukrainian sites
    "/cp1251": (req, res) => { res.writeHead(200, { "content-type": "text/html; charset=windows-1251" }); res.end(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xb3, 0xf2])); },
    "/pdf": (req, res) => { res.writeHead(200, { "content-type": "application/pdf" }); res.end("%PDF"); },
  });
  assert.equal((await fetchPage(JOBS + "/gzip", 3000)).html, "<p>Привіт</p>");
  assert.equal((await fetchPage(JOBS + "/br", 3000)).html, "<p>Вакансія</p>");
  const { html } = await fetchPage(JOBS + "/bomb", 3000);
  assert.ok(html.length > MAX / 2 && html.length <= MAX, "a decompression bomb is cut at the cap: " + html.length);
  assert.equal((await fetchPage(JOBS + "/cp1251", 3000)).html, "Привіт");
  assert.equal(await fetchError(JOBS + "/pdf"), "type application/pdf");
});

// Before pipeline() this never settled: the decoder waited for data forever and the timer was already cleared.
test("a compressed page whose connection drops mid-body fails instead of hanging", { timeout: 5000 }, async (t) => {
  await routed(t, {
    "/cut": (req, res) => {
      res.writeHead(200, { "content-encoding": "gzip" });
      res.write(noisyGzip.subarray(0, 4096));
      setTimeout(() => res.socket.destroy(), 20);
    },
  });
  assert.match(await fetchError(JOBS + "/cut"), /^decode /);
});

test("decodeEntities handles named, decimal and hex entities in one pass", () => {
  assert.equal(decodeEntities("A &amp; B &lt;i&gt; &quot;q&quot; &apos;s&apos; &#39;x&#39;"), "A & B <i> \"q\" 's' 'x'");
  assert.equal(decodeEntities("&laquo;Офіс&raquo; &mdash; &ndash; &hellip; &nbsp;&hryvnia;&euro;"), "«Офіс» — – …  ₴€");
  assert.equal(decodeEntities("&#x2014;&#8212;&#X41;&#128512;"), "——A😀");
  assert.equal(decodeEntities("&AMP;"), "&", "named entities ignore case");
  assert.equal(decodeEntities("&amp;lt;"), "&lt;", "decoded once, not twice");
  assert.equal(decodeEntities("&unknown; & &;"), "&unknown; & &;");
  assert.equal(decodeEntities("&#x110000;"), " ", "a code point past Unicode becomes a space");
  assert.equal(decodeEntities(null), "");
});

test("htmlToText drops scripts, styles, comments and head, and keeps block breaks", () => {
  const html = "<html><head><title>T</title><style>.a{color:red}</style></head><body>" +
    "<script>alert('x')</script><!-- hidden --><h1>Senior&nbsp;Designer</h1>" +
    "<p>Line one<br>Line two<br/>Line   three</p><ul><li>A &amp; B</li><li>&laquo;Київ&raquo;</li></ul>" +
    "<noscript>no js</noscript><svg><text>logo</text></svg><div>Salary:" + NBSP + NBSP + "2000$</div></body></html>";
  assert.equal(htmlToText(html), "Senior Designer\nLine one\nLine two\nLine three\nA & B\n«Київ»\nSalary: 2000$");
  assert.equal(htmlToText(""), "");
});

test("metaContent reads property and name meta tags", () => {
  const html = '<meta property="og:title" content="Designer &amp; Co"><meta name="description" content=" Робота мрії ">';
  assert.equal(metaContent(html, "og:title"), "Designer & Co");
  assert.equal(metaContent(html, "description"), "Робота мрії");
  assert.equal(metaContent(html, "og:site_name"), "");
});

const JOB = {
  "@type": "JobPosting",
  title: "Senior Product Designer",
  hiringOrganization: { "@type": "Organization", name: "Acme &amp; Co" },
  baseSalary: { "@type": "MonetaryAmount", currency: "UAH", value: { "@type": "QuantitativeValue", minValue: 50000, maxValue: 70000, unitText: "MONTH" } },
  employmentType: ["FULL_TIME", "PART_TIME"],
  jobLocationType: "TELECOMMUTE",
  jobLocation: [{ "@type": "Place", address: { addressLocality: "Київ", addressRegion: "Київська", addressCountry: { name: "Україна" } } },
    { "@type": "Place", address: "Львів" }],
  industry: "Design",
  description: "&lt;p&gt;Робота мрії&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Figma&lt;/li&gt;&lt;/ul&gt;",
};
const ld = (data) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;

test("findJobPosting finds a JobPosting nested in @graph, skipping broken and unrelated JSON-LD", () => {
  const html = "<html><head>" + '<script type="application/ld+json">{ broken json</script>' +
    ld({ "@context": "https://schema.org", "@type": "Organization", name: "Site" }) +
    ld({ "@context": "https://schema.org", "@graph": [{ "@type": "WebPage" }, { "@type": "BreadcrumbList" }, JOB] }) +
    "</head><body></body></html>";
  assert.deepEqual(findJobPosting(html), JOB);
});

test("findJobPosting reads @type arrays, top-level arrays and HTML-escaped JSON", () => {
  const typed = { ...JOB, "@type": ["JobPosting", "Thing"] };
  assert.deepEqual(findJobPosting(ld([{ "@type": "WebSite" }, typed])), typed);
  const escaped = '<script type="application/ld+json">{&quot;@type&quot;:&quot;JobPosting&quot;,&quot;title&quot;:&quot;QA&quot;}</script>';
  assert.deepEqual(findJobPosting(escaped), { "@type": "JobPosting", title: "QA" });
  assert.equal(findJobPosting("<html><body>no data</body></html>"), null);
});

test("findJobPosting does not carry state between calls", () => {
  const html = ld(JOB) + ld({ "@type": "Organization" });
  assert.ok(findJobPosting(html));
  assert.ok(findJobPosting(html), "a shared /g regex would resume mid-string and miss the posting");
});

test("jobPostingFields maps salary range, employment type, remote work, places and description", () => {
  assert.deepEqual(jobPostingFields(JOB), {
    title: "Senior Product Designer",
    company: "Acme & Co",
    salary: `50${NBSP}000–70${NBSP}000 UAH / міс`,
    emp: "Full-time",
    remote: true,
    location: "Київ, Київська, Україна; Львів",
    industry: "Design",
    desc: "Робота мрії\nFigma",
  });
});

test("jobPostingFields: other salary shapes and employment types", () => {
  const fields = (extra) => jobPostingFields({ "@type": "JobPosting", title: "Dev", ...extra });
  assert.equal(fields({ baseSalary: { currency: "USD", value: { value: 3000, unitText: "month" } } }).salary, `3${NBSP}000 USD / міс`);
  assert.equal(fields({ baseSalary: { currency: "EUR", value: { minValue: 40000, unitText: "YEAR" } } }).salary, `40${NBSP}000 EUR / рік`);
  assert.equal(fields({ estimatedSalary: [{ value: { maxValue: 25, currency: "USD", unitText: "HOUR" } }] }).salary, "25 USD / год");
  assert.equal(fields({ baseSalary: "від 30 000 грн" }).salary, "від 30 000 грн");
  assert.equal(fields({ baseSalary: { currency: "UAH" } }).salary, "");
  assert.equal(fields({ employmentType: "CONTRACTOR" }).emp, "Project / Контракт");
  assert.equal(fields({ employmentType: "intern" }).emp, "Стажування");
  assert.equal(fields({ employmentType: ["OTHER", "PART_TIME"] }).emp, "Part-time");
  assert.equal(fields({ employmentType: "VOLUNTEER" }).emp, "");
  assert.equal(fields({ jobLocationType: ["TELECOMMUTE"] }).remote, true);
  assert.equal(fields({}).remote, false);
  assert.equal(fields({ hiringOrganization: "Plain Org" }).company, "Plain Org");
  assert.equal(fields({ name: "From name", title: undefined }).title, "From name");
  assert.equal(fields({ occupationalCategory: ["15-1252.00 Software Developers", 7] }).industry, "15-1252.00 Software Developers");
});

test("isPrivateIp refuses the deprecated IPv4-compatible ::/96 form", () => {
  for (const ip of ["::7f00:1", "::a00:1", "::1.2.3.4"]) assert.equal(isPrivateIp(ip), true, ip);
});

test("htmlToText keeps look-alike tags and stray brackets", () => {
  assert.equal(htmlToText("<scripts>keep</scripts> a<b c"), "keep a<b c");
  assert.equal(htmlToText("<p>x</p><SCRIPT type=x>alert(1)</SCRIPT >y"), "x\ny");
});

test("firstBlock returns the inner HTML of the first matching element, whatever its case", () => {
  assert.equal(firstBlock("<html><MAIN id=x><p>m</p></MAIN><main>2</main></html>", "main"), "<p>m</p>");
  assert.equal(firstBlock("<mainframe>no</mainframe>", "main"), "");
  assert.equal(firstBlock("<main>unclosed", "main"), "");
});

// Hostile pages used to make the extraction regexes quadratic (an unclosed <svg repeated 40 000 times took ~15 s).
test("text extraction stays linear on pages built to make regexes backtrack", () => {
  const pages = ["<svg ".repeat(40000), "<!--".repeat(25000), "<a".repeat(50000), "<meta ".repeat(20000),
    "<script type=application/ld+json>".repeat(6000), "<main ".repeat(30000),
    // found by the review: one endless <meta full of matching attributes, and <script tags sharing one far ">"
    "<meta " + 'property="og:title" '.repeat(26000), "<script a".repeat(110000) + ">"];
  for (const page of pages) {
    const started = Date.now();
    htmlToText(page);
    metaContent(page, "og:title");
    findJobPosting(page);
    firstBlock(page, "main");
    assert.ok(Date.now() - started < 500, page.slice(0, 12) + " took " + (Date.now() - started) + " ms");
  }
});

test("metaContent still reads ordinary tags after the linear rewrite", () => {
  const html = '<head><meta charset="utf-8"><meta name="description" content="Опис &amp; більше"><meta property="og:title" content=\'Дизайнер\'></head>';
  assert.equal(metaContent(html, "og:title"), "Дизайнер");
  assert.equal(metaContent(html, "description"), "Опис & більше");
  assert.equal(metaContent('<meta property="og:title" content="x"', "og:title"), "", "an unterminated tag is ignored");
  assert.equal(metaContent('<meta property="og:title" <b>content="x">', "og:title"), "", "a tag cut by the next < is ignored");
});

test("metaContent ends a value at the quote that opened it", () => {
  assert.equal(metaContent(`<meta property="og:title" content="Інженер з комп'ютерних мереж, м'який графік">`, "og:title"), "Інженер з комп'ютерних мереж, м'який графік");
  assert.equal(metaContent(`<meta name='description' content='She said "hi" to us'>`, "description"), 'She said "hi" to us');
});
