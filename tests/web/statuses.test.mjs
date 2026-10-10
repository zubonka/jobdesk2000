import { test } from "node:test";
import assert from "node:assert/strict";
import { STATUS_KEYS, statusLabels, statusLabel, statusKeyOf } from "../../public/js/data/statuses.js";

// STATUS_FORMS of the original single-file app: saved progress holds these exact strings
const ORIGINAL_FORMS = {
  f: ["Не подавалася", "Подалася", "Перша співбесіда", "Тестове завдання", "Друга співбесіда", "Третя співбесіда", "Оффер", "Відмова"],
  m: ["Не подавався", "Подався", "Перша співбесіда", "Тестове завдання", "Друга співбесіда", "Третя співбесіда", "Оффер", "Відмова"],
  n: ["Не подавалися", "Подалися", "Перша співбесіда", "Тестове завдання", "Друга співбесіда", "Третя співбесіда", "Оффер", "Відмова"],
};

test("labels per gender match the original app", () => {
  for (const g of ["f", "m", "n"]) assert.deepEqual(statusLabels(g), ORIGINAL_FORMS[g], g);
});

test("an unknown gender gets the neutral labels", () => {
  assert.deepEqual(statusLabels(undefined), ORIGINAL_FORMS.n);
  assert.deepEqual(statusLabels("x"), ORIGINAL_FORMS.n);
});

test("statusLabel picks the gendered form, unknown keys fall back to not applied", () => {
  assert.equal(statusLabel("applied", "f"), "Подалася");
  assert.equal(statusLabel("applied", "m"), "Подався");
  assert.equal(statusLabel("not_applied", "n"), "Не подавалися");
  assert.equal(statusLabel("offer", "m"), "Оффер");
  assert.equal(statusLabel("nope", "f"), "Не подавалася");
});

test("every label of every gender maps back to its key", () => {
  for (const g of ["f", "m", "n"]) {
    for (const key of STATUS_KEYS) assert.equal(statusKeyOf(statusLabel(key, g)), key, `${g} ${key}`);
  }
});

test("statusKeyOf accepts keys and treats anything unknown as not applied", () => {
  assert.equal(statusKeyOf("interview2"), "interview2");
  assert.equal(statusKeyOf("Подався"), "applied");
  assert.equal(statusKeyOf("whatever"), "not_applied");
  assert.equal(statusKeyOf(undefined), "not_applied");
});
