/**
 * IndexedDB-Zugriffsschicht -- DOM-frei und mit injizierbarem indexedDB,
 * damit schreibeMitRetry (die iOS-Haertung, der Ausloeser der QA-Runde)
 * in Node gegen ein Double getestet werden kann, ohne echten Browser.
 *
 * createDb() kapselt EINE wiederverwendete Verbindung pro Instanz -- sonst
 * sammeln sich offene IDBDatabase-Handles an, die spaetere Schema-Upgrades
 * blockieren wuerden. Im Browser reicht app.js ein `indexedDB` (das Global)
 * herein, die Tests ihr Fake.
 */
import { migriereEintrag } from './core.js';

// Fehler, bei denen ein zweiter Versuch garantiert identisch scheitert: der
// Speicher bleibt voll (Quota), der Schluessel bleibt belegt (Constraint),
// die Daten bleiben unklonbar (DataClone) usw. Solche Fehler sofort
// durchreichen -- der Retry unten ist NUR fuer transiente WebKit-Abbrueche
// gedacht, und ein sofortiges Durchreichen laesst z. B. die Quota-
// Sonderbehandlung im Submit-Handler ohne 150-ms-Umweg greifen.
export const NICHT_WIEDERHOLBAR = new Set([
  'QuotaExceededError',
  'ConstraintError',
  'DataCloneError',
  'DataError',
  'VersionError',
]);

export function createDb({ indexedDB, dbName, dbVersion, store, retryDelayMs = 150 }) {
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, dbVersion);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: 'id' });
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
          const tx = db.transaction(store, 'readwrite');
          let request;
          try {
            request = operation(tx.objectStore(store));
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
        // identisch, nur retryDelayMs spaeter. Sofort durchreichen.
        if (err && NICHT_WIEDERHOLBAR.has(err.name)) throw err;
        // Verbindung koennte tot sein (iOS schliesst sie beim Backgrounding).
        // Vor dem zweiten Versuch verwerfen, damit openDb() frisch oeffnet.
        try {
          if (dbPromise) (await dbPromise).close();
        } catch {
          // Schliessen einer bereits toten Verbindung ist egal.
        }
        dbPromise = null;
        if (versuch === 0) await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
    throw letzterFehler;
  }

  function addEntry(entry) {
    return schreibeMitRetry((s) => s.add(entry));
  }

  function deleteEntry(id) {
    return schreibeMitRetry((s) => s.delete(id));
  }

  // put statt add: legt an ODER ueberschreibt. Fuer das Bearbeiten -- add()
  // wuerde bei bestehender id mit ConstraintError abbrechen.
  function putEntry(entry) {
    return schreibeMitRetry((s) => s.put(entry));
  }

  function clearAllEntries() {
    return schreibeMitRetry((s) => s.clear());
  }

  async function getAllEntries() {
    const db = await openDb();
    const eintraege = await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
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

  return { openDb, schreibeMitRetry, addEntry, deleteEntry, putEntry, clearAllEntries, getAllEntries };
}

// Einmaliger Selbsttest, ob IndexedDB in diesem Browser wirklich SCHREIBBAR
// ist. Auf iOS Safari im privaten Modus laesst sich die DB zwar oeffnen, aber
// jede Schreib-Transaktion scheitert dauerhaft mit UnknownError -- das kann
// schreibeMitRetry NICHT auffangen (nicht transient, der zweite Versuch
// scheitert identisch). Deshalb hier VOR dem ersten echten Speichern pruefen
// und den Nutzer warnen, statt ihn ins Leere speichern zu lassen.
//
// Bewusst gegen eine eigene Wegwerf-DB, nicht gegen den echten Store: so
// bleibt der Datenbestand unberuehrt und es kann kein Testeintrag
// zurueckbleiben. Gibt true/false zurueck und wirft nie.
export function istIndexedDbSchreibbar({ indexedDB, testDbName = 'wk-schreibtest', store = 'probe' }) {
  return new Promise((resolve) => {
    let db = null;
    const fertig = (ergebnis) => {
      try {
        if (db) db.close();
      } catch {
        // egal
      }
      try {
        indexedDB.deleteDatabase(testDbName); // best effort aufraeumen
      } catch {
        // egal
      }
      resolve(ergebnis);
    };

    let req;
    try {
      req = indexedDB.open(testDbName, 1);
    } catch {
      resolve(false);
      return;
    }
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(store)) d.createObjectStore(store, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      db = req.result;
      try {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put({ id: 'probe' });
        tx.oncomplete = () => fertig(true);
        tx.onerror = () => fertig(false);
        tx.onabort = () => fertig(false);
      } catch {
        fertig(false);
      }
    };
    req.onerror = () => fertig(false);
  });
}
