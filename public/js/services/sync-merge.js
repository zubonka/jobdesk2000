// Three-way merge of the synced data, kept free of Firebase so it can be tested on its own.
//
// "Data" is what the cloud document holds: { <storage key>: <raw string> }. The base is a fingerprint of the
// last copy this device and the cloud agreed on: one hash per key, plus hashes per vacancy (the whole vacancy and
// each of its fields) for the vacancy list and its progress map, which are merged vacancy by vacancy.
// A side "changed" a value when its hash differs from the base. Only one side changed: that side wins.
// Both changed one vacancy: field by field the same rule, and for a field changed on both sides the local edit
// wins (it is what the user just did here). Both changed any other key: the cloud wins.
// A vacancy both sides have with no base entry (a guest's copy or a restored backup joining an account, or the same
// company and title added on two devices) is joined field by field: a filled value beats an empty one, two notes
// are both kept, and other values filled on both sides follow `preferRemote`.
// A rename carries the other side's edits of the old vacancy over to the new name. This device's renames are known
// (`renamed`, recorded when they were made); the other side's are recognised by content: it removed a vacancy and
// added one equal to it in all but the name. Only a vacancy with a link or a note can be told apart from a fresh
// card that way, so a blank card renamed on the other device stays apart (a duplicate, never lost edits).
// An empty base ({ keys: {}, jobs: {} }) means "no common history": then everything on either side counts as new.
// Bases written by older versions hold one hash per vacancy only; their vacancies merge as a whole.

import { KEYS } from "../core/storage.js";
import { NONE } from "../data/jobs.js";
import { statusKeyOf } from "../data/statuses.js";

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
export function vacancies(data) {
  const list = parse(data[JOBS], []);
  const progress = parse(data[PROGRESS], {}) || {};
  const out = new Map();
  for (const job of Array.isArray(list) ? list : []) {
    if (job && typeof job === "object" && !out.has(idOf(job))) out.set(idOf(job), { job, progress: progress[idOf(job)] });
  }
  return out;
}

const vacancyHash = (v) => hash(JSON.stringify(v));
const fieldHash = (value) => hash(JSON.stringify(value)); // undefined -> "-"

const JOB_FIELDS = ["prio", "company", "title", "field", "emp", "loc", "salary", "url"];
const PROGRESS_FIELDS = ["status", "date", "deadline", "note"];

function fieldPrint(v) {
  const f = {};
  for (const k of JOB_FIELDS) f["j." + k] = fieldHash(v.job[k]);
  for (const k of PROGRESS_FIELDS) f["p." + k] = fieldHash(v.progress?.[k]);
  return f;
}

export function fingerprint(data) {
  const keys = {};
  for (const [key, value] of Object.entries(data)) if (key !== JOBS && key !== PROGRESS) keys[key] = hash(value);
  const jobs = {};
  for (const [id, v] of vacancies(data)) jobs[id] = { v: vacancyHash(v), f: fieldPrint(v) };
  return { keys, jobs };
}

// a base entry is { v, f } now, or the bare whole-vacancy hash written by older versions
export const wholeOf = (entry) => (entry && typeof entry === "object" ? entry.v : entry) || "-";
const fieldsOf = (entry) => (entry && typeof entry === "object" ? entry.f : null);

// One value seen on both sides, with the base hash. Only one side changed it: that side wins (a removal is a
// change too). Both changed it: `bothChanged` decides.
function choose(local, remote, baseHash, hashOf, bothChanged) {
  const lh = local === undefined ? "-" : hashOf(local), rh = remote === undefined ? "-" : hashOf(remote);
  if (lh === rh) return local;
  if (lh === baseHash) return remote;
  if (rh === baseHash) return local;
  return bothChanged(local, remote);
}

// both sides changed another key: the cloud wins, and a value beats a removal
const remoteValueWins = (local, remote) => (remote !== undefined ? remote : local);
const localWins = (local) => local;

const put = (target, k, value) => { if (value === undefined) delete target[k]; else target[k] = value; };

// Both sides changed one vacancy: each field goes to the side that changed it; a field both changed stays local.
function mergeFields(local, remote, base) {
  const job = { ...remote.job, ...local.job }, progress = { ...(remote.progress || {}), ...(local.progress || {}) };
  for (const k of JOB_FIELDS) put(job, k, choose(local.job[k], remote.job[k], base["j." + k] || "-", fieldHash, localWins));
  for (const k of PROGRESS_FIELDS) put(progress, k, choose(local.progress?.[k], remote.progress?.[k], base["p." + k] || "-", fieldHash, localWins));
  return { job, progress: local.progress === undefined && remote.progress === undefined ? undefined : progress };
}

// what a fresh card holds before anyone fills it in (a status counts by its key, the label depends on the gender)
const BLANK = { field: NONE, emp: NONE, loc: NONE, salary: NONE, url: "#" };
const isBlank = (k, value) => value === undefined || value === "" || value === BLANK[k] || (k === "status" && statusKeyOf(value) === "not_applied");
const joinNotes = (first, second) => (first.includes(second) ? first : second.includes(first) ? second : first + "\n\n" + second);

