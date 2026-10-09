// Statistics window: counters per status group, the pipeline bar, the funnel from applying to offers
// and the weekly rhythm of applications.

import { byId, html, setHtml, todayISO } from "../core/dom.js";
import { on } from "../core/events.js";
import { allJobs } from "../data/jobs.js";
import { STATUS_KEYS, INTERVIEW_KEYS, statusLabel } from "../data/statuses.js";
import { gender } from "../data/user.js";
import { weeklyApplied, weekStreak, weeksText } from "../data/timeline.js";

// counter element id and the statuses it counts
const COUNTERS = [["s-applied", ["applied"]], ["s-inter", INTERVIEW_KEYS], ["s-test", ["test"]], ["s-offer", ["offer"]], ["s-reject", ["reject"]]];
const BAR_COLOURS = {
  not_applied: "var(--dim)", applied: "var(--lav-dd)", interview1: "var(--warn)", test: "var(--warn)",
  interview2: "var(--warn)", interview3: "var(--warn)", offer: "var(--mint-d)", reject: "var(--accent2)",
};

// statuses that mean the employer answered with a conversation (or better)
const TALKED_KEYS = [...INTERVIEW_KEYS, "test", "offer"];
const WEEKS = 8;

const percent = (part, whole) => (whole ? Math.round((part / whole) * 100) + "%" : "");

function renderFunnel(jobs) {
  const applied = jobs.filter((job) => job.status !== "not_applied").length;
  const talked = jobs.filter((job) => TALKED_KEYS.includes(job.status)).length;
  const offers = jobs.filter((job) => job.status === "offer").length;
  const rows = [
    ["Усього подано", applied, "", "var(--lav-dd)"],
    ["До співбесіди", talked, percent(talked, applied), "var(--warn)"],
    ["Оффери", offers, percent(offers, talked), "var(--mint-d)"],
  ];
  const widest = Math.max(applied, 1);
  setHtml(byId("funnel"), html`${rows.map(([label, n, share, colour]) => html`<div class="fun-row">
    <span class="fun-label">${label}</span>
    <span class="fun-bar"><i style="width:${(n / widest) * 100}%;background:${colour}"></i></span>
    <span class="fun-n">${n}${share ? html` <span class="muted">· ${share}</span>` : ""}</span>
  </div>`)}`);
}

const shortDate = (iso) => iso.slice(8, 10) + "." + iso.slice(5, 7);

function weeksNote(series, g) {
  const streak = weekStreak(series), now = series[series.length - 1].count;
  if (streak >= 2) return "🔥 " + weeksText(streak) + " поспіль з подачами ✦ так тримати!";
  if (now) return "Цього тижня вже " + now + " ✦ так тримати!";
  if (series.some((week) => week.count)) return "Цього тижня ще без подач ✦ одна вакансія, і ритм повернеться";
  return "Постав вакансії статус «" + statusLabel("applied", g) + "», і тут зʼявиться твій ритм ✦";
}

function renderWeeks(jobs, g) {
  const series = weeklyApplied(jobs, todayISO(), WEEKS);
  const top = Math.max(...series.map((week) => week.count), 1);
  const chart = byId("weeks");
  setHtml(chart, html`${series.map((week, i) => html`<div class="wk${i === series.length - 1 ? " now" : ""}" title="${shortDate(week.start)}: ${week.count}">
    <span class="wk-n">${week.count || ""}</span>
    <span class="wk-bar" style="height:${(week.count / top) * 100}%"></span>
    <span class="wk-d">${i === series.length - 1 ? "цей" : shortDate(week.start)}</span>
  </div>`)}`);
  chart.setAttribute("aria-label", "Подачі за тижнями, від найдавнішого: " + series.map((week) => week.count).join(", "));
  byId("weeks-note").textContent = weeksNote(series, g);
}

function render() {
  const jobs = allJobs(), g = gender();
  const count = (keys) => jobs.filter((job) => keys.includes(job.status)).length;
  byId("s-total").textContent = jobs.length;
  for (const [id, keys] of COUNTERS) byId(id).textContent = count(keys);

  // one segment per status in use, as wide as its share of all vacancies
  const segments = STATUS_KEYS.map((key) => [key, count([key])]).filter(([, n]) => n);
  setHtml(byId("prog"), html`${segments.map(([key, n]) => html`<i style="width:${(n / jobs.length) * 100}%;background:${BAR_COLOURS[key]};opacity:${key === "not_applied" ? 0.3 : 0.95}" title="${statusLabel(key, g)}: ${n}"></i>`)}`);
  renderFunnel(jobs);
  renderWeeks(jobs, g);
}

export function initStats() {
  // a cloud replace ("state") reaches this module as jobs {type: "reload"}, emitted by main.js after loadJobs()
  on("jobs", render);
  on("user", render);
  render();
}
