(function(){
"use strict";
const $ = id => document.getElementById(id);
const CFG = window.KT_CONFIG || {};
// Nur die Projekt-Adresse verwenden, auch wenn versehentlich ".../rest/v1/" mitkopiert wurde.
const API = String(CFG.supabaseUrl || "").trim().replace(/\/+$/, "").replace(/\/(rest|auth)\/v1$/, "");
const KEY = String(CFG.supabaseKey || "").trim();

const fmt = new Intl.NumberFormat("de-DE", {style:"currency", currency:"EUR"});
const signed = v => (v > 0 ? "+" : v < 0 ? "−" : "") + fmt.format(Math.abs(v));
const dShort = new Intl.DateTimeFormat("de-DE", {weekday:"short", day:"2-digit", month:"2-digit", year:"numeric"});
const dDay = new Intl.DateTimeFormat("de-DE", {weekday:"long", day:"numeric", month:"long"});
const mFmt = new Intl.DateTimeFormat("de-DE", {month:"long", year:"numeric"});
const mShort = new Intl.DateTimeFormat("de-DE", {month:"short"});
const tFmt = new Intl.DateTimeFormat("de-DE", {day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit"});
const CYCLE = {"1":"monatlich", "3":"vierteljährlich", "6":"halbjährlich", "12":"jährlich", "w":"wöchentlich"};
const KINDS = ["category","account","expense","income","transfer","adjust","sub","payment"];
// Feste Kategorien des alten Kosten-Trackers, damit dessen Sicherung eingelesen werden kann.
const OLD_CATS = {lebensmittel:"Lebensmittel", essen:"Essen & Trinken", shopping:"Shopping", mobil:"Auto & Mobilität", wohnen:"Wohnen & Nebenkosten", freizeit:"Freizeit", streaming:"Streaming", gaming:"Gaming", software:"Software & Apps", fitness:"Fitness & Gesundheit", versicherung:"Versicherung", sonstiges:"Sonstiges"};
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]));
const lower = s => String(s || "").trim().toLocaleLowerCase("de");
const clean = s => String(s || "").trim().replace(/\s+/g, " ");
const r2 = n => Math.round(n*100)/100;

// ---------- Datum ----------
const parseDate = s => { const [y,m,d] = s.split("-").map(Number); return new Date(y, m-1, d); };
const toISO = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const today = () => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); };
const daysBetween = (a,b) => Math.round((b-a)/86400000);
const addDays = (d,n) => new Date(d.getFullYear(), d.getMonth(), d.getDate()+n);
function addMonths(d, n, anchor){ const y = d.getFullYear(), m = d.getMonth()+n; const last = new Date(y, m+1, 0).getDate(); return new Date(y, m, Math.min(anchor || d.getDate(), last)); }
const advance = (d, cycle, anchor) => cycle === "w" ? addDays(d, 7) : addMonths(d, Number(cycle), anchor);
const monthKey = d => toISO(d).slice(0,7);
function relative(days){
  if(days < 0) return days === -1 ? "seit gestern überfällig" : `seit ${-days} Tagen überfällig`;
  if(days === 0) return "heute"; if(days === 1) return "morgen"; return `in ${days} Tagen`;
}
const monthlyCost = s => s.cycle === "w" ? s.price*52/12 : s.price/Number(s.cycle);
function parseAmount(str, allowNeg){
  let s = String(str || "").replace(/[\s€]/g, "").replace("−", "-");
  if(s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return isFinite(n) && s !== "" && (allowNeg || n >= 0) ? r2(n) : NaN;
}
const uid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12);

// ---------- Lokaler Speicher ----------
// Alles liegt zuerst lokal, damit die App auch offline geht. Änderungen warten in "pending", bis sie hochgeladen sind.
const LS = {
  get(k, d){ try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch(e){ return d; } },
  set(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch(e){ return false; } },
  del(k){ try { localStorage.removeItem(k); } catch(e){} }
};
let session = LS.get("kt.session", null);
let items = LS.get("kt.items", {});
let pending = LS.get("kt.pending", {});
let lastSync = LS.get("kt.lastSync", "");
let lastSyncAt = LS.get("kt.lastSyncAt", 0);
let storageOk = true;
function persist(){
  storageOk = LS.set("kt.items", items) && LS.set("kt.pending", pending) && LS.set("kt.lastSync", lastSync) && LS.set("kt.lastSyncAt", lastSyncAt);
}

const live = kind => Object.values(items).filter(it => it.kind === kind && !it.deleted).map(it => ({id:it.id, ...it.data}));
function put(kind, id, data){
  const it = {id, kind, data, deleted:false};
  items[id] = {...it, updated_at:(items[id] || {}).updated_at};
  pending[id] = it; persist(); queueSync();
}
function patch(id, fields){ const cur = items[id]; if(cur) put(cur.kind, id, {...cur.data, ...fields}); }
function remove(id){
  const cur = items[id]; if(!cur) return;
  const it = {id, kind:cur.kind, data:{}, deleted:true};
  items[id] = {...it, updated_at:cur.updated_at};
  pending[id] = it; persist(); queueSync();
}

// ---------- Konten ----------
const accounts = () => live("account").sort((a,b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name, "de"));
function accName(id){ if(!id) return ""; const a = items[id]; return a && a.kind === "account" && !a.deleted ? a.data.name : "Gelöschtes Konto"; }
// Alle Geldbewegungen. Positiv = Geld kommt aufs Konto.
function movements(){
  const list = [];
  for(const e of live("expense")) if(e.account) list.push({acc:e.account, date:e.date, amount:-e.amount, label:e.note || catName(e.cat), kind:"Ausgabe", id:e.id, created:e.created});
  for(const i of live("income")) if(i.account) list.push({acc:i.account, date:i.date, amount:+i.amount, label:i.note || catName(i.cat), kind:"Einnahme", id:i.id, created:i.created});
  for(const t of live("transfer")){
    list.push({acc:t.from, date:t.date, amount:-t.amount, label:`→ ${accName(t.to)}${t.note ? " · " + t.note : ""}`, kind:"Umbuchung", id:t.id, created:t.created});
    list.push({acc:t.to, date:t.date, amount:+t.amount, label:`← ${accName(t.from)}${t.note ? " · " + t.note : ""}`, kind:"Umbuchung", id:t.id, created:t.created});
  }
  for(const a of live("adjust")) list.push({acc:a.account, date:a.date, amount:a.amount, label:a.note || "Stand korrigiert", kind:"Korrektur", id:a.id, created:a.created});
  return list;
}
function balances(){
  const b = {};
  for(const a of live("account")) b[a.id] = Number(a.start) || 0;
  for(const m of movements()) if(m.acc in b) b[m.acc] += m.amount;
  for(const k in b) b[k] = r2(b[k]);
  return b;
}
const lastAcc = type => LS.get("kt.lastAcc." + type, "");

// Konto-Auswahl als Knöpfe. Der gewählte Wert steht in data-value.
const accPickers = [];
function setupAccPicker(boxId){
  const box = $(boxId);
  const draw = () => {
    const accs = accounts(), bal = balances(), v = box.dataset.value || "";
    box.innerHTML = accs.length
      ? accs.map(a => `<button type="button" class="chip${a.id === v ? " on" : ""}" data-id="${esc(a.id)}">${esc(a.name)}<small>${fmt.format(bal[a.id] || 0)}</small></button>`).join("")
      : `<span class="hint" style="margin:0">Noch keine Konten. Lege sie unter <b>Vermögen</b> an.</span>`;
  };
  box.addEventListener("click", e => {
    const b = e.target.closest("button.chip"); if(!b) return;
    box.dataset.value = box.dataset.value === b.dataset.id ? "" : b.dataset.id; draw();
  });
  box.setValue = id => { box.dataset.value = id && items[id] && !items[id].deleted ? id : ""; draw(); };
  box.getValue = () => box.dataset.value || "";
  accPickers.push(draw);
  return box;
}

