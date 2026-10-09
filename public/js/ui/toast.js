// Short notices at the bottom of the screen (saved, copied, imported...), with an optional action button.
// Unlike the fairy they are shown to guests too, and they never cover a window's controls for long.

import { byId, html, setHtml } from "../core/dom.js";

const DEFAULT_MS = 4500;
let hideTimer = null;

// toast("Збережено ✦") or toast("Вакансію прибрано ✦", { action: "↶ Повернути", onAction: undo })
export function toast(text, { action, onAction, ms = DEFAULT_MS } = {}) {
  const box = byId("toast");
  setHtml(box, html`<span class="toast-text">${text}</span>${action ? html`<button type="button" class="ui toast-act">${action}</button>` : ""}`);
  if (action) {
    box.querySelector(".toast-act").addEventListener("click", () => {
      hideToast();
      onAction();
    }, { once: true });
  }
  box.hidden = false;
  box.classList.remove("leaving");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideToast, ms);
}

export function hideToast() {
  const box = byId("toast");
  if (box.hidden) return;
  box.classList.add("leaving");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { box.hidden = true; box.classList.remove("leaving"); }, 250);
}
