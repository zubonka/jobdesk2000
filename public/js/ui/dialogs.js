// Modal dialogs (.overlay elements): open/close, Escape, focus; plus the guest gate and the first-visit welcome.

import { KEYS, getRaw, setRaw } from "../core/storage.js";
import { byId } from "../core/dom.js";
import { on, emit } from "../core/events.js";
import { isAuthed } from "../data/user.js";
import { fairyColors, fairyType } from "../fairy/store.js";
import { paintFairy } from "../fairy/render.js";

const stack = [];
const closers = {};

// onClose runs whenever the dialog closes (button, Escape or code)
export function registerDialog(id, onClose) {
  closers[id] = onClose;
}

export function openDialog(id) {
  const el = byId(id);
  if (!el || el.classList.contains("open")) return;
  el.classList.add("open");
  stack.push(id);
}

export function closeDialog(id) {
  const el = byId(id);
  if (!el || !el.classList.contains("open")) return;
  el.classList.remove("open");
  const i = stack.lastIndexOf(id);
  if (i >= 0) stack.splice(i, 1);
  if (closers[id]) closers[id]();
}

export const isDialogOpen = (id) => !!byId(id)?.classList.contains("open");

const GATE_TEXT = {
  fairy: "Щоб створити й кастомізувати свою фею, спершу зареєструйся ✦ Це швидко й безкоштовно!",
  messenger: "Щоб фея писала тобі cover letter, спершу зареєструйся ✦ Це швидко й безкоштовно!",
};

function showGate(app) {
  byId("gate-text").textContent = GATE_TEXT[app] || GATE_TEXT.messenger;
  paintFairy(byId("gate-fairy"), { type: "type1", colours: fairyColors(), size: "90px" });
  openDialog("gate-overlay");
}

function initGate() {
  on("gate", showGate);
  byId("gate-close").addEventListener("click", () => closeDialog("gate-overlay"));
  byId("gate-cancel").addEventListener("click", () => closeDialog("gate-overlay"));
  byId("gate-register").addEventListener("click", () => { closeDialog("gate-overlay"); emit("auth:open", "login"); });
}

function initWelcome() {
  registerDialog("welcome-overlay", () => setRaw(KEYS.welcomed, "1"));
  byId("welcome-close").addEventListener("click", () => closeDialog("welcome-overlay"));
  byId("welcome-start").addEventListener("click", () => {
    closeDialog("welcome-overlay");
    if (!isAuthed()) emit("auth:open", "register");
  });
}

// First visit only, and not for someone who is already signed in.
export function maybeWelcome() {
  if (getRaw(KEYS.welcomed) === "1" || isAuthed()) return;
  paintFairy(byId("welcome-fairy"), { type: fairyType(), size: "96px" });
  openDialog("welcome-overlay");
}

export function initDialogs() {
  initGate();
  initWelcome();
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && stack.length) closeDialog(stack[stack.length - 1]);
  });
}
