/**
 * Wickelkompass Felderfassung — reines Client-Tool fuer die Wickel-Safari.
 *
 * Keine Frameworks, keine Abhaengigkeiten. Speichert Beobachtungen lokal in
 * IndexedDB (Fotos als Blob), exportiert per Web-Share-API oder Download.
 * Feldnamen/Werte sind bewusst identisch zu docs/erhebung/beobachtungen.csv
 * und docs/erhebung/erhebungsbogen.md, damit der Export ohne Mapping in die
 * Desktop-Auswertung (scripts/erhebung-fortschritt.mjs) passt. Zusatzfelder
 * (uhrzeit, zugang, kostenpflichtig, zustand, google_maps_link) haengen als
 * Extraspalten hinten an -- das Auswertungsskript ignoriert unbekannte
 * Spalten, siehe README.
 *
 * Kein Teil des Produkts (siehe README.md "Nicht enthalten: Anwendungscode")
 * -- rein privates Erfassungswerkzeug fuer die Vorbereitungsphase.
 */

// Reine, DOM-/IDB-freie Kernlogik und geteilte Konstanten -- dieselbe
// Datei nutzen die Tests (tests/*.test.mjs). app.js ist deshalb ein
// ES-Modul (siehe index.html: <script type="module">).
import {
  EXPORT_HEADER,
  todayIso,
  nowHm,
  baueCsvText,
  slugify,
  guessBezirk,
  distanceMeters,
  findeDuplikate,
  migriereEintrag,
  offeneEintraege,
  klassifiziereSendeAntwort,
  klassifiziereSendeFehler,
  berechneErinnerung,
} from './core.js';

const DB_NAME = 'wk-feld-erfassung';
const DB_VERSION = 1;
const STORE = 'beobachtungen';
const UNDO_FRIST_MS = 5000;
const CLEAR_UNDO_MS = 9000;
const LS_ENTWURF = 'wk-entwurf';
const LS_THEME = 'wk-theme';

// EXPORT_HEADER (Feldkatalog fuer CSV UND Direktversand) liegt jetzt in
// core.js -- eine Aenderung dort zieht beide Wege nach. Muss weiterhin mit
// FELDER in google-apps-script/Code.gs uebereinstimmen (kein Build-Schritt
// haelt das synchron, siehe Kommentar dort).

// Direktversand an Jonathan statt Mail/WhatsApp (siehe
// google-apps-script/README.md). Die URL und das Secret sind bewusst
// oeffentlich im Client-Code sichtbar -- das Secret ist nur ein
// Grundrauschen-Filter, kein echter Schutz (siehe Session-Notizen zum
// Bedrohungsmodell). Bei Missbrauch: neues Deployment in Apps Script,
// Werte hier austauschen.
const DIREKTSENDEN_URL = 'https://script.google.com/macros/s/AKfycbyxuux5DRarVv0IRoS5DtEXfO96j1F1lq9AYM8KJoWFNDRZS9avtumhyQrFmlQW5R0uYQ/exec';
const DIREKTSENDEN_SECRET = 'd3unrxN2mluC9sjRy_sfWxTgw1wJodY0';
const DIREKTSENDEN_TIMEOUT_MS = 15000;

const STADTBEZIRKE = [
  'Altstadt/Lehel',
  'Ludwigsvorstadt/Isarvorstadt',
  'Maxvorstadt/Schwabing',
  'Haidhausen/Au',
  'Ramersdorf/Berg am Laim',
  'Sendling/Westend',
  'Neuhausen/Nymphenburg',
  'Pasing, Bogenhausen, Giesing',
];

// BEZIRK_MAPPING liegt jetzt in core.js (guessBezirk zieht es mit).

// ---------- IndexedDB ----------

// Eine einzige, wiederverwendete Verbindung statt einer pro Operation --
// sonst sammeln sich offene IDBDatabase-Handles an, die spaetere
// Schema-Upgrades blockieren wuerden.
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Verbindung freigeben, sobald eine andere Instanz ein Upgrade will,
      // und den Cache verwerfen, damit der naechste Zugriff neu oeffnet.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null; // Fehlschlag nicht dauerhaft festschreiben
      reject(req.error);
    };
  });
  return dbPromise;
}

// Fehler, bei denen ein zweiter Versuch garantiert identisch scheitert: der
// Speicher bleibt voll (Quota), der Schluessel bleibt belegt (Constraint),
// die Daten bleiben unklonbar (DataClone) usw. Solche Fehler sofort
// durchreichen -- der Retry unten ist NUR fuer transiente WebKit-Abbrueche
// gedacht, und ein sofortiges Durchreichen laesst z. B. die Quota-
// Sonderbehandlung im Submit-Handler ohne 150-ms-Umweg greifen.
const NICHT_WIEDERHOLBAR = new Set([
  'QuotaExceededError',
  'ConstraintError',
  'DataCloneError',
  'DataError',
  'VersionError',
]);

// Zentraler Schreibpfad fuer alle readwrite-Operationen.
//
// Drei Haerten gegen genau das, was auf iOS Safari (WebKit) in der Praxis
// auftritt und sonst als nichtssagendes "Speichern fehlgeschlagen
// (unbekannter Fehler)" beim Nutzer landet:
//
// 1. Aussagekraeftiger Fehler: WebKit bricht Transaktionen gelegentlich ab,
//    ohne tx.error zu setzen (dann war die Meldung leer). Wir greifen der
//    Reihe nach tx.error, den Request-Fehler und zuletzt einen benannten
//    Fallback ab (name 'TransaktionAbgebrochen', damit die UI-Meldung nicht
//    beim generischen 'Error' landet) -- und fangen synchrone Fehler (z. B.
//    DataCloneError beim add) separat, weil die sonst gar nicht im
//    Promise-Reject landen.
// 2. Ein Wiederholungsversuch: WebKit schliesst IndexedDB-Verbindungen beim
//    Backgrounding und liefert transiente UnknownErrors -- ein zweiter
//    Versuch auf einer frisch geoeffneten Verbindung klappt dann meist.
// 3. Fail-fast bei Dauerfehlern (NICHT_WIEDERHOLBAR): kein sinnloser zweiter
//    Schreibversuch, wenn der erste aus strukturellem Grund scheiterte.
async function schreibeMitRetry(operation) {
  let letzterFehler = null;
  for (let versuch = 0; versuch < 2; versuch++) {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        let request;
        try {
          request = operation(tx.objectStore(STORE));
        } catch (syncErr) {
          // z. B. DataCloneError: add()/put() wirft schon synchron.
          reject(syncErr);
          return;
        }
        const fehler = () => {
          const abbruch = new Error('IndexedDB-Transaktion abgebrochen');
          abbruch.name = 'TransaktionAbgebrochen';
          reject(tx.error || (request && request.error) || abbruch);
        };
        tx.oncomplete = () => resolve(request && request.result);
        tx.onerror = fehler;
        tx.onabort = fehler;
      });
    } catch (err) {
      letzterFehler = err;
      // Strukturelle Fehler nicht wiederholen -- der zweite Versuch scheiterte
      // identisch, nur 150 ms spaeter. Sofort durchreichen.
      if (err && NICHT_WIEDERHOLBAR.has(err.name)) throw err;
      // Verbindung koennte tot sein (iOS schliesst sie beim Backgrounding).
      // Vor dem zweiten Versuch verwerfen, damit openDb() frisch oeffnet.
      try {
        if (dbPromise) (await dbPromise).close();
      } catch {
        // Schliessen einer bereits toten Verbindung ist egal.
      }
      dbPromise = null;
      if (versuch === 0) await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw letzterFehler;
}

async function addEntry(entry) {
  return schreibeMitRetry((store) => store.add(entry));
}

// WERT_MIGRATION und migriereEintrag liegen jetzt in core.js.

