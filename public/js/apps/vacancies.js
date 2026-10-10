// Vacancies window: adding vacancies (by link, from pasted text or by hand), search and filters, and the board of cards.

import { byId, html, raw, setHtml, safeUrl, todayISO } from "../core/dom.js";
import { on } from "../core/events.js";
import {
  PRIORITIES, NONE, allJobs, getJob, addJob, setJobField, removeJob, restoreJob, resetProgress, restoreProgress,
  isCollapsed, toggleCollapsed, normalizeUrl,
} from "../data/jobs.js";
import { STATUS_KEYS, statusLabel } from "../data/statuses.js";
import { gender, isAuthed } from "../data/user.js";
import { hasCV, persona } from "../data/profile.js";
import { deadlineIn, daysText } from "../data/timeline.js";
import { detectSpecialty } from "../content/phrases.js";
import { analyzeVacancy, analyzeProfile, MIN_VACANCY_TEXT } from "../services/api.js";
import { say, reactToStatus } from "../ui/clippy.js";
import { POSE } from "../fairy/render.js";
import { openEditVacancy, openNewVacancy } from "./edit-vacancy.js";
import { confirmDialog } from "../ui/confirm.js";
import { toast } from "../ui/toast.js";
import { confetti } from "../ui/confetti.js";
import { openWin, isFocused } from "../ui/windows.js";

// filter select id and the job property it compares
const FILTERS = [["f-prio", "prio"], ["f-field", "field"], ["f-emp", "emp"], ["f-status", "status"]];
// what the search box looks through
const SEARCH_FIELDS = ["title", "company", "field", "loc", "salary", "note"];
// a deadline gets a badge on its card from this many days before it
const DEADLINE_SOON_DAYS = 14;
// and the fairy mentions it when the app opens from this many days before it
const DEADLINE_REMIND_DAYS = 3;
const UNDO = "↶ Повернути";
const TAGS = [["field", "◈"], ["emp", "⧗"], ["loc", "📍"], ["salary", "₴"]];
const LINK_LABELS = { not_applied: "Податися ↗", reject: "Переглянути ↗", offer: "Відкрити ↗" };
// "jobs" changes that alter what the board shows. Date and note edits are not among them,
// so a card is never redrawn under the user's cursor while they type.
const BOARD_CHANGES = ["add", "remove", "restore", "update", "reload", "reset", "import", "collapse"];
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

const byUkrainian = new Intl.Collator("uk").compare;
const distinct = (key) => [...new Set(allJobs().map((job) => job[key]))].filter((value) => value !== NONE).sort(byUkrainian);

function fillFilters() {
  const g = gender();
  fillSelect(byId("f-field"), "Всі галузі", distinct("field").map((value) => [value, value]));
  fillSelect(byId("f-emp"), "Всі типи", distinct("emp").map((value) => [value, value]));
  fillSelect(byId("f-status"), "Всі статуси", STATUS_KEYS.map((key) => [key, statusLabel(key, g)]));
}

