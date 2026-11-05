/* Stetig: Habit-Tracker. Keine Bibliotheken.
   Daten liegen im Browser. Läuft die Seite als Claude-Artifact, gehen sie zusätzlich
   in die private Datenbank des Kontos, damit Handy und PC denselben Stand haben. */
"use strict";

/* ---------- Grundlagen ---------- */
const KEY = "stetig.v1";
const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const WD_LONG = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const MON_FIRST = [1, 2, 3, 4, 5, 6, 0];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const COLORS = ["sun", "orange", "green", "blue", "pink", "violet", "indigo"];
const DEFAULT_SETTINGS = { threshold: 5, dayStart: 3, weeks: {} };
const MINUS_STEP = 0.9; /* So viel zieht jeder Minuspunkt vom Tageswert ab, an jedem Tag gleich. */
const PAUSE_REASONS = { krank: "Krank", urlaub: "Urlaub", frei: "Freier Tag" };

const SUGGEST = {
  plus: ["Kochen lernen", "Gitarre üben", "Programmieren", "Meditieren", "Tagebuch schreiben", "Zeichnen", "20 Liegestütze", "2 Liter trinken", "Dehnen", "Früh aufstehen", "Vokabeln", "Aufräumen"],
  minus: ["Handy im Bett", "Doomscrolling", "Fast Food", "Zu spät ins Bett", "Sport ausgelassen", "Rauchen", "Serie statt Lernen", "Süßkram"]
};

const pad = n => String(n).padStart(2, "0");
const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = k => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return keyOf(d); };
/* Der Tag beginnt erst um die eingestellte Uhrzeit. So zählt ein langer Abend noch zum alten Tag. */
const todayKey = () => keyOf(new Date(Date.now() - ((S && S.settings.dayStart) || 0) * 3600000));
const dow = k => parseKey(k).getDay();
const fmt = n => n.toFixed(1).replace(".", ",");
const uid = () => "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const mondayOf = k => addDays(k, -((dow(k) + 6) % 7));
const longDate = k => { const d = parseKey(k); return `${d.getDate()}. ${MONTHS[d.getMonth()]}`; };
const shortDate = k => { const d = parseKey(k); return `${WD[d.getDay()]}, ${d.getDate()}. ${MONTHS[d.getMonth()].slice(0, 3)}`; };

/* ---------- Standarddaten ---------- */
function freshState() {
  const old = "2000-01-01";
  const h = (id, type, name, points, icon, color, days = ALL_DAYS) =>
    ({ id, type, name, points, icon, color, days: days.slice(), from: old, archived: null });
  const extras = { bett: ["morgens", 0], lesen: ["abends", 10], gehen: ["tags", 10], franz: ["abends", 15], arbeit: ["tags", 0] };
  const withExtras = list => list.map(x => Object.assign(x, { time: (extras[x.id] || [""])[0], minutes: (extras[x.id] || [0, 0])[1], weekly: 0 }));
  return {
    version: 1,
    habits: withExtras([
      h("bett", "plus", "Bett machen", 1, "bed", "sun"),
      h("lesen", "plus", "10 Minuten lesen", 2, "book", "blue"),
      h("gehen", "plus", "10 Minuten spazieren", 2, "walk", "green"),
      h("franz", "plus", "Französisch lernen", 2, "speech", "violet"),
      h("arbeit", "plus", "Zur Arbeit gegangen", 3, "work", "orange", [1, 2, 3, 4, 5]),
      h("schlaf", "minus", "Mittagsschlaf", 1, "moon", "indigo")
    ]),
    settings: Object.assign({}, DEFAULT_SETTINGS, { weeks: {} }),
    days: {},
    habitsT: 0,
    resetT: 0
  };
}

function isValidState(s) {
  return s && Array.isArray(s.habits) && s.days && typeof s.days === "object" &&
    s.habits.every(h => h && typeof h.id === "string" && typeof h.name === "string" && (h.type === "plus" || h.type === "minus"));
}

/* Eingelesene oder abgeglichene Tage enthalten nur Zahlen, wo die App Zahlen anzeigt. */
function cleanDay(d) {
  const numbers = (o, max) => {
    const out = {};
    if (o && typeof o === "object") Object.keys(o).forEach(id => { const n = Number(o[id]); if (n > 0) out[id] = Math.min(n, max); });
    return out;
  };
  d.done = numbers(d.done, 1);
  d.minus = numbers(d.minus, 99);
  if (d.mins) d.mins = numbers(d.mins, 600);
  if (d.skip) d.skip = numbers(d.skip, 1);
  if (d.rating !== undefined) {
    const r = Math.round(Number(d.rating));
    if (r >= 1 && r <= 10) d.rating = r; else delete d.rating;
  }
  if (d.note !== undefined) d.note = String(d.note).slice(0, 500);
  if (d.pause !== undefined && !PAUSE_REASONS[d.pause]) delete d.pause;
  if (d.ctx !== undefined) d.ctx = String(d.ctx).slice(0, 200);
  if (d.ai !== undefined) {
    const score = Number(d.ai && d.ai.score);
    if (score >= 1 && score <= 10) d.ai = { score: Math.round(score * 2) / 2, text: String(d.ai.text || "").slice(0, 400), sig: String(d.ai.sig || "") };
    else delete d.ai;
  }
  if (d.snap) {
    const o = {};
    Object.keys(d.snap.o || {}).forEach(id => { o[id] = String(d.snap.o[id]).slice(0, 40); });
    d.snap = { p: numbers(d.snap.p, 5), m: numbers(d.snap.m, 5), b: numbers(d.snap.b, 5), o };
  }
}

function normalize(s) {
  s.settings = Object.assign({}, DEFAULT_SETTINGS, { weeks: {} }, s.settings);
  s.habitsT = s.habitsT || 0;
  s.resetT = s.resetT || 0;
  s.settings.weeks = s.settings.weeks || {};
  s.settings.threshold = clamp(Number(s.settings.threshold) || 5, 2, 9);
  s.settings.dayStart = clamp(Number(s.settings.dayStart) || 0, 0, 6);
  Object.keys(s.days).forEach(k => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !s.days[k] || typeof s.days[k] !== "object") { delete s.days[k]; return; }
    cleanDay(s.days[k]);
  });
  s.habits.forEach(h => {
    h.points = clamp(Number(h.points) || 1, 1, 5);
    h.weekly = clamp(Number(h.weekly) || 0, 0, 6);
    h.flex = !!h.flex && !h.weekly;
    h.group = typeof h.group === "string" ? h.group.slice(0, 40) : "";
    h.minutes = clamp(Number(h.minutes) || 0, 0, 240);
    h.time = ["morgens", "tags", "abends"].includes(h.time) ? h.time : "";
    h.days = Array.isArray(h.days) && h.days.length ? h.days : ALL_DAYS.slice();
    h.from = h.from || "2000-01-01";
    h.archived = h.archived || null;
    h.icon = ICONS[h.icon] ? h.icon : "star";
    h.color = COLORS.includes(h.color) ? h.color : "blue";
  });
  return s;
}

/* ---------- Speichern ---------- */
let S;
let hasDisk = true;

function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (isValidState(parsed)) return normalize(parsed);
    }
  } catch (e) { hasDisk = false; }
  return normalize(freshState());
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); hasDisk = true; }
  catch (e) { hasDisk = false; }
  cloudPush();
}

function touchHabits() {
  S.habitsT = Date.now();
  const today = todayKey();
  if (S.days[today]) writeSnap(today);
  persist();
}

function dayOf(k) { return S.days[k] || (S.days[k] = { done: {}, minus: {} }); }
function touchDay(k) { const d = dayOf(k); writeSnap(k); d.t = Date.now(); persist(); }

/* ---------- Synchronisierung im Claude-Artifact ---------- */
const cloud = { on: false, col: null, ready: false, seen: {}, timer: 0, busy: false, failed: false, lost: false };

function renderIdle() {
  const active = document.activeElement;
  if (!sheet && !(active && active.matches("input, textarea"))) render();
}

/* Gleicher Inhalt ergibt immer denselben Text, egal in welcher Reihenfolge der Speicher die Felder liefert. */
function stable(v) {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
  return JSON.stringify(v === undefined ? null : v);
}

function cloudBodies() {
  const out = { habits: { habits: S.habits, settings: S.settings, t: S.habitsT, resetT: S.resetT } };
  Object.keys(S.days).forEach(k => {
    const id = "days-" + k.slice(0, 4);
    (out[id] || (out[id] = { days: {} })).days[k] = S.days[k];
  });
  return out;
}

function applyRemote(docs) {
  let changed = false;
  /* Erst die Habits: Eine eingelesene Sicherung auf einem anderen Gerät macht ältere Tage ungültig. */
  const ordered = docs.slice().sort((a, b) => (b.id === "habits") - (a.id === "habits"));
  ordered.forEach(doc => {
    const data = doc.data && doc.data();
    if (!data) return;
    if (doc.id === "habits") {
      if ((data.resetT || 0) > S.resetT) {
        S.resetT = data.resetT;
        Object.keys(S.days).forEach(k => { if ((S.days[k].t || 0) < S.resetT) delete S.days[k]; });
        changed = true;
      }
      if ((data.t || 0) > S.habitsT && Array.isArray(data.habits)) {
        S.habits = JSON.parse(JSON.stringify(data.habits));
        S.settings = Object.assign({}, DEFAULT_SETTINGS, { weeks: {} }, data.settings);
        S.habitsT = data.t;
        normalize(S);
        changed = true;
      }
    } else if (doc.id.startsWith("days-") && data.days) {
      Object.keys(data.days).forEach(k => {
        const remote = data.days[k], local = S.days[k];
        if ((remote.t || 0) < S.resetT) return;
        if (!local || (remote.t || 0) > (local.t || 0)) {
          S.days[k] = JSON.parse(JSON.stringify(remote));
          cleanDay(S.days[k]);
          changed = true;
        }
      });
    }
    cloud.seen[doc.id] = stable(data);
  });
  return changed;
}

function cloudDirty() {
  const bodies = cloudBodies();
  return Object.keys(bodies).some(id => !(id === "habits" && !S.habitsT) && cloud.seen[id] !== stable(bodies[id]));
}

function cloudPush() {
  if (!cloud.on || !cloud.ready) return;
  clearTimeout(cloud.timer);
  cloud.timer = setTimeout(cloudFlush, 700);
}

async function cloudFlush() {
  if (!cloud.on || !cloud.col) return;
  if (cloud.busy) { cloudPush(); return; }
  cloud.busy = true;
  const wasFailed = cloud.failed;
  try {
    /* Erst den Stand der anderen Geräte holen, dann schreiben. */
    if (cloud.col.poll) await cloud.col.poll();
    if (!cloud.col) throw { auth: true };
    const bodies = cloudBodies();
    for (const id of Object.keys(bodies)) {
      if (id === "habits" && !S.habitsT) continue;
      const text = stable(bodies[id]);
      if (cloud.seen[id] === text) continue;
      await cloud.col.doc(id).set(JSON.parse(JSON.stringify(bodies[id])));
      cloud.seen[id] = text;
    }
    cloud.failed = false;
  } catch (e) {
    if (e && e.auth) { if (cloud.col || session) supaAuthLost(); }
    else if (navigator.onLine === false) cloud.failed = false;
    else { cloud.failed = true; cloud.msg = (e && e.msg) || ""; }
  }
  cloud.busy = false;
  if (cloud.failed !== wasFailed) renderIdle();
}
addEventListener("online", () => cloudPush());

