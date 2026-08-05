/**
 * Wickelkompass Felderfassung — reines Client-Tool fuer die Wickel-Safari.
 *
 * Keine Frameworks, keine Abhaengigkeiten. Speichert Beobachtungen lokal in
 * IndexedDB (Fotos als Blob), exportiert per Web-Share-API oder Download.
 * Feldnamen/Werte sind bewusst identisch zu docs/erhebung/beobachtungen.csv
 * und docs/erhebung/erhebungsbogen.md, damit der Export ohne Mapping in die
 * Desktop-Auswertung (scripts/erhebung-fortschritt.mjs) passt.
 *
 * Kein Teil des Produkts (siehe README.md "Nicht enthalten: Anwendungscode")
 * -- rein privates Erfassungswerkzeug fuer die Vorbereitungsphase.
 */

const DB_NAME = 'wk-feld-erfassung';
const DB_VERSION = 1;
const STORE = 'beobachtungen';
const ZIEL_GESAMT = 150;
const ZIEL_MIT_STANDORT = 100;

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

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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
const gpsMapWrap = document.getElementById('gps-map-wrap');
const gpsMapFrame = document.getElementById('gps-map');
const gpsMapLink = document.getElementById('gps-map-link');
const entriesList = document.getElementById('entries-list');
const progressSummary = document.getElementById('progress-summary');
const headerProgress = document.getElementById('header-progress');
const exportButton = document.getElementById('export-button');
const clearButton = document.getElementById('clear-button');
const toast = document.getElementById('toast');

let currentPosition = null; // { lat, lon }
let currentFotoBlob = null;
let toastTimer = null;

// ---------- Chip-Groups (Ja/Nein & Co. statt Dropdown) ----------

const chipState = {
  changing_table: '',
  changing_table_location: '',
  stroller_access: '',
  quelle: 'field_survey',
};

function setupChipGroups() {
  document.querySelectorAll('.chip-group[data-field]').forEach((group) => {
    const field = group.dataset.field;
    group.querySelectorAll('.chip').forEach((chip) => {
      chip.setAttribute('aria-pressed', 'false');
      chip.addEventListener('click', () => {
        if (group.dataset.disabled === 'true') return;
        selectChip(field, chip.dataset.value);
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
  document.querySelector('.chip-group[data-field="changing_table_location"]').dataset.disabled = 'true';
  selectChip('quelle', 'field_survey');
}

// ---------- Toast ----------

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      toast.hidden = true;
    }, 250);
  }, 2200);
}

// ---------- Init ----------

function init() {
  datumInput.value = todayIso();
  for (const bezirk of STADTBEZIRKE) {
    const opt = document.createElement('option');
    opt.value = bezirk;
    opt.textContent = bezirk;
    bezirkSelect.appendChild(opt);
  }
  setupChipGroups();
  renderList();
  registerServiceWorker();
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
  gpsButton.disabled = true;
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      gpsButton.disabled = false;
      currentPosition = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      gpsStatus.textContent = `✓ Standort erfasst (±${Math.round(pos.coords.accuracy)} m) — auf der Karte prüfen.`;
      showMap(currentPosition.lat, currentPosition.lon);
      await suggestBezirk(currentPosition);
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

async function suggestBezirk({ lat, lon }) {
  if (!navigator.onLine) return; // offline: kein Reverse-Geocoding-Versuch
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=14&addressdetails=1`,
      { headers: { 'Accept-Language': 'de' } }
    );
    if (!res.ok) return;
    const data = await res.json();
    const bucket = guessBezirk(data.address);
    if (bucket) {
      bezirkVorschlag.hidden = false;
      bezirkVorschlag.textContent = `Vorschlag laut GPS: ${bucket} — bitte prüfen.`;
      if (!bezirkSelect.value) bezirkSelect.value = bucket;
    }
  } catch {
    // Offline oder Nominatim nicht erreichbar -- GPS-Koordinaten bleiben trotzdem gespeichert.
  }
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
    ort_name: ortInput.value.trim(),
    adresse: adresseInput.value.trim(),
    google_maps_link: googleLinkInput.value.trim(),
    stadtbezirk: bezirkSelect.value,
    changing_table: chipState.changing_table,
    changing_table_location: chipState.changing_table_location,
    stroller_access: chipState.stroller_access,
    notiz: notizInput.value.trim(),
    quelle: chipState.quelle,
    lat: currentPosition ? currentPosition.lat : '',
    lon: currentPosition ? currentPosition.lon : '',
    foto: currentFotoBlob || null,
    fotoType: currentFotoBlob ? currentFotoBlob.type : '',
  };

  await addEntry(entry);

  form.reset();
  datumInput.value = todayIso();
  resetAllChips();
  fotoPreview.hidden = true;
  bezirkVorschlag.hidden = true;
  gpsStatus.textContent = 'Noch kein Standort erfasst.';
  hideMap();
  currentPosition = null;
  currentFotoBlob = null;

  showToast(`✓ „${entry.ort_name}“ gespeichert`);
  await renderList();
});

async function renderList() {
  const entries = await getAllEntries();
  entries.sort((a, b) => (a.datum < b.datum ? 1 : -1));

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
    meta.textContent = `${e.datum} · ${e.stadtbezirk || 'ohne Bezirk'} · ${e.adresse || ''}`;
    main.appendChild(meta);

    li.appendChild(main);

    const del = document.createElement('button');
    del.className = 'entry-delete';
    del.textContent = '✕';
    del.title = 'Löschen';
    del.addEventListener('click', async () => {
      if (confirm(`„${e.ort_name}“ wirklich löschen?`)) {
        await deleteEntry(e.id);
        await renderList();
      }
    });
    li.appendChild(del);

    entriesList.appendChild(li);
  }
}

exportButton.addEventListener('click', async () => {
  const entries = await getAllEntries();
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
  ];
  const lines = [header.join(';')];
  for (const e of entries) {
    lines.push(header.map((key) => csvEscape(e[key])).join(';'));
  }
  const csvText = lines.join('\n') + '\n';
  const csvBlob = new Blob([csvText], { type: 'text/csv' });
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

clearButton.addEventListener('click', async () => {
  if (!confirm('Wirklich ALLE gespeicherten Beobachtungen löschen? Das kann nicht rückgängig gemacht werden.')) {
    return;
  }
  await clearAllEntries();
  await renderList();
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
