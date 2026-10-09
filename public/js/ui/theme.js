// Light / dark theme: a class on <html>. An inline script in index.html applies the saved
// theme before the first paint; this module keeps it in sync and owns the toggle button.

import { KEYS, getRaw, setRaw } from "../core/storage.js";
import { byId } from "../core/dom.js";

let theme = "light";

export const currentTheme = () => theme;

export function applyTheme(next) {
  theme = next === "dark" ? "dark" : "light";
  const root = document.documentElement;
  root.classList.toggle("theme-dark", theme === "dark");
  root.classList.toggle("theme-light", theme === "light");
  byId("btn-theme").textContent = theme === "dark" ? "🌙" : "☀️";
}

export const reloadTheme = () => applyTheme(getRaw(KEYS.theme) || "light");

export function initTheme() {
  reloadTheme();
  byId("btn-theme").addEventListener("click", () => {
    applyTheme(theme === "dark" ? "light" : "dark");
    setRaw(KEYS.theme, theme);
  });
}