// ---------- Kategorien (getrennt für Einnahmen und Ausgaben) ----------
const catType = c => c.type === "in" ? "in" : "out";
const categories = type => live("category").filter(c => catType(c) === type).sort((a,b) => a.name.localeCompare(b.name, "de"));
function catName(id){ const c = id && items[id]; return c && c.kind === "category" && !c.deleted ? c.data.name : "Ohne Kategorie"; }
function catUsage(){
  const u = {};
  for(const k of ["expense","income","sub","payment"]) for(const x of live(k)) if(x.cat) u[x.cat] = (u[x.cat] || 0) + 1;
  return u;
}
// Name -> ID. Gibt es die Kategorie noch nicht, wird sie angelegt.
function resolveCat(name, type){
  name = clean(name); if(!name) return "";
  const ex = categories(type).find(c => lower(c.name) === lower(name));
  if(ex) return ex.id;
  const id = uid(); put("category", id, {name, type, created:Date.now()}); return id;
}
function renameCat(id, newName){
  newName = clean(newName); const cur = items[id]; if(!newName || !cur) return;
  const type = catType(cur.data);
  const other = categories(type).find(c => c.id !== id && lower(c.name) === lower(newName));
  if(other){
    for(const k of ["expense","income","sub","payment"]) for(const x of live(k)) if(x.cat === id) patch(x.id, {cat:other.id});
    remove(id); toast(`Mit „${other.name}“ zusammengeführt`);
  } else { patch(id, {name:newName}); toast("Umbenannt"); }
}
const pickers = [];
function setupPicker(inputId, chipsId, typeFn){
  const inp = $(inputId), box = $(chipsId);
  const draw = () => {
    const q = lower(inp.value), u = catUsage(), type = typeFn();
    let list = categories(type);
    const exact = list.find(c => lower(c.name) === q);
    if(q && !exact) list = list.filter(c => lower(c.name).includes(q));
    list.sort((a,b) => (u[b.id] || 0) - (u[a.id] || 0) || a.name.localeCompare(b.name, "de"));
    let html = list.slice(0, 16).map(c => `<button type="button" class="chip${exact && exact.id === c.id ? " on" : ""}" data-name="${esc(c.name)}">${esc(c.name)}</button>`).join("");
    if(q && !exact) html += `<span class="chip new">+ „${esc(clean(inp.value))}“ wird neu angelegt</span>`;
    if(!html) html = `<span class="hint" style="margin:0">Noch keine Kategorien. Tippe oben eine ein, z. B. „${type === "in" ? "Arbeit Ciao Ciao" : "Lebensmittel"}“.</span>`;
    box.innerHTML = html;
  };
  inp.addEventListener("input", draw);
  box.addEventListener("click", e => {
    const b = e.target.closest("button.chip"); if(!b) return;
    inp.value = lower(inp.value) === lower(b.dataset.name) ? "" : b.dataset.name; draw();
  });
  pickers.push(draw);
}

// ---------- Supabase: Anmeldung ----------
async function authCall(path, body){
  const r = await fetch(`${API}/auth/v1/${path}`, {method:"POST", headers:{apikey:KEY, "Content-Type":"application/json"}, body:JSON.stringify(body)});
  const j = await r.json().catch(() => ({}));
  if(!r.ok) throw {status:r.status, code:j.error_code || (typeof j.code === "string" ? j.code : "") || j.error || "", msg:j.msg || j.message || j.error_description || ""};
  return j;
}
function saveSession(j){
  session = {
    access_token:j.access_token, refresh_token:j.refresh_token,
    expires_at:j.expires_at || Math.floor(Date.now()/1000) + (j.expires_in || 3600),
    email:(j.user && j.user.email) || (session && session.email) || ""
  };
  LS.set("kt.session", session);
}
let refreshing = null;
async function token(){
  if(!session) throw {auth:true};
  if(session.expires_at - 60 > Date.now()/1000) return session.access_token;
  if(!refreshing){
    refreshing = authCall("token?grant_type=refresh_token", {refresh_token:session.refresh_token})
      .then(saveSession)
      .catch(e => { if(e && e.status >= 400 && e.status < 500){ dropSession(); throw {auth:true}; } throw e; })
      .finally(() => { refreshing = null; });
  }
  await refreshing;
  return session.access_token;
}
function dropSession(){ session = null; LS.del("kt.session"); }
function authErr(e){
  if(e instanceof TypeError) return "Keine Verbindung zum Server. Prüfe das Internet und die Angaben in config.js.";
  const c = String(e.code || ""), m = String(e.msg || "");
  if(c === "invalid_credentials" || /invalid login/i.test(m)) return "E-Mail oder Passwort ist falsch.";
  if(c === "email_not_confirmed" || /not confirmed/i.test(m)) return "Bitte bestätige zuerst den Link in deiner E-Mail.";
  if(c === "user_already_exists" || /already registered/i.test(m)) return "Diese E-Mail hat schon ein Konto. Melde dich an.";
  if(c === "signup_disabled" || /signups not allowed/i.test(m)) return "Neue Konten sind in Supabase gesperrt.";
  if(c === "weak_password" || /password should/i.test(m)) return "Das Passwort ist zu kurz. Mindestens 6 Zeichen.";
  if(/rate limit/i.test(c + m)) return "Zu viele Versuche. Warte kurz und versuche es erneut.";
  if(c === "email_address_invalid" || /invalid.*email/i.test(m)) return "Die E-Mail-Adresse ist ungültig.";
  return "Anmeldung fehlgeschlagen" + (m ? `: ${m}` : ".");
}

// ---------- Supabase: Daten ----------
async function rest(method, query, body, headers, retried){
  const t = await token();
  const r = await fetch(`${API}/rest/v1/items${query}`, {
    method, headers:{apikey:KEY, Authorization:`Bearer ${t}`, "Content-Type":"application/json", ...(headers || {})},
    body: body ? JSON.stringify(body) : undefined
  });
  if(r.status === 401 && !retried){ session.expires_at = 0; return rest(method, query, body, headers, true); }
  if(!r.ok){ const j = await r.json().catch(() => ({})); throw {status:r.status, code:j.code || "", msg:j.message || r.statusText}; }
  return r.status === 204 || r.status === 201 ? null : r.json();
}

let syncing = false, syncAgain = false, syncState = "idle", syncMsg = "", syncTimer = null;
function queueSync(){ clearTimeout(syncTimer); syncTimer = setTimeout(sync, 700); }

