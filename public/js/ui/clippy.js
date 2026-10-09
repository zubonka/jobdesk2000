// Clippy-style fairy in the corner: speech bubble, reactions to statuses, idle motivation.
// She only talks to signed-in users.

import { byId } from "../core/dom.js";
import { on } from "../core/events.js";
import { isAuthed } from "../data/user.js";
import { HAPPY_KEYS } from "../data/statuses.js";
import { persona } from "../data/profile.js";
import { motivPhrases, motivGeneric, statusMessages } from "../content/phrases.js";
import { fairyName } from "../fairy/store.js";
import { paintFairy, POSE } from "../fairy/render.js";

const IDLE_MS = 50000;
const box = () => byId("clippy");
let hideTimer = null, idleTimer = null, pose = POSE.idle;
const ding = new Audio("assets/sounds/ding.mp3");
ding.preload = "none";

const pick = (list) => list[Math.floor(Math.random() * list.length)];

export function playDing() {
  try { ding.currentTime = 0; ding.play().catch(() => {}); } catch (e) { /* autoplay blocked */ }
}

const paint = () => paintFairy(byId("clippy-fairy"), { pose });

// Shows a message (plain text) for `ms` milliseconds.
export function say(message, nextPose = POSE.idle, ms = 9000) {
  if (!isAuthed()) return;
  const el = box();
  el.classList.remove("leaving");
  byId("clippy-say").textContent = message;
  pose = nextPose;
  paint();
  el.classList.add("show");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hide, ms);
}

export function hide() {
  const el = box();
  el.classList.add("leaving");
  setTimeout(() => el.classList.remove("show", "leaving"), 480);
}

export function reactToStatus(key) {
  const options = statusMessages()[key];
  if (!options) return;
  let p = POSE.idle;
  if (key === "offer") { p = POSE.happy; playDing(); }
  else if (key === "reject") p = POSE.sad;
  else if (HAPPY_KEYS.includes(key)) p = POSE.happy;
  say(pick(options), p, 11000);
}

// personal (AI + specialty) phrases first, the neutral ones are always in the mix
function phrasePool() {
  let pool = [];
  if (isAuthed()) {
    if (persona.phrases.length) pool = pool.concat(persona.phrases);
    if (persona.specialty) pool = pool.concat(persona.specialty.phr);
  }
  return pool.concat(motivGeneric(), motivPhrases());
}

function scheduleIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!box().classList.contains("show")) say(pick(phrasePool()), POSE.idle, 9000);
    scheduleIdle();
  }, IDLE_MS);
}

export function greet() {
  const name = fairyName();
  say((name ? name + " вітає тебе ✦ " : "Привіт ✦ ") + "клікни іконку, щоб відкрити вікно.", POSE.idle, 10000);
}

export function initClippy() {
  byId("clippy-x").addEventListener("click", hide);
  on("fairy", () => { if (box().classList.contains("show")) paint(); });
  on("user", () => { if (!isAuthed() && box().classList.contains("show")) hide(); });
  scheduleIdle();
}