async function getAllEntries() {
  const db = await openDb();
  const eintraege = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  // Beim Lesen migrieren und die Korrektur gleich zurueckschreiben, damit
  // sie nicht bei jedem Aufruf erneut anfaellt.
  const zuSchreiben = eintraege.filter(migriereEintrag);
  for (const e of zuSchreiben) {
    try {
      await putEntry(e);
    } catch (err) {
      console.warn('Wertmigration konnte nicht gespeichert werden.', err);
    }
  }
  return eintraege;
}

async function deleteEntry(id) {
  return schreibeMitRetry((store) => store.delete(id));
}

// put statt add: legt an ODER ueberschreibt. Fuer das Bearbeiten -- add()
// wuerde bei bestehender id mit ConstraintError abbrechen.
async function putEntry(entry) {
  return schreibeMitRetry((store) => store.put(entry));
}

async function clearAllEntries() {
  return schreibeMitRetry((store) => store.clear());
}

// ---------- Hilfsfunktionen ----------

// todayIso, nowHm, csvEscape, slugify, guessBezirk und distanceMeters liegen
// jetzt in core.js (importiert oben) -- reine Funktionen, von den Tests
// abgedeckt.

// Fuer den Direktversand: der Apps-Script-Endpunkt bekommt Fotos als
// Base64-String statt als rohe Datei im FormData -- ein rohes Datei-Feld
// aus einem externen fetch()-Aufruf kommt in doPost() nicht als Blob an
// (nur bei Formularen, die Apps Script selbst ausliefert). Siehe
// google-apps-script/Code.gs.
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const commaIndex = reader.result.indexOf(',');
      resolve(reader.result.slice(commaIndex + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- UI-Grundelemente ----------

const form = document.getElementById('entry-form');
const formError = document.getElementById('form-error');
const datumInput = document.getElementById('datum');
const uhrzeitInput = document.getElementById('uhrzeit');
const ortInput = document.getElementById('ort_name');
const adresseInput = document.getElementById('adresse');
const googleLinkInput = document.getElementById('google_maps_link');
const bezirkSelect = document.getElementById('stadtbezirk');
const bezirkVorschlag = document.getElementById('bezirk-vorschlag');
const fotoInput = document.getElementById('foto');
const fotoPreview = document.getElementById('foto-preview');
const notizInput = document.getElementById('notiz');
const gpsButton = document.getElementById('gps-button');
const gpsStatus = document.getElementById('gps-status');
const dupWarning = document.getElementById('dup-warning');
const nearbyWrap = document.getElementById('nearby-wrap');
const nearbyList = document.getElementById('nearby-list');
const gpsMapWrap = document.getElementById('gps-map-wrap');
const gpsMapFrame = document.getElementById('gps-map');
const gpsMapLink = document.getElementById('gps-map-link');
const entriesList = document.getElementById('entries-list');
const exportButton = document.getElementById('export-button');
const clearButton = document.getElementById('clear-button');
const bereichInput = document.getElementById('bereich');
const downloadButton = document.getElementById('download-button');
const direktsendenButton = document.getElementById('direktsenden-button');
const direktsendenStatus = document.getElementById('direktsenden-status');
const geojsonButton = document.getElementById('geojson-button');
const themeToggle = document.getElementById('theme-toggle');
const editHinweis = document.getElementById('edit-hinweis');
const editHinweisText = document.getElementById('edit-hinweis-text');
const editAbbrechen = document.getElementById('edit-abbrechen');
const entwurfHinweis = document.getElementById('entwurf-hinweis');
const entwurfVerwerfen = document.getElementById('entwurf-verwerfen');
const submitButton = document.querySelector('#entry-form button[type="submit"]');
const storageWarning = document.getElementById('storage-warning');
const exportReminder = document.getElementById('export-reminder');
const exportReminderText = document.getElementById('export-reminder-text');
const exportReminderButton = document.getElementById('export-reminder-button');
const toast = document.getElementById('toast');

let currentPosition = null; // { lat, lon }
let currentFotoBlob = null;
let toastTimer = null;
let editingId = null; // gesetzt, solange ein bestehender Eintrag bearbeitet wird
let editingFoto = null; // Foto des bearbeiteten Eintrags, falls kein neues gewaehlt wird
const pendingDeletes = new Map(); // id -> setTimeout-Handle (Soft-Delete mit Undo)

// ---------- Chip-Groups (Ja/Nein & Co. statt Dropdown) ----------

const chipState = {
  changing_table: '',
  changing_table_location: '',
  stroller_access: '',
  zugang: '',
  kostenpflichtig: '',
  zustand: '',
  quelle: 'field_survey',
};

function setupChipGroups() {
  document.querySelectorAll('.chip-group[data-field]').forEach((group) => {
    const field = group.dataset.field;
    group.querySelectorAll('.chip').forEach((chip) => {
      chip.setAttribute('aria-pressed', 'false');
      chip.addEventListener('click', () => {
        if (group.dataset.disabled === 'true') return;
        // Erneutes Antippen des aktiven Chips hebt die Auswahl auf (nur bei optionalen Feldern sinnvoll)
        if (chipState[field] === chip.dataset.value && field !== 'quelle' && field !== 'changing_table') {
          selectChip(field, '');
        } else {
          selectChip(field, chip.dataset.value);
        }
      });
    });
  });
  // Vorbelegung "Selbst gesehen" sichtbar machen
  selectChip('quelle', 'field_survey');
}

function selectChip(field, value) {
  chipState[field] = value;
  const group = document.querySelector(`.chip-group[data-field="${field}"]`);
  group.querySelectorAll('.chip').forEach((chip) => {
    const active = chip.dataset.value === value;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', String(active));
  });

  if (field === 'changing_table') {
    const locationGroup = document.querySelector('.chip-group[data-field="changing_table_location"]');
    const enabled = value === 'yes';
    locationGroup.dataset.disabled = String(!enabled);
    if (!enabled) resetChip('changing_table_location');
  }
}

function resetChip(field) {
  chipState[field] = '';
  const group = document.querySelector(`.chip-group[data-field="${field}"]`);
  group.querySelectorAll('.chip').forEach((chip) => {
    chip.classList.remove('active');
    chip.setAttribute('aria-pressed', 'false');
  });
}

function resetAllChips() {
  resetChip('changing_table');
  resetChip('changing_table_location');
  resetChip('stroller_access');
  resetChip('zugang');
  resetChip('kostenpflichtig');
  resetChip('zustand');
  document.querySelector('.chip-group[data-field="changing_table_location"]').dataset.disabled = 'true';
  selectChip('quelle', 'field_survey');
}

// ---------- Toast (mit optionaler Undo-Aktion) ----------

/**
 * options: { action: { label, onClick }, durationMs, variant: 'error' }
 *
 * Wichtig bei Undo-Toasts: die Standarddauer liegt bewusst UNTER
 * UNDO_FRIST_MS. Stuende der Toast laenger als die Frist, waere der
 * "Rueckgaengig"-Knopf noch sichtbar, nachdem der Eintrag bereits
 * endgueltig geloescht wurde -- ein Tap darauf liefe dann wirkungslos ins
 * Leere. Wer eine eigene Dauer setzt, muss selbst sicherstellen, dass die
 * Aktion so lange gueltig bleibt.
 */
function showToast(message, options = {}) {
  const { action, durationMs, variant } = options;
  toast.innerHTML = '';
  toast.classList.toggle('toast-error', variant === 'error');

  const span = document.createElement('span');
  span.textContent = message;
  toast.appendChild(span);

  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      action.onClick();
      hideToastNow();
    });
    toast.appendChild(btn);
  }

  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add('show'));
  clearTimeout(toastTimer);
  const dauer = durationMs ?? (action ? UNDO_FRIST_MS - 500 : 2200);
  toastTimer = setTimeout(hideToastNow, dauer);
}

function hideToastNow() {
  toast.classList.remove('show');
  setTimeout(() => {
    toast.hidden = true;
  }, 250);
}

// ---------- Hell / Dunkel ----------

