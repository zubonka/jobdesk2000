// "Are you sure?" in the app's own style instead of the browser's grey confirm().
// confirmDialog(text) resolves true for "Так" and false for "Скасувати", the close button or Escape.

import { byId } from "../core/dom.js";
import { registerDialog, openDialog, closeDialog } from "./dialogs.js";
import { paintFairy, POSE } from "../fairy/render.js";

const DIALOG = "confirm-overlay";
let settle = null;

function finish(answer) {
  const done = settle;
  settle = null;
  closeDialog(DIALOG);
  if (done) done(answer);
}

export function confirmDialog(text, { ok = "Так", cancel = "Скасувати" } = {}) {
  if (settle) finish(false); // a second question replaces the first
  byId("confirm-text").textContent = text;
  byId("confirm-ok").textContent = ok;
  byId("confirm-cancel").textContent = cancel;
  paintFairy(byId("confirm-fairy"), { pose: POSE.sad });
  openDialog(DIALOG);
  byId("confirm-ok").focus();
  return new Promise((resolve) => { settle = resolve; });
}

export function initConfirm() {
  // closing by Escape or the ✕ counts as "no"
  registerDialog(DIALOG, () => { if (settle) { const done = settle; settle = null; done(false); } });
  byId("confirm-ok").addEventListener("click", () => finish(true));
  byId("confirm-cancel").addEventListener("click", () => finish(false));
  byId("confirm-close").addEventListener("click", () => finish(false));
}
