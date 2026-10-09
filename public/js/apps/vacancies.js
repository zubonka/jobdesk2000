// Vacancies window: adding vacancies (by link, from pasted text or by hand), the filters and the board of cards.

import { byId, html, raw, setHtml, safeUrl } from "../core/dom.js";
import { on } from "../core/events.js";
import { PRIORITIES, NONE, allJobs, getJob, addJob, setJobField, removeJob, resetProgress, isCollapsed, toggleCollapsed } from "../data/jobs.js";
import { STATUS_KEYS, statusLabel } from "../data/statuses.js";
import { gender, isAuthed } from "../data/user.js";
import { hasCV, persona } from "../data/profile.js";
import { detectSpecialty } from "../content/phrases.js";
import { analyzeVacancy, analyzeProfile } from "../services/api.js";
import { say, reactToStatus } from "../ui/clippy.js";
import { POSE } from "../fairy/render.js";
import { openEditVacancy, openNewVacancy } from "./edit-vacancy.js";

// filter select id and the job property it compares
const FILTERS = [["f-prio", "prio"], ["f-field", "field"], ["f-emp", "emp"], ["f-status", "status"]];
const TAGS = [["field", "◈"], ["emp", "⧗"], ["loc", "📍"], ["salary", "₴"]];
const LINK_LABELS = { not_applied: "Податися ↗", reject: "Переглянути ↗", offer: "Відкрити ↗" };
// "jobs" changes that alter what the board shows. Date and note edits are not among them,
// so a card is never redrawn under the user's cursor while they type.
const BOARD_CHANGES = ["add", "remove", "update", "reload", "reset", "collapse"];
const BOARD_FIELDS = ["status", "prio"];

const setMsg = (text) => { byId("add-url-msg").textContent = text; };
const selected = (flag) => (flag ? raw(" selected") : "");

/* ----- filters ----- */

// options: [value, label] pairs; the selection survives the rebuild when its value is still offered
function fillSelect(sel, allLabel, options) {
  const current = sel.value;
  setHtml(sel, html`<option value="">${allLabel}</option>${options.map(([value, label]) => html`<option value="${value}">${label}</option>`)}`);
  if (options.some(([value]) => value === current)) sel.value = current;
}

const distinct = (key) => [...new Set(allJobs().map((job) => job[key]))].filter((value) => value !== NONE).sort();

function fillFilters() {
  const g = gender();
  fillSelect(byId("f-field"), "Всі галузі", distinct("field").map((value) => [value, value]));
  fillSelect(byId("f-emp"), "Всі типи", distinct("emp").map((value) => [value, value]));
  fillSelect(byId("f-status"), "Всі статуси", STATUS_KEYS.map((key) => [key, statusLabel(key, g)]));
}

function visibleJobs() {
  const active = FILTERS.map(([id, key]) => [key, byId(id).value]).filter(([, value]) => value);
  return allJobs().filter((job) => active.every(([key, value]) => job[key] === value));
}

function resetFilters() {
  for (const [id] of FILTERS) byId(id).value = "";
  renderBoard();
}

/* ----- board ----- */

function cardHead(job, folded) {
  return html`<div class="jhead">
    <select class="js-f jprio-sel" data-id="${job.id}" data-k="prio">${PRIORITIES.map((prio) => html`<option${selected(prio === job.prio)}>${prio}</option>`)}</select>
    <span class="jtools">
      <button type="button" class="ui jcol" data-id="${job.id}" title="${folded ? "Розгорнути" : "Згорнути"}">${folded ? "▸" : "▾"}</button>
      <button type="button" class="ui jedit" data-id="${job.id}" title="Редагувати">✏️</button>
      <button type="button" class="ui jdel" data-id="${job.id}" title="Видалити вакансію">🗑</button>
    </span>
  </div>`;
}

function cardDetails(job) {
  return html`
    <div class="jrow"><label>📅 Дата подачі</label><input type="date" class="js-f" data-id="${job.id}" data-k="date" value="${job.date}"></div>
    <div class="jrow"><label>⏳ Дедлайн</label><input type="date" class="js-f" data-id="${job.id}" data-k="deadline" value="${job.deadline}"></div>
    <div class="jrow"><label>📝 Нотатки</label><textarea class="js-f" data-id="${job.id}" data-k="note" rows="1" placeholder="контакт, деталі...">${job.note}</textarea></div>`;
}

function cardFoot(job, g) {
  return html`<div class="jfoot">
    <select class="st-sel js-f" data-id="${job.id}" data-k="status">${STATUS_KEYS.map((key) => html`<option value="${key}"${selected(key === job.status)}>${statusLabel(key, g)}</option>`)}</select>
    <a class="jlink" href="${safeUrl(job.url)}" target="_blank" rel="noopener">${LINK_LABELS[job.status] || "Перейти ↗"}</a>
  </div>`;
}

function card(job, g) {
  const folded = isCollapsed(job.id);
  const tags = TAGS.filter(([key]) => job[key] !== NONE).map(([key, icon]) => html`<span class="jtag">${icon} ${job[key]}</span>`);
  return html`<div class="jobcard">
    ${cardHead(job, folded)}
    <div class="jt">${job.title}</div><div class="jc">${job.company}</div><div>${tags}</div>
    ${folded ? "" : cardDetails(job)}
    ${cardFoot(job, g)}
  </div>`;
}

function renderBoard() {
  const jobs = visibleJobs(), g = gender();
  const groups = PRIORITIES.map((prio) => [prio, jobs.filter((job) => job.prio === prio)]).filter(([, list]) => list.length);
  setHtml(byId("board"), groups.length
    ? html`${groups.map(([prio, list]) => html`<div class="gh">✦ ${prio} [${list.length}]</div>${list.map((job) => card(job, g))}`)}`
    : html`<div class="muted empty">Нічого не знайдено</div>`);
}