// Feldarbeit findet draussen statt: bei Sonne ist das dunkle Design die
// schlechtere Wahl. Ohne gespeicherte Wahl entscheidet das Geraet.
function themeAnwenden(theme) {
  if (theme === 'hell' || theme === 'dunkel') {
    document.documentElement.dataset.theme = theme === 'hell' ? 'light' : 'dark';
  } else {
    delete document.documentElement.dataset.theme;
  }
  const dunkelAktiv =
    document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  themeToggle.textContent = dunkelAktiv ? '☀️' : '🌙';
  themeToggle.title = dunkelAktiv ? 'Auf hell umschalten' : 'Auf dunkel umschalten';
}

themeToggle.addEventListener('click', () => {
  const dunkelAktiv =
    document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  const neu = dunkelAktiv ? 'hell' : 'dunkel';
  try {
    localStorage.setItem(LS_THEME, neu);
  } catch (err) {
    console.warn('Theme konnte nicht gespeichert werden.', err);
  }
  themeAnwenden(neu);
});

// ---------- Formular-Entwurf ----------

// Felder, die als Entwurf gesichert werden. Das Foto fehlt bewusst: ein
// Bild passt nicht in localStorage, der Hinweistext sagt das auch.
const ENTWURF_FELDER = [
  ['datum', () => datumInput, (v) => (datumInput.value = v)],
  ['uhrzeit', () => uhrzeitInput, (v) => (uhrzeitInput.value = v)],
  ['ort_name', () => ortInput, (v) => (ortInput.value = v)],
  ['adresse', () => adresseInput, (v) => (adresseInput.value = v)],
  ['google_maps_link', () => googleLinkInput, (v) => (googleLinkInput.value = v)],
  ['bereich', () => bereichInput, (v) => (bereichInput.value = v)],
  ['stadtbezirk', () => bezirkSelect, (v) => (bezirkSelect.value = v)],
  ['notiz', () => notizInput, (v) => (notizInput.value = v)],
];

let entwurfTimer = null;

function entwurfSpeichern() {
  // Auch waehrend einer Bearbeitung sichern: sonst waeren Korrekturen an
  // bestehenden Eintraegen als einziger Eingabeweg ungeschuetzt gegen
  // Absturz oder geschlossene App. editingId wandert mit in den Entwurf,
  // damit beim Wiederherstellen klar ist, WAS bearbeitet wurde.
  const daten = { chips: { ...chipState }, position: currentPosition, editingId };
  for (const [key, el] of ENTWURF_FELDER) daten[key] = el().value;

  // Eine laufende Bearbeitung ist nie "leer" -- sie muss auch dann gesichert
  // werden, wenn der Nutzer gerade alle Felder geleert hat.
  const leer =
    !editingId &&
    !daten.ort_name.trim() &&
    !daten.adresse.trim() &&
    !daten.notiz.trim() &&
    !daten.bereich.trim() &&
    !chipState.changing_table &&
    !chipState.stroller_access &&
    !currentPosition;
  try {
    if (leer) localStorage.removeItem(LS_ENTWURF);
    else localStorage.setItem(LS_ENTWURF, JSON.stringify(daten));
  } catch (err) {
    console.warn('Entwurf konnte nicht gesichert werden.', err);
  }
}

function entwurfSpeichernVerzoegert() {
  clearTimeout(entwurfTimer);
  entwurfTimer = setTimeout(entwurfSpeichern, 400);
}

function entwurfLoeschen() {
  clearTimeout(entwurfTimer);
  try {
    localStorage.removeItem(LS_ENTWURF);
  } catch (err) {
    console.warn('Entwurf konnte nicht gelöscht werden.', err);
  }
  entwurfHinweis.hidden = true;
}

async function entwurfWiederherstellen() {
  let daten;
  try {
    daten = JSON.parse(localStorage.getItem(LS_ENTWURF) || 'null');
  } catch {
    return;
  }
  if (!daten) return;

  // War eine Bearbeitung offen, erst den Modus wiederherstellen -- sonst
  // wuerde das Speichern einen NEUEN Eintrag anlegen statt den alten zu
  // ueberschreiben, und der urspruengliche bliebe unveraendert stehen.
  if (daten.editingId) {
    const original = (await getAllEntries()).find((e) => e.id === daten.editingId);
    if (original) {
      bearbeitungsModusSetzen(original);
    } else {
      // Eintrag existiert nicht mehr (zwischenzeitlich geloescht). Der
      // Entwurf wird dann als neue Beobachtung weitergefuehrt.
      console.warn('Bearbeiteter Eintrag nicht mehr vorhanden, Entwurf gilt als neu.');
    }
  }

  for (const [key, , setzen] of ENTWURF_FELDER) {
    if (typeof daten[key] === 'string') setzen(daten[key]);
  }
  for (const [feld, wert] of Object.entries(daten.chips || {})) {
    if (wert) selectChip(feld, wert);
  }
  if (daten.position) {
    currentPosition = daten.position;
    gpsStatus.textContent = '✓ Standort aus Entwurf übernommen.';
    showMap(currentPosition.lat, currentPosition.lon);
  }
  entwurfHinweis.hidden = false;
}

entwurfVerwerfen.addEventListener('click', () => {
  formularZuruecksetzen();
  entwurfLoeschen();
});

// ---------- Export-Erinnerung ----------

// erstelltAm, tageSeit und die Schwellenlogik (berechneErinnerung) liegen
// jetzt in core.js. updateExportReminder ist nur noch die DOM-Anbindung.

// Seit es pro Eintrag ein echtes "versendet"-Flag gibt (automatisches
// Senden beim Speichern, siehe sendeEinzeln()), ist die Erinnerung direkt
// daran gekoppelt statt an einen globalen "letzter Export"-Zeitstempel:
// sie fragt schlicht "liegt hier etwas, das das Geraet noch nicht auf
// irgendeinem Weg verlassen hat" -- Teilen/Herunterladen markieren
// erfolgreich verschickte Eintraege ebenfalls als versendet (siehe
// export-button/download-button), zaehlen also nicht mehr mit.
function updateExportReminder(entries) {
  const { sichtbar, text } = berechneErinnerung(entries);
  if (!sichtbar) {
    exportReminder.hidden = true;
    return;
  }
  exportReminderText.textContent = text;
  exportReminder.hidden = false;
}

// ---------- Init ----------

async function init() {
  datumInput.value = todayIso();
  uhrzeitInput.value = nowHm();
  for (const bezirk of STADTBEZIRKE) {
    const opt = document.createElement('option');
    opt.value = bezirk;
    opt.textContent = bezirk;
    bezirkSelect.appendChild(opt);
  }
  themeAnwenden(localStorage.getItem(LS_THEME));
  setupChipGroups();
  // Erst der Entwurf, dann die Liste: die Wiederherstellung liest die
  // Datenbank (fuer eine offene Bearbeitung) und soll sich nicht mit
  // renderList um dieselbe Verbindung schlagen.
  await entwurfWiederherstellen();
  setupEntwurfAutosave();
  await renderList();
  registerServiceWorker();
  ensurePersistentStorage();
}

// Entwurf mitschreiben, damit ein Anruf oder ein leerer Akku mitten in der
// Eingabe nicht den halben Datensatz kostet.
function setupEntwurfAutosave() {
  for (const el of [
    datumInput,
    uhrzeitInput,
    ortInput,
    adresseInput,
    googleLinkInput,
    bereichInput,
    bezirkSelect,
    notizInput,
  ]) {
    el.addEventListener('input', entwurfSpeichernVerzoegert);
    el.addEventListener('change', entwurfSpeichernVerzoegert);
  }
  document.querySelectorAll('.chip-group[data-field] .chip').forEach((chip) => {
    chip.addEventListener('click', entwurfSpeichernVerzoegert);
  });
}

