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

const DB_NAME = 'wk-feld-erfassung';
const DB_VERSION = 1;
const STORE = 'beobachtungen';
const ZIEL_GESAMT = 150;
const ZIEL_MIT_STANDORT = 100;
const DUPLIKAT_RADIUS_M = 30;
const UNDO_FRIST_MS = 5000;
const CLEAR_UNDO_MS = 9000;

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

// Offizielle Muenchner Stadtbezirke (Nominatim liefert i. d. R. diese Namen
// in address.suburb / address.city_district) -> Hypothese-Gruppen aus
// docs/erhebung/stadtteil-priorisierung.md. Nicht erfasste Bezirke (z. B.
// Moosach, Laim, Hadern) bleiben ohne Vorschlag -- dann waehlt man selbst.
const BEZIRK_MAPPING = [
  { match: ['altstadt-lehel', 'altstadt', 'lehel'], bucket: 'Altstadt/Lehel' },
  { match: ['ludwigsvorstadt', 'isarvorstadt'], bucket: 'Ludwigsvorstadt/Isarvorstadt' },
  { match: ['maxvorstadt', 'schwabing'], bucket: 'Maxvorstadt/Schwabing' },
  { match: ['au-haidhausen', 'haidhausen'], bucket: 'Haidhausen/Au' },
  { match: ['berg am laim', 'ramersdorf', 'perlach'], bucket: 'Ramersdorf/Berg am Laim' },
  { match: ['sendling', 'westend', 'schwanthalerhöhe', 'schwanthalerhoehe'], bucket: 'Sendling/Westend' },
  { match: ['neuhausen', 'nymphenburg'], bucket: 'Neuhausen/Nymphenburg' },
  { match: ['pasing', 'obermenzing', 'bogenhausen', 'giesing'], bucket: 'Pasing, Bogenhausen, Giesing' },
];

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

async function addEntry(entry) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllEntries() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deleteEntry(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function clearAllEntries() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- Hilfsfunktionen ----------

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function nowHm() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function slugify(text) {
  return String(text || 'ort')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40) || 'ort';
}

function guessBezirk(address) {
  const hay = Object.values(address || {}).join(' ').toLowerCase();
  for (const { match, bucket } of BEZIRK_MAPPING) {
    if (match.some((m) => hay.includes(m))) return bucket;
  }
  return null;
}

// Haversine-Distanz in Metern -- fuer Duplikat-Check und Umkreissuche.
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
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
const progressSummary = document.getElementById('progress-summary');
const headerProgress = document.getElementById('header-progress');
const exportButton = document.getElementById('export-button');
const clearButton = document.getElementById('clear-button');
const storageWarning = document.getElementById('storage-warning');
const toast = document.getElementById('toast');

let currentPosition = null; // { lat, lon }
let currentFotoBlob = null;
let toastTimer = null;
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

// ---------- Init ----------