// A vacancy both sides have without a common history: neither copy is taken whole.
function joinFields(local, remote, preferRemote) {
  const pick = (k, l, r) => {
    const [first, second] = preferRemote ? [r, l] : [l, r];
    if (isBlank(k, first)) return isBlank(k, second) ? first ?? second : second;
    if (isBlank(k, second)) return first;
    return k === "note" ? joinNotes(first, second) : first;
  };
  const job = { ...remote.job, ...local.job }, progress = { ...(remote.progress || {}), ...(local.progress || {}) };
  for (const k of JOB_FIELDS) put(job, k, pick(k, local.job[k], remote.job[k]));
  for (const k of PROGRESS_FIELDS) put(progress, k, pick(k, local.progress?.[k], remote.progress?.[k]));
  return { job, progress: local.progress === undefined && remote.progress === undefined ? undefined : progress };
}

// both sides changed a vacancy: an edit beats a removal; field by field when the base knows the fields
const bothChangedVacancy = (entry, preferRemote) => (local, remote) => {
  if (!local || !remote) return local || remote;
  if (entry === undefined) return joinFields(local, remote, preferRemote);
  const f = fieldsOf(entry);
  return f ? mergeFields(local, remote, f) : local;
};

const sameButName = (v, f) => JOB_FIELDS.every((k) => k === "company" || k === "title" || fieldHash(v.job[k]) === f["j." + k])
  && PROGRESS_FIELDS.every((k) => fieldHash(v.progress?.[k]) === f["p." + k]);
// A card with neither a link nor a note looks like any fresh card: one removed and one added are not a rename.
const recognisable = (f) => f["j.url"] !== fieldHash("#") || ![fieldHash(""), fieldHash(undefined)].includes(f["p.note"]);

// Vacancies `side` renamed since the base: the recorded renames, then the ones recognised by content.
function renames(base, side, other, recorded) {
  const added = [...side.keys()].filter((id) => !base.jobs[id] && !other.has(id));
  const out = new Map(); // old id -> new id
  for (const [from, to] of Object.entries(recorded)) {
    if (!base.jobs[from] || side.has(from) || !other.has(from) || !added.includes(to)) continue;
    out.set(from, to);
    added.splice(added.indexOf(to), 1);
  }
  for (const [id, entry] of Object.entries(base.jobs)) {
    const f = fieldsOf(entry);
    if (out.has(id) || !added.length || side.has(id) || !other.has(id) || !f || !recognisable(f)) continue;
    const to = added.find((n) => sameButName(side.get(n), f));
    if (to) { out.set(id, to); added.splice(added.indexOf(to), 1); }
  }
  return out;
}

// When the other side edited a vacancy that this side renamed, the edits follow the new name and the old card
// does not come back.
function followRenames(base, mine, theirs, renamed) {
  for (const [from, to] of renames(base, mine, theirs, renamed)) {
    const old = theirs.get(from), entry = base.jobs[from];
    if (vacancyHash(old) !== wholeOf(entry)) mine.set(to, mergeFields(mine.get(to), old, fieldsOf(entry) || {}));
    theirs.delete(from);
  }
  for (const [from, to] of renames(base, theirs, mine, {})) {
    const edited = mine.get(from), entry = base.jobs[from];
    if (vacancyHash(edited) !== wholeOf(entry)) theirs.set(to, mergeFields(edited, theirs.get(to), fieldsOf(entry)));
    mine.delete(from);
  }
}

function mergeVacancies(base, local, remote, preferRemote, renamed) {
  const mine = vacancies(local), theirs = vacancies(remote);
  followRenames(base, mine, theirs, renamed);
  // cloud order first, then what only this device has
  const order = [...theirs.keys(), ...[...mine.keys()].filter((id) => !theirs.has(id))];
  const jobs = [], progress = {};
  for (const id of order) {
    const entry = base.jobs[id];
    const v = choose(mine.get(id), theirs.get(id), wholeOf(entry), vacancyHash, bothChangedVacancy(entry, preferRemote));
    if (!v) continue;
    jobs.push(v.job);
    if (v.progress !== undefined) progress[id] = v.progress;
  }
  return { [JOBS]: JSON.stringify(jobs), [PROGRESS]: JSON.stringify(progress) };
}

// The merged data, as { key: raw string }; a key missing from the result is deleted.
// preferRemote: for data that joins an account (a guest's), the account's values win where both sides have one.
// renamed: { old id: new id } renamed on this device since the base.
export function merge(base, local, remote, { preferRemote = false, renamed = {} } = {}) {
  const out = {};
  for (const key of new Set([...Object.keys(remote), ...Object.keys(local)])) {
    if (key === JOBS || key === PROGRESS) continue;
    const value = choose(local[key], remote[key], base.keys[key] || "-", hash, remoteValueWins);
    if (value !== undefined) out[key] = value;
  }
  if ([local, remote].some((d) => d[JOBS] !== undefined || d[PROGRESS] !== undefined)) Object.assign(out, mergeVacancies(base, local, remote, preferRemote, renamed));
  return out;
}

export const sameData = (a, b) => {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
};
