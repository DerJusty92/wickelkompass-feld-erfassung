// Distanz- und Duplikatpruefung. Lauf: `node --test` im Repo-Root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceMeters, findeDuplikate } from '../core.js';

test('distanceMeters: gleicher Punkt ist 0 m', () => {
  assert.equal(distanceMeters(48.137, 11.575, 48.137, 11.575), 0);
});

test('distanceMeters: 1 Grad Laenge am Aequator ~111.2 km', () => {
  const d = distanceMeters(0, 0, 0, 1);
  assert.ok(Math.abs(d - 111194.9) < 1, `war ${d}`);
});

test('distanceMeters: 1 Grad Breite ~111.2 km (laengenunabhaengig)', () => {
  const d = distanceMeters(0, 0, 1, 0);
  assert.ok(Math.abs(d - 111194.9) < 1, `war ${d}`);
});

test('distanceMeters: kurze Strecke in Muenchen plausibel (~74 m)', () => {
  // 0.001 Grad Laenge auf Breite 48 ~ 111194.9 * cos(48deg) * 0.001
  const d = distanceMeters(48.1374, 11.5755, 48.1374, 11.5765);
  assert.ok(Math.abs(d - 74.4) < 1.5, `war ${d}`);
});

test('distanceMeters: symmetrisch', () => {
  const a = distanceMeters(48.1, 11.5, 48.2, 11.6);
  const b = distanceMeters(48.2, 11.6, 48.1, 11.5);
  assert.ok(Math.abs(a - b) < 1e-6);
});

test('findeDuplikate: Treffer im Radius, naechster zuerst', () => {
  const lat = 48.1374;
  const lon = 11.5755;
  const entries = [
    { id: 'a', ort_name: 'weit', lat: 48.1374, lon: 11.5765 }, // ~74 m, ausserhalb 30 m
    { id: 'b', ort_name: 'nah', lat: 48.13742, lon: 11.57552 }, // wenige Meter
    { id: 'c', ort_name: 'mittel', lat: 48.13755, lon: 11.5755 }, // ~17 m
  ];
  const treffer = findeDuplikate(entries, lat, lon);
  assert.deepEqual(treffer.map((t) => t.e.ort_name), ['nah', 'mittel']);
  assert.ok(treffer[0].dist <= treffer[1].dist);
});

test('findeDuplikate: eigener Radius wird respektiert', () => {
  const entries = [{ id: 'a', ort_name: 'x', lat: 48.1374, lon: 11.5765 }]; // ~74 m
  assert.equal(findeDuplikate(entries, 48.1374, 11.5755, 30).length, 0);
  assert.equal(findeDuplikate(entries, 48.1374, 11.5755, 100).length, 1);
});

test('findeDuplikate: Eintraege ohne lat/lon werden ignoriert', () => {
  const entries = [
    { id: 'a', ort_name: 'ohne', lat: '', lon: '' },
    { id: 'b', ort_name: 'null', lat: 0, lon: 0 },
    { id: 'c', ort_name: 'mit', lat: 48.13742, lon: 11.57552 },
  ];
  const treffer = findeDuplikate(entries, 48.1374, 11.5755);
  assert.deepEqual(treffer.map((t) => t.e.ort_name), ['mit']);
});

test('findeDuplikate: leere Liste ergibt leeres Ergebnis', () => {
  assert.deepEqual(findeDuplikate([], 48, 11), []);
});
