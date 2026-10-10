// Vacancies: the in-memory list, its storage format and every change to it.
// Each change is saved immediately and announced with the "jobs" event.

import { KEYS, getJSON, getObject, setJSON } from "../core/storage.js";
import { emit } from "../core/events.js";
import { todayISO } from "../core/dom.js";
import { statusKeyOf, statusLabel } from "./statuses.js";
import { gender } from "./user.js";

export const PRIORITIES = ["100% Податися", "Податися", "Подумати"];
export const DEFAULT_PRIO = "Податися";
export const NONE = "—";
export const DEFAULT_TITLE = "Вакансія";

// The id is part of the stored progress map, so it stays "<company>|<title>".
export const jobId = (company, title) => company + "|" + title;

let jobs = [];
let collapsed = {};

const text = (value, fallback) => {
  const s = value == null ? "" : String(value).trim();
  return s || fallback;
};

// Accepts "https://...", or a bare "site.com/path" typed without the scheme.
export function normalizeUrl(value) {
  const s = String(value ?? "").trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(s)) return "https://" + s;
  return "#";
}

// "|" joins company and title into the id, so inside a name it is written as "¦": otherwise "A|B" + "C" and
// "A" + "B|C" would be one vacancy.
const noBar = (name) => name.replace(/\|/g, "¦");

function vacancy(company, title, fields) {
  return {
    id: jobId(company, title),
    prio: PRIORITIES.includes(fields.prio) ? fields.prio : DEFAULT_PRIO,
    company, title,
    field: text(fields.field, NONE), emp: text(fields.emp, NONE), loc: text(fields.loc, NONE), salary: text(fields.salary, NONE),
    url: normalizeUrl(fields.url),
  };
}

// company/title are kept byte for byte: they form the id that keys the saved progress
function fromStorage(raw) {
  const company = raw.company == null || raw.company === "" ? NONE : String(raw.company);
  const title = raw.title == null || raw.title === "" ? DEFAULT_TITLE : String(raw.title);
  return vacancy(company, title, raw);
}

const fromInput = (fields) => vacancy(noBar(text(fields.company, NONE)), noBar(text(fields.title, DEFAULT_TITLE)), fields);

// A stored vacancy whose id is taken by a different one (an old name with "|"): written apart, it stays listed.
function apartFrom(taken, job, raw) {
  if (!taken || (taken.company === job.company && taken.title === job.title)) return taken ? null : job;
  const apart = vacancy(noBar(job.company), noBar(job.title), raw);
  return apart.id === job.id ? null : apart;
}

const isVacancy = (raw) => !!raw && typeof raw === "object" && !Array.isArray(raw);

// How many different vacancies a stored list holds.
export const countVacancies = (list) => new Set((Array.isArray(list) ? list : []).filter(isVacancy)
  .map((raw) => { const job = fromStorage(raw); return job.company + "\u0000" + job.title; })).size;

const str = (value) => (typeof value === "string" ? value : "");

// A stored vacancy with its entry of the progress map (missing, null or hand-edited entries count as empty).
function withProgress(job, entry) {
  const p = entry && typeof entry === "object" ? entry : {};
  return { ...job, status: statusKeyOf(p.status), date: str(p.date), deadline: str(p.deadline), note: str(p.note) };
}

export function loadJobs() {
  const list = getJSON(KEYS.jobs, []);
  const progress = getObject(KEYS.progress);
  collapsed = getObject(KEYS.collapsed);
  const seen = new Map(); // id -> the vacancy listed under it
  jobs = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (!isVacancy(raw)) continue;
    const stored = fromStorage(raw);
    const job = apartFrom(seen.get(stored.id), stored, raw);
    if (!job || seen.has(job.id)) continue; // a second copy of the same vacancy
    seen.set(job.id, job);
    jobs.push(withProgress(job, progress[stored.id]));
  }
}

