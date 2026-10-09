// What the app knows about the user's profession: the CV text (stored) and what the fairy
// learned from it (session only): a detected specialty, an AI-named role and AI phrases.

import { KEYS, getRaw, setRaw, remove } from "../core/storage.js";
import { emit } from "../core/events.js";
import { detectSpecialty } from "../content/phrases.js";

let cv = getRaw(KEYS.cv) || "";

export const persona = {
  specialty: detectSpecialty(cv), // entry of SPECIALTIES or null
  role: "",                       // e.g. "графічна дизайнерка", from the AI profile analysis
  phrases: [],                    // AI phrases for this profession
};

export const getCV = () => cv;
export const hasCV = () => cv.length > 40;
export const cvWordCount = () => (cv.trim() ? cv.trim().split(/\s+/).length : 0);

// Returns false when the text does not fit into browser storage.
export function setCV(text) {
  if (!setRaw(KEYS.cv, text)) return false;
  cv = text;
  persona.specialty = detectSpecialty(cv);
  emit("cv");
  return true;
}

export function clearCV() {
  cv = "";
  remove(KEYS.cv);
  emit("cv");
}

export function reloadCV() {
  cv = getRaw(KEYS.cv) || "";
  persona.specialty = detectSpecialty(cv);
}
