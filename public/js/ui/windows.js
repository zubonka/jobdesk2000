// Window manager: open / close / focus, dragging, resizing, tile mode, keeping windows above the taskbar.
// A window is <section class="win" id="win-<app>" data-app="<app>"> inside #desktop.

import { byId, qsa } from "../core/dom.js";
import { emit, on } from "../core/events.js";
import { isAuthed } from "../data/user.js";

// icon + label are what the taskbar shows; needsAuth apps send guests to the sign-up gate
export const APPS = {
  messenger: { icon: "✉️", label: "Месенджер", needsAuth: true },
  stats: { icon: "📊", label: "Статистика" },
  vacancies: { icon: "💼", label: "Вакансії" },
  fairy: { icon: "🧚", label: "Моя Фея", needsAuth: true },
  about: { icon: "ℹ️", label: "Про застосунок" },
  valya: { icon: "👩‍🍳", label: "Балувана Валя" },
  readme: { icon: "📄", label: "README.TXT" },
};
export const APP_NAMES = Object.keys(APPS);

// Geometry is designed at the 16 px root size; big screens scale the root size (see app.css), and uiScale() follows.
const MIN_W = 260, MIN_H = 160, EDGE = 8, CASCADE = 18, HEAD_REACH = 120, HEAD_KEEP = 40;
// phones, including a phone held sideways; keep in sync with the media query in app.css
const MOBILE = "(max-width:760px), (max-height:500px) and (hover:none)";
let zTop = 100;
let tileMode = false;
const openHooks = {};

const winEl = (app) => byId("win-" + app);
export const isMobile = () => window.matchMedia(MOBILE).matches;
export const uiScale = () => (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 16;
// open: the window has a taskbar button; minimised: open, but hidden until its button brings it back
export const isOpen = (app) => !!winEl(app)?.classList.contains("open");
export const isMinimized = (app) => !!winEl(app)?.classList.contains("minimized");
export const isFocused = (app) => !!winEl(app)?.classList.contains("focused");
const desktop = () => byId("desktop");
const canDrag = () => !isMobile() && !tileMode;

// The keyboard focus follows the windows, like in the dialogs: a window brought to the front takes it, unless the
// person is typing somewhere else, and a closed or minimised window gives it back to what had it before.
const focusBefore = {};
const typing = (el) => !!el?.matches?.("input, textarea, select, [contenteditable]");

function takeFocus(w) {
  const el = document.activeElement;
  if (w.contains(el) || typing(el)) return;
  focusBefore[w.dataset.app] = el && el !== document.body ? el : null;
  w.focus({ preventScroll: true });
}

function giveFocusBack(w, hadFocus, ...candidates) {
  const before = focusBefore[w.dataset.app];
  delete focusBefore[w.dataset.app];
  if (!hadFocus) return;
  const target = [...candidates, before].find((el) => el?.isConnected && el.getClientRects().length);
  (target || byId("startbtn"))?.focus({ preventScroll: true }); // the opener is gone (a START menu item, a rebuilt button)
}

// Brings something inside a window into view. scrollIntoView scrolls every box around it, the desktop included,
// and the desktop must never move (it cannot be scrolled back, and a window hanging over its edge would pull it).
export function reveal(el, options) {
  const desk = desktop(), at = tileMode ? null : [desk.scrollLeft, desk.scrollTop];
  el.scrollIntoView(options);
  if (at) [desk.scrollLeft, desk.scrollTop] = at;
}

// fn runs every time the app's window is opened
export function onOpen(app, fn) {
  (openHooks[app] ||= []).push(fn);
}

export function focusWin(app) {
  const w = winEl(app);
  if (!w) return;
  qsa(".win[data-app]").forEach((x) => x.classList.remove("focused"));
  w.classList.remove("minimized");
  w.classList.add("focused");
  w.style.zIndex = ++zTop;
  emit("windows");
}

// focusWin for a window the person asked for (an icon, a taskbar button): the keyboard goes with it
export function activateWin(app) {
  focusWin(app);
  const w = winEl(app);
  if (w) takeFocus(w);
}

export function openWin(app) {
  if (APPS[app]?.needsAuth && !isAuthed()) { emit("gate", app); return; }
  const w = winEl(app);
  if (!w) return;
  const wasOpen = w.classList.contains("open");
  w.classList.add("open");
  if (tileMode) { if (w.parentElement !== byId("tilewrap")) byId("tilewrap").appendChild(w); }
  else if (!wasOpen) placeNew(w);
  activateWin(app);
  (openHooks[app] || []).forEach((fn) => fn());
}

export function minimizeWin(app) {
  const w = winEl(app);
  if (!w || !w.classList.contains("open")) return;
  const hadFocus = w.contains(document.activeElement);
  w.classList.add("minimized");
  w.classList.remove("focused");
  emit("windows");
  giveFocusBack(w, hadFocus, document.querySelector(`.tb-task[data-app="${app}"]`)); // the window lives there now
}

export function closeWin(app) {
  const w = winEl(app);
  if (!w) return;
  const hadFocus = w.contains(document.activeElement);
  w.classList.remove("open", "focused", "minimized");
  if (tileMode && w.parentElement === byId("tilewrap")) desktop().appendChild(w);
  emit("windows");
  giveFocusBack(w, hadFocus);
}

// Centre a newly opened window, cascading a little so several windows do not stack exactly.
function placeNew(w) {
  if (isMobile()) return;
  const desk = desktop();
  const dw = desk.clientWidth, dh = desk.clientHeight;
  const k = uiScale(), edge = EDGE * k;
  const ww = w.offsetWidth || 460 * k, wh = w.offsetHeight || 400 * k;
  const cascade = qsa(".win[data-app].open").length * CASCADE * k;
  const x = Math.min(Math.max(edge, (dw - ww) / 2) + cascade, dw - ww - edge);
  const y = Math.min(Math.max(edge, (dh - wh) / 2) + cascade, dh - wh - edge);
  w.style.left = Math.max(edge, x) + "px";
  w.style.top = Math.max(edge, y) + "px";
  keepInView(w);
}

// Pulls a window back when it would sit under the taskbar or off the side (content grew, viewport shrank).
// A window resized bigger than the screen it is now on shrinks back, so its ✕ and grip stay reachable.
function keepInView(w) {
  if (!canDrag() || !w.classList.contains("open") || w.classList.contains("minimized")) return;
  const k = uiScale(), edge = EDGE * k;
  const desk = desktop();
  const maxW = desk.clientWidth - 2 * edge, maxH = desk.clientHeight - 2 * edge;
  if (w.style.width && w.offsetWidth > maxW) w.style.width = Math.max(MIN_W * k, maxW) + "px";
  if (w.style.height && w.offsetHeight > maxH) w.style.height = Math.max(MIN_H * k, maxH) + "px";
  const top = w.offsetTop, bottom = top + w.offsetHeight, limit = desk.clientHeight - edge;
  if (bottom > limit) w.style.top = Math.max(edge, top - (bottom - limit)) + "px";
  const left = w.offsetLeft, maxLeft = desk.clientWidth - Math.min(w.offsetWidth, desk.clientWidth - 2 * edge) - edge;
  if (left > maxLeft) w.style.left = Math.max(edge, maxLeft) + "px";
}

function makeDraggable(w) {
  const head = w.querySelector(".win-head");
  let drag = null;
  head.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".win-btn") || !canDrag()) return;
    const r = w.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    head.setPointerCapture(e.pointerId);
    focusWin(w.dataset.app);
    e.preventDefault();
  });
  head.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const k = uiScale();
    const maxTop = desktop().clientHeight - HEAD_KEEP * k; // keep the title bar reachable
    const x = Math.max(-w.offsetWidth + HEAD_REACH * k, Math.min(e.clientX - drag.dx, window.innerWidth - HEAD_REACH * k));
    const y = Math.max(0, Math.min(e.clientY - drag.dy, maxTop));
    w.style.left = x + "px";
    w.style.top = y + "px";
  });
  const end = () => { drag = null; };
  head.addEventListener("pointerup", end);
  head.addEventListener("pointercancel", end);
}

