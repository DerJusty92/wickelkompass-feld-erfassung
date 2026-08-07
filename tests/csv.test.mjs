// CSV-Bau, Escaping und Dateiname-Slug. Lauf: `node --test` im Repo-Root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvEscape, baueCsvText, slugify, EXPORT_HEADER } from '../core.js';

test('csvEscape: harmlose Werte bleiben unveraendert', () => {
  assert.equal(csvEscape('Rewe City'), 'Rewe City');
  assert.equal(csvEscape('48.137'), '48.137');
});

test('csvEscape: Semikolon, Anfuehrungszeichen, Zeilenumbruch werden gequotet', () => {
  assert.equal(csvEscape('a;b'), '"a;b"');
  assert.equal(csvEscape('a"b'), '"a""b"');
  assert.equal(csvEscape('a\nb'), '"a\nb"');
});

test('csvEscape: null/undefined werden zu leerem String', () => {
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape(undefined), '');
});

test('csvEscape: Zahlen werden zu Text', () => {
  assert.equal(csvEscape(0), '0');
  assert.equal(csvEscape(48.1374), '48.1374');
});

test('baueCsvText: erste Zeile ist der Header in fester Reihenfolge', () => {
  const text = baueCsvText([]);
  assert.equal(text, EXPORT_HEADER.join(';') + '\n');
});

test('baueCsvText: Werte stehen in Header-Reihenfolge, Fehlendes bleibt leer', () => {
  const entry = { datum: '2026-08-07', ort_name: 'Cafe X', lat: 48.1, lon: 11.5 };
  const text = baueCsvText([entry]);
  const zeilen = text.trimEnd().split('\n');
  const felder = zeilen[1].split(';');
  const idxDatum = EXPORT_HEADER.indexOf('datum');
  const idxOrt = EXPORT_HEADER.indexOf('ort_name');
  const idxLat = EXPORT_HEADER.indexOf('lat');
  const idxAdresse = EXPORT_HEADER.indexOf('adresse');
  assert.equal(felder[idxDatum], '2026-08-07');
  assert.equal(felder[idxOrt], 'Cafe X');
  assert.equal(felder[idxLat], '48.1');
  assert.equal(felder[idxAdresse], ''); // nicht gesetzt -> leer
  assert.equal(felder.length, EXPORT_HEADER.length);
});

test('baueCsvText: Semikolon im Notizfeld wird gequotet (bricht CSV nicht)', () => {
  const entry = { ort_name: 'X', notiz: 'eng; aber ok' };
  const text = baueCsvText([entry]);
  assert.ok(text.includes('"eng; aber ok"'), text);
});

test('baueCsvText: endet mit genau einem Zeilenumbruch', () => {
  const text = baueCsvText([{ ort_name: 'X' }]);
  assert.ok(text.endsWith('\n'));
  assert.ok(!text.endsWith('\n\n'));
});

test('baueCsvText: mehrere Eintraege ergeben Header + je eine Zeile', () => {
  const text = baueCsvText([{ ort_name: 'A' }, { ort_name: 'B' }]);
  assert.equal(text.trimEnd().split('\n').length, 3);
});

test('slugify: Grundfall lowercased und mit Bindestrichen', () => {
  assert.equal(slugify('Rewe City'), 'rewe-city');
});

test('slugify: leer/nur Sonderzeichen faellt auf "ort" zurueck', () => {
  assert.equal(slugify(''), 'ort');
  assert.equal(slugify('###'), 'ort');
  assert.equal(slugify(null), 'ort');
});

test('slugify: fuehrende/abschliessende Trenner werden entfernt', () => {
  assert.equal(slugify('-Rewe-'), 'rewe');
  assert.equal(slugify('  Cafe  '), 'cafe');
});

test('slugify: auf 40 Zeichen begrenzt', () => {
  const lang = 'a'.repeat(60);
  assert.equal(slugify(lang).length, 40);
});
