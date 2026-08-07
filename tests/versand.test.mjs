// versendet-Tracking und Auto-Send-Fehlerpfade. Lauf: `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  offeneEintraege,
  klassifiziereSendeAntwort,
  klassifiziereSendeFehler,
} from '../core.js';

test('offeneEintraege: nur nicht versendete zaehlen', () => {
  const entries = [
    { id: '1', versendet: true },
    { id: '2', versendet: false },
    { id: '3' }, // versendet fehlt -> gilt als offen
  ];
  assert.deepEqual(offeneEintraege(entries).map((e) => e.id), ['2', '3']);
});

test('offeneEintraege: alles versendet ergibt leere Liste', () => {
  const entries = [{ id: '1', versendet: true }, { id: '2', versendet: true }];
  assert.deepEqual(offeneEintraege(entries), []);
});

test('offeneEintraege: leere Liste bleibt leer', () => {
  assert.deepEqual(offeneEintraege([]), []);
});

test('klassifiziereSendeAntwort: ok=true wird durchgereicht', () => {
  assert.deepEqual(klassifiziereSendeAntwort({ ok: true }), { ok: true });
});

test('klassifiziereSendeAntwort: Tageslimit behaelt seinen reason', () => {
  assert.deepEqual(
    klassifiziereSendeAntwort({ ok: false, reason: 'limit_exceeded' }),
    { ok: false, reason: 'limit_exceeded' }
  );
});

test('klassifiziereSendeAntwort: unauthorized behaelt seinen reason', () => {
  assert.deepEqual(
    klassifiziereSendeAntwort({ ok: false, reason: 'unauthorized' }),
    { ok: false, reason: 'unauthorized' }
  );
});

test('klassifiziereSendeAntwort: ok=false ohne reason wird "unbekannt"', () => {
  assert.deepEqual(klassifiziereSendeAntwort({ ok: false }), { ok: false, reason: 'unbekannt' });
});

test('klassifiziereSendeAntwort: null/undefined (kaputtes JSON) wird "unbekannt"', () => {
  assert.deepEqual(klassifiziereSendeAntwort(null), { ok: false, reason: 'unbekannt' });
  assert.deepEqual(klassifiziereSendeAntwort(undefined), { ok: false, reason: 'unbekannt' });
});

test('klassifiziereSendeFehler: AbortError -> zeitueberschreitung', () => {
  const err = new Error('timeout');
  err.name = 'AbortError';
  assert.deepEqual(klassifiziereSendeFehler(err), { ok: false, reason: 'zeitueberschreitung' });
});

test('klassifiziereSendeFehler: sonstiger Fehler -> netzwerkfehler', () => {
  assert.deepEqual(klassifiziereSendeFehler(new TypeError('failed to fetch')), {
    ok: false,
    reason: 'netzwerkfehler',
  });
});

test('klassifiziereSendeFehler: null -> netzwerkfehler (kein Absturz)', () => {
  assert.deepEqual(klassifiziereSendeFehler(null), { ok: false, reason: 'netzwerkfehler' });
});
