// Statistics window: counters per status group and the pipeline bar.

import { byId, html, setHtml } from "../core/dom.js";
import { on } from "../core/events.js";
import { allJobs } from "../data/jobs.js";
import { STATUS_KEYS, INTERVIEW_KEYS, statusLabel } from "../data/statuses.js";
import { gender } from "../data/user.js";

// counter element id and the statuses it counts
const COUNTERS = [["s-applied", ["applied"]], ["s-inter", INTERVIEW_KEYS], ["s-test", ["test"]], ["s-offer", ["offer"]], ["s-reject", ["reject"]]];
const BAR_COLOURS = {
  not_applied: "var(--dim)", applied: "var(--lav-dd)", interview1: "var(--warn)", test: "var(--warn)",
  interview2: "var(--warn)", interview3: "var(--warn)", offer: "var(--mint-d)", reject: "var(--accent2)",
};

function render() {
  const jobs = allJobs(), g = gender();
  const count = (keys) => jobs.filter((job) => keys.includes(job.status)).length;
  byId("s-total").textContent = jobs.length;
  for (const [id, keys] of COUNTERS) byId(id).textContent = count(keys);

  // one segment per status in use, as wide as its share of all vacancies
  const segments = STATUS_KEYS.map((key) => [key, count([key])]).filter(([, n]) => n);
  setHtml(byId("prog"), html`${segments.map(([key, n]) => html`<i style="width:${(n / jobs.length) * 100}%;background:${BAR_COLOURS[key]};opacity:${key === "not_applied" ? 0.3 : 0.95}" title="${statusLabel(key, g)}: ${n}"></i>`)}`);
}

export function initStats() {
  // a cloud replace ("state") reaches this module as jobs {type: "reload"}, emitted by main.js after loadJobs()
  on("jobs", render);
  on("user", render);
  render();
}
