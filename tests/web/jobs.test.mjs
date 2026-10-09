import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { storage } from "./fake-storage.mjs";

// UTC+14: for most of the day the local date here differs from the UTC date
process.env.TZ = "Pacific/Kiritimati";

const { KEYS } = await import("../../public/js/core/storage.js");
const { on } = await import("../../public/js/core/events.js");
const { setUser } = await import("../../public/js/data/user.js");
const jobs = await import("../../public/js/data/jobs.js");
const { NONE, DEFAULT_TITLE, DEFAULT_PRIO } = jobs;

const storedJSON = (key) => JSON.parse(storage.getItem(key));

// replaces storage with `data` ({ key: value as JSON }) and reloads the list from it
function startWith(data = {}) {
  storage.clear();
  for (const [key, value] of Object.entries(data)) storage.setItem(key, JSON.stringify(value));
  jobs.loadJobs();
}

beforeEach(() => {
  setUser({ name: "Оля", gender: "f" });
  startWith();
});

test("addJob refuses a second vacancy with the same company and title", () => {
  const events = [];
  const off = on("jobs", (detail) => events.push(detail));
  const first = jobs.addJob({ company: "Acme", title: "Designer" });
  off();
  assert.equal(first.id, "Acme|Designer");
  assert.deepEqual(events, [{ type: "add", id: "Acme|Designer" }]);
  assert.equal(jobs.addJob({ company: " Acme ", title: "Designer  " }), null);
  assert.ok(jobs.addJob({ company: "Acme", title: "Lead Designer" }));
  assert.ok(jobs.addJob({ company: "acme", title: "Designer" }), "the id is case sensitive, as in the original app");
  assert.equal(jobs.allJobs().length, 3);
});

test("blank company and title get placeholders and count as one vacancy", () => {
  assert.equal(jobs.addJob({ company: "  ", title: "" }).id, NONE + "|" + DEFAULT_TITLE);
  assert.equal(jobs.addJob({}), null);
});

test("the vacancy list is stored in the original app's format", () => {
  jobs.addJob({ prio: "100% Податися", company: "Acme", title: "Designer", field: "Дизайн", emp: "Full-time", loc: "Віддалено", salary: "$2000", url: "https://acme.example/jobs/1" });
  jobs.addJob({ company: "Beta", title: "Illustrator" });
  // same keys in the same order as the original persistJobs() wrote them
  assert.equal(storage.getItem(KEYS.jobs), JSON.stringify([
    { prio: "100% Податися", company: "Acme", title: "Designer", field: "Дизайн", emp: "Full-time", loc: "Віддалено", salary: "$2000", url: "https://acme.example/jobs/1" },
    { prio: DEFAULT_PRIO, company: "Beta", title: "Illustrator", field: NONE, emp: NONE, loc: NONE, salary: NONE, url: "#" },
  ]));
});

test("progress is stored by '<company>|<title>' with the status as the gendered label", () => {
  const { id } = jobs.addJob({ company: "Acme", title: "Designer" });
  jobs.setJobField(id, "note", "написати HR");
  // same shape and key order as the original persist()
  assert.equal(storage.getItem(KEYS.progress), JSON.stringify({ "Acme|Designer": { status: "Не подавалася", date: "", deadline: "", note: "написати HR" } }));

  jobs.setJobField(id, "status", "offer");
  assert.equal(storedJSON(KEYS.progress)[id].status, "Оффер");
  jobs.setJobField(id, "status", "applied");
  assert.equal(storedJSON(KEYS.progress)[id].status, "Подалася");

  // after a gender change the next save writes the label in the new form (any form still reads back)
  setUser({ name: "Петро", gender: "m" });
  jobs.setJobField(id, "note", "написати HR ще раз");
  assert.equal(storedJSON(KEYS.progress)[id].status, "Подався");
  assert.equal(jobs.getJob(id).status, "applied");
});

test("becoming applied stamps today's local date, but never overwrites a date", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-09T12:00:00Z") }); // already Oct 10 in Kiritimati
  const { id } = jobs.addJob({ company: "Acme", title: "Designer" });
  jobs.setJobField(id, "status", "Подалася"); // a label works as well as a key
  assert.equal(jobs.getJob(id).status, "applied");
  assert.equal(jobs.getJob(id).date, "2026-10-10");

  jobs.setJobField(id, "date", "2026-09-01");
  jobs.setJobField(id, "status", "not_applied");
  jobs.setJobField(id, "status", "applied");
  assert.equal(jobs.getJob(id).date, "2026-09-01");

  const other = jobs.addJob({ company: "Acme", title: "Illustrator" });
  jobs.setJobField(other.id, "status", "interview1");
  assert.equal(jobs.getJob(other.id).date, "");
});