// one form for comparing: composed Unicode (a PDF from macOS gives decomposed letters), lower case,
// and one apostrophe for the four ways Ukrainian words get typed (ʼ ' ’ `)
const lower = (text) => text.normalize("NFC").toLocaleLowerCase("uk").replace(/[ʼ'’‘`]/g, "'");

function visibleJobs() {
  const active = FILTERS.map(([id, key]) => [key, byId(id).value]).filter(([, value]) => value);
  const query = lower(byId("f-search").value.trim());
  const found = (job) => !query || SEARCH_FIELDS.some((key) => lower(job[key]).includes(query));
  return allJobs().filter((job) => active.every(([key, value]) => job[key] === value) && found(job));
}

function resetFilters() {
  for (const [id] of FILTERS) byId(id).value = "";
  byId("f-search").value = "";
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

// "⏳ ще 3 дні" on the card while the deadline is near, louder on its last day and once it has passed
function deadlineBadge(job) {
  const days = deadlineIn(job, todayISO());
  if (days === null || days > DEADLINE_SOON_DAYS) return "";
  const [level, text] = days < 0 ? ["late", "дедлайн минув"]
    : days === 0 ? ["hot", "дедлайн сьогодні!"]
    : days === 1 ? ["hot", "дедлайн завтра"]
    : ["soon", "до дедлайну " + daysText(days)];
  return html`<span class="jtag dl ${level}">⏳ ${text}</span>`;
}

function card(job, g) {
  const folded = isCollapsed(job.id);
  const tags = TAGS.filter(([key]) => job[key] !== NONE).map(([key, icon]) => html`<span class="jtag">${icon} ${job[key]}</span>`);
  return html`<div class="jobcard">
    ${cardHead(job, folded)}
    <div class="jt">${job.title}</div><div class="jc">${job.company}</div><div>${tags}<span class="dl-slot">${deadlineBadge(job)}</span></div>
    ${folded ? "" : cardDetails(job)}
    ${cardFoot(job, g)}
  </div>`;
}

// A redraw (a change from another device, a filter) keeps the field the user is typing in, caret included.
function keepingFocus(draw) {
  const board = byId("board"), el = document.activeElement;
  const field = el && board.contains(el) && el.dataset.id ? { id: el.dataset.id, k: el.dataset.k, start: el.selectionStart, end: el.selectionEnd } : null;
  draw();
  const again = field && [...board.querySelectorAll(".js-f")].find((x) => x.dataset.id === field.id && x.dataset.k === field.k);
  if (!again) return;
  again.focus({ preventScroll: true });
  if (field.start != null) try { again.setSelectionRange(field.start, field.end); } catch (e) { /* a date field has no caret */ }
}

function renderBoard() {
  const jobs = visibleJobs(), g = gender();
  const groups = PRIORITIES.map((prio) => [prio, jobs.filter((job) => job.prio === prio)]).filter(([, list]) => list.length);
  const empty = allJobs().length
    ? html`<div class="muted empty">Нічого не знайдено</div>`
    : html`<div class="muted empty">Тут поки порожньо ✦ Встав посилання чи текст вакансії вгорі або додай її вручну, і вона зʼявиться тут.</div>`;
  keepingFocus(() => setHtml(byId("board"), groups.length
    ? html`${groups.map(([prio, list]) => html`<div class="gh">✦ ${prio} [${list.length}]</div>${list.map((job) => card(job, g))}`)}`
    : empty));
}

function refresh() {
  fillFilters();
  renderBoard();
}

// Both answer with a notice that can undo them for a few seconds; guests get it too.
async function confirmRemove(id) {
  const job = getJob(id);
  if (!job || !(await confirmDialog("Видалити «" + job.company + " — " + job.title + "» зі списку?"))) return;
  const removed = removeJob(id);
  if (removed) toast("Вакансію прибрано ✦", { action: UNDO, onAction: () => restoreJob(removed) });
}

async function clearProgress() {
  if (!(await confirmDialog("Обнулити всі статуси, дати й нотатки?"))) return;
  const before = resetProgress();
  toast("Чистий старт ✦ летимо спочатку!", { action: UNDO, onAction: () => restoreProgress(before), ms: 8000 });
}

// prio and status selects
function onBoardChange(e) {
  const el = e.target;
  if (!el.matches("select.js-f")) return;
  const { id, k } = el.dataset, value = el.value;
  const from = el.getBoundingClientRect(); // the board is redrawn by the change below
  setJobField(id, k, value);
  if (k !== "status") return;
  if (value === "offer") confetti(from.left + from.width / 2, from.top + from.height / 2);
  reactToStatus(value);
}

// date, deadline and note; selects fire "input" too, so they are left to onBoardChange
function onBoardInput(e) {
  const el = e.target;
  if (!el.matches("input.js-f, textarea.js-f")) return;
  const job = setJobField(el.dataset.id, el.dataset.k, el.value);
  // the card is not redrawn while the user types, so only its deadline badge follows
  if (job && el.dataset.k === "deadline") setHtml(el.closest(".jobcard").querySelector(".dl-slot"), deadlineBadge(job));
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

// Clears a field after its vacancy was added, unless the user typed the next one there meanwhile.
const clearIfStill = (id, value) => { if (byId(id).value.trim() === value) byId(id).value = ""; };

async function addFromUrl() {
  const typed = byId("add-url").value.trim();
  if (!typed) { setMsg("Встав посилання ✦"); return; }
  const link = normalizeUrl(typed);
  const url = link === "#" ? typed : link; // "site.com/job" is a link too; anything else the server explains
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
  clearIfStill("add-url", typed);
  say("Проаналізувала й додала " + companyOr(d) + " ✦", POSE.happy, 7000);
}

async function addFromText() {
  const text = byId("a-paste").value.trim();
  if (text.length < MIN_VACANCY_TEXT) { setMsg("Встав більше тексту вакансії ✦"); return; }
  const link = byId("a-paste-url").value.trim(); // the link that belongs to this text, whatever is typed meanwhile
  setMsg("Фея аналізує текст ✦...");
  let d;
  try { d = await analyzeWith(byId("a-paste-go"), { text }); } catch (err) { setMsg("Не вдалося розібрати ✦ " + err.message); return; }
  if (!addAnalyzed(d, link)) return;
  const untouched = byId("a-paste").value.trim() === text;
  clearIfStill("a-paste", text);
  clearIfStill("a-paste-url", link);
  if (untouched) byId("paste-box").hidden = true;
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

const short = (text, max = 60) => (text.length > max ? text.slice(0, max - 1) + "…" : text);
const jobLabel = (job) => short(job.company !== NONE ? job.company + " — " + job.title : job.title);

// When the app opens, the fairy points at the nearest deadline of the next few days.
export function remindDeadline() {
  const today = todayISO();
  const next = allJobs()
    .map((job) => ({ job, days: deadlineIn(job, today) }))
    .filter(({ days }) => days !== null && days >= 0 && days <= DEADLINE_REMIND_DAYS)
    .sort((a, b) => a.days - b.days)[0];
  if (!next) return;
  const when = next.days === 0 ? "Сьогодні" : next.days === 1 ? "Завтра" : "За " + daysText(next.days);
  say("⏳ " + when + " дедлайн: «" + jobLabel(next.job) + "» ✦ не проґав!", POSE.idle, 10000);
}

const firstLink = (text) => (String(text || "").match(/https?:\/\/[^\s<>"']+/i) || [""])[0];

// Another app can hand a vacancy over with a link: ?add=<vacancy url> (Балувана Валя), or ?url= / ?text= from
// a phone's share sheet (site.webmanifest share_target). The link waits in the field; analysing it is one tap.
export function takeSharedLink() {
  const params = new URLSearchParams(window.location.search);
  if (!["add", "url", "text"].some((name) => params.has(name))) return;
  const add = normalizeUrl(params.get("add"));
  const link = (add !== "#" && add) || firstLink(params.get("url")) || firstLink(params.get("text"));
  window.history.replaceState(null, "", window.location.pathname + window.location.hash); // a reload must not bring it back
  if (!link) return;
  openWin("vacancies");
  byId("add-url").value = link;
  setMsg("Посилання вже тут ✦ натисни «✦ Аналіз», і фея розбере вакансію.");
  byId("add-url").focus();
}

// "/" jumps to the search box while the vacancies window is in front
function onShortcut(e) {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || !isFocused("vacancies") || document.querySelector(".overlay.open")) return;
  if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")) return;
  e.preventDefault();
  byId("f-search").focus();
}

export function initVacancies() {
  const board = byId("board");
  board.addEventListener("change", onBoardChange);
  board.addEventListener("input", onBoardInput);
  board.addEventListener("click", onBoardClick);
  for (const [id] of FILTERS) byId(id).addEventListener("change", renderBoard);
  byId("f-search").addEventListener("input", renderBoard);
  document.addEventListener("keydown", onShortcut);
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
