// Offline support and "install as an app" (public/sw.js). Registered after the page has loaded, so it never
// competes with the first paint; without service workers (or on plain http) the app simply works online only.

export function initOffline() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("/sw.js");
      const reg = await navigator.serviceWorker.ready;
      // what this visit already loaded, so the next visit opens offline even if it is the second one ever
      const loaded = performance.getEntriesByType("resource").map((entry) => entry.name);
      reg.active?.postMessage({ cache: [window.location.origin + "/", ...loaded] });
    } catch (err) {
      console.warn("offline mode unavailable:", err && err.message);
    }
  }, { once: true });
}