// Ohne "persistent storage" darf der Browser die IndexedDB bei
// Speicherdruck jederzeit raeumen -- bei einem Werkzeug, das ueber Monate
// 150 Beobachtungen sammelt, waere das der Totalverlust. Die Anfrage wird
// je nach Browser still gewaehrt (Chrome, heuristisch) oder abgelehnt;
// bleibt sie aus, weisen wir sichtbar auf regelmaessigen Export hin.
async function ensurePersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) return;
  try {
    const schonPersistent = await navigator.storage.persisted();
    const persistent = schonPersistent || (await navigator.storage.persist());
    if (!persistent) {
      storageWarning.hidden = false;
      storageWarning.textContent =
        '⚠ Dieser Browser sichert die Daten nicht dauerhaft — sie können bei Speicherdruck gelöscht werden. Regelmäßig exportieren.';
    }
  } catch (err) {
    console.warn('Persistenz-Anfrage fehlgeschlagen.', err);
  }
}

fotoInput.addEventListener('change', () => {
  const file = fotoInput.files && fotoInput.files[0];
  currentFotoBlob = file || null;
  if (file) {
    fotoPreview.src = URL.createObjectURL(file);
    fotoPreview.hidden = false;
  } else {
    fotoPreview.hidden = true;
  }
});

gpsButton.addEventListener('click', async () => {
  if (!('geolocation' in navigator)) {
    gpsStatus.textContent = 'Geolocation wird von diesem Browser nicht unterstützt.';
    return;
  }
  gpsStatus.textContent = 'Standort wird ermittelt …';
  dupWarning.hidden = true;
  nearbyWrap.hidden = true;
  gpsButton.disabled = true;
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      gpsButton.disabled = false;
      currentPosition = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      gpsStatus.textContent = `✓ Standort erfasst (±${Math.round(pos.coords.accuracy)} m) — auf der Karte prüfen.`;
      showMap(currentPosition.lat, currentPosition.lon);
      entwurfSpeichernVerzoegert(); // Standort gehoert mit in den Entwurf
      await Promise.all([
        checkDuplicates(currentPosition.lat, currentPosition.lon),
        suggestBezirkUndAdresse(currentPosition),
        findNearby(currentPosition.lat, currentPosition.lon),
      ]);
      entwurfSpeichernVerzoegert(); // ggf. ergaenzte Adresse/Bezirk mitnehmen
    },
    (err) => {
      gpsButton.disabled = false;
      gpsStatus.textContent = `Standort nicht verfügbar: ${err.message}`;
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
});

function showMap(lat, lon) {
  const dLon = 0.004;
  const dLat = 0.0028;
  const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat].join('%2C');
  gpsMapFrame.src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat}%2C${lon}`;
  gpsMapLink.href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`;
  gpsMapWrap.hidden = false;
}

function hideMap() {
  gpsMapWrap.hidden = true;
  gpsMapFrame.src = 'about:blank';
}

// Duplikat-Check: warnt, wenn der neue GPS-Punkt nah an einer bereits
// gespeicherten Beobachtung liegt -- rein lokal, kein Netzwerk.
async function checkDuplicates(lat, lon) {
  const entries = (await getAllEntries()).filter((e) => !pendingDeletes.has(e.id));
  const treffer = findeDuplikate(entries, lat, lon);

  if (treffer.length > 0) {
    const { e, dist } = treffer[0];
    dupWarning.hidden = false;
    dupWarning.textContent = `⚠ Schon erfasst: „${e.ort_name}“ ca. ${Math.round(dist)} m entfernt (${e.datum}).`;
  } else {
    dupWarning.hidden = true;
  }
}

