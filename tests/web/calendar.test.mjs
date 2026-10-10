import { test } from "node:test";
import assert from "node:assert/strict";
import "./fake-storage.mjs";

const { deadlineCalendar, calendarName } = await import("../../public/js/services/calendar.js");

const JOB = { id: "Acme Studio|Senior Graphic Designer", company: "Acme Studio", title: "Senior Graphic Designer", url: "https://example.com/job/1", deadline: "2026-10-20" };
const NOW = new Date("2026-10-10T09:30:15.123Z");

// RFC 5545 3.1: a folded line continues after CRLF and one space
const unfold = (ics) => ics.replace(/\r\n /g, "");
const field = (ics, name) => unfold(ics).split("\r\n").find((line) => line.startsWith(name))?.slice(name.length);

test("a deadline becomes one all-day event with a reminder at 9:00 the day before", () => {
  const ics = deadlineCalendar(JOB, NOW);
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
  assert.ok(ics.endsWith("END:VEVENT\r\nEND:VCALENDAR\r\n"));
  assert.equal(field(ics, "DTSTART;VALUE=DATE:"), "20261020");
  assert.equal(field(ics, "DTEND;VALUE=DATE:"), "20261021");
  assert.equal(field(ics, "DTSTAMP:"), "20261010T093015Z");
  assert.equal(field(ics, "SUMMARY:"), "⏳ Дедлайн: Acme Studio\\, Senior Graphic Designer");
  assert.equal(field(ics, "URL:"), "https://example.com/job/1");
  assert.equal(field(ics, "TRIGGER:"), "-PT15H");
  assert.equal(unfold(ics).split("\r\n").filter((line) => line === "BEGIN:VEVENT").length, 1);
  assert.equal(calendarName(JOB), "jobdesk2000-deadline-20261020.ics");
});

test("the day after the deadline crosses months, years and leap days", () => {
  assert.equal(field(deadlineCalendar({ ...JOB, deadline: "2026-10-31" }, NOW), "DTEND;VALUE=DATE:"), "20261101");
  assert.equal(field(deadlineCalendar({ ...JOB, deadline: "2026-12-31" }, NOW), "DTEND;VALUE=DATE:"), "20270101");
  assert.equal(field(deadlineCalendar({ ...JOB, deadline: "2028-02-28" }, NOW), "DTEND;VALUE=DATE:"), "20280229");
});

test("no file without a real deadline date", () => {
  for (const deadline of ["", null, undefined, "2026-09-43", "20.10.2026", 42]) {
    assert.equal(deadlineCalendar({ ...JOB, deadline }, NOW), null, String(deadline));
  }
});

test("names with commas, semicolons, backslashes and line breaks cannot break the file", () => {
  const ics = deadlineCalendar({ ...JOB, company: "Ромашка; ТОВ, \\ Київ", title: "Дизайнерка\r\nEND:VCALENDAR" }, NOW);
  assert.equal(field(ics, "SUMMARY:"), "⏳ Дедлайн: Ромашка\\; ТОВ\\, \\\\ Київ\\, Дизайнерка\\nEND:VCALENDAR");
  assert.equal(unfold(ics).split("\r\n").filter((line) => line === "END:VCALENDAR").length, 1);
});

test("long lines are folded at 75 octets without splitting a character", () => {
  const title = "Провідна дизайнерка інтерфейсів і брендингу для музичного лейблу 🎧✨ ".repeat(3);
  const ics = deadlineCalendar({ ...JOB, title }, NOW);
  const encoder = new TextEncoder();
  for (const line of ics.split("\r\n")) assert.ok(encoder.encode(line).length <= 75, line);
  assert.ok(!ics.includes("�"));
  assert.equal(field(ics, "SUMMARY:"), "⏳ Дедлайн: Acme Studio\\, " + title);
});

test("only a web link goes into the event, and never with spaces or line breaks", () => {
  assert.equal(field(deadlineCalendar({ ...JOB, url: "#" }, NOW), "URL:"), undefined);
  assert.equal(field(deadlineCalendar({ ...JOB, url: "javascript:alert(1)" }, NOW), "URL:"), undefined);
  assert.equal(field(deadlineCalendar({ ...JOB, url: "https://example.com/a b\r\nX:y" }, NOW), "URL:"), "https://example.com/abX:y");
});

test("a vacancy keeps its event id, another vacancy gets another one", () => {
  const id = (job) => field(deadlineCalendar(job, NOW), "UID:");
  assert.equal(id(JOB), id({ ...JOB, deadline: "2026-11-01" }));
  assert.notEqual(id(JOB), id({ ...JOB, id: "Acme Studio|Junior Graphic Designer" }));
  assert.match(id(JOB), /^vacancy-[0-9a-f]{8}@jobdesk2000$/);
});

test("an empty company is left out of the title", () => {
  assert.equal(field(deadlineCalendar({ ...JOB, company: "—" }, NOW), "SUMMARY:"), "⏳ Дедлайн: Senior Graphic Designer");
});
