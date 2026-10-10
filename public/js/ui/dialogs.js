// Modal dialogs (.overlay elements): open/close, Escape, focus; plus the guest gate and the first-visit welcome.

import { KEYS, getRaw, setRaw } from "../core/storage.js";
import { byId } from "../core/dom.js";
import { on, emit } from "../core/events.js";
import { isAuthed } from "../data/user.js";
import { fairyColors, fairyType } from "../fairy/store.js";
import { paintFairy } from "../fairy/render.js";

const stack = [];
const closers = {};
const openers = {}; // what had the focus when a dialog opened, to give it back on close

const FOCUSABLE = "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";
const focusables = (el) => [...el.querySelectorAll(FOCUSABLE)].filter((x) => !x.disabled && x.offsetParent !== null);

// onClose runs whenever the dialog closes (button, Escape or code)
export function registerDialog(id, onClose) {
  closers[id] = onClose;
}

// The dialog box itself takes the focus (a phone keyboard does not jump up); Tab then walks its controls.
export function openDialog(id) {
  const el = byId(id);
  if (!el || el.classList.contains("open")) return;
  openers[id] = document.activeElement;
  el.classList.add("open");
  stack.push(id);
  const box = el.querySelector(".dialog") || el;
  box.setAttribute("tabindex", "-1");
  box.focus({ preventScroll: true });
}

export function closeDialog(id) {
  const el = byId(id);
  if (!el || !el.classList.contains("open")) return;
  el.classList.remove("open");
  const i = stack.lastIndexOf(id);
  if (i >= 0) stack.splice(i, 1);
  if (closers[id]) closers[id]();
  const back = openers[id];
  delete openers[id];
  // back to what opened it, unless another dialog took over meanwhile
  if (back && back.isConnected && typeof back.focus === "function" && (!document.activeElement || el.contains(document.activeElement) || document.activeElement === document.body)) back.focus({ preventScroll: true });
}

// Tab and Shift+Tab go round the controls of the dialog on top, never into the page behind it.
function trapTab(e) {
  if (e.key !== "Tab" || !stack.length) return;
  e.preventDefault();
  const items = focusables(byId(stack[stack.length - 1]));
  if (!items.length) return;
  const at = items.indexOf(document.activeElement);
  // from the dialog box itself (or anything else) Tab starts at the first control, Shift+Tab at the last
  const next = at < 0 ? (e.shiftKey ? items.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + items.length) % items.length;
  items[next].focus();
}

export const isDialogOpen = (id) => !!byId(id)?.classList.contains("open");

const GATE_TEXT = {
  fairy: "Щоб створити й кастомізувати свою фею, спершу зареєструйся ✦ Це швидко й безкоштовно!",
  messenger: "Щоб фея писала тобі cover letter, спершу зареєструйся ✦ Це швидко й безкоштовно!",
};

function showGate(app) {
  byId("gate-text").textContent = GATE_TEXT[app] || GATE_TEXT.messenger;
  paintFairy(byId("gate-fairy"), { type: "type1", colours: fairyColors() });
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

// First visit only, and not for someone who is already signed in. The inline script in index.html has
// already shown the dialog through the "first-visit" class; from here on the "open" class owns it.
export function maybeWelcome() {
  const root = document.documentElement;
  const show = getRaw(KEYS.welcomed) !== "1" && !isAuthed();
  if (show) {
    paintFairy(byId("welcome-fairy"), { type: fairyType() });
    openDialog("welcome-overlay");
  }
  root.classList.remove("first-visit");
}

export function initDialogs() {
  initGate();
  initWelcome();
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && stack.length) closeDialog(stack[stack.length - 1]);
    else trapTab(e);
  });
}
