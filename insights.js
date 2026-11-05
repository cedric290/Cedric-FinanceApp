/* Stetig: Auswertungen im Verlauf und die Bibliothek. */
"use strict";
window.EXTRA_ACTIONS = window.EXTRA_ACTIONS || {};
window.EXTRA_SHEETS = window.EXTRA_SHEETS || {};

const fmtMinutes = m => {
  if (m < 60) return `${m} Min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} Std ${r} Min` : `${h} Std`;
};

function setWeekGoal(value) {
  const next = addDays(mondayOf(todayKey()), 7);
  const text = value.trim().slice(0, 120);
  if (text) S.settings.weeks[next] = text; else delete S.settings.weeks[next];
  touchHabits();
}

/* ---------- Wochenrückblick ---------- */
function weekPanel() {
  const today = todayKey();
  const mon = mondayOf(today);
  const keys = Array.from({ length: 7 }, (_, i) => addDays(mon, i)).filter(k => k <= today);
  const first = firstDay();
  const rows = keys.map(k => ({ k, s: calc(k).score })).filter(x => x.s !== null);
  const missed = keys.filter(k => missedDay(k, first)).length;
  const values = rows.map(x => x.s).concat(Array(missed).fill(1));
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const best = rows.slice().sort((a, b) => b.s - a.s)[0];
  const open = S.habits.filter(h => h.type === "plus" && !h.archived)
    .map(h => ({ h, c: constancy(h, keys) }))
    .filter(x => x.c.planned > 0 && x.c.done < x.c.planned)
    .sort((a, b) => a.c.done / a.c.planned - b.c.done / b.c.planned)[0];
  const minus = S.habits.filter(h => h.type === "minus")
    .reduce((a, h) => a + keys.reduce((b, k) => b + ((S.days[k] && S.days[k].minus && S.days[k].minus[h.id]) || 0), 0), 0);
  const next = addDays(mon, 7);
  const lines = [];
  if (avg !== null) lines.push(`Ø Tageswert: <b>${fmt(avg)}</b>`);
  if (best) lines.push(`Bester Tag: <b>${WD_LONG[dow(best.k)]}</b> mit ${fmt(best.s)}`);
  if (open) lines.push(`Mehr Luft nach oben: <b>${esc(open.h.name)}</b> (${open.c.done} von ${open.c.planned})`);
  lines.push(`Minuspunkte eingetragen: <b>${minus}×</b>`);
  return `<section class="panel">
    <h3>${dow(today) === 0 ? "Dein Wochenrückblick" : "Diese Woche"}</h3>
    <ul class="facts">${lines.map(l => `<li>${l}</li>`).join("")}</ul>
    <div class="field"><label for="weekGoal">Ein Vorsatz für nächste Woche</label>
      <input class="input" id="weekGoal" maxlength="120" autocomplete="off" placeholder="Zum Beispiel: Montag direkt nach der Arbeit spazieren" value="${esc(S.settings.weeks[next] || "")}"></div>
  </section>`;
}

/* ---------- Skill-Stunden ---------- */
function skillsPanel() {
  const today = todayKey();
  const mon = mondayOf(today);
  const totals = {}, week = {};
  Object.keys(S.days).forEach(k => {
    const mins = S.days[k].mins;
    if (!mins) return;
    Object.keys(mins).forEach(id => {
      totals[id] = (totals[id] || 0) + mins[id];
      if (k >= mon) week[id] = (week[id] || 0) + mins[id];
    });
  });
  const list = S.habits.filter(h => totals[h.id] || (h.minutes && !h.archived)).sort((a, b) => (totals[b.id] || 0) - (totals[a.id] || 0));
  if (!list.length) return "";
  return `<section class="panel"><h3>Deine Skills</h3>
    ${list.map(h => `<div class="stat-row">${ico(h, true)}<span class="stat-name">${esc(h.name)}</span><span class="stat-val">${fmtMinutes(totals[h.id] || 0)}</span><span class="stat-sub" style="grid-column:2/-1">Diese Woche ${fmtMinutes(week[h.id] || 0)}</span></div>`).join("")}
  </section>`;
}

/* ---------- Erkenntnisse ---------- */
const INSIGHT_MIN_DAYS = 14;
const INSIGHT_MIN_GROUP = 4;