function init() {
  datumInput.value = todayIso();
  uhrzeitInput.value = nowHm();
  for (const bezirk of STADTBEZIRKE) {
    const opt = document.createElement('option');
    opt.value = bezirk;
    opt.textContent = bezirk;
    bezirkSelect.appendChild(opt);
  }
  setupChipGroups();
  renderList();
  registerServiceWorker();
  ensurePersistentStorage();
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
      await Promise.all([
        checkDuplicates(currentPosition.lat, currentPosition.lon),
        suggestBezirkUndAdresse(currentPosition),
        findNearby(currentPosition.lat, currentPosition.lon),
      ]);
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
  const entries = await getAllEntries();
  const treffer = entries
    .filter((e) => e.lat && e.lon && !pendingDeletes.has(e.id))
    .map((e) => ({ e, dist: distanceMeters(lat, lon, e.lat, e.lon) }))
    .filter((x) => x.dist <= DUPLIKAT_RADIUS_M)
    .sort((a, b) => a.dist - b.dist);

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

async function overpassFetch(query) {
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
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
  return null;
}

// Umkreissuche ueber die oeffentliche Overpass-API (kostenlos, kein Key).
// Rein informativ zum Antippen -- kein automatischer Datenabgleich.
async function findNearby(lat, lon) {
  if (!navigator.onLine) return;
  const query = `[out:json][timeout:10];(node(around:40,${lat},${lon})[name];way(around:40,${lat},${lon})[name];);out center 20;`;
  try {
    const data = await overpassFetch(query);
    if (!data) return;
    const results = (data.elements || [])
      .map((el) => {
        const pos = el.type === 'node' ? el : el.center;
        if (!pos) return null;
        return {
          name: el.tags.name,
          kategorie: kategorieLabel(el.tags),
          adresse: [el.tags['addr:street'], el.tags['addr:housenumber']].filter(Boolean).join(' '),
          dist: distanceMeters(lat, lon, pos.lat, pos.lon),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 6);

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

  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    datum: datumInput.value,
    uhrzeit: uhrzeitInput.value,
    ort_name: ortInput.value.trim(),
    adresse: adresseInput.value.trim(),
    google_maps_link: googleLinkInput.value.trim(),
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
    foto: currentFotoBlob || null,
    fotoType: currentFotoBlob ? currentFotoBlob.type : '',
  };

  try {
    await addEntry(entry);
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

  showToast(`✓ „${entry.ort_name}“ gespeichert`);
  await renderList();
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

  const gesamt = entries.filter((e) => e.quelle === 'field_survey').length;
  const mitStandort = entries.filter(
    (e) => e.quelle === 'field_survey' && e.changing_table_location
  ).length;
  progressSummary.textContent = `${gesamt} gespeichert (${mitStandort} mit WC-Standort) — Ziel: ${ZIEL_GESAMT} / ${ZIEL_MIT_STANDORT}`;
  headerProgress.textContent = `${gesamt}/${ZIEL_GESAMT}`;

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
    main.appendChild(badges);

    const meta = document.createElement('div');
    meta.className = 'entry-meta';
    meta.textContent = `${e.datum}${e.uhrzeit ? ' ' + e.uhrzeit : ''} · ${e.stadtbezirk || 'ohne Bezirk'} · ${e.adresse || ''}`;
    main.appendChild(meta);

    li.appendChild(main);

    const del = document.createElement('button');
    del.className = 'entry-delete';
    del.textContent = '✕';
    del.title = 'Löschen';
    del.addEventListener('click', () => softDeleteEntry(e));
    li.appendChild(del);

    entriesList.appendChild(li);
  }
}

// Soft-Delete: sofort aus der Ansicht entfernen, aber erst nach Ablauf der
// Undo-Frist wirklich aus IndexedDB loeschen -- ersetzt den blockierenden
// confirm()-Dialog durch einen Rueckgaengig-Toast.
function softDeleteEntry(entry) {
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

exportButton.addEventListener('click', async () => {
  const entries = (await getAllEntries()).filter((e) => !pendingDeletes.has(e.id));
  if (entries.length === 0) {
    alert('Keine Beobachtungen gespeichert.');
    return;
  }

  const header = [
    'datum',
    'ort_name',
    'adresse',
    'stadtbezirk',
    'changing_table',
    'changing_table_location',
    'stroller_access',
    'notiz',
    'quelle',
    'lat',
    'lon',
    'google_maps_link',
    'uhrzeit',
    'zugang',
    'kostenpflichtig',
    'zustand',
  ];
  const lines = [header.join(';')];
  for (const e of entries) {
    lines.push(header.map((key) => csvEscape(e[key])).join(';'));
  }
  const csvText = lines.join('\n') + '\n';
  // BOM voran, sonst zeigt Excel die Umlaute als Krautsalat. Wer die Zeilen
  // in docs/erhebung/beobachtungen.csv kopiert, bekommt es nicht mit --
  // erhebung-fortschritt.mjs im Hauptrepo entfernt es zur Sicherheit.
  const csvBlob = new Blob(['\uFEFF' + csvText], { type: 'text/csv;charset=utf-8' });
  const csvFile = new File([csvBlob], `beobachtungen-${todayIso()}.csv`, { type: 'text/csv' });

  const photoFiles = entries
    .filter((e) => e.foto)
    .map(
      (e) =>
        new File([e.foto], `${e.datum}_${slugify(e.ort_name)}.jpg`, {
          type: e.fotoType || 'image/jpeg',
        })
    );

  const filesToShare = [csvFile, ...photoFiles];

  if (navigator.canShare && navigator.canShare({ files: filesToShare })) {
    try {
      await navigator.share({
        files: filesToShare,
        title: 'Wickelkompass Beobachtungen',
        text: `${entries.length} Beobachtung(en) aus der Feld-Erfassung.`,
      });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // Nutzer hat abgebrochen
      console.warn('Web Share fehlgeschlagen, falle auf Download zurück.', err);
    }
  }

  downloadBlob(csvBlob, csvFile.name);
  for (const f of photoFiles) downloadBlob(f, f.name);
  alert(
    `${filesToShare.length} Datei(en) heruntergeladen. Bitte manuell per Mail/WhatsApp anhängen.`
  );
});

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

  const snapshot = await getAllEntries();
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

init();
