// Calls to the Netlify functions. Sends the Firebase ID token when the user is signed in.

import { idToken } from "./auth.js";
import { sleep } from "../core/dom.js";

const BUSY = "Сервіс зараз зайнятий ✦ спробуй ще раз за хвилину.";
// On a stalled connection the Firebase SDK may never finish loading; the request must not wait for it forever.
const TOKEN_WAIT_MS = 8000;
// shortest pasted vacancy text the server analyses (netlify/functions/analyze-vacancy.js, MIN_TEXT)
export const MIN_VACANCY_TEXT = 40;

export class ApiError extends Error {
  // retry: the server was busy, trying again later may work; auth: the user must sign in again
  constructor(message, { retry = false, auth = false, page = false } = {}) {
    super(message);
    this.retry = retry;
    this.auth = auth;
    this.page = page;
  }
}

async function post(name, payload, timeoutMs) {
  const headers = { "Content-Type": "application/json" };
  const token = await Promise.race([idToken().catch(() => null), sleep(TOKEN_WAIT_MS).then(() => null)]);
  if (token) headers.Authorization = "Bearer " + token;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch("/.netlify/functions/" + name, { method: "POST", headers, body: JSON.stringify(payload), signal: ctrl.signal });
  } catch (err) {
    throw new ApiError(BUSY); // offline or no answer in time: an automatic retry would only make the wait longer
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || data.auth) throw new ApiError(data.error || ("HTTP " + res.status), { auth: true });
  if (!res.ok || data.error) {
    // 429 is the backend's own rate limit: waiting a few seconds does not help there
    const retry = !!data.retry || (res.status >= 502 && !data.page);
    throw new ApiError(data.error || (retry ? BUSY : "HTTP " + res.status), { retry, page: !!data.page });
  }
  return data;
}

// { url } or { text } -> { company, title, field, emp, loc, salary }
export const analyzeVacancy = (payload) => post("analyze-vacancy", payload, 40000);

// CV or vacancy text -> { role, summary, phrases }  (signed-in users only)
export const analyzeProfile = (text) => post("analyze-vacancy", { mode: "profile", cv: text }, 40000);

// { job, cv, lang, tone, focus, gender, name } -> { text }
export const writeLetter = (payload) => post("cover-letter", { action: "write", ...payload }, 58000);

// same fields plus { letter, request } -> { text }
export const reviseLetter = (payload) => post("cover-letter", { action: "revise", ...payload }, 58000);
