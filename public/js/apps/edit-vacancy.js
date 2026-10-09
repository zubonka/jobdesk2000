// Edit dialog for one vacancy. The same dialog adds a vacancy by hand, and its AI box refills the
// fields from pasted vacancy text.

import { byId } from "../core/dom.js";
import { DEFAULT_PRIO, NONE, DEFAULT_TITLE, getJob, addJob, updateJob } from "../data/jobs.js";
import { analyzeVacancy } from "../services/api.js";
import { registerDialog, openDialog, closeDialog } from "../ui/dialogs.js";
import { say } from "../ui/clippy.js";
import { POSE } from "../fairy/render.js";

const DIALOG = "edit-overlay";
// form fields, each an element with id "ev-<name>"
const FIELDS = ["title", "company", "field", "salary", "emp", "loc", "url", "prio"];
// employment text -> the option it means, checked in this order
const EMP_MATCHES = [
  [/part/, "Part-time"], [/full/, "Full-time"], [/project|контракт|contract/, "Project / Контракт"],
  [/стаж|intern/, "Стажування"], [/freelance|фріланс/, "Freelance"], [/outsource|аутсорс/, "Outsource"],
];

let editingId = null; // id of the vacancy being edited; null while adding a new one
let session = 0;      // grows on every open, so a late AI answer never fills another vacancy's form

const formEl = (name) => byId("ev-" + name);
const setMsg = (text) => { byId("ev-msg").textContent = text; };
const close = () => closeDialog(DIALOG);

// Stored placeholders (NONE, DEFAULT_TITLE, "#") show as empty fields.
const blank = (value, placeholder) => (value == null || value === placeholder ? "" : String(value));

// An unmatched employment type gets an option of its own, so saving the form does not lose it.
function setEmpSelect(value) {
  const sel = formEl("emp");
  if (!value) { sel.value = ""; return; }
  const low = value.toLowerCase();
  const match = EMP_MATCHES.find(([pattern]) => pattern.test(low));
  if (match) { sel.value = match[1]; return; }
  if (![...sel.options].some((o) => o.value === value)) sel.add(new Option(value, value));
  sel.value = value;
}

function fillForm(values) {
  formEl("title").value = blank(values.title, DEFAULT_TITLE);
  for (const name of ["company", "field", "salary", "loc"]) formEl(name).value = blank(values[name], NONE);
  setEmpSelect(blank(values.emp, NONE));
  formEl("url").value = blank(values.url, "#");
  formEl("prio").value = values.prio;
  byId("ev-paste").value = "";
  setMsg("");
}

const readForm = () => Object.fromEntries(FIELDS.map((name) => [name, formEl(name).value]));

function open(id, values) {
  editingId = id;
  session++;
  fillForm(values);
  openDialog(DIALOG);
}

export function openEditVacancy(id) {
  const job = getJob(id);
  if (job) open(id, job);
}

// prefill: any of the form fields, e.g. { url } or an analysed vacancy
export function openNewVacancy(prefill = {}) {
  open(null, { prio: DEFAULT_PRIO, ...prefill });
}

function addNew(fields) {
  if (!addJob(fields)) { setMsg("Така вакансія вже є ✦"); return; }
  close();
  say("Додано: " + (fields.company.trim() || "вакансію") + " ✦", POSE.happy, 7000);
}

function saveChanges(fields) {
  const { job, error } = updateJob(editingId, fields);
  if (error === "duplicate") { setMsg("Така вакансія вже є ✦"); return; }
  close();
  // no job: it was removed meanwhile (a cloud update), so there is nothing left to save into
  if (job) say("Вакансію оновлено ✦", POSE.idle, 5000);
}

function save() {
  const fields = readForm();
  if (editingId === null) addNew(fields);
  else saveChanges(fields);
}

function fillFromAnalysis(d) {
  if (d.title && d.title !== DEFAULT_TITLE) formEl("title").value = d.title;
  for (const name of ["company", "field", "salary"]) if (d[name] && d[name] !== NONE) formEl(name).value = d[name];
  if (d.emp && d.emp !== NONE) setEmpSelect(d.emp);
  const loc = formEl("loc");
  if (d.loc && [...loc.options].some((o) => o.value === d.loc)) loc.value = d.loc;
  setMsg("Заповнено ✦ перевір і збережи");
}

async function analyze() {
  const text = byId("ev-paste").value.trim();
  if (text.length < 40) { setMsg("Встав більше тексту ✦"); return; }
  const mine = session;
  const button = byId("ev-analyze");
  setMsg("Фея аналізує ✦...");
  button.disabled = true;
  let d;
  try {
    d = await analyzeVacancy({ text });
  } catch (err) {
    if (mine === session) setMsg("Не вдалося ✦ " + err.message);
    return;
  } finally {
    button.disabled = false;
  }
  if (mine === session) fillFromAnalysis(d);
}

export function initEditVacancy() {
  registerDialog(DIALOG, () => { editingId = null; });
  byId("edit-close").addEventListener("click", close);
  byId("ev-cancel").addEventListener("click", close);
  byId("ev-analyze").addEventListener("click", analyze);
  byId("ev-save").addEventListener("click", save);
}
