/* Stetig: Konto-Abgleich über Supabase, App-Sperre und Hinweise. */
"use strict";
window.EXTRA_ACTIONS = window.EXTRA_ACTIONS || {};
window.EXTRA_SHEETS = window.EXTRA_SHEETS || {};

/* ---------- Supabase ---------- */
const SUPA = (() => {
  const c = window.STETIG_CONFIG;
  if (!c || !c.supabaseUrl || !c.supabaseKey) return null;
  return { url: String(c.supabaseUrl).trim().replace(/\/+$/, ""), key: String(c.supabaseKey).trim() };
})();
const SESSION_KEY = "stetig.session";
let session = null;
try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (e) { session = null; }
let refreshing = null;

const supaReady = () => !!(SUPA && session);

function saveSession(j) {
  session = {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
    email: (j.user && j.user.email) || (session && session.email) || "",
    user_id: (j.user && j.user.id) || (session && session.user_id) || ""
  };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) { /* bleibt nur im Speicher */ }
}

function dropSession() {
  session = null;
  try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* nichts zu tun */ }
}

async function authCall(path, body) {
  const r = await fetch(`${SUPA.url}/auth/v1/${path}`, {
    method: "POST",
    headers: { apikey: SUPA.key, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw { status: r.status, code: j.error_code || j.error || "" };
  return j;
}

async function supaToken() {
  if (!session) throw { auth: true };
  if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
  if (!refreshing) {
    refreshing = authCall("token?grant_type=refresh_token", { refresh_token: session.refresh_token })
      .then(saveSession)
      .catch(e => { if (e && e.status >= 400 && e.status < 500) throw { auth: true }; throw e; })
      .finally(() => { refreshing = null; });
  }
  await refreshing;
  return session.access_token;
}

async function supaRest(method, query, body, headers, retried) {
  const token = await supaToken();
  const r = await fetch(`${SUPA.url}/rest/v1/stetig_docs${query}`, {
    method,
    headers: Object.assign({ apikey: SUPA.key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, headers || {}),
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 401 && !retried) { session.expires_at = 0; return supaRest(method, query, body, headers, true); }
  if (r.status === 401) throw { auth: true };
  if (r.status === 404) throw { msg: "Die Tabelle für Stetig fehlt noch. Führe einmal stetig-setup.sql in Supabase aus." };
  if (!r.ok) throw { msg: "" };
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

function supaCollection() {
  let next = null, timer = 0;
  const stop = () => {
    next = null;
    clearInterval(timer);
    document.removeEventListener("visibilitychange", poll);
    removeEventListener("online", poll);
  };
  const poll = async () => {
    if (!next || !session || document.hidden) return;
    try {
      const rows = await supaRest("GET", "?select=id,data");
      const wasFailed = cloud.failed;
      cloud.failed = false;
      cloud.msg = "";
      next({ metadata: { fromCache: false }, docs: rows.map(r => ({ id: r.id, data: () => r.data })) });
      if (wasFailed) renderIdle();
    } catch (e) {
      if (e && e.auth) supaAuthLost();
      else if (navigator.onLine !== false) { cloud.failed = true; cloud.msg = (e && e.msg) || ""; renderIdle(); }
    }
  };
  return {
    doc: id => ({
      set: data => supaRest("POST", "?on_conflict=user_id,id", { id, user_id: session.user_id, data }, { Prefer: "resolution=merge-duplicates,return=minimal" })
    }),
    onSnapshot(fn) {
      next = fn;
      poll();
      clearInterval(timer);
      timer = setInterval(poll, 60000);
      document.addEventListener("visibilitychange", poll);
      addEventListener("online", poll);
      return stop;
    },
    poll,
    stop
  };
}

function supaDisconnect() {
  clearTimeout(cloud.timer);
  if (cloud.col && cloud.col.stop) cloud.col.stop();
  dropSession();
  cloud.on = false;
  cloud.ready = false;
  cloud.failed = false;
  cloud.col = null;
  cloud.seen = {};
}

function supaAuthLost() {
  supaDisconnect();
  cloud.relogin = true;
  renderIdle();
}

function accountPanel() {
  if (!SUPA || window.claude) return "";
  if (session) return `<section class="panel"><h3>Dein Konto</h3>
    <p class="panel-note">Angemeldet als ${esc(session.email)}. Änderungen gehen automatisch an alle Geräte.</p>
    <button class="btn is-ghost is-small" data-a="logout">Abmelden</button></section>`;
  return `<section class="panel"><h3>Geräte verbinden</h3>
    <p class="panel-note">Melde dich an, dann sichert Stetig alles automatisch und zeigt auf Handy und PC denselben Stand. Nutze dein Konto von Cedric Finance.</p>
    <button class="btn is-small" data-a="loginSheet">Anmelden</button></section>`;
}

window.EXTRA_SHEETS.login = () => `<div class="sheet-head"><h2 id="sheetTitle">Anmelden</h2><button class="close" data-a="close" aria-label="Schließen">×</button></div>
  <form id="loginForm" class="sheet-form">
    <div class="field"><label for="loginMail">E-Mail</label>
      <input class="input" id="loginMail" type="email" autocomplete="username" autocapitalize="none" required></div>
    <div class="field"><label for="loginPass">Passwort</label>
      <input class="input" id="loginPass" type="password" autocomplete="current-password" required></div>
    <p class="hint is-error" ${sheet.err ? "" : "hidden"}>${esc(sheet.err || "")}</p>
    <button class="btn is-go" type="submit" ${sheet.busy ? "disabled" : ""}>${sheet.busy ? "Einen Moment" : "Anmelden"}</button>
  </form>`;

document.addEventListener("submit", async e => {
  if (e.target.id !== "loginForm") return;
  e.preventDefault();
  const email = document.getElementById("loginMail").value.trim();
  const password = document.getElementById("loginPass").value;
  sheet.busy = true;
  sheet.err = "";
  try {
    saveSession(await authCall("token?grant_type=password", { email, password }));
    cloud.relogin = false;
    closeSheet();
    cloudStart();
  } catch (err) {
    if (!sheet) return;
    sheet.busy = false;
    sheet.err = err && err.status === 400 ? "E-Mail oder Passwort stimmt nicht." : "Anmelden klappt gerade nicht. Prüfe deine Internetverbindung.";
    renderSheet();
  }
});

/* ---------- App-Sperre ---------- */
const PIN_KEY = "stetig.pin";
const LOCK_AFTER_MS = 60000;
let pinEntry = "", hiddenAt = 0, lockForgot = false;

function pinData() {
  try { return JSON.parse(localStorage.getItem(PIN_KEY) || "null"); } catch (e) { return null; }
}

async function hashPin(pin, salt) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + ":" + pin));
  return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function pinPanel() {
  if (!window.crypto || !crypto.subtle) return "";
  const on = !!pinData();
  return `<section class="panel"><h3>App-Sperre</h3>
    <p class="panel-note">${on ? "Stetig fragt beim Öffnen nach deiner PIN." : "Schützt deine Einträge vor neugierigen Blicken."} Die PIN gilt nur auf diesem Gerät. Sie ist ein Sichtschutz, keine Verschlüsselung.</p>
    <button class="btn is-ghost is-small" data-a="${on ? "pinOff" : "pinSetup"}">${on ? "Sperre ausschalten" : "PIN festlegen"}</button></section>`;
}

window.EXTRA_SHEETS.pin = () => `<div class="sheet-head"><h2 id="sheetTitle">PIN festlegen</h2><button class="close" data-a="close" aria-label="Schließen">×</button></div>
  <div class="field"><label for="pinNew">4 Ziffern</label>
    <input class="input" id="pinNew" type="password" inputmode="numeric" maxlength="4" autocomplete="off"></div>
  <div class="field"><label for="pinNew2">Noch einmal</label>
    <input class="input" id="pinNew2" type="password" inputmode="numeric" maxlength="4" autocomplete="off"></div>
  <p class="hint is-error" ${sheet.err ? "" : "hidden"}>${esc(sheet.err || "")}</p>
  <button class="btn is-go" data-a="pinSave">PIN speichern</button>`;

function drawLock() {
  let box = document.getElementById("lock");
  if (!box) {
    box = document.createElement("div");
    box.id = "lock";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "App gesperrt");
    document.body.appendChild(box);
  }
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"];
  box.innerHTML = lockForgot
    ? `<div class="lock-in"><h2>PIN vergessen?</h2>
        <p class="hint">Die Sperre lässt sich nur entfernen, wenn alle Daten auf diesem Gerät gelöscht werden. Daten in deinem Konto bleiben erhalten. Ohne Konto oder Sicherung sind sie weg.</p>
        <div class="btn-row"><button class="btn is-ghost is-small" data-a="pinBack">Zurück</button><button class="btn is-danger is-small" data-a="pinWipe">Alles löschen</button></div></div>`
    : `<div class="lock-in">${LOGO}<h2>Stetig</h2>
        <div class="pin-dots" aria-label="${pinEntry.length} von 4 Ziffern">${[0, 1, 2, 3].map(i => `<i class="${i < pinEntry.length ? "on" : ""}"></i>`).join("")}</div>
        <p class="hint is-error" ${box.dataset.err ? "" : "hidden"}>Falsche PIN</p>
        <div class="pin-pad">${keys.map(k => k ? `<button data-a="pinKey" data-n="${k}" aria-label="${k === "⌫" ? "Löschen" : k}">${k}</button>` : "<span></span>").join("")}</div>
        <button class="link" data-a="pinForgot">PIN vergessen?</button></div>`;
}

function lockNow() {
  if (!pinData()) return;
  pinEntry = "";
  lockForgot = false;
  drawLock();
}

function unlock() {
  const box = document.getElementById("lock");
  if (box) box.remove();
  pinEntry = "";
}

function pinOnStart() { lockNow(); }

function pinOnVisibility() {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (hiddenAt && Date.now() - hiddenAt > LOCK_AFTER_MS) lockNow();
}

Object.assign(window.EXTRA_ACTIONS, {
  loginSheet() { sheet = { mode: "login" }; renderSheet(); },
  logout() {
    const token = session && session.access_token;
    if (token) fetch(`${SUPA.url}/auth/v1/logout`, { method: "POST", headers: { apikey: SUPA.key, Authorization: `Bearer ${token}` } }).catch(() => {});
    supaDisconnect();
    render();
  },
  pinSetup() { sheet = { mode: "pin" }; renderSheet(); },
  async pinSave() {
    const a = document.getElementById("pinNew").value, b = document.getElementById("pinNew2").value;
    if (!/^\d{4}$/.test(a)) { sheet.err = "Die PIN braucht genau 4 Ziffern."; renderSheet(); return; }
    if (a !== b) { sheet.err = "Die beiden PINs sind nicht gleich."; renderSheet(); return; }
    const salt = Array.from(crypto.getRandomValues(new Uint8Array(8))).map(x => x.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(PIN_KEY, JSON.stringify({ salt, hash: await hashPin(a, salt) }));
    closeSheet();
  },
  pinOff() { localStorage.removeItem(PIN_KEY); render(); },
  async pinKey(d) {
    const box = document.getElementById("lock");
    box.dataset.err = "";
    if (d.n === "⌫") pinEntry = pinEntry.slice(0, -1);
    else if (pinEntry.length < 4) pinEntry += d.n;
    drawLock();
    if (pinEntry.length < 4) return;
    const p = pinData();
    if (p && await hashPin(pinEntry, p.salt) === p.hash) { unlock(); return; }
    pinEntry = "";
    box.dataset.err = "1";
    drawLock();
  },
  pinForgot() { lockForgot = true; drawLock(); },
  pinBack() { lockForgot = false; drawLock(); },
  pinWipe() {
    [KEY, PIN_KEY, SESSION_KEY].forEach(k => localStorage.removeItem(k));
    location.reload();
  }
});

/* ---------- Hinweise ---------- */
function backupDue() {
  const last = S.settings.lastBackup;
  const first = firstDay();
  if (!first) return false;
  return addDays(last || first, 7) <= todayKey();
}

function reminderPanel() {
  return `<section class="panel"><h3>Tägliche Erinnerung am iPhone</h3>
    <p class="panel-note">Das geht ohne Server. Öffne die App Kurzbefehle und tippe auf Automation, dann auf Neue Automation. Wähle Tageszeit, zum Beispiel 21:00, täglich und Sofort ausführen. Füge die Aktion Mitteilung anzeigen hinzu, mit dem Text: Zeit für dein Fazit in Stetig.</p>
  </section>`;
}