function collectInsights() {
  const rated = Object.keys(S.days).filter(k => S.days[k].rating && !isPaused(k));
  const mean = list => list.reduce((a, b) => a + b, 0) / list.length;
  const out = [];
  S.habits.forEach(h => {
    const yes = [], no = [];
    rated.forEach(k => {
      const d = S.days[k], r = d.rating;
      if (h.type === "plus") {
        if (isDone(k, h.id)) yes.push(r);
        else if (plannedOn(h, k) || isBonus(h)) no.push(r);
      } else if (d.minus && d.minus[h.id] > 0) yes.push(r);
      else no.push(r);
    });
    if (yes.length < INSIGHT_MIN_GROUP || no.length < INSIGHT_MIN_GROUP) return;
    const diff = mean(yes) - mean(no);
    if (Math.abs(diff) >= 0.5) out.push({ h, diff, n: yes.length + no.length });
  });
  return { rated: rated.length, items: out.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 4) };
}

function weekdayInsight() {
  const groups = {};
  Object.keys(S.days).forEach(k => {
    const s = calc(k).score;
    if (s !== null) (groups[dow(k)] = groups[dow(k)] || []).push(s);
  });
  const means = Object.keys(groups).filter(d => groups[d].length >= 3)
    .map(d => ({ d: Number(d), m: groups[d].reduce((a, b) => a + b, 0) / groups[d].length })).sort((a, b) => b.m - a.m);
  if (means.length < 3) return "";
  const top = means[0], low = means[means.length - 1];
  return top.m - low.m >= 1 ? `Dein stärkster Tag ist der ${WD_LONG[top.d]} (${fmt(top.m)}), dein schwächster der ${WD_LONG[low.d]} (${fmt(low.m)}).` : "";
}

function insightsPanel() {
  const { rated, items } = collectInsights();
  if (rated < INSIGHT_MIN_DAYS) {
    const p = Math.round(rated / INSIGHT_MIN_DAYS * 100);
    return `<section class="panel"><h3>Was dir guttut</h3>
      <p class="panel-note">Noch ${INSIGHT_MIN_DAYS - rated} Tage mit Fazit, dann siehst du hier, was deine Tage wirklich besser macht.</p>
      <div class="bar on-card" role="progressbar" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100" aria-label="Fortschritt bis zu den Erkenntnissen"><i style="width:${p}%"></i></div></section>`;
  }
  const lines = items.map(({ h, diff }) => {
    const size = fmt(Math.abs(diff));
    const way = diff > 0 ? "höher" : "niedriger";
    return `An Tagen mit <b>${esc(h.name)}</b> ist dein Fazit im Schnitt ${size} ${way}.`;
  });
  const wd = weekdayInsight();
  if (wd) lines.push(wd);
  return `<section class="panel"><h3>Was dir guttut</h3>
    ${lines.length ? `<ul class="facts">${lines.map(l => `<li>${l}</li>`).join("")}</ul>` : `<p class="panel-note">Bisher zeigt sich kein klares Muster. Das ist auch eine Antwort.</p>`}
    <p class="panel-note">Das sind Zusammenhänge aus ${rated} Tagen, keine Beweise.</p></section>`;
}

/* ---------- Notizen ---------- */
function notesPanel() {
  const list = Object.keys(S.days).filter(k => S.days[k].note || S.days[k].rating).sort().reverse();
  if (!list.length) return "";
  const shown = V.allNotes ? list : list.slice(0, 5);
  return `<section class="panel"><h3>Deine Fazits</h3>
    <div class="notes">${shown.map(k => {
      const d = S.days[k];
      return `<button class="note-item" data-a="openDay" data-k="${k}">
        <span class="note-top"><b>${shortDate(k)}</b>${d.rating ? `<span class="note-rate">${d.rating}/10</span>` : ""}</span>
        ${d.note ? `<span class="note-text">${esc(d.note)}</span>` : ""}
      </button>`;
    }).join("")}</div>
    ${list.length > 5 ? `<button class="link" data-a="toggleNotes">${V.allNotes ? "Weniger zeigen" : `Alle ${list.length} zeigen`}</button>` : ""}
  </section>`;
}

/* ---------- Minuten eines Tages ändern ---------- */
window.EXTRA_SHEETS.mins = () => {
  const h = S.habits.find(x => x.id === sheet.id);
  return `<div class="sheet-head"><h2 id="sheetTitle">${esc(h ? h.name : "")}</h2><button class="close" data-a="close" aria-label="Schließen">×</button></div>
    <div class="field"><label for="minsValue">Minuten an diesem Tag</label>
      <input class="input" id="minsValue" type="number" inputmode="numeric" min="1" max="600" value="${sheet.value}"></div>
    <p class="hint is-error" ${sheet.err ? "" : "hidden"}>${esc(sheet.err || "")}</p>
    <button class="btn is-go" data-a="saveMins">Speichern</button>`;
};

