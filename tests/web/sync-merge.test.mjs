import { test } from "node:test";
import assert from "node:assert/strict";
import "./fake-storage.mjs";

const { KEYS } = await import("../../public/js/core/storage.js");
const { merge, fingerprint, hash, sameData } = await import("../../public/js/services/sync-merge.js");

const job = (company, title, extra = {}) => ({ prio: "Податися", company, title, field: "—", emp: "—", loc: "—", salary: "—", url: "#", ...extra });
// data in the cloud-document shape: { key: raw string }
function data({ jobs = [], progress = {}, ...rest } = {}) {
  return { [KEYS.jobs]: JSON.stringify(jobs), [KEYS.progress]: JSON.stringify(progress), ...rest };
}
const jobsOf = (d) => JSON.parse(d[KEYS.jobs]).map((j) => j.company + "|" + j.title);
const progressOf = (d) => JSON.parse(d[KEYS.progress]);
const EMPTY = { keys: {}, jobs: {} };

test("hash tells values apart and marks a missing value", () => {
  assert.equal(hash("a"), hash("a"));
  assert.notEqual(hash("a"), hash("b"));
  assert.equal(hash(undefined), "-");
});

test("nothing changed on either side: the result equals both", () => {
  const d = data({ jobs: [job("A", "One")], [KEYS.theme]: "dark" });
  assert.ok(sameData(merge(fingerprint(d), d, d), d));
});

test("only the cloud changed: the cloud copy wins, removals included", () => {
  const base = data({ jobs: [job("A", "One"), job("B", "Two")], [KEYS.theme]: "dark", [KEYS.cv]: "old cv" });
  const remote = data({ jobs: [job("A", "One", { prio: "Подумати" })], [KEYS.theme]: "light" });
  const out = merge(fingerprint(base), base, remote);
  assert.deepEqual(jobsOf(out), ["A|One"]);
  assert.equal(JSON.parse(out[KEYS.jobs])[0].prio, "Подумати");
  assert.equal(out[KEYS.theme], "light");
  assert.equal(out[KEYS.cv], undefined, "a CV removed on another device stays removed");
});

test("only this device changed: its edits survive, and offline edits are not lost on the next sync", () => {
  const base = data({ jobs: [job("A", "One")], progress: { "A|One": { status: "Не подавалася" } } });
  const local = data({ jobs: [job("A", "One"), job("N", "New")], progress: { "A|One": { status: "Подалася" } }, [KEYS.theme]: "dark" });
  const out = merge(fingerprint(base), local, base);
  assert.deepEqual(jobsOf(out), ["A|One", "N|New"]);
  assert.equal(progressOf(out)["A|One"].status, "Подалася");
  assert.equal(out[KEYS.theme], "dark");
});

test("both changed different vacancies: both edits are kept (the two-devices case)", () => {
  const base = data({ jobs: [job("A", "One"), job("B", "Two")], progress: { "A|One": { status: "x" }, "B|Two": { status: "x" } } });
  const local = data({ jobs: [job("A", "One"), job("B", "Two")], progress: { "A|One": { status: "laptop" }, "B|Two": { status: "x" } } });
  const remote = data({ jobs: [job("A", "One"), job("B", "Two"), job("F", "Fresh")], progress: { "A|One": { status: "x" }, "B|Two": { status: "phone" } } });
  const out = merge(fingerprint(base), local, remote);
  assert.deepEqual(jobsOf(out), ["A|One", "B|Two", "F|Fresh"]);
  assert.equal(progressOf(out)["A|One"].status, "laptop");
  assert.equal(progressOf(out)["B|Two"].status, "phone");
});

test("both changed the same vacancy: this device wins; an edit beats a removal", () => {
  const base = data({ jobs: [job("A", "One"), job("B", "Two")] });
  const local = data({ jobs: [job("A", "One", { prio: "Подумати" })] }); // edited A, removed B
  const remote = data({ jobs: [job("A", "One", { prio: "100% Податися" }), job("B", "Two", { salary: "1000" })] }); // edited both
  const out = merge(fingerprint(base), local, remote);
  assert.deepEqual(jobsOf(out), ["A|One", "B|Two"]);
  assert.equal(JSON.parse(out[KEYS.jobs])[0].prio, "Подумати");
  assert.equal(JSON.parse(out[KEYS.jobs])[1].salary, "1000", "the removal here loses to the edit there");
});

test("both changed another key: the cloud wins", () => {
  const base = data({ [KEYS.theme]: "light" });
  const out = merge(fingerprint(base), data({ [KEYS.theme]: "dark" }), data({ [KEYS.theme]: "light2" }));
  assert.equal(out[KEYS.theme], "light2");
});

test("a vacancy deleted on this device while the cloud did not touch it stays deleted", () => {
  const base = data({ jobs: [job("A", "One"), job("Old", "Deleted")] });
  const local = data({ jobs: [job("A", "One")] });
  assert.deepEqual(jobsOf(merge(fingerprint(base), local, base)), ["A|One"]);
});

test("no common history (guest data meets an account): everything from both sides is kept", () => {
  const local = data({ jobs: [job("G", "Guest")], progress: { "G|Guest": { status: "Подалася" } }, [KEYS.theme]: "dark" });
  const remote = data({ jobs: [job("A", "One")], [KEYS.theme]: "light", [KEYS.cv]: "cv" });
  const out = merge(EMPTY, local, remote);
  assert.deepEqual(jobsOf(out), ["A|One", "G|Guest"]);
  assert.equal(progressOf(out)["G|Guest"].status, "Подалася");
  assert.equal(out[KEYS.theme], "light");
  assert.equal(out[KEYS.cv], "cv");
});

test("the merge is stable: merging its own result again changes nothing", () => {
  const base = data({ jobs: [job("A", "One")] });
  const local = data({ jobs: [job("A", "One"), job("L", "Local")] });
  const remote = data({ jobs: [job("A", "One"), job("R", "Remote")] });
  const once = merge(fingerprint(base), local, remote);
  assert.ok(sameData(merge(fingerprint(once), once, once), once));
});

test("broken JSON in a stored value does not throw", () => {
  const out = merge(EMPTY, { [KEYS.jobs]: "{broken", [KEYS.progress]: "[]" }, data({ jobs: [job("A", "One")] }));
  assert.deepEqual(jobsOf(out), ["A|One"]);
});
