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
let hideTimer = null, leaveTimer = null, idleTimer = null, pose = POSE.idle;
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
  clearTimeout(leaveTimer); // a hide still playing out must not take the new message with it
  el.classList.remove("leaving");
  byId("clippy-say").textContent = message;
  pose = nextPose;
  paint();
  el.classList.add("show");
  document.body.classList.add("clippy-on");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hide, ms);
}

export const isTalking = () => box().classList.contains("show");

export function hide() {
  const el = box();
  if (!el.classList.contains("show")) return;
  clearTimeout(hideTimer);
  el.classList.add("leaving");
  clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => {
    el.classList.remove("show", "leaving");
    document.body.classList.remove("clippy-on");
  }, 480);
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
  if (isTalking()) return; // a sign-in that was quicker than the greeting already has her talking
  const name = fairyName();
  say((name ? name + " вітає тебе ✦ " : "Привіт ✦ ") + "клікни іконку, щоб відкрити вікно.", POSE.idle, 10000);
}

export function initClippy() {
  byId("clippy-x").addEventListener("click", hide);
  // phones keep windows clear of the fairy; they need her current height for that
  new ResizeObserver(() => document.documentElement.style.setProperty("--clippy-h", box().offsetHeight + "px")).observe(box());
  on("fairy", () => { if (box().classList.contains("show")) paint(); });
  on("user", () => { if (!isAuthed() && box().classList.contains("show")) hide(); });
  // On touch screens the fairy lets taps through (app.css) and the first tap anywhere sends her away,
  // so she never stands between a finger and a button for long.
  document.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch" && isTalking() && !e.target.closest("#clippy-x")) hide();
  }, true);
  scheduleIdle();
}