async function sync(){
  if(!session || !API) return;
  if(syncing){ syncAgain = true; return; }
  syncing = true; syncState = "busy"; drawSync();
  try {
    do {
      syncAgain = false;
      // 1. Eigene Änderungen hochladen
      const batch = Object.values(pending);
      for(let i = 0; i < batch.length; i += 300){
        await rest("POST", "?on_conflict=id", batch.slice(i, i+300), {Prefer:"resolution=merge-duplicates,return=minimal"});
      }
      for(const it of batch) if(pending[it.id] === it) delete pending[it.id];
      // 2. Änderungen von anderen Geräten holen
      let q = "?select=id,kind,data,deleted,updated_at&order=updated_at.asc";
      if(lastSync) q += "&updated_at=gte." + encodeURIComponent(lastSync);
      for(let offset = 0; ; offset += 1000){
        const rows = await rest("GET", `${q}&limit=1000&offset=${offset}`);
        for(const r of rows){
          if(!pending[r.id]) items[r.id] = r;
          if(r.updated_at > lastSync) lastSync = r.updated_at;
        }
        if(rows.length < 1000) break;
      }
      lastSyncAt = Date.now();
      persist();
    } while(syncAgain);
    syncState = "ok"; syncMsg = "";
  } catch(e){
    if(e && e.auth){ syncState = "err"; syncMsg = "Bitte erneut anmelden."; syncing = false; boot(); return; }
    if(e instanceof TypeError){ syncState = "offline"; syncMsg = "Keine Verbindung. Änderungen bleiben gespeichert und werden später übertragen."; }
    else if(e && e.status === 404){ syncState = "err"; syncMsg = "Die Tabelle „items“ fehlt in Supabase. Führe das SQL aus der Anleitung aus."; }
    else { syncState = "err"; syncMsg = "Sync-Fehler" + (e && e.msg ? `: ${e.msg}` : "."); }
  } finally {
    syncing = false;
  }
  // Abos erst buchen, wenn mindestens einmal alles vom Server geholt wurde. Sonst entstehen Doppelbuchungen mit veralteten Daten.
  if(lastSyncAt) autoBook();
  render();
}

// ---------- Abos automatisch buchen ----------
// Feste ID pro Abbuchung: Buchen PC und Handy dieselbe Abbuchung, entsteht trotzdem nur ein Eintrag.
function autoBook(){
  const t = today();
  for(const s of live("sub")){
    if(!s.next) continue;
    let d = parseDate(s.next), guard = 0;
    while(d < t && guard < 400){
      const iso = toISO(d), id = `abo-${s.id}-${iso}`;
      if((!s.since || iso >= s.since) && !items[id]) put("expense", id, {amount:s.price, date:iso, cat:s.cat || "", account:s.account || "", note:s.name, src:"abo", ref:s.id, created:Date.now()});
      d = advance(d, s.cycle, s.anchorDay); guard++;
    }
    if(guard) patch(s.id, {next:toISO(d)});
  }
}

// ---------- Hilfen ----------
let toastTimer;
function toast(msg){ const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2600); }
function armed(btn){
  if(btn.dataset.armed) return true;
  const label = btn.textContent; btn.dataset.armed = "1"; btn.textContent = "Wirklich?"; btn.classList.add("armed");
  setTimeout(() => { if(btn.isConnected){ delete btn.dataset.armed; btn.textContent = label; btn.classList.remove("armed"); } }, 3500);
  return false;
}
const sum = arr => r2(arr.reduce((a,x) => a + (Number(x.amount) || 0), 0));

// ---------- Zustand der Oberfläche ----------
let tab = LS.get("kt.tab", "uebersicht"), viewMonth = monthKey(today()), txType = "out", txFilter = "all";
let editTx = null, editSub = null, editAcc = null, editCat = null, adjustAcc = null, historyAcc = null, importData = null, installEvt = null;
const TABS = ["uebersicht","buchen","vermoegen","abos","offen","mehr"];

function show(view){
  $("v-setup").hidden = view !== "setup";
  $("v-login").hidden = view !== "login";
  $("v-app").hidden = view !== "app";
  $("sync").hidden = view !== "app";
  $("gear").hidden = view !== "app";
}
function setTab(t, focus){
  if(!TABS.includes(t)) t = "uebersicht";
  tab = t;
  document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
  $("gear").setAttribute("aria-pressed", String(t === "mehr"));
  TABS.forEach(k => $("p-"+k).hidden = k !== t);
  LS.set("kt.tab", t);
  if(focus) setTimeout(() => { const el = $(focus); el.scrollIntoView({block:"center"}); el.focus(); }, 30);
}
function setTxType(type){
  txType = type;
  document.querySelectorAll("[data-type]").forEach(b => { b.classList.toggle("on", b.dataset.type === type); b.classList.toggle("in", b.dataset.type === "in"); });
  $("fx-btn").classList.toggle("in", type === "in");
  $("fx-btn").textContent = editTx ? "Speichern" : type === "in" ? "Einnahme speichern" : "Ausgabe speichern";
  $("fx-catL").firstChild.textContent = type === "in" ? "Quelle / Kategorie" : "Kategorie";
  $("fx-cat").placeholder = type === "in" ? "z. B. Arbeit Ciao Ciao, Trinkgeld" : "Wählen oder neu eintippen";
  $("fx-accL").textContent = type === "in" ? "Eingegangen auf" : "Bezahlt von";
  $("fx-note").placeholder = type === "in" ? "z. B. Lohn Oktober" : "z. B. Rewe, Tanken";
  if(!editTx){ $("fx-cat").value = ""; accFx.setValue(lastAcc(type)); }
  pickers.forEach(p => p());
}

function drawSync(){
  const el = $("sync"), n = Object.keys(pending).length;
  el.className = "sync " + syncState;
  el.querySelector("span").textContent =
    syncState === "busy" ? "Synchronisiere …" :
    syncState === "ok" ? (n ? `${n} Änderung${n === 1 ? "" : "en"} wartet` : "Synchronisiert") :
    syncState === "offline" ? (n ? `Offline · ${n} wartet` : "Offline") :
    syncState === "err" ? "Sync-Fehler" : "Verbinde …";
  const msgs = [];
  if(syncMsg && syncState !== "offline") msgs.push(syncMsg);
  if(!storageOk) msgs.push("Der Browser-Speicher ist voll oder gesperrt. Neue Einträge gehen beim Schließen verloren, wenn sie nicht synchronisiert sind.");
  const ban = $("banner"); ban.hidden = !msgs.length; ban.textContent = msgs.join(" ");
}