function cloudListen() {
  cloud.lost = false;
  cloud.on = true;
  cloud.col.onSnapshot(snap => {
    const changed = applyRemote(snap.docs);
    if (changed) {
      ensureSnaps();
      try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { hasDisk = false; }
      renderIdle();
    }
    if (!snap.metadata.fromCache) {
      cloud.ready = true;
      if (cloudDirty()) cloudPush();
    }
  }, () => { cloud.on = false; cloud.lost = true; renderIdle(); });
}

async function cloudStart() {
  if (!window.claude || typeof window.claude.use !== "function") {
    if (supaReady()) { cloud.col = supaCollection(); cloudListen(); renderIdle(); }
    return;
  }
  try {
    const [db, user] = await Promise.all([window.claude.use("db"), window.claude.use("user")]);
    if (!db || !user) return;
    const id = await user.id();
    if (!id) return;
    cloud.col = db.collection("data/users/" + id);
    cloudListen();
    renderIdle();
  } catch (e) { cloud.on = false; }
}

/* ---------- Rechnen ---------- */
const scheduled = (h, k) => h.days.includes(dow(k));
const notArchived = (h, k) => !h.archived || h.archived > k;
const isPaused = k => !!(S.days[k] && S.days[k].pause);
const isSkipped = (k, id) => !!(S.days[k] && S.days[k].skip && S.days[k].skip[id]);

/* Vergangene Tage behalten ihren Plan und ihre Punkte. Spätere Änderungen an Habits schreiben sie nicht um. */
const snapOf = k => (k !== todayKey() && S.days[k] && S.days[k].snap) || null;
const plusPoints = (h, k) => {
  const s = snapOf(k);
  if (s && h.id in s.p) return s.p[h.id];
  if (s && s.b && h.id in s.b) return s.b[h.id];
  return h.points;
};
/* Bonus-Habits (Sport, große Projekte): Sie geben Punkte, wenn du sie machst, und kosten nichts, wenn nicht. */
const isBonus = h => h.weekly > 0 || h.flex;
const minusPoints = (h, k) => { const s = snapOf(k); return s && s.m && h.id in s.m ? s.m[h.id] : h.points; };

const isDone = (k, id) => !!(S.days[k] && S.days[k].done && S.days[k].done[id]);

function plusShown(k) {
  const s = snapOf(k);
  if (s) return S.habits.filter(h => h.type === "plus" && (h.id in s.p || (s.b && h.id in s.b) || (isBonus(h) && h.from <= k && notArchived(h, k))));
  return S.habits.filter(h => h.type === "plus" && notArchived(h, k) && (isBonus(h) || scheduled(h, k)));
}
/* plusCounted sind die Pflicht-Habits eines Tages. Nur sie bilden die 10 Punkte des Tagesplans. */
function countsOn(h, k) {
  if (isSkipped(k, h.id) || isBonus(h)) return false;
  return !!snapOf(k) || h.from <= k;
}
const plusCounted = k => plusShown(k).filter(h => countsOn(h, k));
const bonusDone = k => plusShown(k).filter(h => isBonus(h) && isDone(k, h.id));

/* Entweder-oder: Habits einer Gruppe teilen sich einen Platz im Tagesplan. Eines davon reicht. */
const groupOf = (h, k) => { const s = snapOf(k); return s && s.o ? s.o[h.id] || "" : h.group; };
const groupPeers = (h, k) => {
  const g = groupOf(h, k);
  return g ? S.habits.filter(x => x.id !== h.id && groupOf(x, k) === g) : [];
};
const slotDone = (h, k) => isDone(k, h.id) || groupPeers(h, k).some(x => isDone(k, x.id));
const minusShown = k => S.habits.filter(h => h.type === "minus" && notArchived(h, k));

function plannedOn(h, k) {
  if (isBonus(h)) return false;
  const s = snapOf(k);
  if (s) return h.id in s.p;
  return h.from <= k && scheduled(h, k) && notArchived(h, k);
}

function weekCount(h, k) {
  const mon = mondayOf(k);
  let n = 0;
  for (let i = 0; i < 7; i++) if (isDone(addDays(mon, i), h.id)) n++;
  return n;
}

/* Pausentage senken das Wochenziel anteilig. */
function weekTarget(h, k) {
  const mon = mondayOf(k);
  let paused = 0;
  for (let i = 0; i < 7; i++) if (isPaused(addDays(mon, i))) paused++;
  return Math.max(0, h.weekly - Math.floor(paused * h.weekly / 7));
}

function writeSnap(k) {
  const d = S.days[k];
  if (!d) return;
  if (!hasEntry(k)) { delete d.snap; return; }
  const isToday = k === todayKey();
  const old = (!isToday && d.snap) || { p: {}, m: {} };
  const p = Object.assign({}, old.p), m = {}, b = {};
  plusShown(k).filter(h => h.from <= k && !isBonus(h)).forEach(h => { if (!(h.id in p)) p[h.id] = h.points; });
  S.habits.filter(h => isBonus(h)).forEach(h => {
    delete p[h.id];
    if (isDone(k, h.id)) b[h.id] = old.b && h.id in old.b ? old.b[h.id] : h.points;
  });
  const o = Object.assign({}, old.o);
  S.habits.forEach(h => { if (h.group && !(h.id in o)) o[h.id] = h.group; });
  S.habits.filter(h => h.type === "minus" && d.minus && d.minus[h.id] > 0)
    .forEach(h => { m[h.id] = h.id in (old.m || {}) ? old.m[h.id] : h.points; });
  d.snap = { p, m, b, o };
}

function ensureSnaps() {
  const today = todayKey();
  const moveOld = !S.settings.bonusSnapFixed;
  S.settings.bonusSnapFixed = true;
  Object.keys(S.days).forEach(k => {
    const d = S.days[k];
    if (moveOld && k < today && d.snap) {
      /* Alte Tage: Wochen-Habits aus dem Pflichtplan in den Bonus verschieben. */
      S.habits.filter(h => isBonus(h) && h.id in d.snap.p).forEach(h => {
        d.snap.b = d.snap.b || {};
        if (isDone(k, h.id)) d.snap.b[h.id] = d.snap.p[h.id];
        delete d.snap.p[h.id];
      });
    }
    if (k < today && !d.snap && hasEntry(k)) writeSnap(k);
  });
  migrateRhythm();
}

/* Einmalig: Sport und Ähnliches aus der Bibliothek war als tägliche Pflicht angelegt. */
function migrateRhythm() {
  if (S.settings.rhythmFixed) return;
  S.settings.rhythmFixed = true;
  S.habits.forEach(h => {
    const r = h.type === "plus" && !isBonus(h) && h.from !== "2000-01-01" ? libraryRhythm(h.name) : 0;
    if (r === "f") h.flex = true;
    else if (r) h.weekly = r;
    if (r) { h.days = ALL_DAYS.slice(); S.habitsT = Date.now(); }
  });
}

function hasEntry(k) {
  const d = S.days[k];
  if (!d) return false;
  return !!d.ai || Object.values(d.done || {}).some(Boolean) || Object.values(d.minus || {}).some(v => v > 0);
}

function calc(k) {
  const d = S.days[k] || { done: {}, minus: {} };
  const plan = plusCounted(k);
  let possible = 0, core = 0;
  const slots = {};
  plan.forEach(h => {
    const pts = plusPoints(h, k), g = groupOf(h, k);
    if (!g) { possible += pts; if (isDone(k, h.id)) core += pts; return; }
    const slot = slots[g] || (slots[g] = { max: 0, done: false });
    slot.max = Math.max(slot.max, pts);
    slot.done = slot.done || isDone(k, h.id);
  });
  Object.values(slots).forEach(s => { possible += s.max; if (s.done) core += s.max; });
  const bonus = bonusDone(k).reduce((a, h) => a + plusPoints(h, k), 0);
  const earned = core + bonus;
  const minus = S.habits.filter(h => h.type === "minus")
    .reduce((a, h) => a + minusPoints(h, k) * ((d.minus && d.minus[h.id]) || 0), 0);
  let habitScore = null;
  if (hasEntry(k) && !isPaused(k)) {
    const base = possible ? 1 + 9 * earned / possible : 10;
    habitScore = Math.round(clamp(base - MINUS_STEP * minus, 1, 10) * 10) / 10;
  }
  /* Hat die KI den Tag bewertet, zählt ihre feste Note. Sonst der Wert aus den Habits. */
  const aiScore = !isPaused(k) && d.ai ? d.ai.score : null;
  const score = aiScore !== null ? aiScore : habitScore;
  return { possible, earned, core, bonus, minus, score, habitScore, aiScore };
}

const tier = s => s === null ? "" : s < 4 ? "t1" : s < 6 ? "t2" : s < 8 ? "t3" : "t4";
const dayClass = (k, score) => isPaused(k) ? "is-pause" : tier(score);

function missedDay(k, first) {
  return !!first && k >= first && k < todayKey() && !isPaused(k) && !hasEntry(k) && plusCounted(k).length > 0;
}

function firstDay() {
  let first = null;
  Object.keys(S.days).forEach(k => { if (hasEntry(k) && (!first || k < first)) first = k; });
  return first;
}

function streak() {
  const first = firstDay();
  if (!first) return 0;
  const thr = S.settings.threshold;
  const today = todayKey();
  /* Regel "nie zweimal in Folge": Erst der zweite Fehltag hintereinander beendet die Serie. */
  let n = 0, missed = false;
  for (let k = today; k >= first; k = addDays(k, -1)) {
    if (isPaused(k)) continue;
    const s = calc(k).score;
    if (s === null && !plusCounted(k).length) continue;
    if (s !== null && s >= thr) { n++; missed = false; }
    else if (k !== today) {
      if (missed) break;
      missed = true;
    }
  }
  return n;
}

function yesterdayMissed() {
  const k = addDays(todayKey(), -1);
  const first = firstDay();
  if (!first || k < first || isPaused(k)) return false;
  const s = calc(k).score;
  return s === null ? plusCounted(k).length > 0 : s < S.settings.threshold;
}

function habitStreak(h) {
  const start = firstDay();
  if (!start || h.flex) return 0;
  const today = todayKey();
  let n = 0, missed = false;
  if (h.weekly) {
    const current = mondayOf(today);
    for (let mon = current; mon >= mondayOf(start); mon = addDays(mon, -7)) {
      const target = weekTarget(h, mon);
      if (!target) continue;
      if (weekCount(h, mon) >= target) { n++; missed = false; }
      else if (mon !== current) {
        if (missed) break;
        missed = true;
      }
    }
    return n;
  }
  let k = today;
  for (let i = 0; i < 1500 && k >= start; i++, k = addDays(k, -1)) {
    if (isPaused(k) || isSkipped(k, h.id) || !plannedOn(h, k)) continue;
    if (slotDone(h, k)) { n++; missed = false; }
    else if (k !== today) {
      if (missed) break;
      missed = true;
    }
  }
  return n;
}

function daysFree(h) {
  const start = firstDay();
  if (!start) return 0;
  let k = todayKey(), n = 0;
  while (k >= start) {
    if (S.days[k] && S.days[k].minus && S.days[k].minus[h.id] > 0) return n;
    n++;
    k = addDays(k, -1);
  }
  return n;
}

function rangeDays(n) {
  const today = todayKey();
  return Array.from({ length: n }, (_, i) => addDays(today, i - n + 1));
}

