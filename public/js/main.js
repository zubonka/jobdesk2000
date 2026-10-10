// Entry point: loads the data, starts the shell (theme, windows, icons, taskbar, dialogs, clippy)
// and the apps, then signs in through Firebase in the background.

import { on, emit } from "./core/events.js";
import { KEYS, SYNC_PREFIX, STORAGE_FULL_TEXT } from "./core/storage.js";
import { currentUser, reloadUser } from "./data/user.js";
import { loadJobs } from "./data/jobs.js";
import { reloadCV } from "./data/profile.js";
import { loadFairy } from "./fairy/store.js";
import { initTheme, reloadTheme } from "./ui/theme.js";
import { initWindows, openWin, closeWin } from "./ui/windows.js";
import { initIcons, reloadIcons } from "./ui/icons.js";
import { initTaskbar } from "./ui/taskbar.js";
import { initDialogs, maybeWelcome } from "./ui/dialogs.js";
import { initClippy, greet, say, hide, isTalking } from "./ui/clippy.js";
import { initConfirm } from "./ui/confirm.js";
import { initAuth } from "./services/auth.js";
import { initVacancies, remindDeadline, takeSharedLink } from "./apps/vacancies.js";
import { initEditVacancy } from "./apps/edit-vacancy.js";
import { initStats } from "./apps/stats.js";
import { initMessenger } from "./apps/messenger.js";
import { initFairyApp } from "./apps/fairy.js";
import { initAuthDialog } from "./apps/auth-dialog.js";
import { initBackup } from "./apps/backup.js";
import { initOffline } from "./services/offline.js";
import { toast } from "./ui/toast.js";
import { todayISO } from "./core/dom.js";

loadJobs();

initTheme();
initWindows();
initIcons();
initTaskbar();
initDialogs();
initConfirm();
initClippy();

initVacancies();
initEditVacancy();
initStats();
initMessenger();
initFairyApp();
initAuthDialog();
initBackup();
initOffline();

// The cloud copy replaced local data: every module re-reads storage and redraws.
on("state", () => {
  loadJobs();
  loadFairy();
  reloadCV();
  reloadTheme();
  reloadIcons();
  emit("jobs", { type: "reload" });
  emit("fairy");
  emit("cv");
  emit("wallpaper");
});

// Another tab of the app wrote to storage. This tab reloads from storage, otherwise its next save would write its
// stale copy over the other tab's change. Signing in or out there reaches this tab through Firebase instead.
let otherTabTimer = null;
window.addEventListener("storage", (e) => {
  if (e.storageArea !== localStorage) return;
  if (e.key === KEYS.user) {
    const next = (() => { try { return JSON.parse(e.newValue || "null"); } catch (err) { return null; } })();
    const cur = currentUser();
    if (next && cur && next.uid === cur.uid) { reloadUser(); emit("user"); }
    return;
  }
  if (e.key !== null && !e.key.startsWith(SYNC_PREFIX)) return;
  clearTimeout(otherTabTimer);
  otherTabTimer = setTimeout(() => emit("state"), 100);
});

// The browser refused to save (its storage is full, usually because of a big wallpaper) or the cloud refused the
// copy: say so, at most every half a minute, instead of letting the change vanish unnoticed.
const warned = {};
const warnOnce = (name, text) => on(name, () => {
  if (Date.now() - (warned[name] || 0) < 30000) return;
  warned[name] = Date.now();
  toast(text, { ms: 12000 });
});
warnOnce("storage-full", STORAGE_FULL_TEXT);
warnOnce("sync-too-big", "Дані завеликі для хмари ✦ тут усе збережено, але інші пристрої не отримають змін, доки найдовші нотатки чи резюме не стануть коротшими.");

// Firebase (~175 KB) waits for the page to load; the desktop already renders from the local copy of the user.
window.addEventListener("load", initAuth, { once: true });
maybeWelcome();
takeSharedLink();
setTimeout(greet, 1000);
setTimeout(() => { if (!isTalking()) remindDeadline(); }, 12000); // after the greeting has gone

// A tab left open overnight, or an installed app resumed on a phone, must not keep last day's deadline badges
// ("дедлайн завтра" on the day itself) or last week's statistics.
let today = todayISO();
function checkDay() {
  if (todayISO() === today) return;
  today = todayISO();
  emit("day");
  if (!isTalking()) remindDeadline();
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkDay(); });
window.addEventListener("focus", checkDay);
setInterval(checkDay, 60_000);

// Small handle for manual checks and browser tests.
window.jobdesk = { openWin, closeWin, say, hide, emit };
