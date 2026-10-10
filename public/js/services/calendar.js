// A vacancy's deadline as a calendar file (iCalendar, RFC 5545): one all-day event with a reminder at 9:00 the day
// before. Phone calendars, Google Calendar, Outlook and Apple Calendar open the file and offer to add the event.

import { safeUrl } from "../core/dom.js";
import { NONE, normalizeUrl } from "../data/jobs.js";
import { isDate } from "../data/timeline.js";

const DAY_MS = 86400000;

const compact = (iso) => iso.replaceAll("-", "");
const nextDay = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + DAY_MS).toISOString().slice(0, 10);
};
const stamp = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// RFC 5545 3.3.11: in a text value backslash, semicolon and comma are escaped and a line break becomes "\n"
const text = (value) => String(value).replace(/[\\;,]/g, (c) => "\\" + c).replace(/\r\n|\r|\n/g, "\\n");

// RFC 5545 3.1: a line longer than 75 octets goes on after CRLF and a space. The cut never falls inside a
// character, so Cyrillic and emoji arrive whole.
const encoder = new TextEncoder();
function fold(line) {
  let out = "", size = 0;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    if (size + n > 75) { out += "\r\n "; size = 1; }
    out += ch;
    size += n;
  }
  return out;
}

// The same vacancy keeps the same event id, so a calendar that knows the event updates it instead of adding a copy.
function eventId(job) {
  let h = 0x811c9dc5; // FNV-1a
  for (const ch of String(job.id)) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return "vacancy-" + h.toString(16).padStart(8, "0") + "@jobdesk2000";
}

export const calendarName = (job) => "jobdesk2000-deadline-" + compact(job.deadline) + ".ics";

// null when the vacancy has no real deadline date
export function deadlineCalendar(job, now = new Date()) {
  if (!isDate(job.deadline)) return null;
  const name = [job.company, job.title].filter((part) => part && part !== NONE).join(", ");
  const link = safeUrl(normalizeUrl(job.url)).replace(/[\s\u0000-\u001f\u007f]/g, ""); // a URI value holds no spaces or line breaks
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//JobDesk 2000//Vacancy deadline//UK",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    "UID:" + eventId(job),
    "DTSTAMP:" + stamp(now),
    "DTSTART;VALUE=DATE:" + compact(job.deadline),
    "DTEND;VALUE=DATE:" + compact(nextDay(job.deadline)),
    "SUMMARY:" + text("⏳ Дедлайн: " + name),
    ...(link !== "#" ? ["URL:" + link, "DESCRIPTION:" + text(link)] : []),
    "TRANSP:TRANSPARENT",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "TRIGGER:-PT15H",
    "DESCRIPTION:" + text("Завтра дедлайн: " + name),
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