function constancy(h, keys) {
  const start = firstDay();
  const today = todayKey();
  let planned = 0, done = 0;
  if (!start || h.flex) return { planned, done };
  if (h.weekly) {
    const current = mondayOf(today);
    [...new Set(keys.map(mondayOf))].filter(m => m >= mondayOf(start) && m >= mondayOf(h.from)).forEach(m => {
      const target = weekTarget(h, m), count = weekCount(h, m);
      const reached = Math.min(count, target);
      planned += m === current ? reached : target;
      done += reached;
    });
    return { planned, done };
  }
  keys.forEach(k => {
    if (k < start || isPaused(k) || isSkipped(k, h.id) || !plannedOn(h, k)) return;
    const did = slotDone(h, k);
    if (k === today && !did) return;
    planned++;
    if (did) done++;
  });
  return { planned, done };
}

/* ---------- Bilder ---------- */
const ICONS = {
  bed: '<path d="M3 6.5a1.5 1.5 0 0 1 3 0V12h15a1 1 0 0 1 1 1v5.5a1.5 1.5 0 0 1-3 0V17H6v1.5a1.5 1.5 0 0 1-3 0z"/><rect x="7" y="7.5" width="6" height="3.5" rx="1.75"/><path d="M14.5 7.5H18a3 3 0 0 1 3 3v.5h-6.5z"/>',
  book: '<path d="M11 6.2C9.3 4.9 6.9 4.2 3.9 4.2a1 1 0 0 0-1 1v12.6a1 1 0 0 0 1 1c2.9 0 5.3.6 7.1 1.9zM13 6.2c1.7-1.3 4.1-2 7.1-2a1 1 0 0 1 1 1v12.6a1 1 0 0 1-1 1c-2.9 0-5.3.6-7.1 1.9z"/>',
  walk: '<circle cx="13.5" cy="4.5" r="2.5"/><path d="M11.2 8.1a2 2 0 0 1 2.6.3l1.9 2.3 2.6.9a1.3 1.3 0 1 1-.9 2.5l-3-1-.2-.1-.7 3 2.3 2.2c.2.2.3.4.4.7l.8 3.2a1.3 1.3 0 0 1-2.5.6l-.7-2.9-3.3-3-1.1 3.2-.3.5-2.6 2.6a1.3 1.3 0 1 1-1.8-1.8l2.4-2.4 2.2-7.2-1.5.9-1 2.4a1.3 1.3 0 1 1-2.4-1l1.2-2.8.5-.6z"/>',
  speech: '<path d="M5 3.5h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-6.6l-4.6 3.3a1 1 0 0 1-1.6-.8v-2.5H5a3 3 0 0 1-3-3v-8a3 3 0 0 1 3-3z"/>',
  work: '<path d="M9 3h6a2 2 0 0 1 2 2v1.5h3a2 2 0 0 1 2 2v3.2l-8.500 2v-1a1 1 0 0 0-1-1h-1a1 1 0 0 0-1 1v1L2 11.700V8.500a2 2 0 0 1 2-2h3V5a2 2 0 0 1 2-2zm.2 2.200v1.300h5.600V5.200z"/><path d="M2 13.700l8.500 2v.8a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-.8l8.500-2V19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"/>',
  dumbbell: '<rect x="1.5" y="9" width="3" height="6" rx="1.2"/><rect x="5" y="6" width="4" height="12" rx="1.4"/><rect x="9" y="10.5" width="6" height="3"/><rect x="15" y="6" width="4" height="12" rx="1.4"/><rect x="19.5" y="9" width="3" height="6" rx="1.2"/>',
  drop: '<path d="M12 2.300c.3 0 .6.1.8.4 3.500 4.300 6.700 8 6.700 11.800a7.500 7.500 0 0 1-15 0c0-3.800 3.200-7.500 6.700-11.800.2-.3.5-.4.8-.4z"/>',
  moon: '<path d="M20.600 14.600a1 1 0 0 1 .3 1.100A9.600 9.600 0 1 1 9.100 3.100a1 1 0 0 1 1.200 1.300 7.600 7.600 0 0 0 9.300 9.300 1 1 0 0 1 1 .9z"/>',
  sun: '<circle cx="12" cy="12" r="5.200"/><g stroke="currentColor" stroke-width="2.400" stroke-linecap="round"><path d="M12 2.400v2M12 19.600v2M2.400 12h2M19.600 12h2M5.200 5.200l1.400 1.400M17.400 17.400l1.400 1.400M5.200 18.800l1.400-1.400M17.400 6.600l1.400-1.400"/></g>',
  star: '<path d="M12 2.600c.4 0 .8.2 1 .6l2.600 5.400 5.900.8c.9.1 1.300 1.300.6 1.900l-4.300 4.100 1 5.900c.2.9-.8 1.600-1.600 1.200L12 20l-5.200 2.800c-.8.4-1.800-.3-1.600-1.200l1-5.900-4.300-4.100c-.7-.6-.3-1.800.6-1.900l5.900-.8L11 3.200c.2-.4.6-.6 1-.6z"/>',
  heart: '<path d="M12 21.200a1.300 1.300 0 0 1-.8-.3C5.700 16.500 2 13 2 8.700a5.400 5.400 0 0 1 5.400-5.400c1.800 0 3.500.9 4.600 2.300a5.700 5.700 0 0 1 4.600-2.300A5.400 5.400 0 0 1 22 8.700c0 4.300-3.700 7.800-9.200 12.200a1.300 1.300 0 0 1-.8.3z"/>',
  pen: '<path d="M16.200 3.200a2.700 2.700 0 0 1 3.800 0l.8.8a2.700 2.700 0 0 1 0 3.800L18.700 9.900l-4.600-4.600zM12.700 6.700l4.600 4.600L7.200 21.400a2 2 0 0 1-.9.5l-3.900 1a1 1 0 0 1-1.200-1.200l1-3.900a2 2 0 0 1 .5-.9z"/>',
  music: '<path d="M9 5.300a1.300 1.300 0 0 1 1-1.300l9.500-2A1.300 1.300 0 0 1 21 3.300V16a3.500 3.500 0 1 1-2.500-3.300V7.200l-7 1.500v9.800A3.500 3.500 0 1 1 9 15.200z"/>',
  code: '<path fill-rule="evenodd" d="M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm6.300 6.700a1.100 1.100 0 0 0-1.600-1.500l-3 3a1.100 1.100 0 0 0 0 1.600l3 3a1.100 1.100 0 0 0 1.600-1.600L8 12zm3.400-1.500a1.100 1.100 0 0 0 0 1.500L16 12l-2.300 2.200a1.100 1.100 0 0 0 1.600 1.600l3-3a1.100 1.100 0 0 0 0-1.600l-3-3a1.100 1.100 0 0 0-1.600 0z"/>',
  cook: '<path d="M3 11h18v6.500a3.500 3.500 0 0 1-3.500 3.500h-11A3.500 3.500 0 0 1 3 17.500z"/><rect x="1" y="8" width="22" height="2.400" rx="1.200"/><path d="M12 3a1.200 1.200 0 0 1 1.200 1.200v1.400h1.300a1.200 1.200 0 0 1 0 2.400h-5a1.200 1.200 0 0 1 0-2.400h1.300V4.200A1.200 1.200 0 0 1 12 3z"/>',
  idea: '<path d="M12 2a7.500 7.500 0 0 1 4.700 13.300c-.8.700-1.200 1.400-1.200 2.200h-7c0-.8-.4-1.500-1.200-2.200A7.500 7.500 0 0 1 12 2z"/><rect x="8.700" y="18.800" width="6.600" height="3.200" rx="1.600"/>',
  phone: '<path fill-rule="evenodd" d="M8 1.500h8a3 3 0 0 1 3 3v15a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-15a3 3 0 0 1 3-3zm4 16.800a1.400 1.400 0 1 0 0 2.800 1.400 1.400 0 0 0 0-2.800z"/>',
  burger: '<path d="M3 10.500C3 6.300 7 3.500 12 3.500s9 2.800 9 7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><rect x="2" y="13" width="20" height="3" rx="1.500"/><path d="M3.500 17.500h17v.5a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3z"/>',
  stop: '<path fill-rule="evenodd" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zM6.100 8.400a7 7 0 0 0 9.500 9.500zM8.400 6.100l9.500 9.500a7 7 0 0 0-9.500-9.500z"/>',
  flame: '<path d="M12.800 1.800c.1 3-1.400 4.700-3 6.400-.5-.7-.8-1.500-.9-2.400-2.900 2-4.900 5-4.900 8.400A8 8 0 0 0 12 22a8 8 0 0 0 8-7.800c0-5-3.300-9.300-7.200-12.400z"/>'
};
const ICON_ORDER = ["star", "bed", "book", "walk", "speech", "work", "dumbbell", "drop", "sun", "moon", "heart", "pen", "music", "code", "cook", "idea", "phone", "burger", "stop", "flame"];
const iconSvg = n => `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${ICONS[n] || ICONS.star}</svg>`;
const ico = (h, small) => `<span class="ico ${small ? "small " : ""}c-${h.color}">${iconSvg(h.icon)}</span>`;

const chevron = dir => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${{ left: "M10 2.500 4.500 8l5.500 5.500", right: "M6 2.500 11.500 8 6 13.500", up: "M2.500 10.500 8 5l5.500 5.500", down: "M2.500 5.500 8 11l5.500-5.500" }[dir]}"/></svg>`;
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.500 10 17.500 19.500 7"/></svg>';
const LOGO = '<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="10" fill="#58cc02"/><circle cx="16" cy="16" r="10" fill="#ffce00"/><path d="M11 16.500l3.600 3.600 6.600-7.400" fill="none" stroke="#2d2c2b" stroke-width="3.400" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* Eigene Figur: eine kleine Sonne, die mit dem Tag mitgeht. */
function mascot(score) {
  let eyes, mouth;
  const eye = (x, y) => `<circle cx="${x}" cy="${y}" r="5" fill="#2d2c2b"/><circle cx="${x + 1.6}" cy="${y - 1.8}" r="1.7" fill="#fff"/>`;
  if (score === null) {
    eyes = `<path d="M36 52q6 5 12 0M64 52q6 5 12 0" fill="none" stroke="#2d2c2b" stroke-width="4" stroke-linecap="round"/>`;
    mouth = `<ellipse cx="56" cy="69" rx="4" ry="3" fill="#2d2c2b"/>`;
  } else if (score >= 8) {
    eyes = `<path d="M35 54q7-9 14 0M63 54q7-9 14 0" fill="none" stroke="#2d2c2b" stroke-width="4.500" stroke-linecap="round"/>`;
    mouth = `<path d="M40 63h32a16 16 0 0 1-32 0z" fill="#2d2c2b"/>`;
  } else if (score >= 6) {
    eyes = eye(42, 52) + eye(70, 52);
    mouth = `<path d="M44 66q12 11 24 0" fill="none" stroke="#2d2c2b" stroke-width="4.500" stroke-linecap="round"/>`;
  } else if (score >= 4) {
    eyes = eye(42, 52) + eye(70, 52);
    mouth = `<path d="M46 70h20" fill="none" stroke="#2d2c2b" stroke-width="4.500" stroke-linecap="round"/>`;
  } else {
    eyes = eye(42, 54) + eye(70, 54);
    mouth = `<path d="M45 74q11-10 22 0" fill="none" stroke="#2d2c2b" stroke-width="4.500" stroke-linecap="round"/>`;
  }
  const rays = Array.from({ length: 10 }, (_, i) => {
    const a = i * Math.PI / 5;
    return `<circle cx="${(56 + Math.cos(a) * 45).toFixed(1)}" cy="${(56 + Math.sin(a) * 45).toFixed(1)}" r="8" fill="#f47d31"/>`;
  }).join("");
  return `<svg class="mascot" viewBox="0 0 112 112" aria-hidden="true">${rays}<circle cx="56" cy="56" r="42" fill="#f47d31"/><circle cx="56" cy="56" r="33" fill="#ffb066" opacity=".55"/>${eyes}${mouth}<ellipse cx="31" cy="65" rx="6" ry="4" fill="#ff8fb9" opacity=".8"/><ellipse cx="81" cy="65" rx="6" ry="4" fill="#ff8fb9" opacity=".8"/></svg>`;
}