/* ---------- Bibliothek ---------- */
function libraryRows() {
  const q = (sheet.q || "").trim().toLowerCase();
  const names = new Set(S.habits.filter(h => !h.archived).map(h => h.name.toLowerCase()));
  const rows = HABIT_LIBRARY.filter(([n, a]) => (q ? n.toLowerCase().includes(q) : a === sheet.area));
  return rows.map(r => {
    const added = names.has(r[0].toLowerCase());
    const isMinus = r[1] === "Weniger";
    const rhythm = libraryRhythm(r[0]);
    const label = rhythm ? ` · Bonus, ${rhythm}× pro Woche` : " · Bonus";
    const sub = isMinus ? `−${r[4]} je Mal` : `+${r[4]}${r[2] ? ` · ${r[2]} Min` : ""}${label}`;
    return `<div class="lib-row"><span class="row-main"><span class="row-name">${esc(r[0])}</span><span class="row-sub">${sub}</span></span>
      <button class="step ${added ? "" : "is-add"}" data-a="libAdd" data-n="${esc(r[0])}" ${added ? "disabled" : ""} aria-label="${esc(r[0])} ${added ? "ist schon dabei" : "hinzufügen"}">${added ? "✓" : "+"}</button></div>`;
  }).join("") || `<p class="hint">Nichts gefunden. Leg das Habit einfach selbst an.</p>`;
}

function renderLibraryList() {
  const box = document.getElementById("libList");
  if (box) box.innerHTML = libraryRows();
}

window.EXTRA_SHEETS.library = () => {
  const active = S.habits.filter(h => h.type === "plus" && !h.archived).length;
  return `<div class="sheet-head"><h2 id="sheetTitle">Bibliothek</h2><button class="close" data-a="close" aria-label="Schließen">×</button></div>
    ${active >= 10 ? `<p class="hint">Du hast schon ${active} Habits. Weniger ist oft beständiger.</p>` : ""}
    <input class="input" id="libSearch" autocomplete="off" placeholder="Suchen" value="${esc(sheet.q || "")}" aria-label="Bibliothek durchsuchen">
    <div class="chips" role="group">${LIBRARY_AREAS.map(a => `<button class="pill" data-a="libArea" data-n="${a}" aria-pressed="${sheet.area === a}">${a}</button>`).join("")}</div>
    <div class="lib-list" id="libList">${libraryRows()}</div>`;
};

Object.assign(window.EXTRA_ACTIONS, {
  toggleNotes() { V.allNotes = !V.allNotes; render(); },
  minsEdit(d) {
    const day = dayOf(V.day);
    sheet = { mode: "mins", id: d.id, value: (day.mins && day.mins[d.id]) || 0 };
    renderSheet();
  },
  saveMins() {
    const value = Math.round(Number(document.getElementById("minsValue").value));
    if (!value || value < 1 || value > 600) { sheet.err = "Gib 1 bis 600 Minuten ein."; renderSheet(); return; }
    const day = dayOf(V.day);
    day.mins = day.mins || {};
    day.mins[sheet.id] = value;
    touchDay(V.day);
    closeSheet();
  },
  library(d) { sheet = { mode: "library", area: d.type === "minus" ? "Weniger" : "Sport", q: "" }; renderSheet(); },
  libArea(d) { sheet.area = d.n; sheet.q = ""; renderSheet(); },
  libAdd(d) {
    const r = HABIT_LIBRARY.find(x => x[0] === d.n);
    if (!r) return;
    const isMinus = r[1] === "Weniger";
    const used = S.habits.filter(h => !h.archived).length;
    /* Aus der Bibliothek kommt alles als Bonus. Zur Pflicht wird ein Habit nur bewusst. */
    const rhythm = isMinus ? 0 : libraryRhythm(r[0]);
    const weekly = typeof rhythm === "number" ? rhythm : 0;
    S.habits.push({
      id: uid(), type: isMinus ? "minus" : "plus", name: r[0], points: r[4], icon: r[3],
      color: isMinus ? "pink" : COLORS[used % 6], days: ALL_DAYS.slice(), from: todayKey(), archived: null,
      weekly, flex: !isMinus && !weekly, group: "", time: isMinus ? "" : r[5], minutes: r[2]
    });
    touchHabits();
    renderLibraryList();
  }
});
