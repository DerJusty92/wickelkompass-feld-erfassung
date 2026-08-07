// Wertmigration (unisex -> unisex_toilet) und Bezirks-/Datumshelfer.
// Lauf: `node --test` im Repo-Root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migriereEintrag, guessBezirk, todayIso, nowHm } from '../core.js';

test('migriereEintrag: unisex wird zu unisex_toilet und meldet Aenderung', () => {
  const e = { changing_table_location: 'unisex' };
  assert.equal(migriereEintrag(e), true);
  assert.equal(e.changing_table_location, 'unisex_toilet');
});

test('migriereEintrag: bereits migrierter Wert bleibt, keine Aenderung', () => {
  const e = { changing_table_location: 'unisex_toilet' };
  assert.equal(migriereEintrag(e), false);
  assert.equal(e.changing_table_location, 'unisex_toilet');
});

test('migriereEintrag: unbekannter Wert bleibt unangetastet', () => {
  const e = { changing_table_location: 'adult_changing_table' };
  assert.equal(migriereEintrag(e), false);
  assert.equal(e.changing_table_location, 'adult_changing_table');
});

test('migriereEintrag: fehlendes Feld ergibt keine Aenderung', () => {
  const e = { ort_name: 'X' };
  assert.equal(migriereEintrag(e), false);
});

test('migriereEintrag: andere Felder bleiben unberuehrt', () => {
  const e = { changing_table_location: 'unisex', ort_name: 'Cafe', notiz: 'nett' };
  migriereEintrag(e);
  assert.equal(e.ort_name, 'Cafe');
  assert.equal(e.notiz, 'nett');
});

test('guessBezirk: bekannter Suburb wird gebucketet', () => {
  assert.equal(guessBezirk({ suburb: 'Maxvorstadt' }), 'Maxvorstadt/Schwabing');
  assert.equal(guessBezirk({ suburb: 'Schwabing' }), 'Maxvorstadt/Schwabing');
});

test('guessBezirk: gross/klein egal', () => {
  assert.equal(guessBezirk({ city_district: 'MAXVORSTADT' }), 'Maxvorstadt/Schwabing');
});

test('guessBezirk: unbekannter Bezirk -> null', () => {
  assert.equal(guessBezirk({ suburb: 'Moosach' }), null);
});

test('guessBezirk: leere/fehlende Adresse -> null', () => {
  assert.equal(guessBezirk({}), null);
  assert.equal(guessBezirk(null), null);
});

test('todayIso: formatiert YYYY-MM-DD mit Nullen', () => {
  // Monat ist 0-basiert: 7 = August, 2 = Maerz.
  assert.equal(todayIso(new Date(2026, 7, 7)), '2026-08-07');
  assert.equal(todayIso(new Date(2026, 2, 9)), '2026-03-09');
});

test('nowHm: formatiert HH:MM mit Nullen', () => {
  assert.equal(nowHm(new Date(2026, 0, 1, 9, 5)), '09:05');
  assert.equal(nowHm(new Date(2026, 0, 1, 23, 59)), '23:59');
});