/* ---------- Ansichtszustand ---------- */
const V = { tab: "heute", day: todayKey(), range: 7, pick: null, month: todayKey().slice(0, 7), popId: null, popHero: false, skipMode: false };
let sheet = null;
const app = document.getElementById("app");

function heroMessage(k, c, allDone) {
  const isToday = k === todayKey();
  if (allDone) return isToday ? "Alles geschafft." : "Alles geschafft an dem Tag.";
  if (c.score === null) return isToday ? "Der Tag ist noch offen." : "Noch nichts eingetragen.";
  if (c.score >= 8) return "Starker Tag.";
  if (c.score >= 6) return "Läuft gut.";
  if (c.score >= 4) return "Da geht noch was.";
  return isToday ? "Noch ist Zeit." : "Morgen neu anfangen.";
}

/* ---------- Heute ---------- */
function weekStrip(k) {
  const mon = mondayOf(k);
  const today = todayKey();
  const days = Array.from({ length: 7 }, (_, i) => addDays(mon, i));
  const canNext = addDays(mon, 7) <= today;
  return `<nav class="week" aria-label="Woche">
    <button class="week-nav" data-a="week" data-n="-7" aria-label="Woche davor">${chevron("left")}</button>
    ${days.map(d => {
      const c = calc(d);
      return `<button class="day ${d === k ? "is-sel" : ""}" data-a="goDay" data-k="${d}" ${d > today ? "disabled" : ""} ${d === today ? 'aria-current="date"' : ""}
        aria-label="${shortDate(d)}${c.score === null ? "" : ", Tageswert " + fmt(c.score)}">
        ${WD[dow(d)]}<b class="${dayClass(d, c.score)}">${parseKey(d).getDate()}</b></button>`;
    }).join("")}
    <button class="week-nav" data-a="week" data-n="7" ${canNext ? "" : "disabled"} aria-label="Woche danach">${chevron("right")}</button>
  </nav>`;
}

function plusRow(h, k) {
  const done = !!(S.days[k] && S.days[k].done && S.days[k].done[h.id]);
  const skipped = isSkipped(k, h.id);
  const st = habitStreak(h);
  const pts = plusPoints(h, k);
  const week = h.weekly ? `${weekCount(h, k)} von ${weekTarget(h, k)} diese Woche · +${pts}` : h.flex ? `Bonus +${pts}` : "";
  const flow = h.weekly ? (st >= 2 ? ` · ${st} Wochen` : "") : (st >= 2 ? ` · ${st} in Folge` : "");
  const peers = groupPeers(h, k);
  const altDone = !done && peers.find(x => isDone(k, x.id));
  const orText = peers.length ? ` · oder ${peers.map(x => esc(x.name)).join(", ")}` : "";
  const sub = skipped ? "Frei, zählt nicht" : altDone ? `Erledigt durch ${esc(altDone.name)}` : `${week || `+${pts} ${pts === 1 ? "Punkt" : "Punkte"}`}${flow}${orText}`;
  const cls = `row ${done ? "is-done" : ""} ${altDone ? "is-alt" : ""} ${skipped ? "is-skip" : ""} ${V.popId === h.id ? "is-pop" : ""}`;
  const main = `${ico(h)}<span class="row-main"><span class="row-name">${esc(h.name)}</span><span class="row-sub">${sub}</span></span>`;
  const mins = (S.days[k] && S.days[k].mins && S.days[k].mins[h.id]) || 0;
  if (done && h.minutes && !V.skipMode) {
    return `<div class="${cls}">
      <button class="row-open" data-a="toggle" data-id="${h.id}" role="checkbox" aria-checked="true">${main}</button>
      <button class="pill mins" data-a="minsEdit" data-id="${h.id}" aria-label="Minuten für ${esc(h.name)} ändern">${mins} Min</button>
      <span class="check">${CHECK}</span>
    </div>`;
  }
  return `<button class="${cls}" data-a="${V.skipMode ? "skip" : "toggle"}" data-id="${h.id}" role="checkbox" aria-checked="${done}">
    ${main}
    <span class="check">${skipped ? "–" : CHECK}</span>
  </button>`;
}

function minusRow(h, k) {
  const n = (S.days[k] && S.days[k].minus && S.days[k].minus[h.id]) || 0;
  const free = daysFree(h);
  const pts = minusPoints(h, k);
  const total = n * pts;
  const sub = n ? `−${total} ${total === 1 ? "Punkt" : "Punkte"}` : free >= 2 ? `−${pts} je Mal · ${free} Tage frei` : `−${pts} je Mal`;
  return `<div class="row ${n ? "is-minus" : ""} ${V.popId === h.id ? "is-pop" : ""}">
    ${ico(h)}
    <span class="row-main"><span class="row-name">${esc(h.name)}</span><span class="row-sub">${sub}</span></span>
    <span class="stepper">
      ${n ? `<button class="step" data-a="minus" data-id="${h.id}" data-n="-1" aria-label="${esc(h.name)}: eins weniger">−</button><span class="count">${n}</span>` : ""}
      <button class="step is-add" data-a="minus" data-id="${h.id}" data-n="1" aria-label="${esc(h.name)} eintragen">+</button>
    </span>
  </div>`;
}

function viewToday() {
  const k = V.day;
  const today = todayKey();
  const isToday = k === today;
  const c = calc(k);
  const plus = plusShown(k);
  const minus = minusShown(k);
  const d = S.days[k] || {};
  const allDone = isAllDone(k);
  const pct = c.score === null ? 0 : (c.score - 1) / 9 * 100;
  const st = streak();
  const coreList = plus.filter(h => !isBonus(h));
  const bonusList = plus.filter(isBonus);
  const slotKey = h => groupOf(h, k) || h.id;
  const active = coreList.filter(h => !isSkipped(k, h.id));
  const slotTotal = new Set(active.map(slotKey)).size;
  const doneShown = new Set(active.filter(h => slotDone(h, k)).map(slotKey)).size;
  const groups = [["morgens", "Morgens"], ["tags", "Tagsüber"], ["abends", "Abends"], ["", "Jederzeit"]];
  const grouped = coreList.some(h => h.time);
  const planHtml = grouped
    ? groups.map(([id, label]) => {
        const rows = coreList.filter(h => h.time === id);
        return rows.length ? `<h3 class="group-label">${label}</h3>${rows.map(h => plusRow(h, k)).join("")}` : "";
      }).join("")
    : coreList.map(h => plusRow(h, k)).join("");
  const bonusHtml = bonusList.length ? `<details class="fold" ${bonusList.some(h => isDone(k, h.id)) ? "open" : ""}>
      <summary>Bonus, wenn es passt</summary>
      <div class="list">${bonusList.map(h => plusRow(h, k)).join("")}</div>
    </details>` : "";
  const now = new Date();
  const evening = !isToday || now.getHours() >= 18 || now.getHours() < S.settings.dayStart;
  const goal = S.settings.weeks[mondayOf(k)];
  const sundayTip = isToday && dow(k) === 0 ? `<button class="add" data-a="tab" data-tab="verlauf">Zeit für deinen Wochenrückblick</button>` : "";
  const missedTip = isToday && !isPaused(k) && yesterdayMissed() && (c.score === null || c.score < S.settings.threshold)
    ? `<p class="section-note" style="margin:0">Gestern ist ausgefallen. Das ist okay. Wichtig ist nur: nicht zweimal in Folge.</p>` : "";
  const r = d.rating || 0;
  const paused = isPaused(k);

  const hero = paused ? `<section class="hero is-paused" aria-label="Pause">
      <div>
        <div class="eyebrow">Pause</div>
        <div class="hero-word">${esc(PAUSE_REASONS[d.pause] || "Pause")}</div>
        <div class="hero-msg">Dieser Tag zählt nicht gegen dich. Deine Serie bleibt.</div>
      </div>
      ${mascot(null)}
      <div class="hero-bar"><button class="btn is-small" data-a="endPause">Pause beenden</button></div>
    </section>` : `<section class="hero ${allDone ? "is-done" : ""} ${V.popHero ? "is-pop" : ""}" id="hero" aria-label="Tageswert">
      <div>
        <div class="eyebrow">${c.aiScore !== null ? "KI-Wert" : "Tageswert"}</div>
        ${c.score === null ? `<div class="hero-word">Offen</div>` : `<div class="hero-score">${fmt(c.score)}<small>/10</small></div>`}
        <div class="hero-msg">${heroMessage(k, c, allDone)}</div>
      </div>
      ${mascot(c.score)}
      <div class="hero-bar">
        <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="Fortschritt"><i style="width:${pct}%"></i></div>
        <div class="hero-points"><span>+${c.core} von ${c.possible}</span>${c.aiScore !== null && c.habitScore !== null ? `<span>Habits ${fmt(c.habitScore)}</span>` : ""}${c.bonus ? `<span>+${c.bonus} Bonus</span>` : ""}${c.minus ? `<span>−${c.minus} Minus</span>` : ""}</div>
      </div>
    </section>`;

  const lists = paused ? "" : `<section class="section">
      <div class="section-head"><h2>${isToday ? "Das steht an" : "Das stand an"}</h2>
        <div class="section-tools"><span>${doneShown} von ${slotTotal}</span><button class="link" data-a="skipMode">${V.skipMode ? "Fertig" : "Frei nehmen"}</button></div></div>
      ${V.skipMode ? `<p class="section-note">Tippe auf alles, was an diesem Tag nicht zählen soll.</p>` : ""}
      <div class="list">
        ${planHtml || `<p class="hint">Für diesen Tag ist nichts geplant.</p>`}
        <button class="add" data-a="newHabit" data-type="plus">+ Habit hinzufügen</button>
      </div>
    </section>

    ${bonusHtml}

    <section class="section">
      <div class="section-head"><h2>Minuspunkte</h2><span>${c.minus ? "−" + c.minus : "0"}</span></div>
      <div class="list">
        ${minus.map(h => minusRow(h, k)).join("")}
        <button class="add" data-a="newHabit" data-type="minus">+ Minuspunkt hinzufügen</button>
      </div>
    </section>`;

  const reflect = reflectCard(k, isToday, d, r);

  return `<div class="page">
    <header class="top">
      <div class="brand">${LOGO}Stetig</div>
      <div class="top-actions">
        ${isToday ? "" : `<button class="chip is-today" data-a="goDay" data-k="${today}">Heute</button>`}
        ${paused ? "" : `<button class="chip" data-a="askPause">Pause</button>`}
        <span class="chip" title="Tage in Folge mit Tageswert ab ${S.settings.threshold}" aria-label="${st} Tage in Folge"><span style="color:var(--orange)">${iconSvg("flame")}</span>${st}</span>
      </div>
    </header>

    <div class="headline">
      <h1>${isToday ? "Heute" : WD_LONG[dow(k)]}</h1>
      <p>${isToday ? WD_LONG[dow(k)] + ", " : ""}${longDate(k)}</p>
    </div>

    ${weekStrip(k)}

    ${hero}
    ${missedTip}
    ${goal ? `<div class="goal"><span class="eyebrow">Vorsatz dieser Woche</span><p>${esc(goal)}</p></div>` : ""}
    ${sundayTip}

    ${evening ? reflect + lists : lists + reflect}
  </div>`;
}

