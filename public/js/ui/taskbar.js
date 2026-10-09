// Taskbar: open-window buttons, START menu, clock and the account label.

import { byId, qsa, html, setHtml } from "../core/dom.js";
import { on, emit } from "../core/events.js";
import { isAuthed, userName } from "../data/user.js";
import { APPS, APP_NAMES, isOpen, isFocused, focusWin, closeWin, openWin } from "./windows.js";

function renderTasks() {
  const wrap = byId("tb-tasks");
  const open = APP_NAMES.filter(isOpen);
  setHtml(wrap, html`${open.map((app) => html`<button type="button" class="ui tb-task${isFocused(app) ? " active" : ""}" data-app="${app}" title="${APPS[app].label}"><span class="tb-ic">${APPS[app].icon}</span><span class="lbl">${APPS[app].label}</span></button>`)}`);
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

export function initTaskbar() {
  byId("tb-tasks").addEventListener("click", (e) => {
    const t = e.target.closest(".tb-task");
    if (!t) return;
    // clicking the focused window's button minimises it, any other brings it forward
    if (isFocused(t.dataset.app)) closeWin(t.dataset.app); else focusWin(t.dataset.app);
  });

  byId("startbtn").addEventListener("click", (e) => { e.stopPropagation(); setMenu(!menu().classList.contains("open")); });
  document.addEventListener("click", (e) => {
    if (menu().classList.contains("open") && !menu().contains(e.target) && e.target.id !== "startbtn") setMenu(false);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && menu().classList.contains("open")) setMenu(false); });
  for (const item of qsa(".sm-item[data-sm]", menu())) {
    item.addEventListener("click", () => { setMenu(false); openWin(item.dataset.sm); });
  }
  byId("sm-auth").addEventListener("click", () => { setMenu(false); emit("account"); });
  byId("btn-account").addEventListener("click", () => emit("account"));

  on("windows", renderTasks);
  on("user", renderAccount);
  renderTasks();
  renderAccount();
  tick();
  setInterval(tick, 10000);
}
