// Desktop icons. On desktop they snap to a grid, can be dragged and remember their cells;
// on phones they form a fixed home-screen grid (row by row) and are not draggable.

import { KEYS, getObject, setJSON } from "../core/storage.js";
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

let positions = getObject(KEYS.iconPos);

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

// Places the icons for the current screen. Only a drag saves a position: a narrow moment (a snapped browser,
// a rotated tablet) moves icons into view without forgetting where the person put them.
function layoutIcons() {
  const used = new Set();
  if (isMobile()) {
    const { cols } = limits();
    icons().forEach((ic, i) => place(ic, { col: i % cols, row: Math.floor(i / cols) }));
    return;
  }
  icons().forEach((ic, i) => {
    const saved = positions[ic.dataset.open];
    const at = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && fromSaved(saved);
    const cell = freeCell(at ? xyToCell(at.x, at.y) : { col: 0, row: i }, used);
    used.add(key(cell));
    place(ic, cell);
  });
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
    // icon coordinates are relative to the icon layer (#icons), which sits a little inside the desktop
    const layer = ic.offsetParent.getBoundingClientRect(), desk = byId("desktop").getBoundingClientRect();
    const x = Math.max(desk.left - layer.left, Math.min(e.clientX - layer.left - drag.dx, desk.right - layer.left - ic.offsetWidth));
    const y = Math.max(desk.top - layer.top, Math.min(e.clientY - layer.top - drag.dy, desk.bottom - layer.top - ic.offsetHeight));
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
  positions = getObject(KEYS.iconPos);
  layoutIcons();
}

export function initIcons() {
  icons().forEach(makeDraggable);
  layoutIcons();
  window.addEventListener("resize", layoutIcons);
  on("windows", syncActive);
}