function reflectCard(k, isToday, d, r) {
  return `<section class="reflect" aria-label="Tagesfazit">
      <div class="reflect-head">
        <div><h2>Dein Fazit</h2><p>Wie war ${isToday ? "dein Tag" : "der Tag"} von 1 bis 10?</p></div>
        <svg class="reflect-moon" viewBox="0 0 54 54" aria-hidden="true"><path d="M42 34A19 19 0 1 1 22 8a15 15 0 0 0 20 26z" fill="#ffce00"/><circle cx="42" cy="13" r="2.500" fill="#d9cdf7"/><circle cx="33" cy="22" r="1.600" fill="#d9cdf7"/><circle cx="49" cy="24" r="1.600" fill="#d9cdf7"/></svg>
      </div>
      <div class="scale" role="group" aria-label="Fazit von 1 bis 10">
        ${Array.from({ length: 10 }, (_, i) => `<button data-a="rate" data-n="${i + 1}" aria-pressed="${r === i + 1}">${i + 1}</button>`).join("")}
      </div>
      <div>
        <label for="note">Notiz zum Tag</label>
        <textarea class="note" id="note" maxlength="500" placeholder="Was lief gut? Was machst du morgen anders?">${esc(d.note || "")}</textarea>
      </div>
      ${aiDayCard(k, d)}
    </section>`;
}

/* ---------- Verlauf ---------- */
function chart(keys) {
  const thr = S.settings.threshold;
  const bar = k => {
    const c = calc(k);
    const rating = S.days[k] && S.days[k].rating;
    const label = `${shortDate(k)}: ${isPaused(k) ? "Pause" : c.score === null ? "kein Eintrag" : "Tageswert " + fmt(c.score)}${rating ? ", Fazit " + rating : ""}`;
    return `<button data-a="pick" data-k="${k}" class="${V.pick === k ? "is-sel" : ""}" aria-label="${label}" title="${label}">
      <i class="${c.score === null ? "is-empty" : ""} ${isPaused(k) ? "is-pause-bar" : ""}" style="height:${c.score === null ? 4 : c.score * 10}%"></i>
      ${rating ? `<u style="bottom:${rating * 10}%"></u>` : ""}
    </button>`;
  };
  const pick = V.pick && keys.includes(V.pick) ? V.pick : null;
  const pc = pick ? calc(pick) : null;
  const pr = pick && S.days[pick] && S.days[pick].rating;
  return `<div class="chart" role="group" aria-label="Tageswert je Tag">
      <div class="chart-line" style="top:0"><em>10</em></div>
      <div class="chart-line is-thr" style="top:${100 - thr * 10}%"><em>${thr}</em></div>
      <div class="chart-line" style="top:100%"><em>0</em></div>
      <div class="bars ${keys.length > 14 ? "is-dense" : ""}">${keys.map(bar).join("")}</div>
    </div>
    <div class="chart-x"><span>${shortDate(keys[0])}</span><span>Heute</span></div>
    <div class="legend"><span><i></i>Tageswert</span><span><i class="is-dot"></i>Dein Fazit</span><span>Gestrichelt: Serie ab ${thr}</span></div>
    ${pick ? `<div class="pick"><span><b>${shortDate(pick)}</b> · ${isPaused(pick) ? "Pause" : pc.score === null ? "kein Eintrag" : "Wert " + fmt(pc.score)}${pr ? " · Fazit " + pr : ""}</span><button class="link" data-a="openDay" data-k="${pick}">Tag öffnen</button></div>` : ""}`;
}

function calendar() {
  const [y, m] = V.month.split("-").map(Number);
  const count = new Date(y, m, 0).getDate();
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const today = todayKey();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push("<div></div>");
  for (let d = 1; d <= count; d++) {
    const k = `${y}-${pad(m)}-${pad(d)}`;
    const c = calc(k);
    cells.push(`<button class="${dayClass(k, c.score)} ${k === today ? "is-today" : ""}" data-a="openDay" data-k="${k}" ${k > today ? "disabled" : ""} aria-label="${shortDate(k)}${isPaused(k) ? ", Pause" : c.score === null ? ", kein Eintrag" : ", Tageswert " + fmt(c.score)}">${d}</button>`);
  }
  const canNext = V.month < today.slice(0, 7);
  return `<section class="panel">
    <div class="panel-head"><h3>${MONTHS[m - 1]} ${y}</h3>
      <div class="month-nav"><button data-a="month" data-n="-1" aria-label="Monat davor">${chevron("left")}</button><button data-a="month" data-n="1" ${canNext ? "" : "disabled"} aria-label="Monat danach">${chevron("right")}</button></div>
    </div>
    <div class="cal">${MON_FIRST.map(i => `<small>${WD[i]}</small>`).join("")}${cells.join("")}</div>
    <div class="ramp"><span>Tageswert 1</span><i class="t1"></i><i class="t2"></i><i class="t3"></i><i class="t4"></i><span>10</span><i class="is-pause" style="margin-left:10px"></i><span>Pause</span></div>
  </section>`;
}

