// Fairy messenger: the CV (PDF or pasted text) and a chat in which the fairy writes a cover letter
// for the chosen vacancy and then rewrites it on request.

import { byId, html, setHtml, sleep } from "../core/dom.js";
import { on, emit } from "../core/events.js";
import { isAuthed, gender, userName } from "../data/user.js";
import { allJobs, getJob } from "../data/jobs.js";
import { getCV, hasCV, cvWordCount, setCV, clearCV, persona, MIN_CV_CHARS } from "../data/profile.js";
import { specialtyName } from "../content/phrases.js";
import { fairyName } from "../fairy/store.js";
import { paintFairy, POSE } from "../fairy/render.js";
import { analyzeProfile, writeLetter, reviseLetter, BUSY } from "../services/api.js";
import { pdfToText } from "../services/pdf.js";
import { onOpen } from "../ui/windows.js";
import { say } from "../ui/clippy.js";

const RETRY_WAITS = [8, 12]; // seconds before each automatic retry while Gemini is busy
const WRITING = "Фея пише ✦...";

const messages = []; // { role: "assistant" | "user" | "letter", text }
let draft = null;  // the latest letter and the request that wrote it: { letter, request }
let busy = false;
let cvTicket = 0; // grows with every CV change, so a PDF still being read never replaces a newer CV

const collapseSpaces = (text) => text.replace(/[ \t]+/g, " ").trim();

/* ----- CV ----- */

function renderCV() {
  const loaded = hasCV();
  setHtml(byId("cv-txt"), loaded
    ? html`<b class="cv-ok">Резюме завантажено ✦</b> (${cvWordCount()} слів)`
    : html`<b class="ink">Резюме не завантажено.</b> Завантаж CV у PDF.`);
  byId("cv-upload").textContent = loaded ? "Замінити" : "Завантажити PDF";
  byId("cv-remove").hidden = !loaded;
}

const cvNote = (markup) => setHtml(byId("cv-txt"), markup);

// The AI names the profession and gives phrases for idle motivation; without it the local keyword guess is used.
async function learnProfession(text) {
  const profile = await analyzeProfile(text).catch(() => null);
  if (text !== getCV()) return; // the CV was replaced or removed while the AI was answering
  if (profile?.phrases?.length) persona.phrases = profile.phrases;
  if (profile?.role) {
    persona.role = profile.role;
    say("Бачу, ти " + profile.role + " ✦ підберу слова саме для тебе!", POSE.happy, 9000);
    return;
  }
  const guess = persona.specialty ? " Бачу, ти " + specialtyName(persona.specialty.key) + " ✦" : "";
  say("Резюме завантажено ✦ обери вакансію!" + guess, POSE.happy, 8000);
}

// Returns false when the text does not fit into browser storage.
function acceptCV(text) {
  if (!setCV(text)) return false;
  say("Резюме завантажено ✦ аналізую твій фах...", POSE.happy, 8000);
  if (isAuthed()) learnProfession(text);
  return true;
}

async function readPdf() {
  const input = byId("cv-file");
  const file = input.files[0];
  if (!file) return;
  const ticket = ++cvTicket;
  cvNote(html`<b>Читаю резюме...</b>`);
  try {
    const text = await pdfToText(file);
    if (ticket !== cvTicket) return; // a CV was pasted or removed meanwhile
    if (text.length < MIN_CV_CHARS) cvNote(html`<b>Не зчиталось.</b> Схоже, це скан.`);
    else if (!acceptCV(text)) renderCV();
  } catch (err) {
    if (ticket === cvTicket) cvNote(html`<b>Помилка PDF.</b>`);
  } finally {
    input.value = ""; // choosing the same file again must fire "change" again
  }
}

function togglePasteBox() {
  const box = byId("cv-paste-box");
  box.hidden = !box.hidden;
  if (!box.hidden) byId("cv-paste").focus();
}

