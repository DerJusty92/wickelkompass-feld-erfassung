// Export-Erinnerung: Schwellen, Text, Zeitableitung aus der id.
// Lauf: `node --test` im Repo-Root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erstelltAm, tageSeit, berechneErinnerung } from '../core.js';

const TAG = 86400000;

// Baut n offene (nicht versendete) Eintraege, alle vor `alterTage` erstellt.
function offeneEintraege(n, jetztMs, alterTage = 0) {
  const ms = jetztMs - alterTage * TAG;
  return Array.from({ length: n }, (_, i) => ({ id: `${ms}-e${i}`, versendet: false }));
}

test('erstelltAm: liest den ms-Teil vor dem ersten Bindestrich', () => {
  assert.equal(erstelltAm({ id: '1700000000000-abc' }), 1700000000000);
});

test('erstelltAm: numerische id wird zu String verarbeitet', () => {
  assert.equal(erstelltAm({ id: 12345 }), 12345);
});

test('erstelltAm: unparsbare id ergibt 0', () => {
  assert.equal(erstelltAm({ id: 'keine-zahl' }), 0);
});

test('tageSeit: heute = 0, drei Tage = 3', () => {
  const jetzt = 1_000_000_000_000;
  assert.equal(tageSeit(jetzt, jetzt), 0);
  assert.equal(tageSeit(jetzt - 3 * TAG, jetzt), 3);
});

test('berechneErinnerung: keine offenen Eintraege -> unsichtbar', () => {
  const jetzt = Date.now();
  const entries = [{ id: `${jetzt}-a`, versendet: true }];
  assert.equal(berechneErinnerung(entries, jetzt).sichtbar, false);
});

test('berechneErinnerung: wenige, frische offene -> unsichtbar', () => {
  const jetzt = Date.now();
  const r = berechneErinnerung(offeneEintraege(3, jetzt, 0), jetzt);
  assert.equal(r.sichtbar, false);
  assert.equal(r.anzahl, 3);
});

test('berechneErinnerung: 10 offene (Mengenschwelle) -> sichtbar, Plural, "von heute"', () => {
  const jetzt = Date.now();
  const r = berechneErinnerung(offeneEintraege(10, jetzt, 0), jetzt);
  assert.equal(r.sichtbar, true);
  assert.equal(r.text, '10 Beobachtungen noch nicht gesendet (von heute).');
});

test('berechneErinnerung: 1 offener seit 7 Tagen (Zeitschwelle) -> sichtbar, Singular', () => {
  const jetzt = Date.now();
  const r = berechneErinnerung(offeneEintraege(1, jetzt, 7), jetzt);
  assert.equal(r.sichtbar, true);
  assert.equal(r.tage, 7);
  assert.equal(r.text, '1 Beobachtung noch nicht gesendet (seit 7 Tagen).');
});

test('berechneErinnerung: Grenzfall 6 Tage und wenige -> noch unsichtbar', () => {
  const jetzt = Date.now();
  assert.equal(berechneErinnerung(offeneEintraege(1, jetzt, 6), jetzt).sichtbar, false);
});

test('berechneErinnerung: Singular "seit 1 Tag" bei sichtbarer Mengenschwelle', () => {
  const jetzt = Date.now();
  const r = berechneErinnerung(offeneEintraege(10, jetzt, 1), jetzt);
  assert.equal(r.sichtbar, true);
  assert.equal(r.text, '10 Beobachtungen noch nicht gesendet (seit 1 Tag).');
});

test('berechneErinnerung: aeltester offener bestimmt die Tage', () => {
  const jetzt = Date.now();
  const entries = [
    { id: `${jetzt}-neu`, versendet: false },
    { id: `${jetzt - 9 * TAG}-alt`, versendet: false },
    { id: `${jetzt - 30 * TAG}-versendet`, versendet: true }, // zaehlt nicht
  ];
  const r = berechneErinnerung(entries, jetzt);
  assert.equal(r.sichtbar, true); // 9 Tage >= 7
  assert.equal(r.tage, 9);
  assert.equal(r.anzahl, 2);
});