function viewHistory() {
  const keys = rangeDays(V.range);
  const prev = rangeDays(V.range * 2).slice(0, V.range);
  const first = firstDay();
  const scores = [];
  let missed = 0, pausedDays = 0;
  keys.forEach(k => {
    const s = calc(k).score;
    if (isPaused(k)) { if (first && k >= first && k <= todayKey()) pausedDays++; }
    else if (s !== null) scores.push(s);
    else if (missedDay(k, first)) { scores.push(1); missed++; }
  });
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const avgNote = [
    missed ? `${missed} ${missed === 1 ? "Tag" : "Tage"} ohne Eintrag ${missed === 1 ? "zählt" : "zählen"} als 1,0.` : "",
    pausedDays ? `${pausedDays} ${pausedDays === 1 ? "Pausentag zählt" : "Pausentage zählen"} nicht.` : ""
  ].filter(Boolean).join(" ");
  const stats = S.habits.filter(h => h.type === "plus" && !h.archived).map(h => ({ h, c: constancy(h, keys) }));
  const totals = stats.reduce((a, s) => [a[0] + s.c.done, a[1] + s.c.planned], [0, 0]);
  const totalPct = totals[1] ? Math.round(totals[0] / totals[1] * 100) : null;
  const minusList = S.habits.filter(h => h.type === "minus" && !h.archived).map(h => {
    const sum = list => list.reduce((a, k) => a + ((S.days[k] && S.days[k].minus && S.days[k].minus[h.id]) || 0), 0);
    return { h, now: sum(keys), before: sum(prev) };
  });

  const seg = `<div class="seg" role="group" aria-label="Zeitraum">
    <button data-a="range" data-n="7" aria-pressed="${V.range === 7}">7 Tage</button>
    <button data-a="range" data-n="30" aria-pressed="${V.range === 30}">30 Tage</button></div>`;

  const body = !first ? `<section class="panel"><div class="empty">${mascot(null)}<b>Noch kein Verlauf</b><span>Hake unter „Heute“ dein erstes Habit ab. Danach siehst du hier deine Kurve.</span></div></section>` : `
    <div class="tiles">
      <div class="tile"><b>${streak()}</b><span>Tage Serie</span></div>
      <div class="tile"><b>${avg === null ? "–" : fmt(avg)}</b><span>Ø Tageswert</span></div>
      <div class="tile"><b>${totalPct === null ? "–" : totalPct + " %"}</b><span>Konstanz</span></div>
    </div>
    ${avgNote ? `<p class="section-note">${avgNote}</p>` : ""}
    ${weekPanel()}
    <section class="panel"><h3>Tageswert</h3>${chart(keys)}</section>
    ${calendar()}
    ${skillsPanel()}
    ${insightsPanel()}
    <section class="panel"><h3>Konstanz je Habit</h3>
      ${stats.filter(s => s.c.planned).sort((a, b) => (b.c.done / (b.c.planned || 1)) - (a.c.done / (a.c.planned || 1))).map(({ h, c }) => {
        const p = c.planned ? Math.round(c.done / c.planned * 100) : 0;
        return `<div class="stat-row">${ico(h, true)}<span class="stat-name">${esc(h.name)}</span><span class="stat-val">${c.done} von ${c.planned}</span>
          <div class="bar on-card" role="progressbar" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(h.name)}: ${p} Prozent"><i style="width:${p}%"></i></div></div>`;
      }).join("") || `<p class="panel-note">Noch keine Habits angelegt.</p>`}
    </section>
    <section class="panel"><h3>Minuspunkte</h3>
      ${minusList.map(({ h, now, before }) => `<div class="stat-row">${ico(h, true)}<span class="stat-name">${esc(h.name)}</span><span class="stat-val">${now}×</span><span class="stat-sub" style="grid-column:2/-1">Davor ${before}×${now < before ? " · weniger geworden" : now > before ? " · mehr geworden" : ""}</span></div>`).join("") || `<p class="panel-note">Noch keine Minuspunkte angelegt.</p>`}
    </section>
    ${notesPanel()}`;

  return `<div class="page">
    <header class="top"><div class="brand">${LOGO}Stetig</div></header>
    <div class="headline"><h1>Verlauf</h1><p>So konstant bist du.</p></div>
    ${first ? seg : ""}
    ${body}
  </div>`;
}

/* ---------- Habits verwalten ---------- */
function dayLabel(h) {
  if (h.weekly) return `${h.weekly}× pro Woche`;
  if (h.flex) return "Bonus, ohne Ziel";
  if (h.days.length === 7) return "Jeden Tag";
  const s = [...h.days].sort((a, b) => MON_FIRST.indexOf(a) - MON_FIRST.indexOf(b));
  if (s.join() === "1,2,3,4,5") return "Mo bis Fr";
  if (s.join() === "6,0") return "Sa und So";
  return s.map(d => WD[d]).join(", ");
}

function manageRow(h, list, i) {
  const peers = S.habits.filter(x => h.group && x.group === h.group && x.id !== h.id && !x.archived);
  const pts = h.type === "plus" ? `+${h.points} · ${dayLabel(h)}${peers.length ? ` · oder ${peers.map(x => esc(x.name)).join(", ")}` : ""}` : `−${h.points} je Mal`;
  const flip = h.type === "plus" ? `<button class="pill kind" data-a="flipKind" data-id="${h.id}" aria-label="${esc(h.name)} zu ${isBonus(h) ? "Pflicht" : "Bonus"} machen">${isBonus(h) ? "Zu Pflicht" : "Zu Bonus"}</button>` : "";
  return `<div class="row is-plain">
    <button class="row-open" data-a="edit" data-id="${h.id}" aria-label="${esc(h.name)} bearbeiten">
      ${ico(h)}
      <span class="row-main"><span class="row-name">${esc(h.name)}</span><span class="row-sub">${pts}</span></span>
    </button>
    ${flip}
    <span class="row-tools">
      <button data-a="move" data-id="${h.id}" data-n="-1" ${i === 0 ? "disabled" : ""} aria-label="${esc(h.name)} nach oben">${chevron("up")}</button>
      <button data-a="move" data-id="${h.id}" data-n="1" ${i === list.length - 1 ? "disabled" : ""} aria-label="${esc(h.name)} nach unten">${chevron("down")}</button>
    </span>
  </div>`;
}

function installPanel() {
  const installed = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (window.claude || installed) return "";
  const iphone = /iPhone|iPad|iPod/.test(navigator.userAgent);
  return `<section class="panel">
    <h3>Als App installieren</h3>
    <p class="panel-note">${iphone ? "Öffne diese Seite in Safari. Tippe unten auf Teilen, dann auf „Zum Home-Bildschirm“." : "Öffne das Browser-Menü und wähle „App installieren“ oder „Zum Startbildschirm hinzufügen“."}</p>
  </section>`;
}

function markBackup() { S.settings.lastBackup = todayKey(); touchHabits(); }

function viewManage() {
  const plus = S.habits.filter(h => h.type === "plus" && !h.archived && !isBonus(h));
  const bonus = S.habits.filter(h => h.type === "plus" && !h.archived && isBonus(h));
  const minus = S.habits.filter(h => h.type === "minus" && !h.archived);
  const today = todayKey();
  const dailyPoints = calc(today).possible;
  const where = cloud.on ? (window.claude ? "Gespeichert in deinem Claude-Konto. Handy und PC zeigen denselben Stand." : "Gespeichert auf diesem Gerät und in deinem Konto. Alle Geräte zeigen denselben Stand.") : hasDisk ? "Gespeichert auf diesem Gerät. Mach ab und zu eine Sicherung." : "Dieser Browser erlaubt kein Speichern. Einträge gehen beim Schließen verloren.";
  return `<div class="page">
    <header class="top"><div class="brand">${LOGO}Stetig</div></header>
    <div class="headline"><h1>Habits</h1><p>Was zählt, entscheidest du.</p></div>

    <section class="section">
      <div class="section-head"><h2>Pflicht</h2><span>${dailyPoints} Punkte heute</span></div>
      <p class="section-note">Das zählt jeden Tag fest. ${plus.length > 5 ? "Mehr als 5 macht eine gute Note schwer. Stell den Rest auf Bonus." : "3 bis 5 Habits sind ideal."}</p>
      <div class="list">${plus.map((h, i) => manageRow(h, plus, i)).join("")}
      <button class="add" data-a="newHabit" data-type="plus">+ Habit hinzufügen</button></div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Bonus</h2><span>${bonus.length}</span></div>
      <p class="section-note">Bringt Extrapunkte und kostet nie etwas.</p>
      <div class="list">${bonus.map((h, i) => manageRow(h, bonus, i)).join("") || `<p class="hint">Noch keine Bonus-Habits. In der Bibliothek findest du über 200 Ideen.</p>`}</div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Minuspunkte</h2><span>${minus.length}</span></div>
      <div class="list">${minus.map((h, i) => manageRow(h, minus, i)).join("")}
      <button class="add" data-a="newHabit" data-type="minus">+ Minuspunkt hinzufügen</button></div>
    </section>

    ${aiPanel()}

    <h2 class="group-title">Einstellungen</h2>
    <details class="fold">
      <summary>Tageswert und Serie</summary>
      <section class="panel">
      <h3>So zählt der Tageswert</h3>
      <p class="panel-note">Lässt du den Tag von der KI bewerten, zählt ihre Note als Tageswert. Sie berücksichtigt, was los war, und vergleicht mit deinen letzten Tagen. Ohne KI-Bewertung gilt der Wert aus den Habits:</p>
      <p class="panel-note">Alle Pflicht-Habits des Tages ergeben 10, keine ergeben 1. Bei Entweder-oder reicht eines. Bonus-Habits wie Sport geben Extrapunkte und kosten nichts, wenn du sie auslässt. So kannst du Lücken ausgleichen, mehr als 10 geht nicht. Jeder Minuspunkt zieht 0,9 ab, an jedem Tag gleich viel. Dein Fazit von 1 bis 10 steht getrennt daneben. Vergangene Tage behalten ihren Wert, auch wenn du später Punkte änderst.</p>
      <div class="setting"><span class="stat-name">Serie zählt ab Tageswert</span>
        <span class="stepper"><button class="step" data-a="thr" data-n="-1" ${S.settings.threshold <= 2 ? "disabled" : ""} aria-label="Grenze senken">−</button><span class="count">${S.settings.threshold}</span><button class="step" data-a="thr" data-n="1" ${S.settings.threshold >= 9 ? "disabled" : ""} aria-label="Grenze erhöhen">+</button></span>
      </div>
      <div class="setting"><span class="stat-name">Neuer Tag beginnt um ${S.settings.dayStart} Uhr</span>
        <span class="stepper"><button class="step" data-a="dayStart" data-n="-1" ${S.settings.dayStart <= 0 ? "disabled" : ""} aria-label="Früher">−</button><span class="count">${S.settings.dayStart}</span><button class="step" data-a="dayStart" data-n="1" ${S.settings.dayStart >= 6 ? "disabled" : ""} aria-label="Später">+</button></span>
      </div>
      </section>
    </details>

    <details class="fold">
      <summary>Daten und Sicherung</summary>
      <section class="panel">
      <h3>Deine Daten</h3>
      <p class="panel-note">${where}</p>
      <p class="panel-note">Letzte Sicherung: ${S.settings.lastBackup ? shortDate(S.settings.lastBackup) : "noch keine"}</p>
      <button class="btn is-ghost is-small" data-a="backup">Sicherung</button>
      </section>
    </details>

    ${accountPanel()}

    <details class="fold">
      <summary>App-Sperre</summary>
      ${pinPanel()}
    </details>

    <details class="fold">
      <summary>Erinnerung und Installation</summary>
      ${installPanel()}
      ${reminderPanel()}
    </details>
  </div>`;
}

/* ---------- Bottom Sheets ---------- */
function altField() {
  const others = S.habits.filter(h => h.type === "plus" && !h.archived && h.id !== sheet.editId);
  if (!others.length) return "";
  const alts = sheet.draft.alts;
  return `<div class="field"><span class="label">Entweder-oder mit</span>
    <div class="chips" role="group">${others.map(h => `<button class="pill" data-a="draftAlt" data-n="${h.id}" aria-pressed="${alts.includes(h.id)}">${esc(h.name)}</button>`).join("")}</div>
    <p class="hint">Du machst eines davon, und der Platz im Tag ist voll. Beides zählt nicht doppelt.</p></div>`;
}

/* Macht ein Habit zum Teil einer Entweder-oder-Gruppe. Alle Mitglieder bekommen dieselbe Art. */
function applyGroup(h, alts) {
  const old = h.group;
  S.habits.forEach(x => { if (old && x.group === old && x.id !== h.id && !alts.includes(x.id)) x.group = ""; });
  if (!alts.length) h.group = "";
  else {
    const members = alts.map(id => S.habits.find(x => x.id === id)).filter(Boolean);
    const gid = old || members.map(x => x.group).find(Boolean) || "g" + uid();
    h.group = gid;
    members.forEach(x => {
      const prior = x.group;
      S.habits.forEach(y => { if (prior && y.group === prior) y.group = gid; });
      x.group = gid;
      x.weekly = h.weekly;
      x.flex = h.flex;
      x.days = h.days.slice();
    });
  }
  const counts = {};
  S.habits.filter(x => x.group && !x.archived).forEach(x => { counts[x.group] = (counts[x.group] || 0) + 1; });
  S.habits.forEach(x => { if (x.group && (counts[x.group] || 0) < 2) x.group = ""; });
}

function habitSheet() {
  const d = sheet.draft;
  const isPlus = d.type === "plus";
  const title = sheet.editId ? "Bearbeiten" : isPlus ? "Neues Habit" : "Neuer Minuspunkt";
  return `<div class="sheet-head"><h2 id="sheetTitle">${title}</h2><button class="close" data-a="close" aria-label="Schließen">×</button></div>
    ${sheet.editId ? "" : `<button class="btn is-ghost is-small" data-a="library" data-type="${d.type}">Aus der Bibliothek wählen</button>`}    <div class="field"><label for="hName">Name</label>
      <input class="input" id="hName" maxlength="40" autocomplete="off" value="${esc(d.name)}" placeholder="${isPlus ? "Zum Beispiel: Gitarre üben" : "Zum Beispiel: Handy im Bett"}"></div>
    ${sheet.editId ? "" : `<div class="chips" aria-label="Vorschläge">${SUGGEST[d.type].map(s => `<button class="pill" data-a="suggest" data-s="${esc(s)}">${esc(s)}</button>`).join("")}</div>`}
    <div class="field"><span class="label">${isPlus ? "Pluspunkte" : "Minuspunkte je Mal"}</span>
      <div class="points ${isPlus ? "" : "is-minus"}" role="group">${[1, 2, 3, 4, 5].map(n => `<button data-a="draftPts" data-n="${n}" aria-pressed="${d.points === n}">${isPlus ? "+" : "−"}${n}</button>`).join("")}</div></div>
    ${isPlus ? `<div class="field"><span class="label">Rhythmus</span>
      <div class="seg" role="group"><button data-a="draftWeekly" data-n="0" aria-pressed="${!d.weekly && !d.flex}">Pflicht</button><button data-a="draftWeekly" data-n="${d.weekly || 3}" aria-pressed="${!!d.weekly}">Pro Woche</button><button data-a="draftFlex" aria-pressed="${!!d.flex}">Bonus</button></div>
      <p class="hint">${d.flex ? "Ohne Ziel. Bringt Punkte, wenn du es machst, und kostet nie etwas." : d.weekly ? "Für Sport und Ähnliches. Bringt Punkte, wenn du es machst. Tage ohne kosten nichts." : "Zählt an den gewählten Tagen fest zum Tagesplan."}</p></div>
    ${altField()}
    ${d.flex ? "" : d.weekly ? `<div class="field"><span class="label">Wie oft pro Woche</span>
      <div class="days weekly" role="group">${[1, 2, 3, 4, 5, 6].map(n => `<button data-a="draftWeekly" data-n="${n}" aria-pressed="${d.weekly === n}">${n}×</button>`).join("")}</div></div>`
    : `<div class="field"><span class="label">An diesen Tagen</span>
      <div class="days" role="group">${MON_FIRST.map(n => `<button data-a="draftDay" data-n="${n}" aria-pressed="${d.days.includes(n)}">${WD[n]}</button>`).join("")}</div></div>`}
    <div class="field"><span class="label">Tageszeit</span>
      <div class="chips" role="group">${[["morgens", "Morgens"], ["tags", "Tagsüber"], ["abends", "Abends"], ["", "Jederzeit"]].map(([v, l]) => `<button class="pill" data-a="draftTime" data-n="${v}" aria-pressed="${d.time === v}">${l}</button>`).join("")}</div></div>
    <div class="field"><span class="label">Zeit als Skill zählen</span>
      <div class="chips" role="group">${[0, 5, 10, 15, 20, 30, 60].map(n => `<button class="pill" data-a="draftMinutes" data-n="${n}" aria-pressed="${d.minutes === n}">${n ? n + " Min" : "Aus"}</button>`).join("")}</div></div>` : ""}
    <div class="field"><span class="label">Symbol</span>
      <div class="icons" role="group">${ICON_ORDER.map(n => `<button data-a="draftIcon" data-n="${n}" aria-pressed="${d.icon === n}" aria-label="Symbol ${n}">${iconSvg(n)}</button>`).join("")}</div></div>
    <div class="field"><span class="label">Farbe</span>
      <div class="swatches" role="group">${COLORS.map(c => `<button class="c-${c}" data-a="draftColor" data-n="${c}" aria-pressed="${d.color === c}" aria-label="Farbe ${c}"></button>`).join("")}</div></div>
    <p class="hint is-error" ${sheet.err ? "" : "hidden"}>${esc(sheet.err || "")}</p>
    <button class="btn is-go" data-a="saveHabit">${sheet.editId ? "Speichern" : "Hinzufügen"}</button>
    ${sheet.editId ? (sheet.confirmDel
      ? `<p class="hint">Das Habit verschwindet aus deinen Listen. Dein Verlauf bleibt erhalten.</p><div class="btn-row"><button class="btn is-ghost is-small" data-a="cancelDel">Behalten</button><button class="btn is-danger is-small" data-a="doDel">Ja, entfernen</button></div>`
      : `<button class="btn is-danger is-small" data-a="askDel">Entfernen</button>`) : ""}`;
}

function backupSheet() {
  return `<div class="sheet-head"><h2 id="sheetTitle">Sicherung</h2><button class="close" data-a="close" aria-label="Schließen">×</button></div>
    <p class="hint">Mit einer Sicherung nimmst du alle Habits und Tage auf ein anderes Gerät mit.</p>
    <div class="btn-row">
      <button class="btn is-small" data-a="saveFile">Als Datei sichern</button>
      <button class="btn is-ghost is-small" data-a="copyBackup">Text kopieren</button>
    </div>
    <div class="field"><label for="bkText">Sicherung einlesen</label>
      <textarea class="input" id="bkText" placeholder="Sicherungstext hier einfügen">${esc(sheet.text || "")}</textarea></div>
    <div class="btn-row">
      <label class="btn is-ghost is-small" for="bkFile">Datei wählen</label>
      <button class="btn is-go is-small" data-a="askImport">Einlesen</button>
    </div>
    <input id="bkFile" type="file" accept=".json,application/json,text/plain" hidden>
    ${sheet.confirmImport ? `<p class="hint">Das ersetzt alle Einträge auf diesem Gerät.</p><div class="btn-row"><button class="btn is-ghost is-small" data-a="cancelImport">Abbrechen</button><button class="btn is-danger is-small" data-a="doImport">Ja, ersetzen</button></div>` : ""}
    <p class="hint ${sheet.err ? "is-error" : ""}" ${sheet.msg || sheet.err ? "" : "hidden"}>${esc(sheet.err || sheet.msg || "")}</p>`;
}

function pauseSheet() {
  return `<div class="sheet-head"><h2 id="sheetTitle">Pause</h2><button class="close" data-a="close" aria-label="Schließen">×</button></div>
    <p class="hint">Pausentage zählen nicht. Deine Serie bleibt stehen und läuft danach weiter.</p>
    <div class="field"><span class="label">Grund</span>
      <div class="chips" role="group">${Object.keys(PAUSE_REASONS).map(r => `<button class="pill" data-a="pauseReason" data-n="${r}" aria-pressed="${sheet.reason === r}">${PAUSE_REASONS[r]}</button>`).join("")}</div></div>
    <div class="field"><label for="pauseUntil">Von ${shortDate(V.day)} bis</label>
      <input class="input" id="pauseUntil" type="date" min="${V.day}" max="${addDays(V.day, 60)}" value="${sheet.until}"></div>
    <p class="hint is-error" ${sheet.err ? "" : "hidden"}>${esc(sheet.err || "")}</p>
    <button class="btn is-go" data-a="savePause">Pause eintragen</button>`;
}

function renderSheet() {
  let host = document.getElementById("sheetHost");
  if (!sheet) { if (host) host.remove(); return; }
  if (!host) {
    host = document.createElement("div");
    host.id = "sheetHost";
    document.body.appendChild(host);
    host.innerHTML = `<div class="scrim" data-a="close"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle"><div class="sheet-in"></div></div>`;
  }
  const box = host.querySelector(".sheet");
  const top = box.scrollTop;
  host.querySelector(".sheet-in").innerHTML = `<div class="grabber" aria-hidden="true"></div>` + (sheet.mode === "habit" ? habitSheet() : sheet.mode === "pause" ? pauseSheet() : sheet.mode === "backup" ? backupSheet() : window.EXTRA_SHEETS[sheet.mode]());
  box.scrollTop = top;
}