async function suggestBezirkUndAdresse({ lat, lon }) {
  if (!navigator.onLine) return; // offline: kein Reverse-Geocoding-Versuch
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=17&addressdetails=1`,
      { headers: { 'Accept-Language': 'de' } }
    );
    if (!res.ok) return;
    const data = await res.json();
    const addr = data.address || {};

    const bucket = guessBezirk(addr);
    if (bucket) {
      bezirkVorschlag.hidden = false;
      bezirkVorschlag.textContent = `Vorschlag laut GPS: ${bucket} — bitte prüfen.`;
      if (!bezirkSelect.value) bezirkSelect.value = bucket;
    }

    if (!adresseInput.value.trim() && (addr.road || addr.house_number)) {
      adresseInput.value = [addr.road, addr.house_number].filter(Boolean).join(' ');
    }
  } catch {
    // Offline oder Nominatim nicht erreichbar -- GPS-Koordinaten bleiben trotzdem gespeichert.
  }
}

// Grobe Uebersetzung haeufiger OSM-Tags in verstaendliche Kurzlabels.
const KATEGORIE_LABELS = {
  cafe: 'Café',
  restaurant: 'Restaurant',
  fast_food: 'Fast Food',
  bar: 'Bar',
  pub: 'Kneipe',
  pharmacy: 'Apotheke',
  supermarket: 'Supermarkt',
  department_store: 'Kaufhaus',
  mall: 'Einkaufszentrum',
  clothes: 'Kleidung',
  museum: 'Museum',
  bakery: 'Bäckerei',
  doctors: 'Arztpraxis',
  bank: 'Bank',
  toilets: 'WC',
};

function kategorieLabel(tags) {
  const raw = tags.shop || tags.amenity || tags.tourism || tags.leisure || tags.office || '';
  return KATEGORIE_LABELS[raw] || raw.replace(/_/g, ' ');
}

// Zwei oeffentliche Overpass-Spiegel -- die kostenlose Infrastruktur ist
// best-effort ohne SLA und faellt gelegentlich mit 504 aus. Erster
// Treffer gewinnt, jeweils mit kurzem Timeout, damit ein toter Spiegel
// nicht laenger blockiert als noetig.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// Beide Spiegel einmal durchprobieren, bei Bedarf eine zweite Runde nach
// kurzer Pause. Im Test war der erste Anlauf regelmaessig erfolglos und der
// zweite erfolgreich -- ohne Wiederholung bleibt unterwegs oefter mal die
// halbe Vorschlagsliste aus, obwohl Netz da ist.
async function overpassFetch(query, runden = 2) {
  for (let runde = 0; runde < runden; runde++) {
    if (runde > 0) await new Promise((r) => setTimeout(r, 1500));
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        const res = await fetch(endpoint, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(query),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (res.ok) return await res.json();
      } catch {
        // naechsten Spiegel probieren
      }
    }
  }
  return null;
}

// Strassenmoebel und Verkehrsinfrastruktur: taucht mit [amenity] auf, ist
// als Erfassungsziel aber nie gemeint. (Am Marienplatz kamen sonst vier
// Fahrkartenautomaten der Bahn statt der umliegenden Lokale.)
const KATEGORIE_AUSGESCHLOSSEN = new Set([
  'vending_machine',
  'bench',
  'waste_basket',
  'bicycle_parking',
  'bicycle_rental',
  'motorcycle_parking',
  'parking',
  'parking_space',
  'parking_entrance',
  'charging_station',
  'atm',
  'post_box',
  'telephone',
  'clock',
  'drinking_water',
  'fountain',
  'street_lamp',
  'shelter',
  'bus_station',
  'taxi',
  'car_sharing',
  'recycling',
  // Denkmaeler, Aussichtspunkte und Infotafeln sind keine Orte mit WC --
  // am Marienplatz kamen sonst Mariensaeule und Glockenspiel vor den
  // umliegenden Lokalen.
  'artwork',
  'viewpoint',
  'information',
  'picture',
  'memorial',
  'monument',
  'attraction',
]);

// Umkreissuche ueber die oeffentliche Overpass-API (kostenlos, kein Key).
// Rein informativ zum Antippen -- kein automatischer Datenabgleich.
//
// WICHTIG: nur Elemente mit POI-Tag abfragen. Ein blosses [name] auf ways
// trifft jede benannte STRASSE -- in der Stadt sind das im Umkreis von 40 m
// immer mehrere, und sie verdraengen die eigentlichen Orte aus der Liste.
// Genau das war auf dem Handy zu sehen: nur Strassen, keine Lokale.
async function findNearby(lat, lon) {
  if (!navigator.onLine) return;
  const r = 70; // etwas grosszuegiger, Handy-GPS liegt oft 20-50 m daneben
  const query =
    `[out:json][timeout:15];(` +
    `nwr(around:${r},${lat},${lon})[name][amenity];` +
    `nwr(around:${r},${lat},${lon})[name][shop];` +
    `nwr(around:${r},${lat},${lon})[name][tourism];` +
    `nwr(around:${r},${lat},${lon})[name][leisure];` +
    `nwr(around:${r},${lat},${lon})[name][office];` +
    `nwr(around:${r},${lat},${lon})[name][healthcare];` +
    `);out center 40;`;
  nearbyWrap.hidden = false;
  nearbyList.innerHTML = '';
  const suchHinweis = document.createElement('li');
  suchHinweis.className = 'empty-state';
  suchHinweis.textContent = 'Suche Orte in der Nähe …';
  nearbyList.appendChild(suchHinweis);

  try {
    const data = await overpassFetch(query);
    if (!data) {
      // Kein Fehlerzustand: die oeffentliche Overpass-Infrastruktur ist
      // best-effort. Manuelle Eingabe funktioniert unveraendert.
      suchHinweis.textContent = 'Keine Vorschläge verfügbar — Ort von Hand eintragen.';
      return;
    }
    const gesehen = new Set();
    const results = (data.elements || [])
      .map((el) => {
        const pos = el.type === 'node' ? el : el.center;
        if (!pos || !el.tags || !el.tags.name) return null;
        const roh = el.tags.shop || el.tags.amenity || el.tags.tourism || el.tags.leisure || '';
        if (KATEGORIE_AUSGESCHLOSSEN.has(roh)) return null;
        return {
          name: el.tags.name,
          kategorie: kategorieLabel(el.tags),
          adresse: [el.tags['addr:street'], el.tags['addr:housenumber']].filter(Boolean).join(' '),
          dist: distanceMeters(lat, lon, pos.lat, pos.lon),
        };
      })
      .filter(Boolean)
      // Filialen sind in OSM oft doppelt erfasst (Node fuer den Eingang,
      // Way fuer das Gebaeude) -- gleicher Name nur einmal anbieten.
      .filter((r) => {
        const key = r.name.toLowerCase();
        if (gesehen.has(key)) return false;
        gesehen.add(key);
        return true;
      })
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 8);

    if (results.length === 0) {
      suchHinweis.textContent = 'Nichts Passendes in der Nähe — Ort von Hand eintragen.';
      return;
    }
    renderNearby(results);
  } catch {
    // Offline oder Overpass nicht erreichbar -- kein Problem, manuelle Eingabe bleibt.
  }
}

function renderNearby(results) {
  nearbyList.innerHTML = '';
  if (results.length === 0) {
    nearbyWrap.hidden = true;
    return;
  }
  for (const r of results) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nearby-item';
    // textContent statt innerHTML: Namen und Tags kommen aus OSM, sind also
    // von Dritten frei editierbar. Als Markup interpretiert koennte ein
    // praeparierter Ortsname Code in diesem Origin ausfuehren -- und in
    // diesem Origin liegen saemtliche erfassten Beobachtungen.
    const nameEl = document.createElement('strong');
    nameEl.textContent = r.name;
    const metaEl = document.createElement('span');
    metaEl.textContent = `${r.kategorie ? r.kategorie + ' · ' : ''}${Math.round(r.dist)} m`;
    btn.append(nameEl, metaEl);
    btn.addEventListener('click', () => {
      ortInput.value = r.name;
      if (r.adresse) adresseInput.value = r.adresse;
      nearbyWrap.hidden = true;
    });
    li.appendChild(btn);
    nearbyList.appendChild(li);
  }
  nearbyWrap.hidden = false;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const missing = [];
  if (!datumInput.value) missing.push('Datum');
  if (!ortInput.value.trim()) missing.push('Ort');
  if (!chipState.changing_table) missing.push('Wickeltisch vorhanden?');
  if (!chipState.stroller_access) missing.push('Erreichbarkeit mit Kinderwagen');

  if (missing.length > 0) {
    formError.textContent = `Bitte ausfüllen: ${missing.join(', ')}.`;
    formError.hidden = false;
    formError.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  formError.hidden = true;

  // Beim Bearbeiten bleibt das vorhandene Foto erhalten, solange kein neues
  // aufgenommen wurde.
  const foto = currentFotoBlob || (editingId ? editingFoto : null);

  const entry = {
    id: editingId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    datum: datumInput.value,
    uhrzeit: uhrzeitInput.value,
    ort_name: ortInput.value.trim(),
    adresse: adresseInput.value.trim(),
    google_maps_link: googleLinkInput.value.trim(),
    bereich: bereichInput.value.trim(),
    stadtbezirk: bezirkSelect.value,
    changing_table: chipState.changing_table,
    changing_table_location: chipState.changing_table_location,
    stroller_access: chipState.stroller_access,
    zugang: chipState.zugang,
    kostenpflichtig: chipState.kostenpflichtig,
    zustand: chipState.zustand,
    notiz: notizInput.value.trim(),
    quelle: chipState.quelle,
    lat: currentPosition ? currentPosition.lat : '',
    lon: currentPosition ? currentPosition.lon : '',
    foto: foto || null,
    fotoType: foto ? foto.type : '',
    // versendet bewusst NICHT hier gesetzt (auch beim Bearbeiten nicht):
    // ein frisch gespeicherter oder geaenderter Eintrag gilt erst als
    // versendet, nachdem sendeEinzeln() das unten tatsaechlich bestaetigt
    // -- siehe direkt nach formularZuruecksetzen().
  };

  try {
    if (editingId) await putEntry(entry);
    else await addEntry(entry);
  } catch (err) {
    // Haeufigster Fall: QuotaExceededError, wenn der Geraetespeicher voll
    // ist (Fotos!). Ohne diese Behandlung braeche der Handler still ab --
    // das Formular bliebe stehen, ohne dass klar waere, dass NICHTS
    // gespeichert wurde.
    console.error('Speichern fehlgeschlagen.', err);
    const voll = err && err.name === 'QuotaExceededError';
    formError.textContent = voll
      ? 'Speicher voll — nichts gespeichert. Bitte erst exportieren und dann Einträge löschen (ggf. ohne Foto erneut versuchen).'
      : `Speichern fehlgeschlagen (${err && err.name ? err.name : 'unbekannter Fehler'}). Eintrag wurde NICHT gespeichert.`;
    formError.hidden = false;
    formError.scrollIntoView({ behavior: 'smooth', block: 'center' });
    showToast('Nicht gespeichert', { variant: 'error', durationMs: 4000 });
    return;
  }

  const warBearbeitung = !!editingId;
  const gemerkt = {
    ort_name: entry.ort_name,
    adresse: entry.adresse,
    google_maps_link: entry.google_maps_link,
    stadtbezirk: entry.stadtbezirk,
    datum: entry.datum,
    position: currentPosition,
  };

  formularZuruecksetzen();
  entwurfLoeschen();

  // Direkt nach dem Speichern wird sofort versucht, die Beobachtung zu
  // senden -- Mitstreiter:innen im Feld sollen nicht zusaetzlich an einen
  // zweiten Knopf denken muessen. Klappt es nicht (kein Netz o. Ae.),
  // bleibt der Eintrag als "nicht gesendet" markiert und laesst sich ueber
  // den Wiederholungsknopf im Versand-Bereich nachreichen.
  const sendeErgebnis = await sendeEinzeln(entry);

  if (warBearbeitung) {
    showToast(
      sendeErgebnis.ok
        ? `✓ „${entry.ort_name}“ geändert & gesendet`
        : `✓ „${entry.ort_name}“ geändert — Versand fehlgeschlagen, später erneut versuchen`,
      { durationMs: sendeErgebnis.ok ? 2200 : 5000 }
    );
  } else {
    showToast(
      sendeErgebnis.ok
        ? `✓ „${entry.ort_name}“ gespeichert & gesendet`
        : `✓ „${entry.ort_name}“ gespeichert — Versand fehlgeschlagen, später erneut versuchen`,
      {
        durationMs: sendeErgebnis.ok ? 6000 : 7000,
        action: { label: '+ Weitere hier', onClick: () => weitereAmSelbenOrt(gemerkt) },
      }
    );
  }
  await renderList();
});

// Grosse Standorte haben oft mehrere Wickelmoeglichkeiten (Kaufhaus: Raum im
// 2. OG, Wickeltisch im Damen-WC im EG). Ein Datensatz je Moeglichkeit,
// unterschieden ueber "bereich" -- der Ortsteil des Formulars wird dafuer
// uebernommen, der wickeltischspezifische Teil bleibt leer.
function weitereAmSelbenOrt(gemerkt) {
  ortInput.value = gemerkt.ort_name;
  adresseInput.value = gemerkt.adresse;
  googleLinkInput.value = gemerkt.google_maps_link;
  bezirkSelect.value = gemerkt.stadtbezirk;
  datumInput.value = gemerkt.datum;
  uhrzeitInput.value = nowHm();
  currentPosition = gemerkt.position;
  if (currentPosition) {
    gpsStatus.textContent = '✓ Standort vom vorigen Eintrag übernommen.';
    showMap(currentPosition.lat, currentPosition.lon);
  }
  bereichInput.focus();
  // Programmatisch gesetzte Werte loesen keine input-Events aus, der
  // Entwurf wuerde also erst beim ersten Tippen gesichert. Wer die App
  // vorher schliesst, verliert Ort, Adresse und GPS der Folgeerfassung.
  entwurfSpeichern();
  showToast('Ort übernommen — jetzt Bereich/Stockwerk angeben.', { durationMs: 3500 });
}

function formularZuruecksetzen() {
  form.reset();
  datumInput.value = todayIso();
  uhrzeitInput.value = nowHm();
  resetAllChips();
  fotoPreview.hidden = true;
  bezirkVorschlag.hidden = true;
  dupWarning.hidden = true;
  nearbyWrap.hidden = true;
  gpsStatus.textContent = 'Noch kein Standort erfasst.';
  hideMap();
  currentPosition = null;
  currentFotoBlob = null;
  bearbeitungBeenden();
  // Muss mit: sonst bliebe nach "Abbrechen" ein Entwurf mit editingId
  // liegen und die abgebrochene Bearbeitung kaeme beim naechsten Start
  // wieder hoch.
  entwurfLoeschen();
}

// ---------- Bearbeiten ----------

// Nur der Modus: Zustand, Foto-Uebernahme und Bedienoberflaeche. Getrennt
// vom Befuellen, weil die Entwurfs-Wiederherstellung den Modus braucht,
// die Feldwerte aber aus dem Entwurf nimmt -- nicht aus dem Original.
function bearbeitungsModusSetzen(entry) {
  editingId = entry.id;
  editingFoto = entry.foto || null;

  // Ein Foto, das fuer den vorigen (noch nicht gespeicherten) Eintrag
  // gewaehlt war, muss weg. Sonst gilt beim Speichern
  // `currentFotoBlob || editingFoto` und das alte Foto landet still am
  // bearbeiteten Eintrag -- ohne dass die Vorschau es je zeigt.
  currentFotoBlob = null;
  fotoInput.value = '';

  if (entry.foto) {
    fotoPreview.src = URL.createObjectURL(entry.foto);
    fotoPreview.hidden = false;
  } else {
    fotoPreview.hidden = true;
  }

  editHinweisText.textContent = `„${entry.ort_name}" wird bearbeitet.`;
  editHinweis.hidden = false;
  submitButton.textContent = '💾 Änderungen speichern';
}

