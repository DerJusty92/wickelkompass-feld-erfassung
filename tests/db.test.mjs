// schreibeMitRetry (die iOS-IndexedDB-Haertung) gegen ein handgeschriebenes,
// dependency-freies IndexedDB-Double. Lauf: `node --test`.
//
// Das Double ist absichtlich minimal: es simuliert genau die Ereignisse, um
// die es geht (oncomplete / onabort mit tx.error=null / synchroner Wurf) und
// zaehlt Transaktionen mit, damit sich Fail-fast (kein zweiter Versuch)
// beweisen laesst.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, istIndexedDbSchreibbar } from '../db.js';

function benannterFehler(name, message = name) {
  const e = new Error(message);
  e.name = name;
  return e;
}

// outcomes: pro readwrite-Transaktion ein Deskriptor, der Reihe nach:
//   { complete: wert }            -> tx.oncomplete, request.result = wert
//   { abort: fehlerOderNull }     -> tx.error = fehler; tx.onabort
//   { requestError: fehler }      -> request.error = fehler; tx.error=null; tx.onerror
//   { throwSync: fehler }         -> store.add/put/... wirft synchron
// `data` ist der Bestand fuer readonly getAll().
function makeFakeIdb({ outcomes = [], data = [] } = {}) {
  const zaehler = { transaktionen: 0, readwrite: 0 };
  const writes = [];
  let restData = data;

  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    onversionchange: null,
    onclose: null,
    close() {},
    transaction(_store, mode) {
      zaehler.transaktionen++;
      const tx = { error: null, oncomplete: null, onerror: null, onabort: null };

      if (mode === 'readonly') {
        tx.objectStore = () => ({
          getAll() {
            const req = { result: restData, error: null, onsuccess: null, onerror: null };
            queueMicrotask(() => req.onsuccess && req.onsuccess());
            return req;
          },
        });
        return tx;
      }

      // readwrite
      zaehler.readwrite++;
      const outcome = outcomes[zaehler.readwrite - 1] || { complete: undefined };
      const schreibe = (arg) => {
        writes.push(arg);
        if ('throwSync' in outcome) throw outcome.throwSync;
        const req = { result: outcome.complete, error: null };
        queueMicrotask(() => {
          if ('abort' in outcome) {
            tx.error = outcome.abort ?? null;
            tx.onabort && tx.onabort();
          } else if ('requestError' in outcome) {
            req.error = outcome.requestError;
            tx.error = null;
            tx.onerror && tx.onerror();
          } else {
            tx.oncomplete && tx.oncomplete();
          }
        });
        return req;
      };
      tx.objectStore = () => ({
        add: schreibe,
        put: schreibe,
        delete: schreibe,
        clear: () => schreibe(undefined),
      });
      return tx;
    },
  };

  const indexedDB = {
    open() {
      const req = { result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => req.onsuccess && req.onsuccess());
      return req;
    },
    deleteDatabase() {
      /* no-op im Test */
    },
  };

  return { indexedDB, zaehler, writes };
}

function makeDb(fake) {
  return createDb({
    indexedDB: fake.indexedDB,
    dbName: 'test',
    dbVersion: 1,
    store: 'beobachtungen',
    retryDelayMs: 0, // Tests nicht kuenstlich verlangsamen
  });
}

test('addEntry: transienter Abbruch (tx.error=null) wird beim 2. Versuch aufgefangen', async () => {
  const fake = makeFakeIdb({ outcomes: [{ abort: null }, { complete: undefined }] });
  const db = makeDb(fake);
  await db.addEntry({ id: '1', ort_name: 'X' }); // darf NICHT werfen
  assert.equal(fake.zaehler.readwrite, 2, 'genau ein Retry');
});

test('addEntry: scheitern beide Versuche, kommt der benannte Fehler hoch', async () => {
  const fake = makeFakeIdb({ outcomes: [{ abort: null }, { abort: null }] });
  const db = makeDb(fake);
  await assert.rejects(db.addEntry({ id: '1' }), (err) => {
    assert.equal(err.name, 'TransaktionAbgebrochen');
    return true;
  });
  assert.equal(fake.zaehler.readwrite, 2);
});

test('addEntry: gesetzter tx.error wird dem synthetischen Fallback vorgezogen', async () => {
  const fake = makeFakeIdb({
    outcomes: [{ abort: benannterFehler('UnknownError') }, { abort: benannterFehler('UnknownError') }],
  });
  const db = makeDb(fake);
  await assert.rejects(db.addEntry({ id: '1' }), (err) => {
    assert.equal(err.name, 'UnknownError');
    return true;
  });
});

