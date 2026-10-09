// START menu: save a copy of the data, restore it, and save the vacancies as a table. Works for guests too:
// for them the copy is the only way to move their vacancies to another browser.

import { byId } from "../core/dom.js";
import { on } from "../core/events.js";
import { allJobs } from "../data/jobs.js";
import { backupJSON, backupName, parseBackup, restoreBackup, vacanciesCSV, tableName } from "../services/backup.js";
import { confirmDialog } from "../ui/confirm.js";
import { toast } from "../ui/toast.js";

const MAX_BACKUP_BYTES = 20 * 1024 * 1024; // a copy with a big wallpaper is a few MB

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function saveCopy() {
  download(backupName(), backupJSON(), "application/json");
  toast("Копію збережено ✦ шукай файл у завантаженнях");
}

function saveTable() {
  if (!allJobs().length) { toast("Поки немає вакансій для таблиці ✦"); return; }
  download(tableName(), vacanciesCSV(), "text/csv;charset=utf-8");
  toast("Таблицю збережено ✦ відкривай в Excel чи Google Таблицях");
}

const dateOf = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : " від " + d.toLocaleDateString("uk-UA");
};

async function restoreFrom(file) {
  if (file.size > MAX_BACKUP_BYTES) { toast("Цей файл завеликий для копії JobDesk 2000 ✦"); return; }
  const backup = parseBackup(await file.text());
  if (!backup) { toast("Це не схоже на копію JobDesk 2000 ✦"); return; }
  const question = "Відновити копію" + dateOf(backup.exported) + " (вакансій: " + backup.count + ")? "
    + "Вакансії, яких тут немає, додадуться, а наявні лишаться як є.";
  if (!(await confirmDialog(question, { ok: "Відновити" }))) return;
  const { added, filled } = restoreBackup(backup);
  if (added) toast("Готово ✦ додано вакансій: " + added);
  else if (filled) toast("Готово ✦ фею, резюме чи фон узято з копії");
  else toast("Усе з цієї копії вже тут ✦");
}

export function initBackup() {
  const input = byId("backup-file");
  input.addEventListener("change", () => {
    const file = input.files[0];
    input.value = ""; // the same file chosen again must fire "change" again
    if (file) restoreFrom(file).catch(() => toast("Не вдалося прочитати файл ✦"));
  });
  on("menu", (action) => {
    if (action === "backup") saveCopy();
    else if (action === "restore") input.click();
    else if (action === "table") saveTable();
  });
}
