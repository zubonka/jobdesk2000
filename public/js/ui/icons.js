// Desktop icons. On desktop they snap to a grid, can be dragged and remember their cells;
// on phones they form a fixed home-screen grid (row by row) and are not draggable.

import { KEYS, getJSON, setJSON, getRaw, setRaw } from "../core/storage.js";
import { byId, qsa } from "../core/dom.js";
import { on } from "../core/events.js";
import { openWin, isOpen, isMobile, uiScale } from "./windows.js";

// Cell sizes at the 16 px root size; big screens scale them with the root (uiScale).
// Saved positions are in those unscaled pixels, so they stay valid when the scale changes.
const GRID = { desktop: { gx: 100, gy: 108, pad: 14 }, mobile: { gx: 96, gy: 124, pad: 12 } };
function grid() {
  const g = isMobile() ? GRID.mobile : GRID.desktop, k = uiScale();
  return { gx: g.gx * k, gy: g.gy * k, pad: g.pad * k };
}
const toSaved = ({ x, y }) => ({ x: Math.round(x / uiScale()), y: Math.round(y / uiScale()) });
const fromSaved = ({ x, y }) => ({ x: x * uiScale(), y: y * uiScale() });

let positions = getJSON(KEYS.iconPos, {}) || {};

const icons = () => qsa(".d-icon");
const key = (cell) => cell.col + "," + cell.row;
const cellToXY = ({ col, row }) => ({ x: grid().pad + col * grid().gx, y: grid().pad + row * grid().gy });
const xyToCell = (x, y) => ({ col: Math.max(0, Math.round((x - grid().pad) / grid().gx)), row: Math.max(0, Math.round((y - grid().pad) / grid().gy)) });

function limits() {
  const desk = byId("desktop");
  const iconH = Math.max(...icons().map((ic) => ic.offsetHeight), 90 * uiScale());
  return {
    cols: Math.max(1, Math.floor((desk.clientWidth - grid().pad) / grid().gx)),
    rows: Math.max(1, Math.floor((desk.clientHeight - grid().pad - iconH) / grid().gy) + 1),
  };
}

// nearest free cell, scanning down the column and then to the next column
function freeCell(cell, used) {
  const { cols, rows } = limits();
  let col = Math.min(cell.col, cols - 1), row = Math.min(cell.row, rows - 1);
  for (let guard = 0; guard < cols * rows; guard++) {
    if (!used.has(key({ col, row }))) return { col, row };
    row++;
    if (row >= rows) { row = 0; col = (col + 1) % cols; }
  }
  return { col, row };
}

function place(ic, cell) {
  const { x, y } = cellToXY(cell);
  ic.style.left = x + "px";
  ic.style.top = y + "px";
}

export function layoutIcons() {
  const used = new Set();
  if (isMobile()) {
    const { cols } = limits();
    icons().forEach((ic, i) => place(ic, { col: i % cols, row: Math.floor(i / cols) }));
    return;
  }
  icons().forEach((ic, i) => {
    const app = ic.dataset.open;
    const saved = positions[app];
    const at = saved && fromSaved(saved);
    const cell = freeCell(at ? xyToCell(at.x, at.y) : { col: 0, row: i }, used);
    used.add(key(cell));
    place(ic, cell);
    positions[app] = toSaved(cellToXY(cell));
  });
  // only a real change is saved: a plain page load must not look like an edit to cloud sync
  const text = JSON.stringify(positions);
  if (text !== getRaw(KEYS.iconPos)) setRaw(KEYS.iconPos, text);
}

function makeDraggable(ic) {
  let drag = null;
  ic.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || isMobile()) return;
    const r = ic.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: false };
    ic.setPointerCapture(e.pointerId);
  });
  ic.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.sx) > 4 || Math.abs(e.clientY - drag.sy) > 4) { drag.moved = true; ic.classList.add("dragging"); }
    if (!drag.moved) return;
    const desk = byId("desktop").getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - desk.left - drag.dx, desk.width - ic.offsetWidth));
    const y = Math.max(0, Math.min(e.clientY - desk.top - drag.dy, desk.height - ic.offsetHeight));
    ic.style.left = x + "px";
    ic.style.top = y + "px";
  });
  ic.addEventListener("pointerup", () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    ic.classList.remove("dragging");
    if (!moved) return;
    ic.dataset.justDragged = "1"; // the click that follows a drag must not open the window
    const used = new Set(icons().filter((x) => x !== ic).map((x) => key(xyToCell(parseFloat(x.style.left), parseFloat(x.style.top)))));
    const cell = freeCell(xyToCell(parseFloat(ic.style.left), parseFloat(ic.style.top)), used);
    place(ic, cell);
    positions[ic.dataset.open] = toSaved(cellToXY(cell));
    setJSON(KEYS.iconPos, positions);
  });
  ic.addEventListener("pointercancel", () => { drag = null; ic.classList.remove("dragging"); });
  ic.addEventListener("click", () => {
    if (ic.dataset.justDragged) { delete ic.dataset.justDragged; return; }
    openWin(ic.dataset.open);
  });
}

const syncActive = () => icons().forEach((ic) => ic.classList.toggle("active", isOpen(ic.dataset.open)));

export function reloadIcons() {
  positions = getJSON(KEYS.iconPos, {}) || {};
  layoutIcons();
}

export function initIcons() {
  icons().forEach(makeDraggable);
  layoutIcons();
  window.addEventListener("resize", layoutIcons);
  on("windows", syncActive);
}