function bearbeitungStarten(entry) {
  bearbeitungsModusSetzen(entry);

  datumInput.value = entry.datum || todayIso();
  uhrzeitInput.value = entry.uhrzeit || '';
  ortInput.value = entry.ort_name || '';
  adresseInput.value = entry.adresse || '';
  googleLinkInput.value = entry.google_maps_link || '';
  bereichInput.value = entry.bereich || '';
  bezirkSelect.value = entry.stadtbezirk || '';
  notizInput.value = entry.notiz || '';

  resetAllChips();
  for (const feld of ['changing_table', 'stroller_access', 'zugang', 'kostenpflichtig', 'zustand', 'quelle']) {
    if (entry[feld]) selectChip(feld, entry[feld]);
  }
  // Erst nach changing_table setzen, sonst sperrt dessen Handler die Gruppe.
  if (entry.changing_table_location) selectChip('changing_table_location', entry.changing_table_location);

  if (entry.lat !== '' && entry.lon !== '') {
    currentPosition = { lat: Number(entry.lat), lon: Number(entry.lon) };
    gpsStatus.textContent = '✓ Gespeicherter Standort.';
    showMap(currentPosition.lat, currentPosition.lon);
  } else {
    currentPosition = null;
    hideMap();
    gpsStatus.textContent = 'Noch kein Standort erfasst.';
  }

  // Foto-Vorschau, Hinweis und Buttontext setzt bereits
  // bearbeitungsModusSetzen().
  entwurfHinweis.hidden = true;
  entwurfSpeichern(); // Bearbeitung ab sofort gegen Abstuerze sichern
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function bearbeitungBeenden() {
  editingId = null;
  editingFoto = null;
  editHinweis.hidden = true;
  submitButton.textContent = '💾 Speichern';
}

editAbbrechen.addEventListener('click', () => {
  formularZuruecksetzen();
});

async function renderList() {
  const entries = (await getAllEntries()).filter((e) => !pendingDeletes.has(e.id));
  // Neueste zuerst. Uhrzeit muss mit rein, sonst ist die Reihenfolge
  // innerhalb eines Erhebungstages -- also im Normalfall -- willkuerlich.
  // Gleichstand bricht die id auf, die mit Date.now() beginnt.
  entries.sort((a, b) => {
    const ka = `${a.datum} ${a.uhrzeit || ''}`;
    const kb = `${b.datum} ${b.uhrzeit || ''}`;
    if (ka !== kb) return ka < kb ? 1 : -1;
    return String(b.id).localeCompare(String(a.id));
  });

  // Absichtlich KEINE Fortschritts-/Abdeckungszahlen mehr hier: dieses
  // Geraet sieht nur seine eigenen, lokalen Eintraege der aktuellen Sitzung
  // -- als Stellvertreter fuer den echten, projektweiten Fortschritt waeren
  // die Zahlen irrefuehrend. Die echte Auswertung passiert zentral im
  // Hauptrepo (scripts/erhebung-fortschritt.mjs) ueber alle eingesammelten
  // Beobachtungen hinweg.
  updateExportReminder(entries);
  updateDirektsendenButton(entries);

  entriesList.innerHTML = '';
  if (entries.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-state';
    li.textContent = 'Noch keine Beobachtungen gespeichert.';
    entriesList.appendChild(li);
    return;
  }

  for (const e of entries) {
    const li = document.createElement('li');
    li.className = 'entry';

    const main = document.createElement('div');
    main.className = 'entry-main';

    const title = document.createElement('strong');
    title.textContent = e.ort_name || '(ohne Namen)';
    main.appendChild(title);

    const badges = document.createElement('div');
    const tableBadge = document.createElement('span');
    tableBadge.className = `badge ${e.changing_table === 'yes' ? 'ok' : ''}`;
    tableBadge.textContent = e.changing_table === 'yes' ? 'Wickeltisch: ja' : 'Wickeltisch: nein';
    badges.appendChild(tableBadge);
    if (e.changing_table_location) {
      const locBadge = document.createElement('span');
      locBadge.className = 'badge ok';
      locBadge.textContent = e.changing_table_location;
      badges.appendChild(locBadge);
    }
    if (e.lat && e.lon) {
      const gpsBadge = document.createElement('span');
      gpsBadge.className = 'badge';
      gpsBadge.textContent = '📍 GPS';
      badges.appendChild(gpsBadge);
    }
    if (e.quelle === 'operator_reply') {
      const srcBadge = document.createElement('span');
      srcBadge.className = 'badge';
      srcBadge.textContent = 'operator_reply';
      badges.appendChild(srcBadge);
    }
    if (!e.versendet) {
      const sendBadge = document.createElement('span');
      sendBadge.className = 'badge';
      sendBadge.textContent = '⏳ nicht gesendet';
      badges.appendChild(sendBadge);
    }
    main.appendChild(badges);

    const meta = document.createElement('div');
    meta.className = 'entry-meta';
    meta.textContent = `${e.datum}${e.uhrzeit ? ' ' + e.uhrzeit : ''} · ${e.stadtbezirk || 'ohne Bezirk'} · ${e.adresse || ''}`;
    main.appendChild(meta);

    li.appendChild(main);

    const aktionen = document.createElement('div');
    aktionen.className = 'entry-aktionen';

    const edit = document.createElement('button');
    edit.className = 'entry-edit';
    edit.textContent = '✎';
    edit.title = 'Bearbeiten';
    edit.setAttribute('aria-label', `„${e.ort_name}" bearbeiten`);
    edit.addEventListener('click', () => bearbeitungStarten(e));
    aktionen.appendChild(edit);

    const del = document.createElement('button');
    del.className = 'entry-delete';
    del.textContent = '✕';
    del.title = 'Löschen';
    del.setAttribute('aria-label', `„${e.ort_name}" löschen`);
    del.addEventListener('click', () => softDeleteEntry(e));
    aktionen.appendChild(del);

    li.appendChild(aktionen);

    entriesList.appendChild(li);
  }
}

// Soft-Delete: sofort aus der Ansicht entfernen, aber erst nach Ablauf der
// Undo-Frist wirklich aus IndexedDB loeschen -- ersetzt den blockierenden
// confirm()-Dialog durch einen Rueckgaengig-Toast.
function softDeleteEntry(entry) {
  // renderList() laeuft asynchron (IndexedDB), der Loeschknopf bleibt also
  // kurz klickbar. Ein zweiter Tap wuerde die Timer-Referenz ueberschreiben;
  // der erste Timer liefe verwaist weiter und loeschte endgueltig, obwohl
  // der sichtbare Undo-Toast nur den zweiten kennt.
  if (pendingDeletes.has(entry.id)) return;

  const timeoutId = setTimeout(async () => {
    pendingDeletes.delete(entry.id);
    await deleteEntry(entry.id);
  }, UNDO_FRIST_MS);
  pendingDeletes.set(entry.id, timeoutId);
  renderList();
  showToast(`Gelöscht: „${entry.ort_name}“`, {
    action: {
      label: 'Rückgängig',
      onClick: () => {
        clearTimeout(pendingDeletes.get(entry.id));
        pendingDeletes.delete(entry.id);
        renderList();
      },
    },
  });
}

// Bricht alle schwebenden Einzel-Loeschungen ab, ohne sie auszufuehren.
// Muss vor jedem Massen-Eingriff laufen: ein bloszes pendingDeletes.clear()
// wuerde die Timer weiterlaufen lassen, und ein spaeter zurueckgeholter
// Eintrag waere dann Sekunden danach wieder verschwunden.
function cancelPendingDeletes() {
  for (const timeoutId of pendingDeletes.values()) clearTimeout(timeoutId);
  pendingDeletes.clear();
}

// Baut CSV und Fotodateien. Von Teilen- und Download-Knopf gemeinsam
// genutzt, damit beide garantiert denselben Inhalt liefern.
async function exportDateienBauen() {
  const entries = (await getAllEntries()).filter((e) => !pendingDeletes.has(e.id));
  if (entries.length === 0) return null;

  const csvText = baueCsvText(entries);
  // BOM voran, sonst zeigt Excel die Umlaute als Krautsalat. Wer die Zeilen
  // in docs/erhebung/beobachtungen.csv kopiert, bekommt es nicht mit --
  // erhebung-fortschritt.mjs im Hauptrepo entfernt es zur Sicherheit.
  const csvBlob = new Blob(['\uFEFF' + csvText], { type: 'text/csv;charset=utf-8' });
  const csvFile = new File([csvBlob], `beobachtungen-${todayIso()}.csv`, { type: 'text/csv' });

  // Dateiname muss eindeutig sein: Zwei Wickelmoeglichkeiten am selben Ort
  // am selben Tag (genau der "+ Weitere hier"-Fall) ergaeben sonst zweimal
  // denselben Namen. Beim Teilen wuerde eine der Dateien je nach Zielapp
  // still verworfen. Bereich und id-Suffix machen ihn eindeutig.
  const photoFiles = entries
    .filter((e) => e.foto)
    .map(
      (e) =>
        new File(
          [e.foto],
          [e.datum, slugify(e.ort_name), e.bereich ? slugify(e.bereich) : '', String(e.id).slice(-6)]
            .filter(Boolean)
            .join('_') + '.jpg',
          { type: e.fotoType || 'image/jpeg' }
        )
    );

  return { csvBlob, csvFile, photoFiles, entries, anzahl: entries.length };
}

// Markiert Eintraege als versendet, nachdem sie auf einem anderen Weg als
// dem Direktversand das Geraet erfolgreich verlassen haben (Teilen/
// Herunterladen) -- sonst wuerden sie dauerhaft als "nicht gesendet"
// gelten, obwohl die Daten laengst bei Jonathan angekommen sind.
async function markiereVersendet(entries) {
  for (const e of entries) {
    if (!e.versendet) await putEntry({ ...e, versendet: true });
  }
}

exportButton.addEventListener('click', async () => {
  const paket = await exportDateienBauen();
  if (!paket) {
    showToast('Keine Beobachtungen gespeichert.', { variant: 'error' });
    return;
  }
  const { csvBlob, csvFile, photoFiles, entries } = paket;
  const filesToShare = [csvFile, ...photoFiles];

  if (navigator.canShare && navigator.canShare({ files: filesToShare })) {
    try {
      // NUR files -- ohne title/text. Etliche Android-Ziele (WhatsApp allen
      // voran) nehmen bei gemischtem Aufruf den Text und lassen die Dateien
      // fallen: die Freigabe meldet Erfolg, im Chat kommt aber nur Text an.
      await navigator.share({ files: filesToShare });
      await markiereVersendet(entries);
      await renderList();
      // Web Share meldet auch dann Erfolg, wenn die Zielanwendung die
      // Dateien verworfen hat -- das laesst sich von hier aus nicht
      // feststellen, also lieber einmal zu viel darauf hinweisen.
      showToast('Geteilt — kam nur Text an? Dann „Herunterladen" nutzen.', { durationMs: 5000 });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // Nutzer hat abgebrochen
      console.warn('Web Share fehlgeschlagen, falle auf Download zurück.', err);
    }
  }

  downloadBlob(csvBlob, csvFile.name);
  for (const f of photoFiles) downloadBlob(f, f.name);
  await markiereVersendet(entries);
  await renderList();
  showToast(`${filesToShare.length} Datei(en) heruntergeladen.`);
});

downloadButton.addEventListener('click', async () => {
  const paket = await exportDateienBauen();
  if (!paket) {
    showToast('Keine Beobachtungen gespeichert.', { variant: 'error' });
    return;
  }
  downloadBlob(paket.csvBlob, paket.csvFile.name);
  for (const f of paket.photoFiles) downloadBlob(f, f.name);
  await markiereVersendet(paket.entries);
  await renderList();
  showToast(`${1 + paket.photoFiles.length} Datei(en) heruntergeladen.`);
});

// Direktversand: schickt jede Beobachtung einzeln an den Apps-Script-
// Endpunkt (siehe google-apps-script/README.md) -- Alternative zu
// Teilen/Herunterladen, ohne Mail/WhatsApp als Zwischenschritt. Bricht bei
// Tageslimit oder einem Fehler ab, statt endlos weiterzuversuchen, und
// verweist auf die bestehenden Wege fuer den Rest.
async function direktsendenEintrag(entry) {
  const formData = new FormData();
  formData.append('secret', DIREKTSENDEN_SECRET);
  for (const key of EXPORT_HEADER) formData.append(key, entry[key] ?? '');
  if (entry.foto) {
    formData.append('foto_base64', await blobToBase64(entry.foto));
    formData.append('foto_mimetype', entry.fotoType || 'image/jpeg');
    formData.append(
      'foto_filename',
      [entry.datum, slugify(entry.ort_name), String(entry.id).slice(-6)].filter(Boolean).join('_') + '.jpg'
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DIREKTSENDEN_TIMEOUT_MS);
  try {
    const response = await fetch(DIREKTSENDEN_URL, {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });
    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

// Ein einzelner Sendeversuch. Bei Erfolg wird der Eintrag als "versendet"
// markiert -- das ist die Grundlage dafuer, dass sowohl das automatische
// Senden beim Speichern als auch der manuelle Wiederholungsknopf niemals
// eine bereits angekommene Beobachtung ein zweites Mal ins Sheet schreiben.
async function sendeEinzeln(entry) {
  try {
    const antwort = await direktsendenEintrag(entry);
    const ergebnis = klassifiziereSendeAntwort(antwort);
    if (ergebnis.ok) await putEntry({ ...entry, versendet: true });
    return ergebnis;
  } catch (err) {
    console.warn('Direktversand fehlgeschlagen.', err);
    return klassifiziereSendeFehler(err);
  }
}

// Spiegelt den Knopftext/-zustand an der Zahl der noch nicht erfolgreich
// gesendeten Eintraege -- macht sichtbar, ob ueberhaupt noch was zu tun ist,
// ohne dass man erst reinklicken muss.
function updateDirektsendenButton(entries) {
  const offen = offeneEintraege(entries).length;
  if (offen === 0) {
    direktsendenButton.disabled = true;
    direktsendenButton.textContent = '✓ Alles gesendet';
  } else {
    direktsendenButton.disabled = false;
    direktsendenButton.textContent = `🔄 ${offen} nicht gesendete erneut versuchen`;
  }
}

// Manueller Wiederholungsknopf: schickt NUR Eintraege, die noch nicht als
// "versendet" markiert sind (typischerweise, weil das automatische Senden
// beim Speichern mangels Netz im Feld fehlgeschlagen ist). Sendet
// absichtlich nicht alles erneut -- das wuerde bei jedem Klick Duplikate im
// Sheet erzeugen, weil dort (anders als bei der CSV) niemand von Hand
// dedupliziert.
direktsendenButton.addEventListener('click', async () => {
  const entries = (await getAllEntries()).filter((e) => !pendingDeletes.has(e.id) && !e.versendet);
  if (entries.length === 0) {
    showToast('Nichts offen — alles schon gesendet.');
    return;
  }

  direktsendenButton.disabled = true;
  direktsendenStatus.hidden = false;
  direktsendenStatus.textContent = `Sende 0 / ${entries.length} …`;

  let erfolge = 0;
  let abbruchGrund = null;

  for (let i = 0; i < entries.length; i++) {
    direktsendenStatus.textContent = `Sende ${i + 1} / ${entries.length} …`;
    const ergebnis = await sendeEinzeln(entries[i]);
    if (ergebnis.ok) {
      erfolge++;
    } else {
      abbruchGrund = ergebnis.reason === 'limit_exceeded' ? 'Tageslimit erreicht' : `Fehler (${ergebnis.reason})`;
      break;
    }
  }

  await renderList(); // setzt den Knopftext/-zustand ueber updateDirektsendenButton() neu

  if (erfolge === entries.length) {
    direktsendenStatus.hidden = true;
    showToast(`✓ ${erfolge} ${erfolge === 1 ? 'Beobachtung' : 'Beobachtungen'} nachgesendet.`);
    return;
  }

  const rest = entries.length - erfolge;
  direktsendenStatus.textContent =
    `${erfolge} von ${entries.length} gesendet. ${abbruchGrund ? abbruchGrund + ' — ' : ''}` +
    `Restliche ${rest} bitte über „Weitere Optionen" (Teilen/Herunterladen) senden.`;
  showToast('Nachsenden unvollständig — siehe Hinweis unten.', { variant: 'error', durationMs: 5000 });
});

// GeoJSON: oeffnet sich in praktisch jeder Kartenanwendung (Organic Maps,
// QGIS, geojson.io) -- ersetzt eine eingebaute Karte, ohne dass eine
// Kartenbibliothek ins Repo muss.
geojsonButton.addEventListener('click', async () => {
  const entries = (await getAllEntries()).filter(
    (e) => !pendingDeletes.has(e.id) && e.lat !== '' && e.lon !== ''
  );
  if (entries.length === 0) {
    showToast('Keine Beobachtungen mit GPS-Standort.', { variant: 'error' });
    return;
  }
  const geojson = {
    type: 'FeatureCollection',
    features: entries.map((e) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [Number(e.lon), Number(e.lat)] },
      properties: {
        name: e.ort_name,
        datum: e.datum,
        changing_table: e.changing_table,
        changing_table_location: e.changing_table_location,
        stroller_access: e.stroller_access,
        bereich: e.bereich || '',
        stadtbezirk: e.stadtbezirk,
        quelle: e.quelle,
      },
    })),
  };
  const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/geo+json' });
  downloadBlob(blob, `beobachtungen-${todayIso()}.geojson`);
  showToast(`${entries.length} Orte als GeoJSON exportiert.`);
});

exportReminderButton.addEventListener('click', () => direktsendenButton.click());

// "Alle löschen": zweiter Tap zur Bestätigung statt native confirm(), danach
// ebenfalls per Undo-Toast rueckgaengig machbar (Snapshot vorher im Speicher).
let clearArmed = false;
let clearArmTimeout = null;
const CLEAR_BUTTON_TEXT = 'Alle Einträge löschen';

clearButton.addEventListener('click', async () => {
  if (!clearArmed) {
    clearArmed = true;
    clearButton.textContent = 'Wirklich? Nochmal tippen';
    clearArmTimeout = setTimeout(() => {
      clearArmed = false;
      clearButton.textContent = CLEAR_BUTTON_TEXT;
    }, 4000);
    return;
  }
  clearTimeout(clearArmTimeout);
  clearArmed = false;
  clearButton.textContent = CLEAR_BUTTON_TEXT;

  // Einzeln geloeschte Eintraege liegen bis zum Ablauf ihrer Undo-Frist noch
  // in IndexedDB, gelten aber als geloescht. Sie duerfen NICHT in den
  // Snapshot -- sonst holte ein "Rueckgaengig" der Sammelloeschung Eintraege
  // zurueck, die der Nutzer vorher bewusst einzeln entfernt hat.
  const snapshot = (await getAllEntries()).filter((e) => !pendingDeletes.has(e.id));
  if (snapshot.length === 0) return;
  // Erst die schwebenden Einzel-Timer entschaerfen, dann loeschen -- sonst
  // wuerde ein zurueckgeholter Eintrag Sekunden spaeter erneut verschwinden.
  cancelPendingDeletes();
  await clearAllEntries();
  await renderList();
  showToast(`${snapshot.length} ${snapshot.length === 1 ? 'Eintrag' : 'Einträge'} gelöscht`, {
    // Laenger als die Einzel-Undo-Frist: hier haengt nichts an einem Timer,
    // der Snapshot bleibt gueltig, solange der Toast steht.
    durationMs: CLEAR_UNDO_MS,
    action: {
      label: 'Rückgängig',
      onClick: async () => {
        for (const entry of snapshot) await addEntry(entry);
        await renderList();
      },
    },
  });
});

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch((err) => {
      console.warn('Service-Worker-Registrierung fehlgeschlagen.', err);
    });
  });
}


init().catch((err) => console.error('Initialisierung fehlgeschlagen.', err));