/* ---------- Zeichnen ---------- */
function tabs() {
  const items = [
    ["heute", "Heute", '<path fill-rule="evenodd" d="M7 2a1.300 1.300 0 0 1 1.300 1.300V4h7.400v-.7a1.300 1.300 0 0 1 2.600 0V4H19a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h.7v-.7A1.300 1.300 0 0 1 7 2zm9.700 9.300a1.200 1.200 0 0 0-1.700-1.700L10.700 14 9 12.300a1.200 1.200 0 0 0-1.700 1.700l2.600 2.500c.5.500 1.200.5 1.700 0z"/>'],
    ["verlauf", "Verlauf", '<rect x="3" y="12" width="5" height="9" rx="1.800"/><rect x="9.500" y="3" width="5" height="18" rx="1.800"/><rect x="16" y="8" width="5" height="13" rx="1.800"/>'],
    ["habits", "Habits", '<rect x="9" y="4" width="13" height="4" rx="2"/><rect x="9" y="10" width="13" height="4" rx="2"/><rect x="9" y="16" width="13" height="4" rx="2"/><circle cx="4.500" cy="6" r="2.500"/><circle cx="4.500" cy="12" r="2.500"/><circle cx="4.500" cy="18" r="2.500"/>']
  ];
  return `<nav class="tabs" aria-label="Hauptmenü"><div class="tabs-in">${items.map(([id, label, path]) =>
    `<button class="tab" data-a="tab" data-tab="${id}" ${V.tab === id ? 'aria-current="page"' : ""}><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${path}</svg>${label}</button>`).join("")}</div></nav>`;
}

function statusBanner() {
  if (!hasDisk) return `<div class="warn" role="status">Speichern klappt hier gerade nicht. Mach jetzt eine Sicherung.</div>`;
  if (cloud.relogin) return `<div class="warn" role="status"><span>Bitte melde dich wieder an. Deine Einträge liegen sicher auf diesem Gerät.</span><button class="link" data-a="loginSheet">Anmelden</button></div>`;
  if (cloud.lost || cloud.failed) return `<div class="warn" role="status"><span>${esc(cloud.msg || "Abgleich gestört. Deine Einträge liegen auf diesem Gerät.")}</span><button class="link" data-a="retrySync">Nochmal</button></div>`;
  if (!cloud.on && hasEntry(todayKey()) && backupDue()) return `<div class="warn is-soft" role="status"><span>Deine letzte Sicherung ist über eine Woche her.</span><button class="link" data-a="backup">Sichern</button></div>`;
  return "";
}

function render() {
  const view = V.tab === "heute" ? viewToday() : V.tab === "verlauf" ? viewHistory() : viewManage();
  const open = [...app.querySelectorAll("details.fold[open] > summary")].map(s => s.textContent);
  app.innerHTML = view.replace("</header>", "</header>" + statusBanner()) + tabs();
  app.querySelectorAll("details.fold > summary").forEach(s => { if (open.includes(s.textContent)) s.parentElement.open = true; });
  V.popId = null;
  V.popHero = false;
}

function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const hero = document.getElementById("hero");
  if (!hero) return;
  const box = document.createElement("div");
  box.className = "confetti";
  const cols = ["#ffce00", "#1cb0f6", "#ffa1cc", "#f47d31", "#ffffff", "#5f2b89"];
  for (let i = 0; i < 18; i++) {
    const s = document.createElement("span");
    const a = Math.random() * Math.PI * 2, r = 80 + Math.random() * 90;
    s.style.background = cols[i % cols.length];
    s.style.setProperty("--x", Math.cos(a) * r + "px");
    s.style.setProperty("--y", Math.sin(a) * r + "px");
    box.appendChild(s);
  }
  hero.appendChild(box);
  setTimeout(() => box.remove(), 1000);
}

/* ---------- Aktionen ---------- */
function isAllDone(k) {
  const c = calc(k);
  return !isPaused(k) && c.possible > 0 && c.core >= c.possible && c.minus === 0;
}

function emptyDraft(type) {
  const used = S.habits.filter(h => !h.archived).length;
  return { type, name: "", points: type === "plus" ? 2 : 1, days: ALL_DAYS.slice(), icon: type === "plus" ? "star" : "stop", color: type === "plus" ? COLORS[used % 6] : "pink", weekly: 0, flex: false, time: "", minutes: 0, alts: [] };
}

