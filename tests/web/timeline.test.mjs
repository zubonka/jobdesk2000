import { test } from "node:test";
import assert from "node:assert/strict";

const { daysBetween, deadlineIn, daysText, weekStart, weeklyApplied, weekStreak } = await import("../../public/js/data/timeline.js");

test("daysBetween counts calendar days, across months, years and the DST switch", () => {
  assert.equal(daysBetween("2026-10-10", "2026-10-10"), 0);
  assert.equal(daysBetween("2026-10-10", "2026-10-11"), 1);
  assert.equal(daysBetween("2026-10-11", "2026-10-10"), -1);
  assert.equal(daysBetween("2026-10-24", "2026-10-26"), 2); // Kyiv leaves summer time on Oct 25
  assert.equal(daysBetween("2026-12-31", "2027-01-01"), 1);
  assert.equal(daysBetween("2028-02-28", "2028-03-01"), 2);
});

test("daysBetween is null for anything that is not a date", () => {
  for (const bad of ["", null, undefined, "10.10.2026", "2026-1-5", "soon", 42]) {
    assert.equal(daysBetween("2026-10-10", bad), null, String(bad));
    assert.equal(daysBetween(bad, "2026-10-10"), null, String(bad));
  }
});

test("a deadline is watched until the vacancy ends with an offer or a refusal", () => {
  const today = "2026-10-10";
  assert.equal(deadlineIn({ status: "not_applied", deadline: "2026-10-13" }, today), 3);
  assert.equal(deadlineIn({ status: "test", deadline: "2026-10-09" }, today), -1);
  assert.equal(deadlineIn({ status: "applied", deadline: "" }, today), null);
  assert.equal(deadlineIn({ status: "offer", deadline: "2026-10-13" }, today), null);
  assert.equal(deadlineIn({ status: "reject", deadline: "2026-10-13" }, today), null);
});

test("daysText picks the Ukrainian plural form", () => {
  const forms = [1, 2, 4, 5, 11, 12, 14, 15, 21, 22, 25, 101, 111, 112].map(daysText);
  assert.deepEqual(forms, ["1 день", "2 дні", "4 дні", "5 днів", "11 днів", "12 днів", "14 днів", "15 днів", "21 день", "22 дні", "25 днів", "101 день", "111 днів", "112 днів"]);
});

test("weeks start on Monday", () => {
  assert.equal(weekStart("2026-10-10"), "2026-10-05"); // Saturday
  assert.equal(weekStart("2026-10-05"), "2026-10-05"); // Monday
  assert.equal(weekStart("2026-10-11"), "2026-10-05"); // Sunday
  assert.equal(weekStart("2027-01-01"), "2026-12-28");
});

test("weeklyApplied puts each application into its week and ignores the rest", () => {
  const jobs = [
    { date: "2026-10-10" }, { date: "2026-10-05" },  // this week
    { date: "2026-10-04" },                           // last week (Sunday)
    { date: "2026-08-17" },                           // the oldest of 8 weeks
    { date: "2026-08-16" },                           // too old
    { date: "2026-10-12" },                           // next week: a typo in the future
    { date: "" }, { date: "not a date" }, {},
  ];
  const series = weeklyApplied(jobs, "2026-10-10");
  assert.equal(series.length, 8);
  assert.equal(series[0].start, "2026-08-17");
  assert.equal(series[7].start, "2026-10-05");
  assert.deepEqual(series.map((w) => w.count), [1, 0, 0, 0, 0, 0, 1, 2]);
});

test("the streak counts weeks in a row and forgives a week that has only just begun", () => {
  const counts = (list) => list.map((count) => ({ count }));
  assert.equal(weekStreak(counts([0, 1, 1, 3])), 3);
  assert.equal(weekStreak(counts([1, 1, 2, 0])), 3);
  assert.equal(weekStreak(counts([1, 0, 1, 0])), 1);
  assert.equal(weekStreak(counts([1, 1, 0, 0])), 0);
  assert.equal(weekStreak(counts([0, 0, 0, 0])), 0);
  assert.equal(weekStreak([]), 0);
});