// ---------- Anzeige ----------
function render(){
  drawSync();
  pickers.forEach(p => p()); accPickers.forEach(p => p());
  const t = today(), tISO = toISO(t);
  const expenses = live("expense"), incomes = live("income"), payments = live("payment");
  const accs = accounts(), bal = balances();
  const worth = r2(accs.reduce((a,x) => a + (bal[x.id] || 0), 0));
  const openPays = payments.filter(p => p.status !== "paid").sort((a,b) => a.due.localeCompare(b.due));
  const paidPays = payments.filter(p => p.status === "paid").sort((a,b) => (b.paidOn || "").localeCompare(a.paidOn || ""));
  const subs = live("sub").sort((a,b) => a.next.localeCompare(b.next) || a.name.localeCompare(b.name));
  const inMonth = (arr, m) => arr.filter(e => e.date && e.date.slice(0,7) === m);
  const openSum = sum(openPays);
  const loading = !lastSyncAt && !Object.keys(items).length;
  const empty = txt => loading ? "Lade …" : txt;

  $("welcome").hidden = loading || accs.length > 0;

  // ----- Übersicht -----
  const curM = monthKey(t), prevM = monthKey(new Date(t.getFullYear(), t.getMonth()-1, 1));
  const mName = mFmt.format(t).split(" ")[0];
  const inSum = sum(inMonth(incomes, curM)), outSum = sum(inMonth(expenses, curM));
  $("sInL").textContent = "Einnahmen " + mName; $("sOutL").textContent = "Ausgaben " + mName;
  $("sIn").textContent = fmt.format(inSum);
  $("sInS").textContent = `Vormonat: ${fmt.format(sum(inMonth(incomes, prevM)))}`;
  $("sOut").textContent = fmt.format(outSum);
  $("sOutS").textContent = `Vormonat: ${fmt.format(sum(inMonth(expenses, prevM)))}`;
  const bilanz = r2(inSum - outSum);
  $("sBal").textContent = signed(bilanz); $("sBal").className = "v " + (bilanz > 0 ? "pos" : bilanz < 0 ? "neg" : "");
  $("sBalS").textContent = bilanz >= 0 ? "mehr rein als raus" : "mehr raus als rein";
  $("sWorth").textContent = fmt.format(worth); $("sWorth").className = "v" + (worth < 0 ? " neg" : "");
  $("sWorthS").textContent = accs.length ? `${accs.length} Konto${accs.length === 1 ? "" : "en"}` : "noch keine Konten";

  const overdue = openPays.filter(p => p.due < tISO);
  $("sOpen").textContent = fmt.format(openSum); $("sOpen").classList.toggle("neg", overdue.length > 0);
  $("sOpenS").textContent = overdue.length ? `${overdue.length} überfällig` : openPays.length ? `nächste ${dShort.format(parseDate(openPays[0].due))}` : "nichts offen";
  const subMonth = subs.reduce((a,s) => a + monthlyCost(s), 0);
  $("sSubs").textContent = fmt.format(subMonth);
  $("sSubsS").textContent = `${subs.length} Abo${subs.length === 1 ? "" : "s"}`;
  const limit7 = toISO(addDays(t,7));
  const due7 = [...subs.filter(s => s.next <= limit7).map(s => s.price), ...openPays.filter(p => p.due <= limit7).map(p => p.amount)];
  const due7Sum = r2(due7.reduce((a,b) => a+b, 0));
  $("sDue").textContent = fmt.format(due7Sum); $("sDue").classList.toggle("neg", due7Sum > 0);
  $("sDueS").textContent = due7.length ? `${due7.length} Zahlung${due7.length === 1 ? "" : "en"}` : "nichts fällig";
  const badge = $("openBadge"); badge.hidden = overdue.length === 0; badge.textContent = overdue.length;

  // 6-Monats-Diagramm
  const months = [];
  for(let i = 5; i >= 0; i--){ const d = new Date(t.getFullYear(), t.getMonth()-i, 1); months.push({d, k:monthKey(d)}); }
  months.forEach(m => { m.inc = sum(inMonth(incomes, m.k)); m.out = sum(inMonth(expenses, m.k)); });
  const cmax = Math.max(1, ...months.map(m => Math.max(m.inc, m.out)));
  $("chart").innerHTML = months.map(m => {
    const diff = r2(m.inc - m.out);
    return `<div class="col" title="${esc(mFmt.format(m.d))}: Einnahmen ${fmt.format(m.inc)}, Ausgaben ${fmt.format(m.out)}">
      <div class="pair"><div class="b in" style="height:${m.inc/cmax*100}%"></div><div class="b out" style="height:${m.out/cmax*100}%"></div></div>
      <div class="m">${esc(mShort.format(m.d))}</div><div class="d ${diff > 0 ? "pos" : diff < 0 ? "neg" : ""}">${m.inc || m.out ? signed(Math.round(diff)).replace(/,00/, "") : "–"}</div></div>`;
  }).join("");

  const limit30 = toISO(addDays(t,30));
  const up = [
    ...subs.filter(s => s.next <= limit30).map(s => ({date:s.next, name:s.name, amount:s.price, tag:"Abo", cls:"", acc:s.account})),
    ...openPays.filter(p => p.due <= limit30).map(p => ({date:p.due, name:p.merchant + (p.parts > 1 ? ` · Rate ${p.part}/${p.parts}` : ""), amount:p.amount, tag:p.provider, cls:"pay", acc:p.account}))
  ].sort((a,b) => a.date.localeCompare(b.date));
  $("upcoming").innerHTML = up.length ? up.map(u => {
    const days = daysBetween(t, parseDate(u.date));
    return `<li class="row${days <= 7 ? " due" : ""}"><div><div class="name">${esc(u.name)}<span class="tag ${u.cls}">${esc(u.tag)}</span></div>${u.acc ? `<div class="meta">von ${esc(accName(u.acc))}</div>` : ""}</div>
      <div class="when">${dShort.format(parseDate(u.date))} · ${relative(days)}</div><div class="amt">${fmt.format(u.amount)}</div></li>`;
  }).join("") : `<li class="empty">${empty("In den nächsten 30 Tagen ist nichts fällig.")}</li>`;

  const catBars = (arr, cls) => {
    const by = {};
    arr.forEach(e => { const n = catName(e.cat); by[n] = (by[n] || 0) + (Number(e.amount) || 0); });
    const rows = Object.entries(by).sort((a,b) => b[1]-a[1]);
    const max = rows.length ? rows[0][1] : 0;
    return rows.map(([n,v]) => `<div class="bar"><span title="${esc(n)}">${esc(n)}</span><div class="track"><div class="fill ${cls}" style="width:${max ? Math.max(2, v/max*100) : 0}%"></div></div><span class="n">${fmt.format(v)}</span></div>`).join("");
  };
  $("inCatTitle").textContent = `Einnahmen nach Quelle · ${mFmt.format(t)}`;
  $("catTitle").textContent = `Ausgaben nach Kategorie · ${mFmt.format(t)}`;
  $("inCats").innerHTML = catBars(inMonth(incomes, curM), "in") || `<p class="empty">${empty("Diesen Monat noch keine Einnahmen.")}</p>`;
  $("cats").innerHTML = catBars(inMonth(expenses, curM), "") || `<p class="empty">${empty("Diesen Monat noch keine Ausgaben.")}</p>`;

  // ----- Buchen -----
  const vm = parseDate(viewMonth + "-01");
  $("mLabel").textContent = mFmt.format(vm);
  const mi = inMonth(incomes, viewMonth), mo = inMonth(expenses, viewMonth);
  const mb = r2(sum(mi) - sum(mo));
  $("mSum").innerHTML = `<span class="pos">+${fmt.format(sum(mi))}</span> · −${fmt.format(sum(mo))} · <b class="${mb > 0 ? "pos" : mb < 0 ? "neg" : ""}">${signed(mb)}</b>`;
  document.querySelectorAll("[data-filter]").forEach(b => b.classList.toggle("on", b.dataset.filter === txFilter));
  const tx = [
    ...(txFilter !== "out" ? mi.map(x => ({...x, type:"in"})) : []),
    ...(txFilter !== "in" ? mo.map(x => ({...x, type:"out"})) : [])
  ].sort((a,b) => b.date.localeCompare(a.date) || (b.created || 0) - (a.created || 0));
  if(!tx.length){ $("txList").innerHTML = `<p class="empty">${empty("Keine Buchungen in diesem Monat.")}</p>`; }
  else {
    let html = "", lastDay = "";
    for(const e of tx){
      if(e.date !== lastDay){ if(lastDay) html += "</ul>"; html += `<div class="day">${dDay.format(parseDate(e.date))}</div><ul>`; lastDay = e.date; }
      const tag = e.src === "abo" ? `<span class="tag">Abo</span>` : e.src === "pay" ? `<span class="tag pay">Rechnung</span>` : "";
      const meta = [e.note ? catName(e.cat) : "", e.account ? (e.type === "in" ? "auf " : "von ") + accName(e.account) : ""].filter(Boolean).join(" · ");
      html += `<li class="row"><div><div class="name">${esc(e.note || catName(e.cat))}${tag}</div>${meta ? `<div class="meta">${esc(meta)}</div>` : ""}</div><div class="amt ${e.type === "in" ? "pos" : ""}">${e.type === "in" ? "+" : "−"}${fmt.format(e.amount)}</div>
        <div class="actions"><button class="link" data-act="tx-edit" data-id="${esc(e.id)}">Bearbeiten</button><button class="link" data-act="tx-del" data-id="${esc(e.id)}">Löschen</button></div></li>`;
    }
    $("txList").innerHTML = html + "</ul>";
  }

  // ----- Vermögen -----
  $("worth").textContent = fmt.format(worth); $("worth").classList.toggle("neg", worth < 0);
  $("worthS").textContent = openSum ? `Nach offenen Rechnungen: ${fmt.format(r2(worth - openSum))}` : "";
  const mv = movements(), mvCount = {};
  mv.forEach(m => mvCount[m.acc] = (mvCount[m.acc] || 0) + 1);
  const posTotal = accs.reduce((a,x) => a + Math.max(0, bal[x.id] || 0), 0);
  $("accList").innerHTML = accs.length ? accs.map(a => {
    const b = bal[a.id] || 0, share = posTotal ? Math.max(0, b)/posTotal*100 : 0;
    let extra = "";
    if(adjustAcc === a.id) extra = `<div class="inline"><input id="adjInput" inputmode="decimal" placeholder="Tatsächlicher Stand" value="${String(b).replace(".", ",")}" aria-label="Tatsächlicher Stand"><button class="primary" data-act="acc-adjust-save" data-id="${esc(a.id)}">Übernehmen</button><button data-act="acc-adjust-cancel">Abbrechen</button></div>`;
    return `<li class="row${historyAcc === a.id ? " sel" : ""}"><div><div class="name">${esc(a.name)}</div>
      <div class="bar" style="grid-template-columns:minmax(0,1fr) 40px;margin-top:4px"><div class="track"><div class="fill" style="width:${share}%"></div></div><span class="meta" style="text-align:right">${Math.round(share)} %</span></div></div>
      <div class="amt ${b < 0 ? "neg" : ""}" style="font-size:1.05rem">${fmt.format(b)}</div>
      <div class="actions"><button class="link" data-act="acc-history" data-id="${esc(a.id)}">Verlauf (${mvCount[a.id] || 0})</button><button class="link" data-act="acc-adjust" data-id="${esc(a.id)}">Stand korrigieren</button><button class="link" data-act="acc-edit" data-id="${esc(a.id)}">Bearbeiten</button><button class="link" data-act="acc-del" data-id="${esc(a.id)}">Löschen</button></div>${extra}</li>`;
  }).join("") : `<li class="empty">${empty("Noch keine Konten. Lege unten dein erstes an.")}</li>`;

  // Verlauf eines Kontos mit laufendem Stand
  const hAcc = historyAcc && items[historyAcc] && !items[historyAcc].deleted ? items[historyAcc] : null;
  $("historyCard").hidden = !hAcc;
  if(hAcc){
    const list = mv.filter(m => m.acc === historyAcc).sort((a,b) => a.date.localeCompare(b.date) || (a.created || 0) - (b.created || 0));
    let run = Number(hAcc.data.start) || 0;
    const rows = list.map(m => { run = r2(run + m.amount); return {...m, run}; }).reverse();
    $("historyTitle").innerHTML = `Verlauf · ${esc(hAcc.data.name)} <button class="link" data-act="acc-history-close" style="float:right">Schließen</button>`;
    $("historyList").innerHTML = rows.map(m => `<li class="row"><div><div class="name">${esc(m.label)}</div><div class="meta">${esc(m.kind)} · ${dShort.format(parseDate(m.date))}</div></div><div class="when meta">Stand ${fmt.format(m.run)}</div><div class="amt ${m.amount > 0 ? "pos" : ""}">${signed(m.amount)}</div></li>`).join("")
      + `<li class="row"><div><div class="name">Anfangsstand</div></div><div></div><div class="amt">${fmt.format(Number(hAcc.data.start) || 0)}</div></li>`;
  }

  // Umbuchungs-Formular
  const opts = accs.map(a => `<option value="${esc(a.id)}">${esc(a.name)} (${fmt.format(bal[a.id] || 0)})</option>`).join("");
  for(const id of ["fm-from","fm-to"]){ const s = $(id), v = s.value; s.innerHTML = opts; if(v && accs.some(a => a.id === v)) s.value = v; }
  if(accs.length > 1 && $("fm-from").value === $("fm-to").value) $("fm-to").selectedIndex = 1;
  $("moveCard").hidden = accs.length < 2;
  const moves = live("transfer").sort((a,b) => b.date.localeCompare(a.date) || (b.created || 0) - (a.created || 0)).slice(0, 10);
  $("moveList").innerHTML = moves.length ? moves.map(m => `<li class="row"><div><div class="name">${esc(accName(m.from))} → ${esc(accName(m.to))}</div><div class="meta">${dShort.format(parseDate(m.date))}${m.note ? " · " + esc(m.note) : ""}</div></div><div class="amt">${fmt.format(m.amount)}</div>
    <div class="actions"><button class="link" data-act="move-del" data-id="${esc(m.id)}">Löschen</button></div></li>`).join("") : `<li class="empty">Noch nichts verschoben.</li>`;

  // ----- Abos -----
  $("subsSum").textContent = subs.length ? `(${fmt.format(subMonth)} / Monat)` : "";
  $("subList").innerHTML = subs.length ? subs.map(s => {
    const days = daysBetween(t, parseDate(s.next));
    return `<li class="row${days <= 7 ? " due" : ""}"><div><div class="name">${esc(s.name)}</div><div class="meta">${CYCLE[s.cycle] || ""} · ${fmt.format(monthlyCost(s))} / Monat · ${esc(catName(s.cat))}${s.account ? " · von " + esc(accName(s.account)) : ""}</div></div>
      <div class="when">${dShort.format(parseDate(s.next))} · ${relative(days)}</div><div class="amt">${fmt.format(s.price)}</div>
      <div class="actions"><button class="link" data-act="sub-edit" data-id="${esc(s.id)}">Bearbeiten</button><button class="link" data-act="sub-del" data-id="${esc(s.id)}">Löschen</button></div></li>`;
  }).join("") : `<li class="empty">${empty("Noch keine Abos.")}</li>`;

  // ----- Offen -----
  $("openSum").textContent = openPays.length ? `(${fmt.format(openSum)})` : "";
  const payRow = (p, paid) => {
    const days = daysBetween(t, parseDate(p.due));
    const label = p.merchant + (p.parts > 1 ? ` · Rate ${p.part}/${p.parts}` : "");
    const when = paid ? `bezahlt am ${dShort.format(parseDate(p.paidOn || p.due))}` : `${dShort.format(parseDate(p.due))} · ${relative(days)}`;
    return `<li class="row${!paid && days <= 7 ? " due" : ""}${paid ? " paid" : ""}"><div><div class="name">${esc(label)}<span class="tag pay">${esc(p.provider)}</span></div><div class="meta">${esc(catName(p.cat))}${p.account ? " · von " + esc(accName(p.account)) : ""}</div></div>
      <div class="when">${when}</div><div class="amt">${fmt.format(p.amount)}</div>
      <div class="actions"><label class="chk"><input type="checkbox" data-act="pay-toggle" data-id="${esc(p.id)}" ${paid ? "checked" : ""}> bezahlt</label><button class="link" data-act="pay-del" data-id="${esc(p.id)}">Löschen</button></div></li>`;
  };
  $("payList").innerHTML = openPays.length ? openPays.map(p => payRow(p, false)).join("") : `<li class="empty">${empty("Keine offenen Rechnungen.")}</li>`;
  $("paidWrap").hidden = paidPays.length === 0;
  $("paidSummary").textContent = `Bezahlt (${paidPays.length})`;
  $("paidList").innerHTML = paidPays.slice(0, 30).map(p => payRow(p, true)).join("");

  // ----- Einstellungen -----
  const u = catUsage();
  const catRows = type => {
    const cats = categories(type);
    return cats.length ? cats.map(c => editCat === c.id
      ? `<li class="catrow"><input id="catEditInput" value="${esc(c.name)}" aria-label="Neuer Name"><button class="primary" data-act="cat-save" data-id="${esc(c.id)}">Speichern</button><button data-act="cat-cancel">Abbrechen</button></li>`
      : `<li class="catrow"><span class="name">${esc(c.name)}</span><span class="meta">${u[c.id] || 0}×</span><button class="link" data-act="cat-edit" data-id="${esc(c.id)}">Umbenennen</button><button class="link" data-act="cat-del" data-id="${esc(c.id)}">Löschen</button></li>`
    ).join("") : `<li class="empty">Noch keine.</li>`;
  };
  $("catListIn").innerHTML = catRows("in");
  $("catListOut").innerHTML = catRows("out");
  const n = Object.keys(pending).length;
  $("acctInfo").textContent = session
    ? `Angemeldet als ${session.email || "?"}. ${lastSyncAt ? "Zuletzt synchronisiert: " + tFmt.format(new Date(lastSyncAt)) + "." : "Noch nicht synchronisiert."}${n ? ` ${n} Änderung${n === 1 ? "" : "en"} noch nicht übertragen.` : ""}`
    : "";
  renderInstall();
}

