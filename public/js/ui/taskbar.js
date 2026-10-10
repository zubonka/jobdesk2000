// Taskbar: open-window buttons, START menu, clock and the account label.

import { byId, qsa, html, setHtml } from "../core/dom.js";
import { on, emit } from "../core/events.js";
import { isAuthed, userName } from "../data/user.js";
import { APPS, APP_NAMES, isOpen, isFocused, isMinimized, focusWin, minimizeWin, openWin } from "./windows.js";

function renderTasks() {
  const wrap = byId("tb-tasks");
  const open = APP_NAMES.filter(isOpen);
  setHtml(wrap, html`${open.map((app) => html`<button type="button" class="ui tb-task${isFocused(app) ? " active" : ""}${isMinimized(app) ? " min" : ""}" data-app="${app}" title="${APPS[app].label}"><span class="tb-ic">${APPS[app].icon}</span><span class="lbl">${APPS[app].label}</span></button>`)}`);
}

function renderAccount() {
  const name = isAuthed() ? userName() : "Гість";
  byId("acc-label").textContent = name;
  byId("sm-user").textContent = name;
  byId("sm-auth").textContent = isAuthed() ? "🚪 Вийти (" + userName() + ")" : "👤 Увійти / зареєструватися";
}

function tick() {
  const d = new Date();
  byId("clock").textContent = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

const menu = () => byId("startmenu");
const setMenu = (open) => {
  menu().classList.toggle("open", open);
  byId("startbtn").setAttribute("aria-expanded", String(open));
};

// Opened from the keyboard (a click with detail 0 is Enter or Space), the menu takes the focus so Tab walks it.
function toggleMenu(e) {
  e.stopPropagation();
  const open = !menu().classList.contains("open");
  setMenu(open);
  if (open && e.detail === 0) menu().querySelector(".sm-item")?.focus();
}

export function initTaskbar() {
  byId("tb-tasks").addEventListener("click", (e) => {
    const t = e.target.closest(".tb-task");
    if (!t) return;
    // clicking the focused window's button minimises it, any other (a minimised one too) brings it forward
    if (isFocused(t.dataset.app)) minimizeWin(t.dataset.app); else focusWin(t.dataset.app);
  });

  byId("startbtn").addEventListener("click", toggleMenu);
  document.addEventListener("click", (e) => {
    if (menu().classList.contains("open") && !menu().contains(e.target) && e.target.id !== "startbtn") setMenu(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !menu().classList.contains("open")) return;
    const inside = menu().contains(document.activeElement);
    setMenu(false);
    if (inside) byId("startbtn").focus();
  });
  for (const item of qsa(".sm-item[data-sm]", menu())) {
    item.addEventListener("click", () => { setMenu(false); openWin(item.dataset.sm); });
  }
  for (const item of qsa(".sm-item[data-action]", menu())) {
    item.addEventListener("click", () => { setMenu(false); emit("menu", item.dataset.action); });
  }
  byId("sm-auth").addEventListener("click", () => { setMenu(false); emit("account"); });
  byId("btn-account").addEventListener("click", () => emit("account"));

  const showOnline = () => { byId("tb-offline").hidden = navigator.onLine; };
  window.addEventListener("online", showOnline);
  window.addEventListener("offline", showOnline);
  showOnline();

  on("windows", renderTasks);
  on("user", renderAccount);
  renderTasks();
  renderAccount();
  tick();
  setInterval(tick, 10000);
}
