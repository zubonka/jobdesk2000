// A burst of stars from a point on the screen, for the happiest moment of a job search (an offer).
// Skipped for people who asked their system for less motion.

import { uiScale } from "./windows.js";

const GLYPHS = ["✦", "★", "✧", "♥", "✿", "✦"];
const COLOURS = ["var(--accent)", "var(--mint-d)", "var(--warn)", "var(--lav-d)", "var(--accent2)"];
const COUNT = 30;

const calm = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function confetti(x, y) {
  if (calm() || typeof Element.prototype.animate !== "function") return;
  const layer = document.createElement("div");
  layer.className = "confetti";
  layer.setAttribute("aria-hidden", "true");
  document.body.append(layer);

  const scale = uiScale();
  const flights = [];
  for (let i = 0; i < COUNT; i++) {
    const star = document.createElement("span");
    star.textContent = GLYPHS[i % GLYPHS.length];
    star.style.color = COLOURS[i % COLOURS.length];
    star.style.left = x + "px";
    star.style.top = y + "px";
    layer.append(star);

    // spread evenly around the circle with a little jitter, mostly upwards, then fall
    const angle = (i / COUNT) * Math.PI * 2 + Math.random() * 0.4;
    const reach = (70 + Math.random() * 110) * scale;
    const dx = Math.cos(angle) * reach, dy = Math.sin(angle) * reach - 50 * scale;
    const spin = (Math.random() - 0.5) * 540;
    flights.push(star.animate([
      { transform: "translate(-50%, -50%) scale(.3)", opacity: 1 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1) rotate(${spin / 2}deg)`, opacity: 1, offset: 0.55 },
      { transform: `translate(calc(-50% + ${dx * 1.15}px), calc(-50% + ${dy + 150 * scale}px)) scale(.8) rotate(${spin}deg)`, opacity: 0 },
    ], { duration: 1300 + Math.random() * 700, easing: "cubic-bezier(.15,.7,.35,1)", fill: "forwards" }).finished);
  }
  Promise.allSettled(flights).then(() => layer.remove());
}