test("renaming a vacancy keeps its progress and collapsed state", () => {
  const { id } = jobs.addJob({ company: "Acme", title: "Designer" });
  jobs.setJobField(id, "status", "interview1");
  jobs.setJobField(id, "note", "друга зустріч у пʼятницю");
  jobs.setJobField(id, "deadline", "2026-11-01");
  jobs.toggleCollapsed(id);

  const { job } = jobs.updateJob(id, { title: "Lead Designer", salary: "$3000" });
  assert.equal(job.id, "Acme|Lead Designer");
  assert.equal(job.salary, "$3000");
  assert.deepEqual([job.status, job.note, job.deadline], ["interview1", "друга зустріч у пʼятницю", "2026-11-01"]);
  assert.equal(jobs.getJob(id), null);
  assert.ok(jobs.isCollapsed(job.id));
  assert.ok(!jobs.isCollapsed(id));

  assert.deepEqual(storedJSON(KEYS.collapsed), { "Acme|Lead Designer": true });
  assert.deepEqual(storedJSON(KEYS.progress), { "Acme|Lead Designer": { status: "Перша співбесіда", date: "", deadline: "2026-11-01", note: "друга зустріч у пʼятницю" } });
});

test("updateJob refuses to rename onto another vacancy", () => {
  const a = jobs.addJob({ company: "Acme", title: "Designer" });
  jobs.addJob({ company: "Acme", title: "Illustrator" });
  assert.deepEqual(jobs.updateJob(a.id, { title: "Illustrator" }), { error: "duplicate" });
  assert.equal(jobs.getJob(a.id).title, "Designer");
  assert.deepEqual(jobs.updateJob("Nobody|Nothing", { title: "x" }), { error: "missing" });
});

test("links that are not http(s) become #, bare domains get https://", () => {
  assert.equal(jobs.addJob({ company: "A", title: "1", url: "javascript:alert(1)" }).url, "#");
  assert.equal(jobs.addJob({ company: "A", title: "2", url: "data:text/html,<b>hi</b>" }).url, "#");
  assert.equal(jobs.addJob({ company: "A", title: "3", url: "jobs.example.com/42" }).url, "https://jobs.example.com/42");
  assert.equal(jobs.addJob({ company: "A", title: "4", url: " https://jobs.example.com/43 " }).url, "https://jobs.example.com/43");
  const { id } = jobs.addJob({ company: "A", title: "5", url: "https://ok.example" });
  assert.equal(jobs.updateJob(id, { url: "JavaScript:alert(1)" }).job.url, "#");
});

test("data saved by the original app loads without being rewritten", () => {
  const legacy = {
    [KEYS.jobs]: [
      { prio: "Подумати", company: "Acme", title: "Designer", field: "Дизайн", emp: "Full-time", loc: "Офіс", salary: "$2000", url: "https://acme.example/1" },
      // a priority this version does not know, a script link and no loc field
      { prio: "Терміново", company: "Beta", title: "Illustrator", field: NONE, emp: NONE, salary: NONE, url: "javascript:alert(document.cookie)" },
      { prio: "Подумати", company: "Acme", title: "Designer", field: "a duplicate entry", emp: NONE, loc: NONE, salary: NONE, url: "#" },
      null,
      "junk",
    ],
    [KEYS.progress]: {
      "Acme|Designer": { status: "Подався", date: "2026-07-01", deadline: "", note: "HR: Оля" },
      "Beta|Illustrator": { status: "Оффер", date: "2026-07-02", note: "" },
      "Gone|Job": { status: "Відмова", date: "", deadline: "", note: "" },
    },
    [KEYS.collapsed]: { "Beta|Illustrator": true },
  };
  startWith(legacy);

  const list = jobs.allJobs();
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], {
    id: "Acme|Designer", prio: "Подумати", company: "Acme", title: "Designer", field: "Дизайн", emp: "Full-time", loc: "Офіс",
    salary: "$2000", url: "https://acme.example/1", status: "applied", date: "2026-07-01", deadline: "", note: "HR: Оля",
  });
  assert.equal(list[1].prio, DEFAULT_PRIO);
  assert.equal(list[1].url, "#");
  assert.equal(list[1].loc, NONE);
  assert.equal(list[1].status, "offer");
  assert.equal(list[1].deadline, "");
  assert.ok(jobs.isCollapsed("Beta|Illustrator"));

  // loading alone must leave the user's data exactly as it was
  for (const [key, value] of Object.entries(legacy)) assert.equal(storage.getItem(key), JSON.stringify(value), key);
});

test("resetProgress clears statuses, application dates and notes but keeps deadlines, like the original", () => {
  const { id } = jobs.addJob({ company: "Acme", title: "Designer" });
  jobs.setJobField(id, "status", "offer");
  jobs.setJobField(id, "date", "2026-09-01");
  jobs.setJobField(id, "deadline", "2026-11-01");
  jobs.setJobField(id, "note", "HR");
  jobs.resetProgress();
  assert.deepEqual(storedJSON(KEYS.progress)[id], { status: "Не подавалася", date: "", deadline: "2026-11-01", note: "" });
  assert.equal(jobs.allJobs().length, 1);
});

test("links saved by the original app without a scheme stay usable; unsafe ones become '#'", () => {
  startWith({
    [KEYS.jobs]: [
      { prio: "Податися", company: "A", title: "One", url: "djinni.co/jobs/123-designer" },
      { prio: "Податися", company: "B", title: "Two", url: "javascript:alert(1)" },
      { prio: "Податися", company: "C", title: "Three", url: "https://work.ua/jobs/1/" },
    ],
  });
  assert.deepEqual(jobs.allJobs().map((j) => j.url), ["https://djinni.co/jobs/123-designer", "#", "https://work.ua/jobs/1/"]);
});