function makeResizable(w) {
  const grip = document.createElement("div");
  grip.className = "win-resize";
  w.appendChild(grip);
  let start = null;
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !canDrag()) return;
    const r = w.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
    grip.setPointerCapture(e.pointerId);
    focusWin(w.dataset.app);
    e.preventDefault();
    e.stopPropagation();
  });
  grip.addEventListener("pointermove", (e) => {
    if (!start) return;
    const k = uiScale();
    const maxH = Math.max(MIN_H * k, desktop().clientHeight - w.offsetTop - EDGE * k);
    w.style.width = Math.max(MIN_W * k, start.w + (e.clientX - start.x)) + "px";
    w.style.height = Math.min(Math.max(MIN_H * k, start.h + (e.clientY - start.y)), maxH) + "px";
    w.style.maxHeight = "none";
  });
  const end = () => { start = null; };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
}

// Tile mode lays every available window out in a grid instead of floating windows.
function setTileMode(on) {
  tileMode = on;
  const wrap = byId("tilewrap");
  document.body.classList.toggle("tile-mode", on);
  for (const app of APP_NAMES) {
    const w = winEl(app);
    if (on) {
      if (APPS[app].needsAuth && !isAuthed()) continue;
      w.classList.add("open");
      w.classList.remove("minimized");
      wrap.appendChild(w);
    } else {
      desktop().appendChild(w);
    }
  }
  emit("windows");
}

export function initWindows() {
  for (const w of qsa(".win[data-app]")) {
    w.tabIndex = -1; // focusable from code (takeFocus), not a Tab stop of its own
    makeDraggable(w);
    makeResizable(w);
    w.addEventListener("pointerdown", () => { if (!w.classList.contains("focused")) focusWin(w.dataset.app); });
    new ResizeObserver(() => keepInView(w)).observe(w);
  }
  for (const b of qsa("[data-close]")) b.addEventListener("click", (e) => { e.stopPropagation(); closeWin(b.dataset.close); });
  for (const b of qsa("[data-min]")) b.addEventListener("click", (e) => { e.stopPropagation(); minimizeWin(b.dataset.min); });
  byId("btn-tile").addEventListener("click", () => setTileMode(!tileMode));
  // phones lay out the fairy differently while a window covers the screen (app.css, body.win-open)
  on("windows", () => document.body.classList.toggle("win-open", APP_NAMES.some((app) => isOpen(app) && !isMinimized(app))));
  window.addEventListener("resize", () => {
    if (tileMode && isMobile()) setTileMode(false); // phones have no tile button and no room for a grid
    qsa(".win[data-app].open").forEach(keepInView);
  });
}
