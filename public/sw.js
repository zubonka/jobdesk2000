// Service worker: JobDesk 2000 keeps opening without a connection (the vacancies live in the browser anyway).
//
// - The app's own files: network first, so a new deploy shows at once; the cache answers only when the network
//   does not. Every successful response refreshes the cache.
// - The pinned Firebase SDK and pdf.js versions never change: cache first. With them cached, a signed-in person
//   offline still gets their account, and cloud sync picks up by itself when the connection returns.
// - Requests to the functions, the dev server's helpers and everything else are left alone.

const CACHE = "jobdesk2000-v1";
const SHELL = ["/", "/css/app.css", "/js/main.js", "/site.webmanifest", "/assets/fonts/vt323-latin.woff2"];
const PINNED = [/^https:\/\/www\.gstatic\.com\/firebasejs\/\d+\.\d+\.\d+\//, /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js\/\d+\.\d+\.\d+\//];

const own = (url) => url.origin === self.location.origin && !url.pathname.startsWith("/.netlify/") && !url.pathname.startsWith("/__");
const pinned = (url) => PINNED.some((re) => re.test(url.href));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

// The page sends the files it loaded before this worker took over, so the very first visit is cached too.
self.addEventListener("message", (event) => {
  const urls = Array.isArray(event.data?.cache) ? event.data.cache : [];
  const wanted = urls.map((u) => { try { return new URL(u); } catch (e) { return null; } })
    .filter((url) => url && (own(url) || pinned(url)));
  event.waitUntil(caches.open(CACHE).then((cache) => Promise.all(wanted.map(async (url) => {
    if (await cache.match(url.href)) return;
    const res = await fetch(url.href, pinned(url) ? { mode: "cors" } : {}).catch(() => null);
    if (res && res.status === 200) await cache.put(url.href, res);
  }))));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res.status === 200 && res.type === "basic") cache.put(request, res.clone()).catch(() => {}); // 206 and friends are not cached
    return res;
  } catch (err) {
    const hit = await cache.match(request, { ignoreSearch: request.mode === "navigate" });
    if (hit) return hit;
    if (request.mode === "navigate") return (await cache.match("/")) || Response.error();
    return Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request.url);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.status === 200) cache.put(request.url, res.clone()).catch(() => {});
  return res;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (own(url)) event.respondWith(networkFirst(request));
  else if (pinned(url)) event.respondWith(cacheFirst(request));
});
