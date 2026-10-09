// Sign-in dialog (#auth-overlay): email and password, Google, password reset, plus signing out
// from the account button. A first Google sign-in on this device also asks how to address the person.

import { byId, qsa } from "../core/dom.js";
import { on } from "../core/events.js";
import { isAuthed, userName } from "../data/user.js";
import {
  register, signIn, signInWithGoogle, resetPassword, setGender, signOutUser, authErrorText, googleErrorText,
} from "../services/auth.js";
import { registerDialog, openDialog, closeDialog, isDialogOpen } from "../ui/dialogs.js";
import { say } from "../ui/clippy.js";
import { POSE } from "../fairy/render.js";

const DIALOG = "auth-overlay";
const MIN_PASSWORD = 6;
const emailOK = (email) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email);

let mode = "login";
let pendingGender = null;
let pickingGender = false;

const setMsg = (text) => { byId("auth-msg").textContent = text; };

function setAuthMode(next) {
  mode = next;
  const reg = mode === "register";
  for (const tab of qsa(".auth-tab")) tab.classList.toggle("sel", tab.dataset.tab === mode);
  byId("reg-only").hidden = !reg;
  byId("reg-gender").hidden = !reg;
  byId("auth-title").textContent = reg ? "✦ Реєстрація" : "✦ Вхід";
  byId("auth-sub").textContent = reg ? "Створи акаунт, щоб фея памʼятала твої вакансії й писала листи ✦" : "Увійди, щоб фея писала листи й памʼятала твої вакансії ✦";
  byId("auth-submit").textContent = reg ? "✦ Зареєструватися" : "✦ Увійти";
  byId("auth-pass").setAttribute("autocomplete", reg ? "new-password" : "current-password");
  byId("auth-forgot").hidden = reg;
  setMsg("");
}

function selectGender(g) {
  pendingGender = g;
  for (const btn of qsa(".gender-btn")) btn.classList.toggle("sel", btn.dataset.g === g);
}

function openAuth(next) {
  openDialog(DIALOG);
  setAuthMode(next === "register" ? "register" : "login");
  for (const id of ["auth-email", "auth-pass", "auth-name"]) byId(id).value = "";
  selectGender(null);
}

// Only the three gender buttons stay visible; leaving the step restores the current mode's form.
function setGenderStep(active) {
  pickingGender = active;
  for (const el of byId("auth-form").children) el.hidden = active && el.id !== "reg-gender";
  if (!active) setAuthMode(mode);
}

function welcome() {
  closeDialog(DIALOG);
  say("Вітаю, " + userName() + "! ✦ Тепер я з тобою ✦", POSE.happy, 10000);
}

// Keeps a second click from starting a second request while the first is in flight.
async function busy(button, request) {
  button.disabled = true;
  try { return await request(); } finally { button.disabled = false; }
}

function formProblem({ email, password, name }) {
  if (!emailOK(email)) return "Впиши справжню пошту (напр. you@gmail.com) ✦";
  if (password.length < MIN_PASSWORD) return "Пароль мінімум 6 символів ✦";
  if (mode !== "register") return "";
  if (!name) return "Впиши імʼя ✦";
  if (!pendingGender) return "Обери, як до тебе звертатись ✦";
  return "";
}

async function submit(e) {
  e.preventDefault();
  const fields = { email: byId("auth-email").value.trim(), password: byId("auth-pass").value, name: byId("auth-name").value.trim() };
  const problem = formProblem(fields);
  if (problem) { setMsg(problem); return; }
  const registering = mode === "register";
  setMsg(registering ? "Створюю акаунт ✦..." : "Входжу ✦...");
  try {
    await busy(byId("auth-submit"), () => (registering
      ? register({ ...fields, gender: pendingGender })
      : signIn(fields.email, fields.password)));
  } catch (err) {
    setMsg(authErrorText(err));
    return;
  }
  welcome();
}

async function continueWithGoogle() {
  setMsg("Відкриваю Google ✦...");
  let result;
  try {
    result = await busy(byId("auth-google"), () => signInWithGoogle(pendingGender));
  } catch (err) {
    setMsg(googleErrorText(err));
    return;
  }
  // nobody has told us yet how to address this person; if the dialog was closed meanwhile, the neutral form stays
  if (result.needsGender && isDialogOpen(DIALOG)) setGenderStep(true);
  else welcome();
}

function pickGender(g) {
  if (!pickingGender) { selectGender(g); return; }
  setGender(g);
  welcome();
}

async function forgotPassword() {
  const email = byId("auth-email").value.trim();
  if (!emailOK(email)) { setMsg("Впиши пошту, і я надішлю лист для скидання ✦"); return; }
  try {
    await resetPassword(email);
    setMsg("Лист для скидання пароля надіслано ✦ перевір пошту.");
  } catch (err) {
    setMsg(authErrorText(err));
  }
}

function account() {
  if (!isAuthed()) { openAuth("login"); return; }
  if (confirm("Вийти з акаунта «" + userName() + "»?")) signOutUser();
}

export function initAuthDialog() {
  registerDialog(DIALOG, () => { if (pickingGender) setGenderStep(false); });
  byId("auth-close").addEventListener("click", () => closeDialog(DIALOG));
  for (const tab of qsa(".auth-tab")) tab.addEventListener("click", () => setAuthMode(tab.dataset.tab));
  for (const btn of qsa(".gender-btn")) btn.addEventListener("click", () => pickGender(btn.dataset.g));
  byId("auth-form").addEventListener("submit", submit);
  byId("auth-google").addEventListener("click", continueWithGoogle);
  byId("auth-forgot").addEventListener("click", forgotPassword);
  on("auth:open", openAuth);
  on("account", account);
}
