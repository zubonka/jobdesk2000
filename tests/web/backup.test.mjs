import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { storage } from "./fake-storage.mjs";

const { KEYS } = await import("../../public/js/core/storage.js");
const { setUser } = await import("../../public/js/data/user.js");
const jobs = await import("../../public/js/data/jobs.js");
const { backupJSON, parseBackup, restoreBackup, csvCell, vacanciesCSV } = await import("../../public/js/services/backup.js");

beforeEach(() => {
  setUser({ name: "Оля", gender: "f" });
  storage.clear();
  jobs.loadJobs();
});

test("a copy holds the user's data in the stored format and reads back", () => {
  jobs.addJob({ company: "Acme", title: "Designer", url: "https://acme.example/1" });
  jobs.setJobField("Acme|Designer", "note", "HR: Оля");
  storage.setItem(KEYS.cv, "Олена, дизайнерка, 5 років досвіду у брендингу та айдентиці.");
  storage.setItem(KEYS.user, JSON.stringify({ name: "Оля", uid: "secret-uid" }));
  storage.setItem(KEYS.syncBase, "{}");

  const text = backupJSON();
  const doc = JSON.parse(text);
  assert.equal(doc.app, "JobDesk 2000");
  assert.equal(doc.data[KEYS.jobs], storage.getItem(KEYS.jobs));
  assert.equal(doc.data[KEYS.progress], storage.getItem(KEYS.progress));
  assert.equal(doc.data[KEYS.cv], storage.getItem(KEYS.cv));
  assert.equal(doc.data[KEYS.user], undefined, "the account record stays out of the file");
  assert.equal(doc.data[KEYS.syncBase], undefined, "so does the sync bookkeeping");

  const parsed = parseBackup(text);
  assert.equal(parsed.count, 1);
  assert.ok(parsed.exported);
});

test("anything that is not a JobDesk 2000 copy is refused", () => {
  for (const text of ["", "not json", "null", "[]", '{"app":"Other","data":{}}', '{"app":"JobDesk 2000"}', '{"app":"JobDesk 2000","data":"x"}']) {
    assert.equal(parseBackup(text), null, text);
  }
  // unknown keys and non-string values are dropped
  const parsed = parseBackup(JSON.stringify({ app: "JobDesk 2000", data: { [KEYS.jobs]: "[]", [KEYS.user]: "{}", evil: "x", [KEYS.cv]: 42 } }));
  assert.deepEqual(Object.keys(parsed.data), [KEYS.jobs]);
});

test("restoring adds the missing vacancies and fills in only what this device does not have", () => {
  jobs.addJob({ company: "Acme", title: "Designer" });
  jobs.setJobField("Acme|Designer", "status", "offer");
  storage.setItem(KEYS.cv, "local cv text that must stay exactly as it is here");
  const copy = {
    data: {
      [KEYS.jobs]: JSON.stringify([
        { prio: "Податися", company: "Acme", title: "Designer", field: "old", emp: "—", loc: "—", salary: "—", url: "#" },
        { prio: "Подумати", company: "Beta", title: "Illustrator", field: "Арт", emp: "—", loc: "—", salary: "—", url: "#" },
      ]),
      [KEYS.progress]: JSON.stringify({ "Acme|Designer": { status: "Відмова" }, "Beta|Illustrator": { status: "Подалася", date: "2026-10-01", deadline: "", note: "з копії" } }),
      [KEYS.cv]: "cv from the copy",
      [KEYS.fairy]: JSON.stringify({ name: "Піксі", current: "type2", type1: {}, type2: {} }),
    },
  };
  const result = restoreBackup(copy);
  assert.deepEqual(result, { added: 1, filled: 1 });
  assert.equal(jobs.getJob("Acme|Designer").status, "offer");
  assert.equal(jobs.getJob("Beta|Illustrator").note, "з копії");
  assert.equal(storage.getItem(KEYS.cv), "local cv text that must stay exactly as it is here");
  assert.equal(JSON.parse(storage.getItem(KEYS.fairy)).name, "Піксі");
  assert.deepEqual(restoreBackup(copy), { added: 0, filled: 0 });
});

test("CSV cells are quoted when needed and never start a formula", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("a;b"), '"a;b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("line\nbreak"), '"line\nbreak"');
  assert.equal(csvCell("=HYPERLINK(\"http://evil\")"), "\"'=HYPERLINK(\"\"http://evil\"\")\"");
  for (const start of ["+", "-", "@"]) assert.equal(csvCell(start + "1"), "'" + start + "1");
  assert.equal(csvCell("—"), "", "the app's placeholder is an empty cell");
  assert.equal(csvCell(undefined), "");
});

test("the CSV has a BOM, a header and one row per vacancy with the status in the user's form", () => {
  jobs.addJob({ company: "Acme", title: "Designer", salary: "$2000", url: "https://acme.example/1" });
  jobs.setJobField("Acme|Designer", "status", "applied");
  const csv = vacanciesCSV();
  assert.ok(csv.startsWith("﻿"));
  const lines = csv.slice(1).trimEnd().split("\r\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "Пріоритет;Компанія;Посада;Галузь;Зайнятість;Формат / локація;Зарплата;Статус;Дата подачі;Дедлайн;Нотатки;Посилання");
  const cells = lines[1].split(";");
  assert.deepEqual([cells[1], cells[2], cells[6], cells[7], cells[11]], ["Acme", "Designer", "$2000", "Подалася", "https://acme.example/1"]);
  assert.match(cells[8], /^\d{4}-\d{2}-\d{2}$/);
});
