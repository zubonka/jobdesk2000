// Entry point: loads the data, starts the shell (theme, windows, icons, taskbar, dialogs, clippy)
// and the apps, then signs in through Firebase in the background.

import { on, emit } from "./core/events.js";
import { loadJobs } from "./data/jobs.js";
import { reloadCV } from "./data/profile.js";
import { loadFairy } from "./fairy/store.js";
import { initTheme, reloadTheme } from "./ui/theme.js";
import { initWindows, openWin, closeWin } from "./ui/windows.js";
import { initIcons, reloadIcons } from "./ui/icons.js";
import { initTaskbar } from "./ui/taskbar.js";
import { initDialogs, maybeWelcome } from "./ui/dialogs.js";
import { initClippy, greet, say, hide } from "./ui/clippy.js";
import { initAuth } from "./services/auth.js";
import { initVacancies } from "./apps/vacancies.js";
import { initEditVacancy } from "./apps/edit-vacancy.js";
import { initStats } from "./apps/stats.js";
import { initMessenger } from "./apps/messenger.js";
import { initFairyApp } from "./apps/fairy.js";
import { initAuthDialog } from "./apps/auth-dialog.js";

loadJobs();

initTheme();
initWindows();
initIcons();
initTaskbar();
initDialogs();
initClippy();

initVacancies();
initEditVacancy();
initStats();
initMessenger();
initFairyApp();
initAuthDialog();

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

// Firebase (~175 KB) waits for the page to load; the desktop already renders from the local copy of the user.
window.addEventListener("load", initAuth, { once: true });
maybeWelcome();
setTimeout(greet, 1000);

// Small handle for manual checks and browser tests.
window.jobdesk = { openWin, closeWin, say, hide, emit };