function savePastedCV() {
  const area = byId("cv-paste");
  const text = collapseSpaces(area.value);
  if (text.length < MIN_CV_CHARS) {
    say("Встав більше тексту ✦", POSE.idle, 6000);
    return;
  }
  if (!acceptCV(text)) return;
  area.value = "";
  byId("cv-paste-box").hidden = true;
}

/* ----- vacancy select ----- */

function fillJobSelect(keep) {
  const select = byId("cl-job");
  const jobs = allJobs();
  setHtml(select, jobs.length
    ? html`${jobs.map((j) => html`<option value="${j.id}">[${j.prio}] ${j.company} — ${j.title}</option>`)}`
    : html`<option value="">— додай вакансію —</option>`);
  if (getJob(keep)) select.value = keep;
}

function onJobsChanged({ type, key, id, oldId }) {
  if (type === "field" && key !== "prio") return; // options show prio, company and title only
  const selected = byId("cl-job").value;
  fillJobSelect(type === "update" && selected === oldId ? id : selected);
}

/* ----- chat ----- */

function messageHtml(m, idx) {
  if (m.role === "letter") {
    return html`<div class="chat-letter-wrap"><button type="button" class="letter-copy" data-idx="${idx}" title="Копіювати лист">⧉ копіювати</button><div class="chat-letter">${m.text}</div></div>`;
  }
  return html`<div class="chat-msg ${m.role === "user" ? "me" : "fairy"}" data-msg="${idx}"><span class="b">${m.text}</span></div>`;
}

function renderChat() {
  const box = byId("cl-out");
  setHtml(box, html`${messages.map(messageHtml)}`);
  box.scrollTop = box.scrollHeight;
}

function addMessage(role, text) {
  const m = { role, text };
  messages.push(m);
  renderChat();
  return m;
}

function replaceMessage(old, ...next) {
  messages.splice(messages.indexOf(old), 1, ...next);
  renderChat();
}

const setStatus = (text) => { byId("cl-status").textContent = text; };
const showEditRow = () => { byId("cl-editrow").hidden = false; };

function setBusy(value) {
  busy = value;
  byId("cl-gen").disabled = value;
  byId("cl-send").disabled = value;
}

// Plain http and browsers without the async Clipboard API fall back to a hidden textarea.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus();
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  }
}

async function onChatClick(e) {
  const btn = e.target.closest(".letter-copy");
  if (!btn || !(await copyText(messages[Number(btn.dataset.idx)].text))) return;
  btn.textContent = "✓ скопійовано";
  setTimeout(() => { btn.textContent = "⧉ копіювати"; }, 1800);
}

function startChat() {
  if (messages.length) return;
  showEditRow();
  addMessage("assistant", "Привіт ✦ Я " + (fairyName() || "Фея") + "! Обери вакансію, мову й тон угорі та натисни «Написати листа». Далі пиши мені прямо сюди, що підправити — і я перепишу лист ✦");
}

/* ----- writing and rewriting ----- */

// The countdown changes only its own bubble: a reader scrolled up or selecting text in an earlier letter keeps both.
function showProgress(typing, text) {
  typing.text = text;
  const bubble = byId("cl-out").querySelector(`[data-msg="${messages.indexOf(typing)}"] .b`);
  if (bubble) bubble.textContent = text; else renderChat();
  setStatus(text);
}

async function countdown(seconds, typing) {
  for (let s = seconds; s > 0; s--) {
    showProgress(typing, "Gemini зараз зайнятий ✦ автоматично пробую ще раз за " + s + "с...");
    await sleep(1000);
  }
  showProgress(typing, "Пробую ще раз ✦...");
}

async function withRetries(call, typing) {
  for (const wait of RETRY_WAITS) {
    try {
      return await call();
    } catch (err) {
      if (!err.retry) throw err;
      await countdown(wait, typing);
    }
  }
  return call();
}

