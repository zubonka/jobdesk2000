// The signed-in user as the UI knows it. Firebase is the source of truth (see services/auth.js);
// this copy lives in localStorage so the desktop renders before Firebase has loaded.

import { KEYS, getJSON, getObject, setJSON, remove } from "../core/storage.js";
import { emit } from "../core/events.js";

let user = getJSON(KEYS.user, null);

export const currentUser = () => user;
export const isAuthed = () => !!(user && user.name);
export const gender = () => (user && user.gender) || "n";
export const userName = () => (user && user.name) || "";

export function setUser(next) {
  user = { name: next.name, email: next.email || "", gender: next.gender || "n", uid: next.uid || "" };
  setJSON(KEYS.user, user);
  emit("user");
}

export function updateUser(patch) {
  if (!user) return;
  setUser({ ...user, ...patch });
}

export function clearUser() {
  user = null;
  remove(KEYS.user);
  emit("user");
}

export function reloadUser() {
  user = getJSON(KEYS.user, null);
}

// Picks the word form for the user's grammatical gender: feminine, masculine, neutral (guests), non-binary.
export function gv(fem, masc, neu, nb) {
  if (!user) return neu || fem;
  if (user.gender === "m") return masc;
  if (user.gender === "f") return fem;
  if (user.gender === "n") return nb || neu || fem;
  return neu || fem;
}

// Firebase profiles have no gender field, so it is remembered per uid on this device.
export function genderFor(uid) {
  const map = getObject(KEYS.genders);
  return map[uid] || "n";
}

export function hasGenderFor(uid) {
  const map = getObject(KEYS.genders);
  return !!map[uid];
}

export function rememberGender(uid, g) {
  const map = getObject(KEYS.genders);
  map[uid] = g;
  setJSON(KEYS.genders, map);
}
