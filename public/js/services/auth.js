// Sign-in state. Firebase Auth decides who is signed in; data/user.js mirrors it for the UI,
// and cloud sync follows the signed-in uid.

import { loadFirebase, firebaseNow } from "./firebase.js";
import { startSync, stopSync, flushSync, forgetAccountData } from "./sync.js";
import { emit } from "../core/events.js";
import { currentUser, isAuthed, setUser, clearUser, genderFor, hasGenderFor, rememberGender } from "../data/user.js";

export const firebaseReady = () => !!firebaseNow();

const nameOf = (u, email) => u.displayName || (u.email || email || "").split("@")[0];

function onAuthChange(u) {
  if (u) {
    const local = currentUser();
    if (!local || local.uid !== u.uid) setUser({ name: nameOf(u), email: u.email || "", gender: genderFor(u.uid), uid: u.uid });
    startSync(u.uid);
  } else {
    stopSync();
    if (!isAuthed()) return;
    // The session ended elsewhere (another tab, expiry) or this was a stale local copy. Reloading drops the
    // previous account's letters, chat and AI phrases that live only in memory.
    clearUser();
    location.reload();
  }
}

export function initAuth() {
  loadFirebase().then((fb) => {
    if (!fb) return;
    emit("firebase");
    fb.A.onAuthStateChanged(fb.auth, onAuthChange);
  });
}

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
  const cr = await A.createUserWithEmailAndPassword(auth, email, password);
  await A.updateProfile(cr.user, { displayName: name });
  try { await A.sendEmailVerification(cr.user); } catch (e) { /* the account works without it */ }
  rememberGender(cr.user.uid, gender);
  setUser({ name, email, gender, uid: cr.user.uid });
  return cr.user;
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
  const synced = await flushSync();
  stopSync();
  const fb = firebaseNow();
  if (fb) { try { await fb.A.signOut(fb.auth); } catch (e) { /* signing out locally is enough */ } }
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
