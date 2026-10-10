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

// The two races found by the E2E offline test (services/sync.js push()).
test("a stale copy paired with newer history would delete the other device's vacancy; the right pair keeps it", () => {
  const start = data({ jobs: [job("Base", "Co")] });
  const phoneAdded = data({ jobs: [job("Base", "Co"), job("Phone", "Co")] });
  const laptopEdit = data({ jobs: [job("Base", "Co")], progress: { "Base|Co": { status: "Перша співбесіда" } } });
  // wrong pair: the laptop's old copy against history that already contains the phone's vacancy
  assert.deepEqual(jobsOf(merge(fingerprint(phoneAdded), laptopEdit, phoneAdded)), ["Base|Co"]);
  // right pair: the copy and the history it was made from
  const out = merge(fingerprint(start), laptopEdit, phoneAdded);
  assert.deepEqual(jobsOf(out), ["Base|Co", "Phone|Co"]);
  assert.equal(progressOf(out)["Base|Co"].status, "Перша співбесіда");
});

test("edits typed during a push are put on top of what the push wrote, nothing of the other device is lost", () => {
  const before = data({ jobs: [job("A", "One")] });                                         // what the push sent
  const written = data({ jobs: [job("A", "One"), job("B", "Other device")] });              // merged with the cloud
  const now = data({ jobs: [job("A", "One")], progress: { "A|One": { note: "typed meanwhile" } } }); // typed since
  const next = merge(fingerprint(before), now, written);
  assert.deepEqual(jobsOf(next), ["A|One", "B|Other device"]);
  assert.equal(progressOf(next)["A|One"].note, "typed meanwhile");
  // and the following push, with what was written as the common history, keeps both
  const again = merge(fingerprint(written), next, written);
  assert.deepEqual(jobsOf(again), ["A|One", "B|Other device"]);
});

test("two devices changing different fields of one vacancy both win; a field changed on both keeps this device's", () => {
  const base = data({ jobs: [job("Same", "Co")], progress: { "Same|Co": { status: "Не подавалася", date: "", deadline: "", note: "" } } });
  const local = data({ jobs: [job("Same", "Co", { salary: "$2000" })], progress: { "Same|Co": { status: "Перша співбесіда", date: "", deadline: "", note: "моя" } } });
  const remote = data({ jobs: [job("Same", "Co", { loc: "Офіс" })], progress: { "Same|Co": { status: "Не подавалася", date: "", deadline: "", note: "HR: Олена" } } });
  const out = merge(fingerprint(base), local, remote);
  const [merged] = JSON.parse(out[KEYS.jobs]);
  assert.deepEqual([merged.salary, merged.loc], ["$2000", "Офіс"]);
  assert.deepEqual(progressOf(out)["Same|Co"], { status: "Перша співбесіда", date: "", deadline: "", note: "моя" });
});

test("a base from an older version (one hash per vacancy) still merges the vacancy as a whole", () => {
  const base = data({ jobs: [job("Same", "Co")], progress: { "Same|Co": { status: "Не подавалася", note: "" } } });
  const old = fingerprint(base);
  for (const id of Object.keys(old.jobs)) old.jobs[id] = old.jobs[id].v;
  const local = data({ jobs: [job("Same", "Co")], progress: { "Same|Co": { status: "Оффер", note: "" } } });
  const remote = data({ jobs: [job("Same", "Co")], progress: { "Same|Co": { status: "Не подавалася", note: "HR" } } });
  assert.deepEqual(progressOf(merge(old, local, remote))["Same|Co"], { status: "Оффер", note: "" });
});

test("a rename here and a status change there give one card with the new name and the new status", () => {
  const base = data({ jobs: [job("Typo Co", "Designer")], progress: { "Typo Co|Designer": { status: "Не подавалася", date: "", deadline: "", note: "HR" } } });
  const renamed = data({ jobs: [job("Typo Company", "Designer")], progress: { "Typo Company|Designer": { status: "Не подавалася", date: "", deadline: "", note: "HR" } } });
  const offer = data({ jobs: [job("Typo Co", "Designer")], progress: { "Typo Co|Designer": { status: "Оффер", date: "", deadline: "", note: "HR" } } });
  for (const [local, remote] of [[renamed, offer], [offer, renamed]]) {
    const out = merge(fingerprint(base), local, remote);
    assert.deepEqual(jobsOf(out), ["Typo Company|Designer"]);
    assert.equal(progressOf(out)["Typo Company|Designer"].status, "Оффер");
  }
});

