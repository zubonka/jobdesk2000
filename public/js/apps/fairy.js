// "Моя Фея" window: the fairy's type, name and colours, plus the desktop wallpaper
// (old TV effect) that the fairy's colours can be matched to.

import { byId, qsa, isPictureData } from "../core/dom.js";
import { on, emit } from "../core/events.js";
import { KEYS, getRaw, setRaw, remove } from "../core/storage.js";
import {
  TYPES, ZONES, ZONE_DEFAULTS, fairyType, fairyName, fairyColors,
  setFairyType, setFairyName, setZoneColor, setAllZones, saveFairy,
} from "../fairy/store.js";
import { paintFairy, POSE } from "../fairy/render.js";
import { say } from "../ui/clippy.js";

const TYPE_PREVIEW = { type1: "tb1", type2: "tb2" };
const WALL_MAX_WIDTH = 1280;
const WALL_QUALITY = 0.8;
const PALETTE_SIZE = 6;
const SAMPLE_SIZE = 64;
const MIN_COLOUR_DISTANCE = 60;

// only a picture of our own: a wallpaper pointing anywhere else would make the page call that server
const storedWall = () => { const wall = getRaw(KEYS.wallpaper) || ""; return isPictureData(wall) ? wall : ""; };

function renderFairy() {
  const name = fairyName();
  const colours = fairyColors();
  for (const btn of qsa(".type-btn")) btn.classList.toggle("sel", btn.dataset.type === fairyType());
  for (const type of TYPES) paintFairy(byId(TYPE_PREVIEW[type]), { type });
  paintFairy(byId("fairy-preview"));
  for (const zone of ZONES) byId("cc-" + zone).value = colours[zone];
  byId("fairy-hello").textContent = name ? "Твоя фея: " + name + " ✦" : "Обери свою фею ✦";
  // the store already holds what is being typed; rewriting the field would only move the caret
  const input = byId("fairy-name");
  if (document.activeElement !== input) input.value = name;
}

const randomColour = () => "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0");

const randomize = () => setAllZones(Object.fromEntries(ZONES.map((zone) => [zone, randomColour()])));

function save() {
  saveFairy();
  say((fairyName() || "Фея") + " готова допомагати ✦ Полетіли!", POSE.happy, 9000);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image could not be decoded"));
    img.src = src;
  });
}

function samplePixels(img) {
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  return ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
}

// Groups the pixels into 8 levels per channel and ranks the groups by size and saturation.
// Only near-black and near-white pixels are skipped, so dark and pastel pictures still give colours.
function rankedColours(pixels) {
  const buckets = {};
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    if (pixels[i + 3] < 128) continue;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const light = (max + min) / 2;
    if (light < 20 || light > 250) continue;
    const bucket = (buckets[(r >> 5) + "," + (g >> 5) + "," + (b >> 5)] ||= { r: 0, g: 0, b: 0, count: 0, score: 0 });
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    bucket.count++;
    bucket.score += max - min + 30;
  }
  return Object.values(buckets)
    .map((bk) => ({ r: Math.round(bk.r / bk.count), g: Math.round(bk.g / bk.count), b: Math.round(bk.b / bk.count), score: bk.score }))
    .sort((x, y) => y.score - x.score);
}

const toHex = (c) => "#" + [c.r, c.g, c.b].map((x) => x.toString(16).padStart(2, "0")).join("");
const distance = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);

// The n best-ranked colours that are not too alike; a picture with fewer distinct colours repeats them.
function extractPalette(pixels, n) {
  const ranked = rankedColours(pixels);
  const out = [];
  for (const c of ranked) {
    if (out.every((o) => distance(o, c) > MIN_COLOUR_DISTANCE)) {
      out.push(c);
      if (out.length >= n) break;
    }
  }
  while (out.length < n && ranked.length) out.push(ranked[out.length % ranked.length]);
  return out.map(toHex);
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

// Every zone takes the palette colour whose brightness is closest to the zone's default,
// so dark hair stays dark and light wings stay light.
function zonesFromPalette(palette) {
  const colours = {};
  for (const zone of ZONES) {
    const target = luminance(ZONE_DEFAULTS[zone]);
    let best = palette[0], bestDistance = Infinity;
    for (const c of palette) {
      const d = Math.abs(luminance(c) - target);
      if (d < bestDistance) { bestDistance = d; best = c; }
    }
    colours[zone] = best;
  }
  return colours;
}

async function matchWallpaper() {
  const wall = storedWall();
  if (!wall) {
    say("Спершу завантаж фон ✦ тоді підберу кольори феї під нього.", POSE.idle, 7000);
    return;
  }
  const palette = extractPalette(samplePixels(await loadImage(wall)), PALETTE_SIZE);
  if (palette.length) setAllZones(zonesFromPalette(palette));
  say("Фею перефарбовано під фон ✦", POSE.happy, 7000);
}

function applyWall(dataUrl) {
  byId("wall-layer").style.backgroundImage = dataUrl ? `url("${dataUrl}")` : "";
  byId("desktop").classList.toggle("has-wall", !!dataUrl);
  byId("wall-remove").hidden = !dataUrl;
}

// A downscaled JPEG keeps the picture small enough for localStorage.
function toWallpaper(img) {
  let w = img.naturalWidth, h = img.naturalHeight;
  if (w > WALL_MAX_WIDTH) { h = Math.round(h * WALL_MAX_WIDTH / w); w = WALL_MAX_WIDTH; }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", WALL_QUALITY);
}

async function uploadWallpaper(input) {
  const file = input.files[0];
  input.value = ""; // so that picking the same file again fires "change" again
  if (!file || !file.type.startsWith("image/")) return;
  const url = URL.createObjectURL(file);
  let img;
  try { img = await loadImage(url); } finally { URL.revokeObjectURL(url); }
  if (!setRaw(KEYS.wallpaper, toWallpaper(img))) {
    say("Зображення завелике ✦ спробуй менше.", POSE.idle, 7000);
    return;
  }
  emit("wallpaper");
  say("Новий фон встановлено ✦ як на старому телику! Хочеш — натисни «🖼 Під фон», щоб і фею підібрати під нього.", POSE.happy, 10000);
}

function removeWallpaper() {
  remove(KEYS.wallpaper);
  emit("wallpaper");
}

const warnImage = (err) => console.warn("wallpaper image not usable:", err);

export function initFairyApp() {
  for (const btn of qsa(".type-btn")) btn.addEventListener("click", () => setFairyType(btn.dataset.type));
  byId("fairy-name").addEventListener("input", (e) => setFairyName(e.target.value.trim()));
  for (const zone of ZONES) byId("cc-" + zone).addEventListener("input", (e) => setZoneColor(zone, e.target.value));
  byId("fairy-random").addEventListener("click", randomize);
  byId("fairy-save").addEventListener("click", save);
  byId("fairy-match").addEventListener("click", () => matchWallpaper().catch(warnImage));

  const file = byId("wall-file");
  byId("wall-upload").addEventListener("click", () => file.click());
  file.addEventListener("change", () => uploadWallpaper(file).catch(warnImage));
  byId("wall-remove").addEventListener("click", removeWallpaper);

  // a cloud "state" arrives here too: main.js reloads the store, then emits "fairy" and "wallpaper"
  on("fairy", renderFairy);
  on("wallpaper", () => applyWall(storedWall()));
  renderFairy();
  applyWall(storedWall());
}
