// Draws a fairy as inline SVG. Colours are CSS variables set on the container element.

import { FAIRY_ART } from "./art.js";
import { SKIN, fairyColors, fairyType } from "./store.js";

export const POSE = { idle: 0, happy: 1, sad: 2 };

export function fairySvg(type, pose = POSE.idle, size = "100%") {
  const art = FAIRY_ART[type] && FAIRY_ART[type][pose];
  if (!art) return "";
  return `<svg viewBox="${art.viewBox}" width="${size}" height="${size}" aria-hidden="true" focusable="false">${art.body}</svg>`;
}

export function lighten(hex, amount) {
  const n = parseInt(String(hex).slice(1), 16);
  if (Number.isNaN(n)) return hex;
  const mix = (c) => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

export function applyFairyColors(el, colours) {
  const vars = {
    "--fz-hair": colours.hair, "--fz-wing": colours.wing, "--fz-wing2": lighten(colours.wing, 0.25),
    "--fz-wingline": colours.wingline, "--fz-dress": colours.dress, "--fz-trink": colours.trink, "--fz-skin": SKIN,
  };
  for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, value);
}

// options: type (default: the user's), pose, size, colours (default: that type's colours)
export function paintFairy(el, { type = fairyType(), pose = POSE.idle, size = "100%", colours } = {}) {
  if (!el) return;
  applyFairyColors(el, colours || fairyColors(type));
  el.innerHTML = fairySvg(type, pose, size);
}