function refresh() {
  fillFilters();
  renderBoard();
}

function confirmRemove(id) {
  const job = getJob(id);
  if (!job || !confirm("Видалити «" + job.company + " — " + job.title + "» зі списку?")) return;
  removeJob(id);
  say("Вакансію прибрано ✦", POSE.idle, 5000);
}

function clearProgress() {
  if (!confirm("Обнулити всі статуси, дати й нотатки?")) return;
  resetProgress();
  say("Чистий старт ✦ летимо спочатку!", POSE.idle, 8000);
}

// prio and status selects
function onBoardChange(e) {
  const el = e.target;
  if (!el.matches("select.js-f")) return;
  const { id, k } = el.dataset, value = el.value;
  setJobField(id, k, value);
  if (k === "status") reactToStatus(value);
}

// date, deadline and note; selects fire "input" too, so they are left to onBoardChange
function onBoardInput(e) {
  const el = e.target;
  if (el.matches("input.js-f, textarea.js-f")) setJobField(el.dataset.id, el.dataset.k, el.value);
}

function onBoardClick(e) {
  const btn = e.target.closest(".jtools button");
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.classList.contains("jcol")) toggleCollapsed(id);
  else if (btn.classList.contains("jedit")) openEditVacancy(id);
  else if (btn.classList.contains("jdel")) confirmRemove(id);
}

/* ----- adding ----- */

// The button stays disabled while its request runs, so one click sends one request.
async function analyzeWith(button, payload) {
  button.disabled = true;
  try { return await analyzeVacancy(payload); } finally { button.disabled = false; }
}

const companyOr = (d) => (d.company && d.company !== NONE ? d.company : "вакансію");

// Returns false when the vacancy is already listed.
function addAnalyzed(d, url) {
  if (!addJob({ ...d, url })) { setMsg("Ця вакансія вже у списку ✦"); return false; }
  setMsg("Додано: " + companyOr(d) + " ✦");
  return true;
}

// Many job sites block the server-side page fetch. The pasted-text route still works, so it opens
// with the link already filled in.
function offerPaste(url) {
  setMsg("Не вдалося відкрити сторінку (сайт міг заблокувати) ✦ Скопіюй текст вакансії й натисни «📋 Вставити текст вакансії».");
  byId("a-paste-url").value = url;
  byId("paste-box").hidden = false;
}

async function addFromUrl() {
  const url = byId("add-url").value.trim();
  if (!url) { setMsg("Встав посилання ✦"); return; }
  setMsg("Фея аналізує вакансію ✦...");
  let d;
  try {
    d = await analyzeWith(byId("btn-url-add"), { url });
  } catch (err) {
    // the page could not be read: pasting its text still works; any other failure (busy, rate limit) says so itself
    if (err.page) offerPaste(url); else setMsg(err.message);
    return;
  }
  if (!addAnalyzed(d, url)) return;
  byId("add-url").value = "";
  say("Проаналізувала й додала " + companyOr(d) + " ✦", POSE.happy, 7000);
}

async function addFromText() {
  const text = byId("a-paste").value.trim();
  if (text.length < 40) { setMsg("Встав більше тексту вакансії ✦"); return; }
  setMsg("Фея аналізує текст ✦...");
  let d;
  try { d = await analyzeWith(byId("a-paste-go"), { text }); } catch (err) { setMsg("Не вдалося розібрати ✦ " + err.message); return; }
  if (!addAnalyzed(d, byId("a-paste-url").value)) return;
  byId("a-paste").value = "";
  byId("a-paste-url").value = "";
  byId("paste-box").hidden = true;
  say("Розібрала текст і додала " + companyOr(d) + " ✦", POSE.happy, 7000);
}

// Without a CV the fairy has nothing to learn the user's profession from, so the vacancies they add stand in for it.
function learnFromVacancy(job) {
  if (!isAuthed() || persona.phrases.length || hasCV()) return;
  const text = (job.title + " " + job.field + " " + job.company).trim();
  persona.specialty = detectSpecialty(text);
  analyzeProfile("Вакансія, яка цікавить кандидата: " + text)
    .then((d) => {
      if (hasCV()) return; // a CV arrived meanwhile and is the better source
      if (d.phrases.length) persona.phrases = d.phrases;
      if (d.role) persona.role = d.role;
    })
    .catch(() => { /* the fairy keeps her generic phrases; the next added vacancy tries again */ });
}

function onJobsChange({ type, id, key }) {
  if (type === "add") learnFromVacancy(getJob(id));
  if (BOARD_CHANGES.includes(type) || (type === "field" && BOARD_FIELDS.includes(key))) refresh();
}

export function initVacancies() {
  const board = byId("board");
  board.addEventListener("change", onBoardChange);
  board.addEventListener("input", onBoardInput);
  board.addEventListener("click", onBoardClick);
  for (const [id] of FILTERS) byId(id).addEventListener("change", renderBoard);
  byId("btn-reset").addEventListener("click", resetFilters);
  byId("btn-clear").addEventListener("click", clearProgress);

  byId("btn-url-add").addEventListener("click", addFromUrl);
  byId("add-url").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !byId("btn-url-add").disabled) addFromUrl();
  });
  byId("btn-paste").addEventListener("click", () => {
    const box = byId("paste-box");
    box.hidden = !box.hidden;
  });
  byId("a-paste-go").addEventListener("click", addFromText);
  byId("btn-manual").addEventListener("click", () => openNewVacancy({}));

  // a cloud replace ("state") reaches this module as jobs {type: "reload"}, emitted by main.js after loadJobs()
  on("jobs", onJobsChange);
  on("user", refresh);
  refresh();
}