function renderInstall(){
  const standalone = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  let html;
  if(standalone) html = `<p class="meta" style="margin:0">Läuft als installierte App.</p>`;
  else if(installEvt) html = `<button class="primary" data-act="install">Als App installieren</button>`;
  else if(ios) html = `<ol class="steps"><li>Diese Seite in <b>Safari</b> öffnen.</li><li>Unten auf <b>Teilen</b> tippen (Quadrat mit Pfeil).</li><li><b>Zum Home-Bildschirm</b> wählen und <b>Hinzufügen</b>.</li><li>Die App über das neue Symbol öffnen und dort einmal anmelden.</li></ol>`;
  else html = `<ol class="steps"><li>In <b>Edge</b>: oben rechts <b>…</b> → <b>Apps</b> → <b>Diese Website als App installieren</b>.</li><li>In <b>Chrome</b>: rechts in der Adressleiste das Installieren-Symbol anklicken.</li><li>Die App startet danach in einem eigenen Fenster und steht im Startmenü.</li></ol>`;
  $("installBox").innerHTML = html;
}

// ---------- Buchen (Einnahme / Ausgabe) ----------
const accFx = setupAccPicker("fx-acc"), accFs = setupAccPicker("fs-acc"), accFp = setupAccPicker("fp-acc");
function resetTx(){
  editTx = null; $("fx").reset(); $("fx-date").value = toISO(today()); $("fx-cancel").hidden = true;
  setTxType(txType);
}
$("fx").addEventListener("submit", e => {
  e.preventDefault();
  const amount = parseAmount($("fx-amount").value);
  if(isNaN(amount) || amount === 0){ toast("Bitte einen gültigen Betrag eingeben, z. B. 12,50."); $("fx-amount").focus(); return; }
  const kind = txType === "in" ? "income" : "expense";
  const account = accFx.getValue();
  const data = {amount, cat:resolveCat($("fx-cat").value, txType), date:$("fx-date").value, note:clean($("fx-note").value), account};
  if(account) LS.set("kt.lastAcc." + txType, account);
  if(editTx){
    const cur = items[editTx];
    // Art geändert (Ausgabe ↔ Einnahme): Eintrag unter neuer Art speichern
    if(cur && cur.kind !== kind) put(kind, editTx, {...cur.data, ...data, src:"manual"});
    else patch(editTx, data);
  } else put(kind, uid(), {...data, src:"manual", created:Date.now()});
  toast(editTx ? "Gespeichert" : `${txType === "in" ? "+" : "−"}${fmt.format(amount)} gebucht${account ? (txType === "in" ? " auf " : " von ") + accName(account) : ""}`);
  viewMonth = data.date.slice(0,7); resetTx(); render(); $("fx-amount").focus();
});
$("fx-cancel").addEventListener("click", () => { resetTx(); render(); });
document.querySelectorAll("[data-type]").forEach(b => b.addEventListener("click", () => setTxType(b.dataset.type)));
document.querySelectorAll("[data-filter]").forEach(b => b.addEventListener("click", () => { txFilter = b.dataset.filter; render(); }));

