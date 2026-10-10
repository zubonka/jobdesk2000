// Sign-in state. Firebase Auth decides who is signed in; data/user.js mirrors it for the UI,
// and cloud sync follows the signed-in uid.

import { loadFirebase, firebaseNow } from "./firebase.js";
import { startSync, stopSync, flushSync, forgetAccountData } from "./sync.js";
import { emit } from "../core/events.js";
import { KEYS, getRaw, setRaw, remove } from "../core/storage.js";
import { sleep } from "../core/dom.js";
import { currentUser, isAuthed, setUser, clearUser, genderFor, hasGenderFor, rememberGender } from "../data/user.js";

// Set while signOutUser runs: Firebase reports the sign-out through onAuthStateChanged too, and that path must
// not start a second reload while signOutUser is still cleaning up.
let signingOut = false;

// What was typed at sign-up: Firebase announces the new account before register() has stored the name.
let signingUp = null;

const nameOf = (u, email) => u.displayName || signingUp?.name || (u.email || email || "").split("@")[0];
const genderOf = (u) => (!hasGenderFor(u.uid) && signingUp?.gender) || genderFor(u.uid);

// how long signing out waits for Firebase when it has not loaded yet
const SIGN_OUT_WAIT_MS = 5000;

function onAuthChange(u) {
  if (u && getRaw(KEYS.signedOut) === u.uid) {
    // signed out here while Firebase could not be reached: its session ends now instead of coming back
    firebaseNow()?.A.signOut(firebaseNow().auth).catch(() => {});
    return;
  }
  remove(KEYS.signedOut);
  if (u) {
    const local = currentUser();
    if (!local || local.uid !== u.uid) setUser({ name: nameOf(u), email: u.email || "", gender: genderOf(u), uid: u.uid });
    startSync(u.uid);
  } else {
    stopSync();
    if (signingOut || !isAuthed()) return;
    // The session ended elsewhere (another tab, expiry) or this was a stale local copy. Reloading drops the
    // previous account's letters, chat and AI phrases that live only in memory.
    clearUser();
    location.reload();
  }
}

let watching = false;

export function initAuth() {
  loadFirebase().then((fb) => {
    if (!fb || watching) return;
    watching = true;
    emit("firebase");
    fb.A.onAuthStateChanged(fb.auth, onAuthChange);
  });
}

// Opened without a connection (and without the SDK in the offline cache): sign-in and sync start once it is back.
window.addEventListener("online", () => { if (!watching) initAuth(); });

// Fresh ID token for the backend, or null for guests.
export async function idToken() {
  const fb = firebaseNow() || (await loadFirebase());
  if (!fb) return null;
  if (fb.auth.authStateReady) await fb.auth.authStateReady();
  const u = fb.auth.currentUser;
  return u ? u.getIdToken() : null;
}

async function sdk() {
  const fb = await loadFirebase();
  if (!fb) throw Object.assign(new Error("Firebase unavailable"), { code: "app/unavailable" });
  return fb;
}

export async function register({ name, email, password, gender }) {
  const { A, auth } = await sdk();
  signingUp = { name, gender };
  try {
    const cr = await A.createUserWithEmailAndPassword(auth, email, password);
    rememberGender(cr.user.uid, gender);
    await A.updateProfile(cr.user, { displayName: name });
    try { await A.sendEmailVerification(cr.user); } catch (e) { /* the account works without it */ }
    setUser({ name, email, gender, uid: cr.user.uid });
    return cr.user;
  } finally {
    signingUp = null;
  }
}

export async function signIn(email, password) {
  const { A, auth } = await sdk();
  const cr = await A.signInWithEmailAndPassword(auth, email, password);
  setUser({ name: nameOf(cr.user, email), email, gender: genderFor(cr.user.uid), uid: cr.user.uid });
  return cr.user;
}

// Returns { user, needsGender } so the dialog can ask how to address a first-time Google user.
export async function signInWithGoogle(pendingGender) {
  const { A, auth } = await sdk();
  const cr = await A.signInWithPopup(auth, new A.GoogleAuthProvider());
  const u = cr.user;
  if (pendingGender && (!hasGenderFor(u.uid) || genderFor(u.uid) === "n")) rememberGender(u.uid, pendingGender);
  setUser({ name: nameOf(u), email: u.email || "", gender: genderFor(u.uid), uid: u.uid });
  return { user: u, needsGender: !hasGenderFor(u.uid) };
}

export async function resetPassword(email) {
  const { A, auth } = await sdk();
  await A.sendPasswordResetEmail(auth, email);
}

export function setGender(g) {
  const u = currentUser();
  if (!u) return;
  if (u.uid) rememberGender(u.uid, g);
  setUser({ ...u, gender: g });
}

// Pushes pending changes, signs out and reloads. The account's data leaves this device only when
// the cloud is known to have it; otherwise it stays (and is never uploaded into another account).
export async function signOutUser() {
  signingOut = true;
  const synced = await flushSync();
  stopSync();
  const fb = firebaseNow() || (await Promise.race([loadFirebase(), sleep(SIGN_OUT_WAIT_MS).then(() => null)]));
  const uid = currentUser()?.uid;
  if (fb) { try { await fb.A.signOut(fb.auth); } catch (e) { /* signing out locally is enough */ } }
  else if (uid) setRaw(KEYS.signedOut, uid); // Firebase would bring the session back on the next load
  if (synced) forgetAccountData();
  clearUser();
  location.reload();
}

export function authErrorText(err) {
  const c = (err && err.code) || "";
  if (c.includes("email-already-in-use")) return "Ця пошта вже зареєстрована ✦ Спробуй «Увійти».";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "Невірна пошта або пароль ✦";
  if (c.includes("weak-password")) return "Пароль надто простий ✦";
  if (c.includes("invalid-email")) return "Некоректна пошта ✦";
  if (c.includes("too-many-requests")) return "Забагато спроб ✦ спробуй за хвилину.";
  if (c.includes("popup-closed")) return "Вікно Google закрито ✦";
  if (c.includes("unauthorized-domain")) return "Домен не дозволено у Firebase ✦ додай його в Authorized domains.";
  if (c.includes("app/unavailable")) return "Firebase ще вантажиться ✦ зачекай пару секунд і спробуй ще (онови сторінку, якщо не зникає).";
  return "Помилка: " + ((err && err.message) || c || "невідома");
}

export function googleErrorText(err) {
  const c = (err && err.code) || "";
  if (c.includes("operation-not-allowed")) return "Google-вхід вимкнено у Firebase ✦ увімкни його: Authentication → Sign-in method → Google → Enable.";
  if (c.includes("unauthorized-domain")) return "Домен не дозволено ✦ додай його в Firebase → Authentication → Settings → Authorized domains.";
  if (c.includes("popup-blocked")) return "Браузер заблокував спливне вікно ✦ дозволь popup для цього сайту й спробуй ще.";
  if (c.includes("popup-closed") || c.includes("cancelled-popup")) return "Вікно Google закрито ✦ спробуй ще раз.";
  return authErrorText(err);
}
