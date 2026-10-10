import { test } from "node:test";
import assert from "node:assert/strict";
import "./fake-storage.mjs";

const { lighten, applyFairyColors } = await import("../../public/js/fairy/render.js");
const { SKIN } = await import("../../public/js/fairy/store.js");

test("lighten mixes every channel toward white and rounds", () => {
  assert.equal(lighten("#000000", 0.5), "#808080");
  assert.equal(lighten("#BDC8FF", 0.25), "#ced6ff");
  assert.equal(lighten("#123456", 1), "#ffffff");
});

test("lighten by 0 keeps the colour, written in lower case", () => {
  assert.equal(lighten("#280F59", 0), "#280f59");
});

test("lighten returns a value it cannot parse unchanged", () => {
  assert.equal(lighten("none", 0.3), "none");
});

test("applyFairyColors sets the zone variables, the second wing tone a quarter lighter", () => {
  const props = {};
  const el = { style: { setProperty: (name, value) => { props[name] = value; } } };
  applyFairyColors(el, { hair: "#280F59", wing: "#BDC8FF", wingline: "#FFFFFF", dress: "#FF9EEA", trink: "#DF20F5" });
  assert.deepEqual(props, {
    "--fz-hair": "#280F59", "--fz-wing": "#BDC8FF", "--fz-wing2": "#ced6ff", "--fz-wingline": "#FFFFFF",
    "--fz-dress": "#FF9EEA", "--fz-trink": "#DF20F5", "--fz-skin": SKIN,
  });
});