test("a removal on one side and a new vacancy that only looks alike are not taken for a rename", () => {
  const base = data({ jobs: [job("Old", "Designer")], progress: { "Old|Designer": { status: "Подалася", note: "x" } } });
  const local = data({ jobs: [job("New", "Designer", { salary: "$9000" })], progress: { "New|Designer": { status: "Не подавалася", note: "" } } });
  const remote = data({ jobs: [job("Old", "Designer")], progress: { "Old|Designer": { status: "Оффер", note: "x" } } });
  const out = merge(fingerprint(base), local, remote);
  assert.deepEqual(jobsOf(out).sort(), ["New|Designer", "Old|Designer"], "an edit beats a removal, and the new vacancy stays");
});

/* ----- a vacancy on both sides without a common history ----- */

const ACCOUNT = data({
  jobs: [job("SoftServe", "QA", { prio: "100% Податися", salary: "$2000", url: "https://jobs.example/qa" })],
  progress: { "SoftServe|QA": { status: "Перша співбесіда", date: "2026-10-01", deadline: "2026-10-15", note: "HR Olena, tech call Mon 10:00" } },
});

test("a guest's blank copy of a vacancy the account has does not wipe the account's progress and fields", () => {
  const guest = data({ jobs: [job("SoftServe", "QA")], progress: { "SoftServe|QA": { status: "Не подавалися", date: "", deadline: "", note: "" } } });
  const out = merge(EMPTY, guest, ACCOUNT, { preferRemote: true });
  assert.deepEqual(JSON.parse(out[KEYS.jobs]), JSON.parse(ACCOUNT[KEYS.jobs]));
  assert.deepEqual(progressOf(out)["SoftServe|QA"], progressOf(ACCOUNT)["SoftServe|QA"]);
});

test("an older backup restored by a guest keeps the account's newer status, and both notes survive", () => {
  const backup = data({ jobs: [job("SoftServe", "QA", { salary: "$1800" })], progress: { "SoftServe|QA": { status: "Подався", date: "2026-09-20", deadline: "", note: "sent CV" } } });
  const out = merge(EMPTY, backup, ACCOUNT, { preferRemote: true });
  const p = progressOf(out)["SoftServe|QA"];
  assert.equal(p.status, "Перша співбесіда");
  assert.equal(p.date, "2026-10-01");
  assert.equal(p.deadline, "2026-10-15");
  assert.equal(p.note, "HR Olena, tech call Mon 10:00\n\nsent CV");
  assert.equal(JSON.parse(out[KEYS.jobs])[0].salary, "$2000");
});

test("what only the guest filled in joins the account's copy", () => {
  const account = data({ jobs: [job("Acme", "Designer")], progress: { "Acme|Designer": { status: "Не подавалася", date: "", deadline: "", note: "" } } });
  const guest = data({ jobs: [job("Acme", "Designer", { loc: "Віддалено", url: "https://acme.example/1" })], progress: { "Acme|Designer": { status: "Подалися", date: "2026-10-05", deadline: "", note: "via Djinni" } } });
  const out = merge(EMPTY, guest, account, { preferRemote: true });
  const [j] = JSON.parse(out[KEYS.jobs]);
  assert.equal(j.loc, "Віддалено");
  assert.equal(j.url, "https://acme.example/1");
  assert.deepEqual(progressOf(out)["Acme|Designer"], { status: "Подалися", date: "2026-10-05", deadline: "", note: "via Djinni" });
});

test("the same vacancy added on two devices keeps what each filled in, this device's values first", () => {
  const base = data({ jobs: [job("Other", "Card")] });
  const local = data({ jobs: [job("Other", "Card"), job("Twin", "Co", { salary: "$1000" })], progress: { "Twin|Co": { status: "Подалася", date: "2026-10-02", deadline: "", note: "laptop" } } });
  const remote = data({ jobs: [job("Other", "Card"), job("Twin", "Co", { loc: "Офіс", salary: "$1200" })], progress: { "Twin|Co": { status: "Не подавалася", date: "", deadline: "2026-10-30", note: "phone" } } });
  const out = merge(fingerprint(base), local, remote);
  const twin = JSON.parse(out[KEYS.jobs]).find((j) => j.company === "Twin");
  assert.equal(twin.salary, "$1000");
  assert.equal(twin.loc, "Офіс");
  assert.deepEqual(progressOf(out)["Twin|Co"], { status: "Подалася", date: "2026-10-02", deadline: "2026-10-30", note: "laptop\n\nphone" });
  const again = merge(fingerprint(out), out, out);
  assert.ok(sameData(again, out), "stable");
});

