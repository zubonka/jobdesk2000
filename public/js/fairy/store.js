// The user's fairy: chosen type, name and five colour zones per type.
// Edits live in memory until saveFairy(); the "fairy" event fires on every change so previews follow.

import { KEYS, getJSON, setJSON } from "../core/storage.js";
import { emit } from "../core/events.js";

export const TYPES = ["type1", "type2"];
export const ZONES = ["hair", "wing", "wingline", "dress", "trink"];
export const ZONE_DEFAULTS = { hair: "#280F59", wing: "#BDC8FF", wingline: "#FFFFFF", dress: "#FF9EEA", trink: "#DF20F5" };
export const SKIN = "#F5C518";

const defaults = (type) => ({ type, ...ZONE_DEFAULTS });

let store;

export function loadFairy() {
  store = { name: "", current: "type1", type1: defaults("type1"), type2: defaults("type2") };
  const saved = getJSON(KEYS.fairy, null);
  if (saved && (saved.type1 || saved.type2)) {
    store.name = typeof saved.name === "string" ? saved.name : "";
    store.current = TYPES.includes(saved.current) ? saved.current : "type1";
    for (const t of TYPES) {
      const colours = { ...defaults(t), ...(saved[t] || {}) };
      for (const z of ZONES) if (!colours[z]) colours[z] = ZONE_DEFAULTS[z];
      store[t] = colours;
    }
  }
}

export const fairyType = () => store.current;
export const fairyName = () => store.name;
export const fairyColors = (type = store.current) => store[type];

export function setFairyType(type) {
  if (!TYPES.includes(type)) return;
  store.current = type;
  emit("fairy");
}

export function setFairyName(name) {
  store.name = name;
}

export function setZoneColor(zone, colour) {
  store[store.current][zone] = colour;
  emit("fairy");
}

export function setAllZones(colours) {
  Object.assign(store[store.current], colours);
  emit("fairy");
}

export function saveFairy() {
  setJSON(KEYS.fairy, store);
  emit("fairy");
}

loadFairy();