// One typing bubble, automatic retries, then the letter or the error in the chat. Returns the letter or null.
async function askFairy({ typing, call, reply, status, fail }) {
  setBusy(true);
  setStatus(WRITING);
  const pending = addMessage("assistant", typing);
  // the person just asked: the chat comes into view (on a phone it sits below the button), the letter lands there
  byId("cl-out").scrollIntoView({ block: "nearest" });
  try {
    const { text } = await withRetries(call, pending);
    replaceMessage(pending, { role: "assistant", text: reply }, { role: "letter", text });
    setStatus(status);
    return text;
  } catch (err) {
    // still busy after the automatic retries: the server's "trying again" is no longer true
    const message = err.retry ? BUSY : err.message;
    replaceMessage(pending, { role: "assistant", text: fail + message });
    setStatus("✕ " + message);
    if (err.auth) emit("auth:open", "login");
    return null;
  } finally {
    setBusy(false);
  }
}

function letterRequest(job, wish) {
  return {
    job: { company: job.company, title: job.title, field: job.field, emp: job.emp, loc: job.loc, salary: job.salary },
    cv: getCV(),
    lang: byId("cl-lang").value,
    tone: byId("cl-tone").value,
    focus: [byId("cl-focus").value.trim(), wish].filter(Boolean).join("; "),
    gender: gender(),
    name: userName(),
  };
}

// wish: what the user wrote in the chat before there was a letter to revise
async function generateLetter(wish) {
  if (busy) return;
  const job = getJob(byId("cl-job").value);
  if (!job) { say("Спершу додай вакансію ✦", POSE.idle, 7000); return; }
  if (!hasCV()) { say("Спершу завантаж резюме (PDF) ✦", POSE.idle, 8000); return; }
  const request = letterRequest(job, typeof wish === "string" ? wish : "");
  showEditRow();
  const letter = await askFairy({
    typing: "Пишу листа під " + job.company + " ✦...",
    call: () => writeLetter(request),
    reply: "Ось твій лист під " + job.company + " ✦ Напиши, що підправити 👇",
    status: "Готово ✦",
    fail: "Ой ✦ ",
  });
  if (letter == null) return;
  draft = { letter, request };
  say("Лист готовий ✦ напиши мені, що підправити — я перепишу!", POSE.happy, 11000);
}

// A revision resends the request that wrote the letter, so it keeps that letter's vacancy, language and CV.
async function sendEdit() {
  if (busy) return;
  const input = byId("cl-edit");
  const edit = input.value.trim();
  if (!edit) return;
  input.value = "";
  addMessage("user", edit);
  if (!draft) return generateLetter(edit);
  if (!hasCV()) { say("Спершу завантаж резюме (PDF) ✦", POSE.idle, 8000); return; } // a removed CV is never sent again
  const { letter, request } = draft;
  const revised = await askFairy({
    typing: "Переписую ✦...",
    call: () => reviseLetter({ ...request, cv: getCV(), letter, request: edit }),
    reply: "Готово ✦ ось оновлений варіант:",
    status: "Оновлено ✦",
    fail: "Не вийшло ✦ ",
  });
  if (revised != null) draft = { letter: revised, request };
}

/* ----- init ----- */

const paintAvatar = () => paintFairy(byId("msg-fairy"));

export function initMessenger() {
  byId("cv-upload").addEventListener("click", () => byId("cv-file").click());
  byId("cv-file").addEventListener("change", readPdf);
  byId("cv-remove").addEventListener("click", clearCV);
  byId("cv-paste-toggle").addEventListener("click", togglePasteBox);
  byId("cv-paste-save").addEventListener("click", savePastedCV);

  byId("cl-gen").addEventListener("click", () => generateLetter());
  byId("cl-send").addEventListener("click", sendEdit);
  byId("cl-edit").addEventListener("keydown", (e) => { if (e.key === "Enter") sendEdit(); });
  byId("cl-out").addEventListener("click", onChatClick);

  onOpen("messenger", startChat);
  on("cv", () => { cvTicket++; renderCV(); });
  on("jobs", onJobsChanged);
  on("fairy", paintAvatar);

  renderCV();
  fillJobSelect();
  paintAvatar();
}
