import { test } from "node:test";
import assert from "node:assert/strict";
import "./fake-storage.mjs";

const { detectSpecialty, SPECIALTIES } = await import("../../public/js/content/phrases.js");
const keyOf = (text) => detectSpecialty(text)?.key ?? null;

test("no text or no keyword means no specialty", () => {
  assert.equal(detectSpecialty(""), null);
  assert.equal(detectSpecialty(null), null);
  assert.equal(detectSpecialty("Кухар у ресторані"), null);
});

test("keywords are found regardless of case", () => {
  assert.equal(keyOf("Senior GRAPHIC DESIGNER: Figma, Photoshop"), "design");
  assert.equal(keyOf("Python backend розробник"), "dev");
  assert.equal(keyOf("SMM і таргетована реклама"), "marketing");
  assert.equal(keyOf("Scrum master, agile"), "pm");
  assert.equal(keyOf("Музика, звук, продюсер"), "music");
});

test("the specialty with the most keyword hits wins", () => {
  assert.equal(keyOf("React and JavaScript developer who once opened Figma"), "dev");
});

test("a tie goes to the specialty listed first", () => {
  assert.equal(keyOf("design and code"), "design");
});

test("the result is the SPECIALTIES entry with its phrases", () => {
  const found = detectSpecialty("figma");
  assert.equal(found, SPECIALTIES.find((s) => s.key === "design"));
  assert.ok(found.phr.length > 0);
});

test("keywords count only at the start of a word, and short ones only as whole words", () => {
  for (const text of [
    "Accountant. Built monthly reports quickly as required, guidance for juniors, equipment audits",
    "Кухарка: продукти харчування, продуктивна зміна",
    "Юрист: Цивільний кодекс, Податковий кодекс",
    "Касир у супермаркеті, штрих-коди товарів",
    "Логіст, обробка рекламацій",
  ]) assert.equal(keyOf(text), null, text);
  assert.equal(keyOf("UI/UX designer"), "design");
  assert.equal(keyOf("UX researcher"), "design");
  assert.equal(keyOf("Розробниця на Java"), "dev");
  assert.equal(keyOf("Маркетологиня, таргетована реклама"), "marketing");
  assert.equal(keyOf("Продакт-менеджер у стартапі"), "pm");
});
