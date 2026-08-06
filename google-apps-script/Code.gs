/**
 * Wickelkompass Feld-Erfassung — Direktversand-Bridge
 *
 * Nimmt Beobachtungen per POST von der PWA entgegen und haengt sie an ein
 * Google Sheet an (Foto optional in einen Drive-Ordner). Laeuft als
 * "Container-bound Script" in genau dem Sheet, das als Eingang dient
 * (Extensions > Apps Script aus dem Sheet heraus geoeffnet) — deshalb kein
 * SHEET_ID noetig, SpreadsheetApp.getActiveSpreadsheet() reicht.
 *
 * Enthaelt bewusst KEIN Secret im Code. Das Secret liegt in den
 * Script Properties (Projekteinstellungen > Script Properties), damit
 * diese Datei gefahrlos in einem oeffentlichen Repo liegen kann.
 *
 * Script Properties, die vor dem Deploy gesetzt werden muessen:
 *   SHARED_SECRET     — beliebiger String, muss mit DIREKTSENDEN_SECRET in
 *                        app.js uebereinstimmen (siehe README.md hier)
 *   DRIVE_FOLDER_ID   — ID des Drive-Ordners fuer Fotos (aus der Ordner-URL)
 *
 * Deployment: Web App, "Execute as: Me", "Who has access: Anyone".
 * Kein doGet() — bewusst nur ein Schreibpfad, kein Lesepfad nach aussen.
 *
 * WICHTIG: FELDER muss mit EXPORT_HEADER in app.js uebereinstimmen (Namen
 * UND Reihenfolge sind fuer die Sheet-Spalten nicht zwingend, aber die
 * Feldnamen selbst muessen identisch sein, sonst kommt e.parameter.<feld>
 * hier leer an). Es gibt keinen Build-Schritt, der das automatisch
 * synchron haelt -- bei Aenderungen an einer Seite die andere mitziehen.
 */

const SHEET_NAME = 'Beobachtungen';
const DAILY_LIMIT = 100;

// Reihenfolge = Spaltenreihenfolge im Sheet (nach "zeitstempel"). Muss mit
// EXPORT_HEADER in app.js uebereinstimmen.
const FELDER = [
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

function doPost(e) {
  try {
    const props = PropertiesService.getScriptProperties();
    const expectedSecret = props.getProperty('SHARED_SECRET');
    const secret = e.parameter.secret;

    if (!expectedSecret || secret !== expectedSecret) {
      return jsonResponse({ ok: false, reason: 'unauthorized' });
    }

    if (isOverDailyLimit_(props)) {
      return jsonResponse({ ok: false, reason: 'limit_exceeded' });
    }

    const ortName = (e.parameter.ort_name || '').trim();
    if (!ortName) {
      return jsonResponse({ ok: false, reason: 'invalid', detail: 'ort_name fehlt' });
    }

    // Wichtig: doPost() konvertiert ein Datei-Feld aus FormData nur dann
    // automatisch in ein Blob, wenn das Formular von Apps Script selbst
    // ausgeliefert wurde (eigene HtmlService-Seite). Bei einem externen
    // Aufrufer (unsere PWA) kommt bei e.parameter.<feldname> nichts
    // Verwertbares an. Deshalb schickt der Client das Foto als Base64-
    // String, hier wird daraus wieder ein Blob gebaut. Siehe
    // https://tanaikech.github.io/2020/08/13/uploading-file-to-google-drive-from-external-html-without-authorization/
    let fotoUrl = '';
    const fotoBase64 = e.parameter.foto_base64;
    if (fotoBase64) {
      const folderId = props.getProperty('DRIVE_FOLDER_ID');
      if (folderId) {
        const bytes = Utilities.base64Decode(fotoBase64);
        const mimeType = e.parameter.foto_mimetype || 'image/jpeg';
        const filename = e.parameter.foto_filename || 'foto.jpg';
        const blob = Utilities.newBlob(bytes, mimeType, filename);
        const folder = DriveApp.getFolderById(folderId);
        const file = folder.createFile(blob);
        fotoUrl = file.getUrl();
      }
    }

    const sheet = getOrCreateSheet_();
    const row = FELDER.map((feld) => e.parameter[feld] || '');
    sheet.appendRow([new Date(), ...row, fotoUrl]);

    incrementDailyCounter_(props);
    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ ok: false, reason: 'server_error', detail: String(err) });
  }
}

function getOrCreateSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);
    sheet.appendRow(['zeitstempel', ...FELDER, 'foto_url']);
  }
  return sheet;
}

function isOverDailyLimit_(props) {
  const today = todayKey_();
  const storedDay = props.getProperty('COUNTER_DAY');
  if (storedDay !== today) return false; // neuer Tag, Zaehler wird bei increment zurueckgesetzt
  const count = Number(props.getProperty('COUNTER_VALUE') || '0');
  return count >= DAILY_LIMIT;
}

function incrementDailyCounter_(props) {
  const today = todayKey_();
  const storedDay = props.getProperty('COUNTER_DAY');
  const count = storedDay === today ? Number(props.getProperty('COUNTER_VALUE') || '0') : 0;
  props.setProperty('COUNTER_DAY', today);
  props.setProperty('COUNTER_VALUE', String(count + 1));
}

function todayKey_() {
  return Utilities.formatDate(new Date(), 'Europe/Berlin', 'yyyy-MM-dd');
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