const actions = {
  tab(d) { V.tab = d.tab; V.pick = null; V.skipMode = false; render(); scrollTo(0, 0); },
  skipMode() { V.skipMode = !V.skipMode; render(); },
  skip(d) {
    const k = V.day, day = dayOf(k);
    if (day.skip && day.skip[d.id]) delete day.skip[d.id];
    else { day.skip = day.skip || {}; day.skip[d.id] = 1; delete day.done[d.id]; }
    touchDay(k);
    V.popHero = true;
    render();
  },
  askPause() { sheet = { mode: "pause", reason: "krank", until: V.day }; renderSheet(); },
  pauseReason(d) { syncPause(); sheet.reason = d.n; renderSheet(); },
  savePause() {
    syncPause();
    if (!sheet.until || sheet.until < V.day) { sheet.err = "Das Enddatum darf nicht vor dem Starttag liegen."; renderSheet(); return; }
    if (sheet.until > addDays(V.day, 60)) { sheet.err = "Eine Pause geht höchstens 60 Tage."; renderSheet(); return; }
    const now = Date.now();
    for (let k = V.day; k <= sheet.until; k = addDays(k, 1)) { const day = dayOf(k); day.pause = sheet.reason; day.t = now; }
    persist();
    V.skipMode = false;
    closeSheet();
  },
  endPause() {
    const now = Date.now();
    for (let k = V.day; isPaused(k); k = addDays(k, 1)) { delete S.days[k].pause; S.days[k].t = now; }
    persist();
    render();
  },
  dayStart(d) {
    const wasToday = V.day === todayKey();
    S.settings.dayStart = clamp(S.settings.dayStart + Number(d.n), 0, 6);
    touchHabits();
    lastToday = todayKey();
    if (wasToday) V.day = lastToday;
    render();
  },
  retrySync() { if (cloud.lost) cloudListen(); else cloudFlush(); renderIdle(); },
  goDay(d) { V.day = d.k; render(); },
  openDay(d) { V.day = d.k; V.tab = "heute"; V.pick = null; render(); scrollTo(0, 0); },
  week(d) {
    const t = todayKey();
    const k = addDays(V.day, Number(d.n));
    V.day = k > t ? t : k;
    render();
  },
  toggle(d) {
    const k = V.day, day = dayOf(k);
    const h = S.habits.find(x => x.id === d.id);
    const before = isAllDone(k);
    if (day.done[d.id]) {
      delete day.done[d.id];
      if (day.mins) delete day.mins[d.id];
    } else {
      day.done[d.id] = 1;
      if (day.skip) delete day.skip[d.id];
      if (h && h.minutes) { day.mins = day.mins || {}; day.mins[d.id] = h.minutes; }
      /* Entweder-oder: Es zählt immer nur eine Wahl. */
      if (h) groupPeers(h, k).forEach(x => {
        delete day.done[x.id];
        if (day.mins) delete day.mins[x.id];
      });
      if (h && k < h.from) { h.from = k; S.habitsT = Date.now(); }
      if (navigator.vibrate) navigator.vibrate(12);
    }
    touchDay(k);
    V.popId = d.id; V.popHero = true;
    render();
    if (!before && isAllDone(k)) confetti();
  },
  minus(d) {
    const k = V.day, day = dayOf(k);
    const n = clamp((day.minus[d.id] || 0) + Number(d.n), 0, 99);
    if (n) day.minus[d.id] = n; else delete day.minus[d.id];
    touchDay(k);
    V.popId = d.id; V.popHero = true;
    render();
  },
  rate(d) {
    const day = dayOf(V.day), n = Number(d.n);
    if (day.rating === n) delete day.rating; else day.rating = n;
    touchDay(V.day);
    render();
  },
  range(d) { V.range = Number(d.n); V.pick = null; render(); },
  pick(d) { V.pick = V.pick === d.k ? null : d.k; render(); },
  month(d) {
    const [y, m] = V.month.split("-").map(Number);
    const x = new Date(y, m - 1 + Number(d.n), 1);
    V.month = `${x.getFullYear()}-${pad(x.getMonth() + 1)}`;
    render();
  },
  newHabit(d) { sheet = { mode: "habit", draft: emptyDraft(d.type) }; renderSheet(); },
  edit(d) {
    const h = S.habits.find(x => x.id === d.id);
    if (!h) return;
    sheet = { mode: "habit", editId: h.id, draft: { type: h.type, name: h.name, points: h.points, days: h.days.slice(), icon: h.icon, color: h.color, weekly: h.weekly, flex: h.flex, time: h.time, minutes: h.minutes, alts: S.habits.filter(x => h.group && x.group === h.group && x.id !== h.id && !x.archived).map(x => x.id) } };
    renderSheet();
  },
  close() { closeSheet(); },
  suggest(d) { syncDraft(); sheet.draft.name = d.s; sheet.err = ""; renderSheet(); },
  draftPts(d) { syncDraft(); sheet.draft.points = Number(d.n); renderSheet(); },
  draftIcon(d) { syncDraft(); sheet.draft.icon = d.n; renderSheet(); },
  draftColor(d) { syncDraft(); sheet.draft.color = d.n; renderSheet(); },
  draftWeekly(d) { syncDraft(); sheet.draft.weekly = Number(d.n); sheet.draft.flex = false; renderSheet(); },
  draftFlex() { syncDraft(); sheet.draft.weekly = 0; sheet.draft.flex = true; renderSheet(); },
  draftAlt(d) {
    syncDraft();
    const alts = sheet.draft.alts;
    sheet.draft.alts = alts.includes(d.n) ? alts.filter(x => x !== d.n) : alts.concat(d.n);
    renderSheet();
  },
  flipKind(d) {
    const h = S.habits.find(x => x.id === d.id);
    if (!h) return;
    const toPflicht = isBonus(h);
    const peers = S.habits.filter(x => h.group && x.group === h.group);
    (peers.length ? peers : [h]).forEach(x => {
      x.flex = !toPflicht;
      x.weekly = 0;
    });
    touchHabits();
    render();
  },
  draftTime(d) { syncDraft(); sheet.draft.time = d.n; renderSheet(); },
  draftMinutes(d) { syncDraft(); sheet.draft.minutes = Number(d.n); renderSheet(); },
  draftDay(d) {
    syncDraft();
    const n = Number(d.n), list = sheet.draft.days;
    sheet.draft.days = list.includes(n) ? list.filter(x => x !== n) : list.concat(n);
    renderSheet();
  },
  saveHabit() {
    syncDraft();
    const dr = sheet.draft;
    dr.name = dr.name.trim();
    if (!dr.name) { sheet.err = "Gib deinem Habit einen Namen."; renderSheet(); return; }
    if (dr.type === "plus" && !isBonus(dr) && !dr.days.length) { sheet.err = "Wähle mindestens einen Tag."; renderSheet(); return; }
    if (isBonus(dr)) dr.days = ALL_DAYS.slice();
    const alts = dr.alts || [];
    let saved;
    if (sheet.editId) {
      saved = S.habits.find(x => x.id === sheet.editId);
      Object.assign(saved, { name: dr.name, points: dr.points, days: dr.days, icon: dr.icon, color: dr.color, weekly: dr.weekly, flex: dr.flex, time: dr.time, minutes: dr.minutes });
    } else {
      const { alts: _unused, ...fields } = dr;
      saved = Object.assign({ id: uid(), from: todayKey(), archived: null, group: "" }, fields);
      S.habits.push(saved);
    }
    if (saved.type === "plus") applyGroup(saved, alts);
    touchHabits();
    closeSheet();
  },
  askDel() { syncDraft(); sheet.confirmDel = true; renderSheet(); },
  cancelDel() { syncDraft(); sheet.confirmDel = false; renderSheet(); },
  doDel() {
    const h = S.habits.find(x => x.id === sheet.editId);
    if (h) {
      /* Schon heute Erledigtes bleibt für heute gültig. Erst morgen fällt das Habit weg. */
      const today = todayKey();
      const doneToday = S.days[today] && S.days[today].done && S.days[today].done[h.id];
      h.archived = doneToday ? addDays(today, 1) : today;
      applyGroup(h, []);
      touchHabits();
    }
    closeSheet();
  },
  move(d) {
    const h = S.habits.find(x => x.id === d.id);
    const peers = S.habits.filter(x => x.type === h.type && !x.archived && isBonus(x) === isBonus(h));
    const other = peers[peers.indexOf(h) + Number(d.n)];
    if (!other) return;
    const a = S.habits.indexOf(h), b = S.habits.indexOf(other);
    S.habits[a] = other; S.habits[b] = h;
    touchHabits();
    render();
  },
  thr(d) { S.settings.threshold = clamp(S.settings.threshold + Number(d.n), 2, 9); touchHabits(); render(); },
  backup() { sheet = { mode: "backup" }; renderSheet(); },
  async saveFile() {
    const name = `stetig-sicherung-${todayKey()}.json`;
    const text = JSON.stringify(S);
    try {
      const file = new File([text], name, { type: "application/json" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "Stetig Sicherung" });
        markBackup();
        setBackupMsg("Sicherung gespeichert.");
        return;
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(file);
      a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      markBackup();
      setBackupMsg("Datei erstellt: " + name);
    } catch (e) {
      if (e && e.name === "AbortError") return;
      setBackupMsg("", "Die Datei ging hier nicht. Nutze „Text kopieren“.");
    }
  },
  async copyBackup() {
    const text = JSON.stringify(S);
    try { await navigator.clipboard.writeText(text); markBackup(); setBackupMsg("Sicherung kopiert. Füge sie zum Beispiel in eine Notiz ein."); }
    catch (e) {
      sheet.text = text; sheet.msg = "Kopieren ging nicht. Der Text steht oben im Feld."; sheet.err = "";
      renderSheet();
      const box = document.getElementById("bkText");
      if (box) box.select();
    }
  },
  askImport() {
    const box = document.getElementById("bkText");
    sheet.text = box ? box.value : "";
    if (!sheet.text.trim()) { setBackupMsg("", "Füge erst eine Sicherung ein oder wähle eine Datei."); return; }
    try {
      if (!isValidState(JSON.parse(sheet.text))) throw 0;
      sheet.confirmImport = true; sheet.err = ""; sheet.msg = "";
    } catch (e) { sheet.err = "Das ist keine gültige Stetig-Sicherung."; sheet.confirmImport = false; }
    renderSheet();
  },
  cancelImport() { sheet.confirmImport = false; renderSheet(); },
  doImport() {
    const now = Date.now();
    const incoming = normalize(JSON.parse(sheet.text));
    Object.values(incoming.days).forEach(d => { d.t = now; });
    incoming.habitsT = now;
    incoming.resetT = now;
    S = incoming;
    ensureSnaps();
    persist();
    V.day = todayKey();
    closeSheet();
  }
};

Object.assign(actions, window.EXTRA_ACTIONS || {});

function setBackupMsg(msg, err = "") {
  const box = document.getElementById("bkText");
  if (box) sheet.text = box.value;
  sheet.msg = msg; sheet.err = err;
  renderSheet();
}

function syncDraft() {
  const input = document.getElementById("hName");
  if (input && sheet && sheet.draft) sheet.draft.name = input.value;
}

function syncPause() {
  const input = document.getElementById("pauseUntil");
  if (input && sheet) { sheet.until = input.value; sheet.err = ""; }
}

function closeSheet() {
  if (aiCtl) aiCtl.abort();
  sheet = null;
  renderSheet();
  render();
}

/* Fenster am Griff nach unten ziehen schließt es. */
let drag = null;
document.addEventListener("pointerdown", e => {
  if (!e.target.closest(".grabber")) return;
  drag = { box: e.target.closest(".sheet"), y: e.clientY, d: 0 };
  drag.box.style.transition = "none";
  e.target.setPointerCapture(e.pointerId);
});
document.addEventListener("pointermove", e => {
  if (!drag) return;
  drag.d = Math.max(0, e.clientY - drag.y);
  drag.box.style.transform = `translateY(${drag.d}px)`;
});
function endDrag() {
  if (!drag) return;
  const close = drag.d > 90;
  drag.box.style.transform = "";
  drag.box.style.transition = "";
  drag = null;
  if (close) closeSheet();
}
document.addEventListener("pointerup", endDrag);
document.addEventListener("pointercancel", endDrag);

document.addEventListener("click", e => {
  const el = e.target.closest("[data-a]");
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.a];
  if (fn) fn(el.dataset, el);
});

document.addEventListener("input", e => {
  if (e.target.id === "weekGoal") { setWeekGoal(e.target.value); return; }
  if (e.target.id === "dayCtx") { dayOf(V.day).ctx = e.target.value.slice(0, 200); touchDay(V.day); return; }
  if (e.target.id === "libSearch" && sheet) { sheet.q = e.target.value; renderLibraryList(); return; }
  if (e.target.id !== "note") return;
  dayOf(V.day).note = e.target.value;
  touchDay(V.day);
});

document.addEventListener("change", e => {
  if (e.target.id === "aiDayMinus") { S.settings.aiMinus = e.target.checked; touchHabits(); return; }
  if (e.target.id !== "bkFile" || !e.target.files[0]) return;
  const reader = new FileReader();
  reader.onload = () => { sheet.text = String(reader.result || ""); sheet.msg = "Datei geladen. Tippe auf Einlesen."; sheet.err = ""; renderSheet(); };
  reader.onerror = () => setBackupMsg("", "Die Datei ließ sich nicht lesen.");
  reader.readAsText(e.target.files[0]);
});

document.addEventListener("keydown", e => { if (e.key === "Escape" && sheet) closeSheet(); });

/* Springt nach Mitternacht beim Zurückkehren auf den neuen Tag. */
let lastToday = todayKey();
function checkNewDay() {
  const t = todayKey();
  if (t === lastToday) return;
  if (V.day === lastToday) V.day = t;
  lastToday = t;
  if (!sheet) render();
}
document.addEventListener("visibilitychange", () => {
  pinOnVisibility();
  if (!document.hidden) checkNewDay();
});
addEventListener("focus", checkNewDay);

/* ---------- Start ---------- */
S = loadState();
V.day = lastToday = todayKey();
V.month = V.day.slice(0, 7);
ensureSnaps();
render();
pinOnStart();
cloudStart();
