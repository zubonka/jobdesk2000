// Three-way merge of the synced data, kept free of Firebase so it can be tested on its own.
//
// "Data" is what the cloud document holds: { <storage key>: <raw string> }. The base is a fingerprint of the
// last copy this device and the cloud agreed on: one hash per key, plus one hash per vacancy for the vacancy
// list and its progress map, which are merged vacancy by vacancy. A side "changed" a value when its hash differs
// from the base. Only one side changed: that side wins. Both changed: for a vacancy the local edit wins (it is
// what the user just did here); for any other key the cloud wins.
// An empty base ({ keys: {}, jobs: {} }) means "no common history": then everything on either side counts as new.

import { KEYS } from "../core/storage.js";

const JOBS = KEYS.jobs, PROGRESS = KEYS.progress;

// FNV-1a, 32 bit: tiny, fast, good enough to tell edits apart
export function hash(text) {
  if (text === undefined) return "-";
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const parse = (text, fallback) => { try { return JSON.parse(text) ?? fallback; } catch (e) { return fallback; } };
const idOf = (job) => job.company + "|" + job.title;

// { <vacancy id>: { job, progress } } in list order
function vacancies(data) {
  const list = parse(data[JOBS], []);
  const progress = parse(data[PROGRESS], {}) || {};
  const out = new Map();
  for (const job of Array.isArray(list) ? list : []) {
    if (job && typeof job === "object" && !out.has(idOf(job))) out.set(idOf(job), { job, progress: progress[idOf(job)] });
  }
  return out;
}

const vacancyHash = (v) => hash(JSON.stringify(v));

export function fingerprint(data) {
  const keys = {};
  for (const [key, value] of Object.entries(data)) if (key !== JOBS && key !== PROGRESS) keys[key] = hash(value);
  const jobs = {};
  for (const [id, v] of vacancies(data)) jobs[id] = vacancyHash(v);
  return { keys, jobs };
}

// One value seen on both sides, with the base hash. Only one side changed it: that side wins (a removal is a
// change too). Both changed it: `bothChanged` decides.
function choose(local, remote, baseHash, hashOf, bothChanged) {
  const lh = local === undefined ? "-" : hashOf(local), rh = remote === undefined ? "-" : hashOf(remote);
  if (lh === rh) return local;
  if (lh === baseHash) return remote;
  if (rh === baseHash) return local;
  return bothChanged(local, remote);
}

// both sides changed a vacancy: this device's edit wins, and an edit beats a removal
const localVacancyWins = (local, remote) => local || remote;
// both sides changed another key: the cloud wins, and a value beats a removal
const remoteValueWins = (local, remote) => (remote !== undefined ? remote : local);

function mergeVacancies(base, local, remote) {
  const mine = vacancies(local), theirs = vacancies(remote);
  // cloud order first, then what only this device has
  const order = [...theirs.keys(), ...[...mine.keys()].filter((id) => !theirs.has(id))];
  const jobs = [], progress = {};
  for (const id of order) {
    const v = choose(mine.get(id), theirs.get(id), base.jobs[id] || "-", vacancyHash, localVacancyWins);
    if (!v) continue;
    jobs.push(v.job);
    if (v.progress !== undefined) progress[id] = v.progress;
  }
  return { [JOBS]: JSON.stringify(jobs), [PROGRESS]: JSON.stringify(progress) };
}

// The merged data, as { key: raw string }; a key missing from the result is deleted.
export function merge(base, local, remote) {
  const out = {};
  for (const key of new Set([...Object.keys(remote), ...Object.keys(local)])) {
    if (key === JOBS || key === PROGRESS) continue;
    const value = choose(local[key], remote[key], base.keys[key] || "-", hash, remoteValueWins);
    if (value !== undefined) out[key] = value;
  }
  if ([local, remote].some((d) => d[JOBS] !== undefined || d[PROGRESS] !== undefined)) Object.assign(out, mergeVacancies(base, local, remote));
  return out;
}

export const sameData = (a, b) => {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
};
