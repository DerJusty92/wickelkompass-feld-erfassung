/**
 * Wickelkompass Felderfassung — reine Kernlogik (core).
 *
 * Alles hier drin ist DOM- und IndexedDB-frei: reine Funktionen und
 * Konstanten, die sowohl der Browser (app.js importiert sie als ES-Modul)
 * als auch der Node-Testlauf (tests/*.test.mjs) benutzen. Kein Build-Schritt
 * -- Browser wie Node laden ES-Module nativ.
 *
 * Faustregel: was ein <input>, ein document.getElementById, eine
 * IndexedDB-Transaktion oder einen fetch() braucht, gehoert NICHT hierher,
 * sondern bleibt in app.js. Was sich allein aus seinen Argumenten ergibt,
 * gehoert hierher -- und wird getestet.
 */

// Gemeinsamer Feldkatalog fuer CSV-Export UND Direktversand -- eine
// Aenderung hier zieht automatisch beide Wege nach. Muss mit FELDER in
// google-apps-script/Code.gs uebereinstimmen (kein Build-Schritt haelt das
// automatisch synchron, siehe Kommentar dort).
export const EXPORT_HEADER = [
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
  'bereich',
];

export const DUPLIKAT_RADIUS_M = 30;

// Export-Erinnerung. Die Daten liegen in genau einer Browser-Datenbank auf
// genau einem Geraet; der Export ist die einzige Sicherung. Schwellen
// bewusst niedrig -- lieber einmal zu oft erinnert als eine Safari verloren.
export const ERINNERUNG_EINTRAEGE = 10;
export const ERINNERUNG_TAGE = 7;

// Offizielle Muenchner Stadtbezirke (Nominatim liefert i. d. R. diese Namen
// in address.suburb / address.city_district) -> Hypothese-Gruppen aus
// docs/erhebung/stadtteil-priorisierung.md. Nicht erfasste Bezirke (z. B.
// Moosach, Laim, Hadern) bleiben ohne Vorschlag -- dann waehlt man selbst.
export const BEZIRK_MAPPING = [
  { match: ['altstadt-lehel', 'altstadt', 'lehel'], bucket: 'Altstadt/Lehel' },
  { match: ['ludwigsvorstadt', 'isarvorstadt'], bucket: 'Ludwigsvorstadt/Isarvorstadt' },
  { match: ['maxvorstadt', 'schwabing'], bucket: 'Maxvorstadt/Schwabing' },
  { match: ['au-haidhausen', 'haidhausen'], bucket: 'Haidhausen/Au' },
  { match: ['berg am laim', 'ramersdorf', 'perlach'], bucket: 'Ramersdorf/Berg am Laim' },
  { match: ['sendling', 'westend', 'schwanthalerhöhe', 'schwanthalerhoehe'], bucket: 'Sendling/Westend' },
  { match: ['neuhausen', 'nymphenburg'], bucket: 'Neuhausen/Nymphenburg' },
  { match: ['pasing', 'obermenzing', 'bogenhausen', 'giesing'], bucket: 'Pasing, Bogenhausen, Giesing' },
];

// Wertumbenennungen. Am 05.08.2026 wurde 'unisex' auf die OSM-Schreibweise
// 'unisex_toilet' umgestellt. Eintraege, die vorher auf einem Geraet
// erfasst wurden, wuerden sonst mit einem Wert exportiert, den weder der
// Erhebungsbogen noch OSM kennt -- still und unbemerkt.
export const WERT_MIGRATION = { changing_table_location: { unisex: 'unisex_toilet' } };

// ---------- Datum/Zeit ----------