/* ----- removals that only look like renames ----- */

for (const [name, dropped, added] of [
  ["two blank cards", job("SoftServe", "QA"), job("EPAM", "Designer")],
  ["two cards that share the format", job("SoftServe", "QA", { emp: "Full-time", loc: "Віддалено" }), job("EPAM", "Designer", { emp: "Full-time", loc: "Віддалено" })],
  ["only the title differs", job("SoftServe", "QA"), job("SoftServe", "Designer")],
]) {
  test(`a card removed here and a fresh one added are not a rename (${name}): the other device's edits stay on their card`, () => {
    const fresh = { status: "Не подавалася", date: "", deadline: "", note: "" };
    const keep = job("Keep", "Co");
    const id = (j) => j.company + "|" + j.title;
    const base = data({ jobs: [keep, dropped], progress: { "Keep|Co": fresh, [id(dropped)]: fresh } });
    const laptop = data({ jobs: [keep, added], progress: { "Keep|Co": fresh, [id(added)]: fresh } });
    const phone = data({ jobs: [keep, dropped], progress: { "Keep|Co": fresh, [id(dropped)]: { status: "Подалася", date: "2026-10-10", deadline: "", note: "HR Olena, call Mon" } } });
    for (const [local, remote] of [[laptop, phone], [phone, laptop]]) {
      const out = merge(fingerprint(base), local, remote);
      assert.deepEqual(jobsOf(out).sort(), [id(added), id(dropped), "Keep|Co"].sort());
      assert.equal(progressOf(out)[id(dropped)].note, "HR Olena, call Mon");
      assert.equal(progressOf(out)[id(added)].note, "", "the new card stays fresh");
    }
  });
}

test("a card with a link is still followed through a rename", () => {
  const base = data({ jobs: [job("Typo Co", "Designer", { url: "https://jobs.example/7" })], progress: { "Typo Co|Designer": { status: "Не подавалася", date: "", deadline: "", note: "" } } });
  const renamed = data({ jobs: [job("Typo Company", "Designer", { url: "https://jobs.example/7" })], progress: { "Typo Company|Designer": { status: "Не подавалася", date: "", deadline: "", note: "" } } });
  const offer = data({ jobs: [job("Typo Co", "Designer", { url: "https://jobs.example/7" })], progress: { "Typo Co|Designer": { status: "Оффер", date: "", deadline: "", note: "" } } });
  for (const [local, remote] of [[renamed, offer], [offer, renamed]]) {
    const out = merge(fingerprint(base), local, remote);
    assert.deepEqual(jobsOf(out), ["Typo Company|Designer"]);
    assert.equal(progressOf(out)["Typo Company|Designer"].status, "Оффер");
  }
});

test("a blank card renamed on this device follows the rename it recorded; renamed on the other one it stays apart", () => {
  const fresh = { status: "Не подавалася", date: "", deadline: "", note: "" };
  const base = data({ jobs: [job("Typo Co", "Designer")], progress: { "Typo Co|Designer": fresh } });
  const renamed = data({ jobs: [job("Typo Company", "Designer")], progress: { "Typo Company|Designer": fresh } });
  const offer = data({ jobs: [job("Typo Co", "Designer")], progress: { "Typo Co|Designer": { ...fresh, status: "Оффер" } } });
  const here = merge(fingerprint(base), renamed, offer, { renamed: { "Typo Co|Designer": "Typo Company|Designer" } });
  assert.deepEqual(jobsOf(here), ["Typo Company|Designer"]);
  assert.equal(progressOf(here)["Typo Company|Designer"].status, "Оффер");
  const there = merge(fingerprint(base), offer, renamed);
  assert.deepEqual(jobsOf(there).sort(), ["Typo Co|Designer", "Typo Company|Designer"].sort(), "a duplicate, never a lost edit");
  assert.equal(progressOf(there)["Typo Co|Designer"].status, "Оффер");
});
