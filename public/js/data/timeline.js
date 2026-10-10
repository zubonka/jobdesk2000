// Dates of the job search: how far a deadline is, and the weekly rhythm of applications.
// Dates are local "YYYY-MM-DD" strings, the format the date inputs store.

const DAY_MS = 86400000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// a deadline no longer matters once the story of the vacancy has ended
const FINAL_KEYS = ["offer", "reject"];

const utc = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
// a real calendar day: "2026-09-43" would silently roll over into October
const isDate = (value) => typeof value === "string" && ISO_DATE.test(value) && toISO(utc(value)) === value;
const toISO = (ms) => new Date(ms).toISOString().slice(0, 10);

// Whole days from `from` to `to`; null when either is not a date.
export function daysBetween(from, to) {
  if (!isDate(from) || !isDate(to)) return null;
  return Math.round((utc(to) - utc(from)) / DAY_MS);
}

// Days left until the vacancy's deadline (negative once it has passed), or null when there is none to watch.
export function deadlineIn(job, today) {
  if (FINAL_KEYS.includes(job.status)) return null;
  return daysBetween(today, job.deadline);
}

// The Ukrainian plural form for n: forms = [one, few, many], e.g. ["день", "дні", "днів"].
function plural(n, [one, few, many]) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  return n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? few : many;
}

// "1 день", "3 дні", "5 днів", "21 день"
export const daysText = (n) => n + " " + plural(n, ["день", "дні", "днів"]);
// "1 тиждень", "3 тижні", "5 тижнів"
export const weeksText = (n) => n + " " + plural(n, ["тиждень", "тижні", "тижнів"]);

// Monday of the week that contains `iso`.
export function weekStart(iso) {
  const day = (new Date(utc(iso)).getUTCDay() + 6) % 7; // Monday = 0
  return toISO(utc(iso) - day * DAY_MS);
}

// Applications (the "date" of a vacancy) per week for the last `weeks` weeks, oldest first; the last one is this week.
export function weeklyApplied(jobs, today, weeks = 8) {
  const thisWeek = utc(weekStart(today));
  const series = Array.from({ length: weeks }, (_, i) => ({ start: toISO(thisWeek - (weeks - 1 - i) * 7 * DAY_MS), count: 0 }));
  for (const job of jobs) {
    if (!isDate(job.date)) continue;
    const i = weeks - 1 - Math.round((thisWeek - utc(weekStart(job.date))) / (7 * DAY_MS));
    if (i >= 0 && i < weeks) series[i].count++;
  }
  return series;
}

// Weeks in a row with at least one application, counted back from this week
// (or from last week while this one has none yet).
export function weekStreak(series) {
  let i = series.length - 1;
  if (i >= 0 && !series[i].count) i--;
  let streak = 0;
  for (; i >= 0 && series[i].count; i--) streak++;
  return streak;
}
