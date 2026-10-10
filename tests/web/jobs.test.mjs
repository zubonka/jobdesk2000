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

test("an undone removal puts the vacancy back in its place with its progress", () => {
  for (const title of ["One", "Two", "Three"]) jobs.addJob({ company: "Acme", title });
  jobs.setJobField("Acme|Two", "status", "interview1");
  jobs.setJobField("Acme|Two", "note", "HR: Оля");
  jobs.toggleCollapsed("Acme|Two");

  const removed = jobs.removeJob("Acme|Two");
  assert.deepEqual(jobs.allJobs().map((j) => j.title), ["One", "Three"]);
  assert.equal(jobs.removeJob("Acme|Two"), null);

  const events = [];
  const off = on("jobs", (detail) => events.push(detail));
  assert.equal(jobs.restoreJob(removed), true);
  off();
  assert.deepEqual(events, [{ type: "restore", id: "Acme|Two" }]);
  assert.deepEqual(jobs.allJobs().map((j) => j.title), ["One", "Two", "Three"]);
  assert.equal(storedJSON(KEYS.progress)["Acme|Two"].status, "Перша співбесіда");
  assert.equal(jobs.getJob("Acme|Two").note, "HR: Оля");
  assert.ok(jobs.isCollapsed("Acme|Two"));
});

test("an undone removal never duplicates a vacancy that was added again", () => {
  jobs.addJob({ company: "Acme", title: "Designer" });
  const removed = jobs.removeJob("Acme|Designer");
  jobs.addJob({ company: "Acme", title: "Designer" });
  assert.equal(jobs.restoreJob(removed), false);
  assert.equal(jobs.allJobs().length, 1);
});

test("an undone reset brings back statuses, dates and notes", () => {
  const { id } = jobs.addJob({ company: "Acme", title: "Designer" });
  jobs.setJobField(id, "status", "offer");
  jobs.setJobField(id, "date", "2026-09-01");
  jobs.setJobField(id, "note", "HR");
  const before = jobs.resetProgress();
  assert.equal(jobs.getJob(id).status, "not_applied");
  jobs.restoreProgress(before);
  assert.deepEqual(storedJSON(KEYS.progress)[id], { status: "Оффер", date: "2026-09-01", deadline: "", note: "HR" });
});

test("importJobs adds only the missing vacancies and keeps the ones already here as they are", () => {
  const { id } = jobs.addJob({ company: "Acme", title: "Designer" });
  jobs.setJobField(id, "status", "offer");
  const backup = [
    { prio: "Подумати", company: "Acme", title: "Designer", field: "old copy", emp: NONE, loc: NONE, salary: NONE, url: "#" },
    { prio: "100% Податися", company: "Beta", title: "Illustrator", field: "Арт", emp: NONE, loc: NONE, salary: NONE, url: "beta.example/jobs" },
    null, "junk", { prio: "Податися", company: "Beta", title: "Illustrator" },
  ];
  const progress = {
    "Acme|Designer": { status: "Відмова", date: "", deadline: "", note: "" },
    "Beta|Illustrator": { status: "Подалася", date: "2026-10-01", deadline: 20261010, note: { evil: true } },
  };
  assert.equal(jobs.importJobs(backup, progress), 1);
  assert.equal(jobs.getJob(id).status, "offer");
  assert.equal(jobs.getJob(id).field, NONE);
  const beta = jobs.getJob("Beta|Illustrator");
  assert.deepEqual([beta.prio, beta.status, beta.date, beta.deadline, beta.note, beta.url],
    ["100% Податися", "applied", "2026-10-01", "", "", "https://beta.example/jobs"]);
  assert.equal(jobs.importJobs(backup, progress), 0);
  assert.equal(jobs.importJobs("not a list", null), 0);
});

test("a null or hand-edited progress entry loads as an empty one instead of stopping the app", () => {
  startWith({
    [KEYS.jobs]: [{ prio: "Податися", company: "A", title: "One" }, { prio: "Податися", company: "B", title: "Two" }, { prio: "Податися", company: "C", title: "Three" }],
    [KEYS.progress]: { "A|One": null, "B|Two": "junk", "C|Three": { status: "Оффер", date: 42, note: ["x"] } },
  });
  assert.deepEqual(jobs.allJobs().map((j) => [j.status, j.date, j.note]), [["not_applied", "", ""], ["not_applied", "", ""], ["offer", "", ""]]);
  assert.equal(jobs.importJobs([{ prio: "Податися", company: "D", title: "Four" }], { "D|Four": null }), 1);
});

test("a \"|\" inside a new name is written as \"¦\", so two different vacancies never share an id", () => {
  const a = jobs.addJob({ company: "Acme|Kyiv", title: "Designer" });
  const b = jobs.addJob({ company: "Acme", title: "Kyiv|Designer" });
  assert.ok(a && b);
  assert.notEqual(a.id, b.id);
  assert.equal(a.company, "Acme¦Kyiv");
});

test("old data with two different vacancies joining to one id keeps both, the second written apart", () => {
  startWith({
    [KEYS.jobs]: [{ prio: "Податися", company: "Acme|Kyiv", title: "Designer" }, { prio: "Податися", company: "Acme", title: "Kyiv|Designer" }, { prio: "Податися", company: "Acme|Kyiv", title: "Designer" }],
    [KEYS.progress]: { "Acme|Kyiv|Designer": { status: "Оффер", date: "", deadline: "", note: "спільна" } },
  });
  const list = jobs.allJobs();
  assert.equal(list.length, 2, "the third entry is a true duplicate of the first");
  assert.deepEqual(list.map((j) => [j.company, j.title, j.status]), [["Acme|Kyiv", "Designer", "offer"], ["Acme", "Kyiv¦Designer", "offer"]]);
  assert.equal(jobs.countVacancies([{ company: "A", title: "B" }, { company: "A", title: "B" }, null, "x", 7, { company: "C" }]), 2);
});

test("an undone reset follows a vacancy renamed meanwhile", () => {
  const { id } = jobs.addJob({ company: "Acme", title: "Designer" });
  jobs.setJobField(id, "status", "interview1");
  const before = jobs.resetProgress();
  jobs.updateJob(id, { title: "Lead Designer" });
  jobs.restoreProgress(before);
  assert.equal(jobs.getJob("Acme|Lead Designer").status, "interview1");
});

test("stored maps that are not plain objects read as empty ones", async () => {
  const { getObject } = await import("../../public/js/core/storage.js");
  for (const bad of ["5", "true", "[]", "null", "\"x\"", "not json"]) {
    storage.setItem("jobdesk2000_test", bad);
    assert.deepEqual(getObject("jobdesk2000_test"), {}, bad);
  }
  storage.setItem("jobdesk2000_test", '{"a":1}');
  assert.deepEqual(getObject("jobdesk2000_test"), { a: 1 });
});