// ---------- Konten ----------
function resetAcc(){
  editAcc = null; $("fa").reset();
  $("faTitle").textContent = "Konto anlegen"; $("fa-btn").textContent = "Konto anlegen"; $("fa-cancel").hidden = true;
  $("fa-startL").firstChild.textContent = "Aktueller Stand (€)";
}
$("fa").addEventListener("submit", e => {
  e.preventDefault();
  const name = clean($("fa-name").value); if(!name) return;
  const start = parseAmount($("fa-start").value, true);
  if(isNaN(start)){ toast("Bitte einen gültigen Betrag eingeben, z. B. 1000 oder -250."); $("fa-start").focus(); return; }
  if(live("account").some(a => a.id !== editAcc && lower(a.name) === lower(name))){ toast("Ein Konto mit diesem Namen gibt es schon."); return; }
  if(editAcc) patch(editAcc, {name, start});
  else put("account", uid(), {name, start, order:Date.now(), created:Date.now()});
  toast(editAcc ? "Konto gespeichert" : `Konto „${name}“ angelegt`); resetAcc(); render();
});
$("fa-cancel").addEventListener("click", resetAcc);

$("fm").addEventListener("submit", e => {
  e.preventDefault();
  const from = $("fm-from").value, to = $("fm-to").value, amount = parseAmount($("fm-amount").value);
  if(!from || !to || from === to){ toast("Bitte zwei verschiedene Konten wählen."); return; }
  if(isNaN(amount) || amount === 0){ toast("Bitte einen gültigen Betrag eingeben."); $("fm-amount").focus(); return; }
  put("transfer", uid(), {from, to, amount, date:$("fm-date").value, note:clean($("fm-note").value), created:Date.now()});
  toast(`${fmt.format(amount)} von ${accName(from)} nach ${accName(to)} verschoben`);
  $("fm-amount").value = ""; $("fm-note").value = ""; render();
});

// Stand korrigieren: Differenz als Korrekturbuchung speichern, damit der Verlauf nachvollziehbar bleibt.
function saveAdjust(id){
  const i = $("adjInput"); if(!i) return;
  const actual = parseAmount(i.value, true);
  if(isNaN(actual)){ toast("Bitte einen gültigen Betrag eingeben."); i.focus(); return; }
  const diff = r2(actual - (balances()[id] || 0));
  if(diff !== 0) put("adjust", uid(), {account:id, amount:diff, date:toISO(today()), note:"Stand korrigiert", created:Date.now()});
  adjustAcc = null; toast(diff ? `Korrigiert um ${signed(diff)}` : "Stand stimmt bereits"); render();
}

