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
// shortest CV text worth keeping; the messenger refuses anything shorter
export const MIN_CV_CHARS = 40;
export const hasCV = () => cv.length >= MIN_CV_CHARS;
export const cvWordCount = () => (cv.trim() ? cv.trim().split(/\s+/).length : 0);

// What the fairy learned belongs to one CV: another CV, or none, starts from what its own text says.
function learnFrom(text) {
  if (text === cv) return;
  cv = text;
  persona.specialty = detectSpecialty(cv);
  persona.role = "";
  persona.phrases = [];
}

// Returns false when the text does not fit into browser storage.
export function setCV(text) {
  if (!setRaw(KEYS.cv, text)) return false;
  learnFrom(text);
  emit("cv");
  return true;
}

export function clearCV() {
  learnFrom("");
  remove(KEYS.cv);
  emit("cv");
}

export const reloadCV = () => learnFrom(getRaw(KEYS.cv) || "");
