// Window manager: open / close / focus, dragging, resizing, tile mode, keeping windows above the taskbar.
// A window is <section class="win" id="win-<app>" data-app="<app>"> inside #desktop.

import { byId, qsa } from "../core/dom.js";
import { emit } from "../core/events.js";
import { isAuthed } from "../data/user.js";

// icon + label are what the taskbar shows; needsAuth apps send guests to the sign-up gate
export const APPS = {
  messenger: { icon: "✉️", label: "Месенджер", needsAuth: true },
  stats: { icon: "📊", label: "Статистика" },
  vacancies: { icon: "💼", label: "Вакансії" },
  fairy: { icon: "🧚", label: "Моя Фея", needsAuth: true },
  about: { icon: "ℹ️", label: "Про застосунок" },
  valya: { icon: "👩‍🍳", label: "Балувана Валя" },
};
export const APP_NAMES = Object.keys(APPS);

// Geometry is designed at the 16 px root size; big screens scale the root size (see app.css), and uiScale() follows.
const MIN_W = 260, MIN_H = 160, EDGE = 8, CASCADE = 18, HEAD_REACH = 120, HEAD_KEEP = 40;
// phones, including a phone held sideways; keep in sync with the media query in app.css
const MOBILE = "(max-width:760px), (max-height:500px) and (hover:none)";
let zTop = 100;
let tileMode = false;
const openHooks = {};

export const winEl = (app) => byId("win-" + app);
export const isMobile = () => window.matchMedia(MOBILE).matches;
export const uiScale = () => (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 16;
export const isOpen = (app) => !!winEl(app)?.classList.contains("open");
export const isFocused = (app) => !!winEl(app)?.classList.contains("focused");
export const inTileMode = () => tileMode;
const desktop = () => byId("desktop");
const canDrag = () => !isMobile() && !tileMode;

// fn runs every time the app's window is opened
export function onOpen(app, fn) {
  (openHooks[app] ||= []).push(fn);
}

export function focusWin(app) {
  const w = winEl(app);
  if (!w) return;
  qsa(".win[data-app]").forEach((x) => x.classList.remove("focused"));
  w.classList.add("focused");
  w.style.zIndex = ++zTop;
  emit("windows");
}

export function openWin(app) {
  if (APPS[app]?.needsAuth && !isAuthed()) { emit("gate", app); return; }
  const w = winEl(app);
  if (!w) return;
  const wasOpen = w.classList.contains("open");
  w.classList.add("open");
  if (!wasOpen) placeNew(w);
  focusWin(app);
  (openHooks[app] || []).forEach((fn) => fn());
}

export function closeWin(app) {
  const w = winEl(app);
  if (!w) return;
  w.classList.remove("open", "focused");
  if (tileMode && w.parentElement === byId("tilewrap")) desktop().appendChild(w);
  emit("windows");
}

export const toggleWin = (app) => (isOpen(app) ? closeWin(app) : openWin(app));

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
export function keepInView(w) {
  if (!canDrag() || !w.classList.contains("open")) return;
  const edge = EDGE * uiScale();
  const desk = desktop();
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
export function setTileMode(on) {
  tileMode = on;
  const wrap = byId("tilewrap");
  document.body.classList.toggle("tile-mode", on);
  for (const app of APP_NAMES) {
    const w = winEl(app);
    if (on) {
      if (APPS[app].needsAuth && !isAuthed()) continue;
      w.classList.add("open");
      wrap.appendChild(w);
    } else {
      desktop().appendChild(w);
    }
  }
  emit("windows");
}

export function initWindows() {
  for (const w of qsa(".win[data-app]")) {
    makeDraggable(w);
    makeResizable(w);
    w.addEventListener("pointerdown", () => { if (!w.classList.contains("focused")) focusWin(w.dataset.app); });
    new ResizeObserver(() => keepInView(w)).observe(w);
  }
  for (const b of qsa("[data-close]")) b.addEventListener("click", (e) => { e.stopPropagation(); closeWin(b.dataset.close); });
  for (const b of qsa("[data-min]")) b.addEventListener("click", (e) => { e.stopPropagation(); closeWin(b.dataset.min); });
  byId("btn-tile").addEventListener("click", () => setTileMode(!tileMode));
  window.addEventListener("resize", () => qsa(".win[data-app].open").forEach(keepInView));
}