test('addEntry: Fail-fast bei QuotaExceededError (kein zweiter Versuch)', async () => {
  const fake = makeFakeIdb({ outcomes: [{ abort: benannterFehler('QuotaExceededError') }] });
  const db = makeDb(fake);
  await assert.rejects(db.addEntry({ id: '1' }), (err) => {
    assert.equal(err.name, 'QuotaExceededError');
    return true;
  });
  assert.equal(fake.zaehler.readwrite, 1, 'kein Retry bei strukturellem Fehler');
});

test('putEntry: Fail-fast bei synchronem DataCloneError (kein zweiter Versuch)', async () => {
  const fake = makeFakeIdb({ outcomes: [{ throwSync: benannterFehler('DataCloneError') }] });
  const db = makeDb(fake);
  await assert.rejects(db.putEntry({ id: '1', foto: {} }), (err) => {
    assert.equal(err.name, 'DataCloneError');
    return true;
  });
  assert.equal(fake.zaehler.readwrite, 1);
});

test('addEntry: request.error wird genutzt, wenn tx.error fehlt', async () => {
  const fake = makeFakeIdb({
    outcomes: [{ requestError: benannterFehler('AbortError') }, { requestError: benannterFehler('AbortError') }],
  });
  const db = makeDb(fake);
  await assert.rejects(db.addEntry({ id: '1' }), (err) => {
    assert.equal(err.name, 'AbortError');
    return true;
  });
});

test('schreibeMitRetry: reicht request.result durch (z. B. den Key)', async () => {
  const fake = makeFakeIdb({ outcomes: [{ complete: 'der-key' }] });
  const db = makeDb(fake);
  const ergebnis = await db.schreibeMitRetry((s) => s.add({ id: '1' }));
  assert.equal(ergebnis, 'der-key');
});

test('addEntry: reicht die Operation an den Store durch (add bekommt den Eintrag)', async () => {
  const fake = makeFakeIdb({ outcomes: [{ complete: undefined }] });
  const db = makeDb(fake);
  const eintrag = { id: '1', ort_name: 'Cafe' };
  await db.addEntry(eintrag);
  assert.deepEqual(fake.writes[0], eintrag);
});

test('getAllEntries: migriert beim Lesen und schreibt die Korrektur zurueck', async () => {
  const fake = makeFakeIdb({
    data: [
      { id: 'a', changing_table_location: 'unisex' },
      { id: 'b', changing_table_location: 'unisex_toilet' },
    ],
    outcomes: [{ complete: undefined }], // der eine Migrations-putEntry
  });
  const db = makeDb(fake);
  const entries = await db.getAllEntries();
  // Rueckgabe traegt den migrierten Wert (migriereEintrag mutiert in place)
  assert.equal(entries.find((e) => e.id === 'a').changing_table_location, 'unisex_toilet');
  // genau ein Zurueckschreiben (nur der veraltete Eintrag)
  assert.equal(fake.zaehler.readwrite, 1);
  assert.equal(fake.writes[0].id, 'a');
  assert.equal(fake.writes[0].changing_table_location, 'unisex_toilet');
});

test('getAllEntries: ohne veraltete Werte wird nichts zurueckgeschrieben', async () => {
  const fake = makeFakeIdb({ data: [{ id: 'a', changing_table_location: 'unisex_toilet' }] });
  const db = makeDb(fake);
  await db.getAllEntries();
  assert.equal(fake.zaehler.readwrite, 0);
});

test('istIndexedDbSchreibbar: true, wenn die Probe-Transaktion durchlaeuft', async () => {
  const fake = makeFakeIdb({ outcomes: [{ complete: undefined }] });
  assert.equal(await istIndexedDbSchreibbar({ indexedDB: fake.indexedDB }), true);
});

test('istIndexedDbSchreibbar: false bei Abbruch (z. B. iOS-Privatmodus)', async () => {
  const fake = makeFakeIdb({ outcomes: [{ abort: benannterFehler('UnknownError') }] });
  assert.equal(await istIndexedDbSchreibbar({ indexedDB: fake.indexedDB }), false);
});

test('istIndexedDbSchreibbar: false, wenn open() synchron wirft, ohne selbst zu werfen', async () => {
  const kaputt = {
    open() {
      throw new Error('kein IndexedDB');
    },
    deleteDatabase() {},
  };
  assert.equal(await istIndexedDbSchreibbar({ indexedDB: kaputt }), false);
});
