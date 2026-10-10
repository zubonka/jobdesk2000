// Module hooks for sync.test.mjs. services/firebase.js is replaced by fake-firebase.mjs, and an app module imported
// with "?device=<name>" brings its whole graph of app modules under that name: each simulated device or tab has its
// own sync state and listeners, and its core/storage.js reads globalThis.__stores[<name>] instead of localStorage
// (two tabs of one browser share one store). Nothing on disk changes.

const FAKE = new URL("./fake-firebase.mjs", import.meta.url).href;
const APP = "/public/js/";
const deviceOf = (url) => (url.match(/[?&]device=([\w-]+)/) || [])[1];

export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context);
  if (!resolved.url.startsWith("file:")) return resolved;
  let url = resolved.url;
  if (url.includes(APP + "services/firebase.js")) url = FAKE;
  const device = deviceOf(context.parentURL || "");
  if (device && (url.includes(APP) || url.startsWith(FAKE)) && !deviceOf(url)) url += (url.includes("?") ? "&" : "?") + "device=" + device;
  return { ...resolved, url, shortCircuit: true };
}

export async function load(url, context, next) {
  const loaded = await next(url, context);
  const device = url.includes(APP + "core/storage.js") && deviceOf(url);
  if (!device) return loaded;
  const source = String(loaded.source).replace(/\blocalStorage\b/g, `globalThis.__stores[${JSON.stringify(device)}]`);
  return { ...loaded, source, shortCircuit: true };
}