function save() {
  setJSON(KEYS.jobs, jobs.map(({ prio, company, title, field, emp, loc, salary, url }) => ({ prio, company, title, field, emp, loc, salary, url })));
  const g = gender();
  const progress = {};
  for (const j of jobs) progress[j.id] = { status: statusLabel(j.status, g), date: j.date, deadline: j.deadline, note: j.note };
  setJSON(KEYS.progress, progress);
}

export const allJobs = () => jobs;
export const getJob = (id) => jobs.find((j) => j.id === id) || null;

// Returns the new job, or null when the same company + title is already listed.
export function addJob(fields) {
  const job = fromInput(fields);
  if (jobs.some((j) => j.id === job.id)) return null;
  jobs.push({ ...job, status: "not_applied", date: "", deadline: "", note: "" });
  save();
  emit("jobs", { type: "add", id: job.id });
  return getJob(job.id);
}

// Inline edits on a card: status (a key), date, deadline, note, prio.
export function setJobField(id, key, value) {
  const job = getJob(id);
  if (!job) return null;
  job[key] = key === "status" ? statusKeyOf(value) : value;
  if (key === "status" && job.status === "applied" && !job.date) job.date = todayISO();
  save();
  emit("jobs", { type: "field", id, key });
  return job;
}

// Edits from the edit dialog. Returns { job } or { error: "duplicate" | "missing" }.
export function updateJob(id, fields) {
  const job = getJob(id);
  if (!job) return { error: "missing" };
  const next = fromInput({ ...job, ...fields });
  if (next.id !== id && jobs.some((j) => j.id === next.id)) return { error: "duplicate" };
  if (next.id !== id && collapsed[id] != null) {
    collapsed[next.id] = collapsed[id];
    delete collapsed[id];
    setJSON(KEYS.collapsed, collapsed);
  }
  Object.assign(job, next);
  save();
  emit("jobs", { type: "update", id: job.id, oldId: id });
  return { job };
}

// Returns what restoreJob() needs to bring the vacancy back, or null when it is not listed.
export function removeJob(id) {
  const index = jobs.findIndex((j) => j.id === id);
  if (index < 0) return null;
  const [job] = jobs.splice(index, 1);
  save();
  emit("jobs", { type: "remove", id });
  return { job, index };
}

// Undoes removeJob(): the vacancy returns to its place with its progress. False when it was added again meanwhile.
export function restoreJob({ job, index }) {
  if (getJob(job.id)) return false;
  jobs.splice(Math.min(index, jobs.length), 0, job);
  save();
  emit("jobs", { type: "restore", id: job.id });
  return true;
}

// Clears statuses, application dates and notes; deadlines and the vacancies themselves stay.
// Returns what restoreProgress() needs to undo it (it follows the vacancies, so a rename meanwhile is fine).
export function resetProgress() {
  const before = jobs.map((job) => ({ job, status: job.status, date: job.date, note: job.note }));
  for (const j of jobs) Object.assign(j, { status: "not_applied", date: "", note: "" });
  save();
  emit("jobs", { type: "reset" });
  return before;
}

export function restoreProgress(before) {
  for (const { job, ...fields } of before) if (jobs.includes(job)) Object.assign(job, fields);
  save();
  emit("jobs", { type: "reset" });
}

// Adds the vacancies of a backup (stored format: list + progress map) that are not listed yet.
// Vacancies already here keep their current state. Returns how many were added.
export function importJobs(list, progress) {
  const map = progress && typeof progress === "object" ? progress : {};
  let added = 0;
  for (const raw of Array.isArray(list) ? list : []) {
    if (!isVacancy(raw)) continue;
    const stored = fromStorage(raw);
    const job = apartFrom(getJob(stored.id), stored, raw);
    if (!job || getJob(job.id)) continue;
    jobs.push(withProgress(job, map[stored.id]));
    added++;
  }
  if (added) {
    save();
    emit("jobs", { type: "import" });
  }
  return added;
}

export const isCollapsed = (id) => !!collapsed[id];

export function toggleCollapsed(id) {
  collapsed[id] = !collapsed[id];
  setJSON(KEYS.collapsed, collapsed);
  emit("jobs", { type: "collapse", id });
}