// ---------- Abos ----------
function resetSub(){
  editSub = null; $("fs").reset(); $("fs-next").value = toISO(today()); accFs.setValue(lastAcc("out"));
  $("fsTitle").textContent = "Abo hinzufügen"; $("fs-btn").textContent = "Hinzufügen"; $("fs-cancel").hidden = true;
  pickers.forEach(p => p());
}
$("fs").addEventListener("submit", e => {
  e.preventDefault();
  const price = parseAmount($("fs-price").value);
  if(isNaN(price)){ toast("Bitte einen gültigen Preis eingeben, z. B. 9,99."); $("fs-price").focus(); return; }
  const name = clean($("fs-name").value); if(!name) return;
  const next = $("fs-next").value;
  const data = {name, price, cycle:$("fs-cycle").value, next, anchorDay:parseDate(next).getDate(), cat:resolveCat($("fs-cat").value, "out"), account:accFs.getValue()};
  if(editSub) patch(editSub, data);
  else put("sub", uid(), {...data, since:toISO(today()), created:Date.now()});
  toast("Gespeichert"); resetSub(); if(lastSyncAt) autoBook(); render();
});
$("fs-cancel").addEventListener("click", resetSub);

// ---------- Offene Rechnungen ----------
function resetPay(){
  $("fp").reset(); $("fp-due").value = toISO(addDays(today(), 14)); $("fp-gap").disabled = true; accFp.setValue(lastAcc("out"));
  pickers.forEach(p => p());
}
$("fp").addEventListener("submit", e => {
  e.preventDefault();
  const total = parseAmount($("fp-amount").value);
  if(isNaN(total) || total === 0){ toast("Bitte einen gültigen Betrag eingeben."); $("fp-amount").focus(); return; }
  const merchant = clean($("fp-merchant").value); if(!merchant) return;
  const parts = Number($("fp-parts").value), gap = $("fp-gap").value, first = parseDate($("fp-due").value);
  const provider = $("fp-provider").value, cat = resolveCat($("fp-cat").value, "out"), group = uid(), account = accFp.getValue();
  const cents = Math.round(total*100), base = Math.floor(cents/parts);
  for(let i = 0; i < parts; i++){
    const due = gap === "1m" ? addMonths(first, i, first.getDate()) : addDays(first, 30*i);
    const amount = (i === parts-1 ? cents - base*(parts-1) : base)/100;
    put("payment", uid(), {merchant, provider, cat, account, amount, due:toISO(due), part:i+1, parts, group, status:"open", created:Date.now()});
  }
  toast(parts > 1 ? `${parts} Raten eingetragen` : "Eingetragen"); resetPay(); render();
});
$("fp-parts").addEventListener("change", () => { $("fp-gap").disabled = $("fp-parts").value === "1"; });

// ---------- Anmeldung ----------
function loginMsg(text, ok){ const m = $("li-msg"); m.textContent = text; m.className = "msg" + (ok ? " ok" : ""); }
async function doAuth(mode){
  const email = $("li-email").value.trim(), pw = $("li-pw").value;
  if(!email || !pw){ loginMsg("Bitte E-Mail und Passwort eingeben."); return; }
  if(pw.length < 6){ loginMsg("Das Passwort braucht mindestens 6 Zeichen."); return; }
  const btns = [$("li-login"), $("li-signup")]; btns.forEach(b => b.disabled = true);
  loginMsg(mode === "signup" ? "Erstelle Konto …" : "Melde an …", true);
  try {
    if(mode === "signup"){
      const j = await authCall("signup", {email, password:pw});
      if(!j.access_token){ loginMsg("Konto erstellt. Klicke den Bestätigungslink in deiner E-Mail und melde dich dann hier an.", true); return; }
      saveSession(j);
    } else {
      saveSession(await authCall("token?grant_type=password", {email, password:pw}));
    }
    // Anderes Konto als zuletzt: lokale Daten des alten Kontos verwerfen.
    const owner = LS.get("kt.owner", "");
    if(owner && lower(owner) !== lower(session.email)){ items = {}; pending = {}; lastSync = ""; lastSyncAt = 0; persist(); }
    LS.set("kt.owner", session.email);
    $("li-pw").value = ""; loginMsg("");
    boot();
  } catch(e){ loginMsg(authErr(e)); }
  finally { btns.forEach(b => b.disabled = false); }
}
$("loginForm").addEventListener("submit", e => { e.preventDefault(); doAuth("login"); });
$("li-signup").addEventListener("click", () => doAuth("signup"));

function logout(){
  const n = Object.keys(pending).length;
  if(n && !confirm(`${n} Änderung${n === 1 ? " ist" : "en sind"} noch nicht übertragen und gehen verloren. Trotzdem abmelden?`)) return;
  const t = session && session.access_token;
  if(t) fetch(`${API}/auth/v1/logout`, {method:"POST", headers:{apikey:KEY, Authorization:`Bearer ${t}`}}).catch(() => {});
  dropSession(); items = {}; pending = {}; lastSync = ""; lastSyncAt = 0; persist(); LS.del("kt.owner");
  boot();
}

