// DOM helpers shared by every module.

export const byId = (id) => document.getElementById(id);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

class SafeHtml {
  constructor(text) { this.text = text; }
  toString() { return this.text; }
}

// Marks a trusted string as markup, so html`` does not escape it.
export const raw = (text) => new SafeHtml(String(text));

const render = (value) => {
  if (value instanceof SafeHtml) return value.text;
  if (Array.isArray(value)) return value.map(render).join("");
  if (value == null || value === false) return "";
  return escapeHtml(value);
};

// Tagged template: every ${value} is HTML-escaped unless it is raw(...) or another html`` result.
// Arrays are joined, null/undefined/false render as nothing.
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, i) => { out += render(value) + strings[i + 1]; });
  return new SafeHtml(out);
}

export function setHtml(el, markup) {
  el.innerHTML = String(markup);
  return el;
}

// Links that leave the app must be http(s); everything else becomes "#".
export const safeUrl = (url) => {
  const s = String(url ?? "").trim();
  return /^https?:\/\//i.test(s) ? s : "#";
};

// A picture stored as a data: URL (the wallpaper); anything else, a remote address above all, is refused.
export const isPictureData = (value) => typeof value === "string" && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(value);

// Local date as YYYY-MM-DD (toISOString would give the UTC date).
export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Hands a file made in the page to the browser's downloads.
export function downloadFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
