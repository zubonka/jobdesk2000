// A copy of the user's data as a JSON file, and the vacancies as a CSV table for Excel or Google Sheets.
// The copy holds the raw storage values, the format the cloud copy and older versions use too.
// Restoring never overwrites: vacancies already here stay as they are, the fairy, CV and wallpaper are only
// filled in when this device has none.

import { KEYS, getRaw, setRaw } from "../core/storage.js";
import { emit } from "../core/events.js";
import { todayISO, isPictureData } from "../core/dom.js";
import { allJobs, importJobs, countVacancies, NONE } from "../data/jobs.js";
import { statusLabel } from "../data/statuses.js";
import { gender } from "../data/user.js";

const APP = "JobDesk 2000";
const FORMAT = 1;
const BACKUP_KEYS = [KEYS.jobs, KEYS.progress, KEYS.collapsed, KEYS.fairy, KEYS.cv, KEYS.wallpaper];
const FILL_IN_KEYS = [KEYS.fairy, KEYS.cv, KEYS.wallpaper];

const parse = (text, fallback) => { try { return JSON.parse(text) ?? fallback; } catch (e) { return fallback; } };

export const backupName = () => "jobdesk2000-backup-" + todayISO() + ".json";
export const tableName = () => "jobdesk2000-vacancies-" + todayISO() + ".csv";

export function backupJSON() {
  const data = {};
  for (const key of BACKUP_KEYS) {
    const value = getRaw(key);
    if (value != null) data[key] = value;
  }
  return JSON.stringify({ app: APP, format: FORMAT, exported: new Date().toISOString(), data }, null, 1);
}

// null when the text is not a JobDesk 2000 copy
export function parseBackup(text) {
  const doc = parse(text, null);
  if (!doc || doc.app !== APP || !doc.data || typeof doc.data !== "object") return null;
  const data = {};
  for (const key of BACKUP_KEYS) if (typeof doc.data[key] === "string") data[key] = doc.data[key];
  if (data[KEYS.wallpaper] && !isPictureData(data[KEYS.wallpaper])) delete data[KEYS.wallpaper]; // a picture, not an address
  return { data, exported: typeof doc.exported === "string" ? doc.exported : "", count: countVacancies(parse(data[KEYS.jobs], [])) };
}

// Returns { added: vacancies added, filled: other parts taken from the copy }.
export function restoreBackup({ data }) {
  const added = importJobs(parse(data[KEYS.jobs], []), parse(data[KEYS.progress], {}));
  let filled = 0;
  for (const key of FILL_IN_KEYS) {
    if (data[key] && getRaw(key) == null && setRaw(key, data[key])) filled++;
  }
  if (filled) emit("state"); // the fairy, CV and wallpaper modules reload from storage
  return { added, filled };
}

/* ----- CSV ----- */

const COLUMNS = [
  ["Пріоритет", (j) => j.prio], ["Компанія", (j) => j.company], ["Посада", (j) => j.title], ["Галузь", (j) => j.field],
  ["Зайнятість", (j) => j.emp], ["Формат / локація", (j) => j.loc], ["Зарплата", (j) => j.salary],
  ["Статус", (j, g) => statusLabel(j.status, g)], ["Дата подачі", (j) => j.date], ["Дедлайн", (j) => j.deadline],
  ["Нотатки", (j) => j.note], ["Посилання", (j) => (j.url === "#" ? "" : j.url)],
];

// A spreadsheet must never run a cell as a formula, and ";" is the list separator of Excel in Ukrainian.
export function csvCell(value) {
  let text = String(value ?? "");
  if (text === NONE) text = "";
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[";\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

export function vacanciesCSV(jobs = allJobs(), g = gender()) {
  const lines = [COLUMNS.map(([title]) => csvCell(title)).join(";")];
  for (const job of jobs) lines.push(COLUMNS.map(([, get]) => csvCell(get(job, g))).join(";"));
  return "﻿" + lines.join("\r\n") + "\r\n"; // the BOM makes Excel read UTF-8
}
