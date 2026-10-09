// localStorage access. Keys and value formats are shared with the cloud copy (Firestore users/<uid>)
// and with older versions of the app, so they must not change.

export const KEYS = {
  progress: "jobdesk2000_v1",        // { "<company>|<title>": { status: <label>, date, deadline, note } }
  jobs: "jobdesk2000_added_v1",      // [{ prio, company, title, field, emp, loc, salary, url }]
  user: "jobdesk2000_user_v1",       // { name, email, gender, uid }
  theme: "jobdesk2000_theme",        // "light" | "dark"
  iconPos: "jobdesk2000_iconpos_v2", // { <app>: { x, y } }
  fairy: "jobdesk2000_fairy_v1",     // { name, current, type1: {...colours}, type2: {...colours} }
  cv: "jobdesk2000_cv_v1",           // plain text extracted from the CV
  wallpaper: "jobdesk2000_wall_v1",  // data: URL (JPEG)
  collapsed: "jobdesk2000_collapsed",// { <job id>: true }
  welcomed: "jobdesk2000_welcomed",  // "1" once the welcome dialog was closed
  genders: "jd2000_gender",          // { <uid>: "f" | "m" | "n" }, this device only
  owner: "jd2000_owner",             // uid whose data is stored on this device, this device only
};

// Keys with this prefix are mirrored to the cloud for signed-in users.
export const SYNC_PREFIX = "jobdesk2000";

const writeListeners = new Set();
let muted = 0;

// fn(key) runs after every write to a synced key, except writes made inside silently().
export const onWrite = (fn) => writeListeners.add(fn);

export function silently(fn) {
  muted++;
  try { return fn(); } finally { muted--; }
}

function notify(key) {
  if (muted || !key.startsWith(SYNC_PREFIX)) return;
  for (const fn of writeListeners) fn(key);
}

export function getRaw(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

// Returns false when the browser refuses the write (quota, private mode).
export function setRaw(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { return false; }
  notify(key);
  return true;
}

export function remove(key) {
  try { localStorage.removeItem(key); } catch (e) { return; }
  notify(key);
}

export function getJSON(key, fallback) {
  const text = getRaw(key);
  if (text == null) return fallback;
  try { return JSON.parse(text) ?? fallback; } catch (e) { return fallback; }
}

export const setJSON = (key, value) => setRaw(key, JSON.stringify(value));

// All synced keys with their raw string values.
export function syncedEntries() {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(SYNC_PREFIX)) out[key] = localStorage.getItem(key);
    }
  } catch (e) { /* storage unavailable */ }
  return out;
}