// ---------- Klicks ----------
document.addEventListener("click", async e => {
  const b = e.target.closest("[data-act]"); if(!b || b.tagName === "INPUT") return;
  const act = b.dataset.act, id = b.dataset.id;
  if(act === "goto-out"){ setTab("buchen"); setTxType("out"); setTab("buchen", "fx-amount"); }
  else if(act === "goto-in"){ setTab("buchen"); setTxType("in"); setTab("buchen", "fx-amount"); }
  else if(act === "goto-move"){ setTab("vermoegen", accounts().length > 1 ? "fm-amount" : "fa-name"); }
  else if(act === "goto-acc"){ setTab("vermoegen", "fa-name"); }
  else if(act === "month"){ const d = parseDate(viewMonth + "-01"); viewMonth = monthKey(new Date(d.getFullYear(), d.getMonth() + Number(b.dataset.d), 1)); render(); }
  else if(act === "tx-edit"){
    const cur = items[id]; if(!cur || cur.deleted) return;
    const x = cur.data; editTx = id;
    setTxType(cur.kind === "income" ? "in" : "out");
    $("fx-amount").value = String(x.amount).replace(".", ","); $("fx-date").value = x.date; $("fx-note").value = x.note || "";
    $("fx-cat").value = x.cat && items[x.cat] && !items[x.cat].deleted ? catName(x.cat) : "";
    accFx.setValue(x.account); $("fx-btn").textContent = "Speichern"; $("fx-cancel").hidden = false;
    pickers.forEach(p => p()); window.scrollTo({top:0, behavior:"smooth"}); $("fx-amount").focus();
  }
  else if(act === "tx-del"){ if(!armed(b)) return; remove(id); if(editTx === id) resetTx(); toast("Gelöscht"); render(); }
  else if(act === "acc-history"){ historyAcc = historyAcc === id ? null : id; render(); if(historyAcc) $("historyCard").scrollIntoView({behavior:"smooth", block:"start"}); }
  else if(act === "acc-history-close"){ historyAcc = null; render(); }
  else if(act === "acc-adjust"){ adjustAcc = id; render(); const i = $("adjInput"); if(i){ i.focus(); i.select(); } }
  else if(act === "acc-adjust-cancel"){ adjustAcc = null; render(); }
  else if(act === "acc-adjust-save"){ saveAdjust(id); }
  else if(act === "acc-edit"){
    const a = items[id]; if(!a) return; editAcc = id;
    $("fa-name").value = a.data.name; $("fa-start").value = String(a.data.start).replace(".", ",");
    $("faTitle").textContent = "Konto bearbeiten"; $("fa-btn").textContent = "Speichern"; $("fa-cancel").hidden = false;
    $("fa-startL").firstChild.textContent = "Anfangsstand (€)";
    $("fa-name").scrollIntoView({block:"center"}); $("fa-name").focus();
  }
  else if(act === "acc-del"){
    const n = movements().filter(m => m.acc === id).length;
    if(!armed(b)) return;
    remove(id); if(historyAcc === id) historyAcc = null;
    toast(n ? `Konto gelöscht. ${n} Buchungen bleiben, zählen aber zu keinem Konto mehr.` : "Konto gelöscht"); render();
  }
  else if(act === "move-del"){ if(!armed(b)) return; remove(id); toast("Umbuchung gelöscht"); render(); }
  else if(act === "sub-edit"){
    const s = live("sub").find(z => z.id === id); if(!s) return;
    editSub = id; $("fs-name").value = s.name; $("fs-price").value = String(s.price).replace(".", ","); $("fs-cycle").value = s.cycle; $("fs-next").value = s.next;
    $("fs-cat").value = s.cat && items[s.cat] && !items[s.cat].deleted ? catName(s.cat) : ""; accFs.setValue(s.account);
    $("fsTitle").textContent = "Abo bearbeiten"; $("fs-btn").textContent = "Speichern"; $("fs-cancel").hidden = false;
    pickers.forEach(p => p()); window.scrollTo({top:0, behavior:"smooth"}); $("fs-name").focus();
  }
  else if(act === "sub-del"){ if(!armed(b)) return; remove(id); if(editSub === id) resetSub(); toast("Abo gelöscht. Bereits gebuchte Ausgaben bleiben."); render(); }
  else if(act === "pay-del"){ if(!armed(b)) return; remove(id); toast("Gelöscht"); render(); }
  else if(act === "cat-edit"){ editCat = id; render(); const i = $("catEditInput"); if(i){ i.focus(); i.select(); } }
  else if(act === "cat-cancel"){ editCat = null; render(); }
  else if(act === "cat-save"){ const i = $("catEditInput"); if(i) renameCat(id, i.value); editCat = null; render(); }
  else if(act === "cat-del"){
    const used = catUsage()[id] || 0;
    if(!armed(b)) return;
    remove(id); toast(used ? `Gelöscht. ${used} Einträge sind jetzt ohne Kategorie.` : "Gelöscht"); render();
  }
  else if(act === "sync-now"){ sync(); }
  else if(act === "logout"){ logout(); }
  else if(act === "export"){ exportData(); }
  else if(act === "import-pick"){ $("importFile").click(); }
  else if(act === "import-go"){ runImport(); }
  else if(act === "import-cancel"){ importData = null; $("importBox").hidden = true; }
  else if(act === "install" && installEvt){ installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; renderInstall(); }
});
document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));
$("gear").addEventListener("click", () => setTab(tab === "mehr" ? "uebersicht" : "mehr"));
$("sync").addEventListener("click", () => sync());
document.addEventListener("keydown", e => {
  if(e.target.id === "catEditInput"){
    if(e.key === "Enter"){ e.preventDefault(); renameCat(editCat, e.target.value); editCat = null; render(); }
    if(e.key === "Escape"){ editCat = null; render(); }
  }
  if(e.target.id === "adjInput"){
    if(e.key === "Enter"){ e.preventDefault(); saveAdjust(adjustAcc); }
    if(e.key === "Escape"){ adjustAcc = null; render(); }
  }
});

document.addEventListener("change", e => {
  const c = e.target; if(c.dataset.act !== "pay-toggle") return;
  const p = live("payment").find(z => z.id === c.dataset.id); if(!p) return;
  if(c.checked){
    const paidOn = toISO(today());
    patch(p.id, {status:"paid", paidOn});
    put("expense", "pay-" + p.id, {amount:p.amount, date:paidOn, cat:p.cat || "", account:p.account || "", note:p.merchant + (p.parts > 1 ? ` (Rate ${p.part}/${p.parts})` : ""), src:"pay", ref:p.id, created:Date.now()});
    toast(p.account ? `Bezahlt und von ${accName(p.account)} abgezogen` : "Als bezahlt markiert und unter Ausgaben gebucht");
  } else {
    patch(p.id, {status:"open", paidOn:null}); remove("pay-" + p.id); toast("Wieder offen");
  }
  render();
});

// ---------- Sicherung ----------
function exportData(){
  const data = {app:"kosten-app", version:2, exported:new Date().toISOString(),
    items:Object.values(items).filter(i => !i.deleted).map(({id, kind, data}) => ({id, kind, data}))};
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `kosten-tracker-${toISO(today())}.json`;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  toast("Sicherung gespeichert");
}
$("importFile").addEventListener("change", () => {
  const f = $("importFile").files[0]; if(!f) return;
  const r = new FileReader();
  r.onload = () => {
    $("importFile").value = "";
    try {
      const d = JSON.parse(r.result);
      let info;
      if(d && d.app === "kosten-app" && Array.isArray(d.items)){
        const c = k => d.items.filter(i => i && i.kind === k).length;
        info = `${c("income")} Einnahmen, ${c("expense")} Ausgaben, ${c("account")} Konten, ${c("sub")} Abos, ${c("payment")} Rechnungen`;
      } else if(d && Array.isArray(d.expenses) && Array.isArray(d.subs) && Array.isArray(d.payments)){
        info = `${d.expenses.length} Ausgaben, ${d.subs.length} Abos, ${d.payments.length} Rechnungen (alter Kosten-Tracker)`;
      } else throw 0;
      importData = d;
      $("importBox").hidden = false;
      $("importBox").innerHTML = `Sicherung vom ${esc(d.exported ? dShort.format(new Date(d.exported)) : "?")}: ${esc(info)}. Einträge mit gleicher ID werden überschrieben, andere bleiben. <div class="quick"><button class="primary" data-act="import-go">Einlesen</button><button data-act="import-cancel">Abbrechen</button></div>`;
    } catch(e){ toast("Die Datei ist keine gültige Sicherung."); }
  };
  r.readAsText(f);
});
function runImport(){
  if(!importData) return;
  const d = importData; importData = null;
  let n = 0;
  if(d.app === "kosten-app"){
    for(const it of d.items){ if(it && typeof it.id === "string" && KINDS.includes(it.kind) && it.data){ put(it.kind, it.id, it.data); n++; } }
  } else {
    // Alter Kosten-Tracker: feste Kategorie-Schlüssel in eigene Kategorien umwandeln.
    const map = {};
    const mapCat = k => { if(!k) return ""; if(!(k in map)) map[k] = resolveCat(OLD_CATS[k] || k, "out"); return map[k]; };
    for(const [kind, arr] of [["expense", d.expenses], ["sub", d.subs], ["payment", d.payments]]){
      for(const x of arr){ if(!x || typeof x.id !== "string") continue; const {id, ...body} = x; put(kind, id, {...body, cat:mapCat(body.cat)}); n++; }
    }
  }
  $("importBox").textContent = `${n} Einträge eingelesen. Sie werden jetzt synchronisiert.`;
  render();
}

// ---------- Start ----------
function boot(){
  if(!API || !KEY){ show("setup"); return; }
  if(!session){ show("login"); $("li-email").value = LS.get("kt.owner", "") || ""; return; }
  show("app"); setTab(tab); render(); sync();
}

setupPicker("fx-cat", "fx-chips", () => txType);
setupPicker("fs-cat", "fs-chips", () => "out");
setupPicker("fp-cat", "fp-chips", () => "out");
$("fm-date").value = toISO(today());
resetTx(); resetSub(); resetPay(); resetAcc();
boot();

document.addEventListener("visibilitychange", () => { if(!document.hidden && session){ render(); sync(); } });
window.addEventListener("online", () => { if(session) sync(); });
setInterval(() => { if(!document.hidden && session) sync(); }, 30000);
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; renderInstall(); });
if("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")){
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
})();