// Das optionale Date-Argument ist nur fuer deterministische Tests da; im
// App-Betrieb wird es weggelassen und faellt auf "jetzt" zurueck.
export function todayIso(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function nowHm(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------- CSV ----------

export function csvEscape(value) {
  const s = String(value ?? '');
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Reiner CSV-Text (Header + Zeilen, mit abschliessendem Zeilenumbruch).
// Das vorangestellte BOM und die Verpackung in Blob/File macht app.js --
// das braucht Browser-APIs und laesst sich hier nicht sinnvoll testen.
export function baueCsvText(entries) {
  const lines = [EXPORT_HEADER.join(';')];
  for (const e of entries) {
    lines.push(EXPORT_HEADER.map((key) => csvEscape(e[key])).join(';'));
  }
  return lines.join('\n') + '\n';
}

// ---------- Slug / Bezirk ----------

export function slugify(text) {
  return String(text || 'ort')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40) || 'ort';
}

export function guessBezirk(address) {
  const hay = Object.values(address || {}).join(' ').toLowerCase();
  for (const { match, bucket } of BEZIRK_MAPPING) {
    if (match.some((m) => hay.includes(m))) return bucket;
  }
  return null;
}

// ---------- Geometrie ----------

// Haversine-Distanz in Metern -- fuer Duplikat-Check und Umkreissuche.
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Findet bereits gespeicherte Beobachtungen im Umkreis, naechste zuerst.
// Rein rechnerisch -- der Aufrufer filtert vorher schwebende Loeschungen
// heraus und macht danach die Anzeige. Rueckgabe: [{ e, dist }, ...].
export function findeDuplikate(entries, lat, lon, radius = DUPLIKAT_RADIUS_M) {
  return entries
    .filter((e) => e.lat && e.lon)
    .map((e) => ({ e, dist: distanceMeters(lat, lon, e.lat, e.lon) }))
    .filter((x) => x.dist <= radius)
    .sort((a, b) => a.dist - b.dist);
}

// ---------- Wertmigration ----------

// Migriert veraltete Werte IN PLACE und meldet per Rueckgabe, ob sich etwas
// geaendert hat -- der Aufrufer schreibt geaenderte Eintraege zurueck.
export function migriereEintrag(entry) {
  let geaendert = false;
  for (const [feld, abbildung] of Object.entries(WERT_MIGRATION)) {
    const alt = entry[feld];
    if (alt && abbildung[alt]) {
      entry[feld] = abbildung[alt];
      geaendert = true;
    }
  }
  return geaendert;
}

// ---------- Versand-Status ----------

// Alle noch nicht (erfolgreich) versendeten Eintraege -- Grundlage sowohl
// fuer die Export-Erinnerung als auch fuer den Direktversand-Knopf.
export function offeneEintraege(entries) {
  return entries.filter((e) => !e.versendet);
}

// Reason-Klassifikation der Sende-Antwort/-Fehler, getrennt von fetch() und
// IndexedDB, damit die Fehlerpfade (Netz, Timeout, Limit) testbar sind.
export function klassifiziereSendeAntwort(ergebnis) {
  if (ergebnis && ergebnis.ok) return { ok: true };
  return { ok: false, reason: (ergebnis && ergebnis.reason) || 'unbekannt' };
}

export function klassifiziereSendeFehler(err) {
  return { ok: false, reason: err && err.name === 'AbortError' ? 'zeitueberschreitung' : 'netzwerkfehler' };
}

// ---------- Export-Erinnerung ----------

// Die id beginnt mit Date.now() -- daraus laesst sich das Erfassungsdatum
// ableiten, ohne einen separaten Zeitstempel mitzufuehren.
export function erstelltAm(entry) {
  const ms = Number(String(entry.id).split('-')[0]);
  return Number.isFinite(ms) ? ms : 0;
}

export function tageSeit(ms, jetztMs = Date.now()) {
  return Math.floor((jetztMs - ms) / 86400000);
}

// Entscheidet, OB und mit welchem Text die Export-Erinnerung erscheint --
// die reine Logik hinter updateExportReminder(). jetztMs ist fuer Tests
// injizierbar. Rueckgabe: { sichtbar, anzahl, tage, text }.
export function berechneErinnerung(entries, jetztMs = Date.now()) {
  const offen = offeneEintraege(entries);
  if (offen.length === 0) {
    return { sichtbar: false, anzahl: 0, tage: 0, text: '' };
  }

  const tage = tageSeit(Math.min(...offen.map(erstelltAm)), jetztMs);

  if (offen.length < ERINNERUNG_EINTRAEGE && tage < ERINNERUNG_TAGE) {
    return { sichtbar: false, anzahl: offen.length, tage, text: '' };
  }

  const wieViele = `${offen.length} ${offen.length === 1 ? 'Beobachtung' : 'Beobachtungen'}`;
  const wannHer = tage === 0 ? 'von heute' : `seit ${tage} ${tage === 1 ? 'Tag' : 'Tagen'}`;
  return { sichtbar: true, anzahl: offen.length, tage, text: `${wieViele} noch nicht gesendet (${wannHer}).` };
}
