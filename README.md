# Wickelkompass — Feld-Erfassung (PWA)

Privates Erfassungstool für die "Wickel-Safari" (Phase 4 des
[Wickelkompass](https://github.com/DerJusty92/Wickelkompass)-Projekts, dort
im privaten Hauptrepo). Kein Teil des eigentlichen Produkts — nur ein
Hilfsmittel, um unterwegs strukturiert Beobachtungen zu erfassen statt als
Handynotiz.

Eigenes öffentliches Repo, weil GitHub Pages auf dem Free-Plan nur bei
öffentlichen Repos verfügbar ist. Der Code hier ist bewusst generisch und
ohne Geschäfts-/Projektkontext — die eigentliche Auswertung
(`scripts/erhebung-fortschritt.mjs`, `docs/erhebung/`) bleibt im privaten
Wickelkompass-Repo.

## Wichtig: was hier "öffentlich" bedeutet — und was nicht

**Öffentlich ist nur der App-Code in diesem Repo (HTML/CSS/JS), niemals die
eigenen erfassten Daten.** Drei getrennte Dinge:

1. GitHub Pages liefert aus diesem Repo ausschließlich statische Dateien
   aus. Kein Backend, keine Datenbank — es gibt keinen Ort, an dem
   eingegebene Beobachtungen hier ankommen könnten.
2. Alle erfassten Daten (Ort, Adresse, GPS, Notizen, Fotos) liegen
   ausschließlich lokal im Browser des jeweiligen Geräts (IndexedDB). Der
   Code enthält keinen einzigen Netzwerk-Call, der diese Daten irgendwohin
   sendet.
3. Die automatischen Netzwerk-Calls sind der optionale Stadtbezirk-/Adress-
   Vorschlag (OpenStreetMap Nominatim) und die Umkreissuche (OpenStreetMap
   Overpass), beide nur nach GPS-Erfassung ausgelöst — dabei gehen
   ausschließlich rohe GPS-Koordinaten raus, keine Ortsnamen, keine Notizen,
   keine Fotos. Export passiert nur auf expliziten Klick, über das
   Teilen-Menü des Geräts oder als lokaler Download — nie automatisch.

## Vanilla, keine Abhängigkeiten

HTML/CSS/JS, kein Build-Schritt. Speichert in IndexedDB auf dem Gerät.
Verlässt das Gerät nur beim expliziten Export.

## Live

**https://derjusty92.github.io/wickelkompass-feld-erfassung/**

Auf dem Handy öffnen und über das Browser-Menü „Zum Startbildschirm
hinzufügen" installieren (Android: Chrome-Menü → App installieren; iOS:
Safari → Teilen → Zum Home-Bildschirm).

## Lokal testen

```bash
node dev-server.mjs
```

Dann `http://localhost:5050` öffnen.

## Icons neu erzeugen

Nur nötig, wenn sich Farbe/Motiv ändern sollen:

```bash
node generate-icons.mjs
```

## Felder

Identisch zu `docs/erhebung/erhebungsbogen.md` /
`docs/erhebung/beobachtungen.csv` im Wickelkompass-Hauptrepo, plus drei
Erweiterungen gegenüber dem Papier-Bogen:

- **GPS-Koordinaten** (`lat`/`lon`), per Button erfasst — spart Adresstippen
  unterwegs, wird zusätzlich zu Name/Adresse gespeichert, nicht als Ersatz.
- **Stadtbezirk- und Adress-Vorschlag per Reverse-Geocoding**: Nach
  GPS-Erfassung wird bei bestehender Verbindung ein Stadtbezirk aus den 8
  Gruppen aus `docs/erhebung/stadtteil-priorisierung.md` (Hauptrepo)
  vorgeschlagen (Mapping der offiziellen 25 Münchner Stadtbezirke auf die 8
  Gruppen in `app.js`, `BEZIRK_MAPPING`) und — falls das Adressfeld noch
  leer ist — Straße/Hausnummer automatisch befüllt. Bitte immer prüfen,
  beides sind nur Vorschläge. Offline bleiben die Felder leer,
  GPS-Koordinaten werden trotzdem gespeichert.
- **Umkreissuche** (OpenStreetMap Overpass, kostenlos, kein Key): zeigt nach
  GPS-Erfassung bis zu 6 nahegelegene benannte Orte (< 40 m) zum Antippen —
  füllt Ort-Name (und Adresse, falls vorhanden) direkt aus. Zwei
  Overpass-Spiegel mit Timeout hintereinander probiert, da der kostenlose
  Dienst gelegentlich überlastet ist (kein SLA) — schlägt in dem Fall
  einfach fehl, ohne die App zu stören, manuelle Eingabe bleibt möglich.
- **Duplikat-Warnung**: liegt der neue GPS-Punkt < 30 m von einer bereits
  gespeicherten Beobachtung entfernt, erscheint ein Hinweis mit Ortsname und
  Datum — rein lokal, kein Netzwerk-Call. Blockiert nichts, nur ein Hinweis.
- **Uhrzeit, Zugänglichkeit, Kostenpflichtig, Zustand** (alle optional):
  strukturierte Zusatzfelder über den Erhebungsbogen hinaus — dort ist das
  bisher nur Freitext in der Notiz. Gehen als eigene Spalten in den Export,
  aber (noch) nicht in `mk.observation` — falls sich das dauerhaft bewährt,
  gehört das ins dokumentierte Datenmodell im Hauptrepo nachgezogen.
- **Foto** (optional, rein als eigene Gedächtnisstütze). Bewusst nur für
  dieses private Tool — der Erhebungsbogen schließt Fotos fürs Produkt
  bewusst aus (Moderationsaufwand, Persönlichkeitsrechte, Speicherkosten).
  Das Foto geht beim Export als eigene Datei mit raus, landet aber nicht in
  der CSV und nicht in `mk.observation`.
- **Google-Maps-Link** (optional, `google_maps_link`): reiner Referenz-Link,
  von Hand aus Google Maps kopiert. **Kein automatischer Abruf der
  Google-Places-API** aus dieser App heraus — Google Maps Platform hat
  eigene, strikte Nutzungsbedingungen für das dauerhafte Speichern von
  Place-Daten (anders als bei OSM/ADR 0001 im Hauptrepo, aber im gleichen
  Geist: nicht einfach mischen/cachen, ohne die Bedingungen geprüft zu
  haben). Ausnahme ist die reine Google Place ID, die laut Google
  unbegrenzt speicherbar ist — die künftige Auflösung Link → Place ID
  gehört serverseitig erledigt (API-Key darf nicht in dieser öffentlichen
  Client-PWA landen), nicht hier. Eine echte Places-Integration mit
  Zusatzinfos braucht vorher eine eigene ADR im Hauptrepo.

## Export

Button „Exportieren / Teilen" baut eine CSV (Spalten wie
`docs/erhebung/beobachtungen.csv` im Hauptrepo, plus `lat`/`lon`/
`google_maps_link`/`uhrzeit`/`zugang`/`kostenpflichtig`/`zustand` am Ende —
die werden vom dortigen Auswertungsskript ignoriert, da es Spalten über den
bekannten Header hinaus nicht auswertet) und hängt Fotos als einzelne
Dateien an.

- Unterstützt das Gerät die Web-Share-API mit Dateien (die meisten aktuellen
  Mobil-Browser): öffnet das native Teilen-Menü — direkt an Mail, WhatsApp
  o. Ä. weiterreichbar.
- Sonst: Dateien werden heruntergeladen, manuell anhängen.

Nach dem Export: Zeilen der CSV manuell unten in
`docs/erhebung/beobachtungen.csv` (Hauptrepo) einfügen (Spalten `lat`/`lon`/
`google_maps_link` können beim Einfügen weggelassen werden, siehe oben —
ggf. `google_maps_link` separat aufheben, falls für eine spätere
Places-Zuordnung gebraucht).

## Löschen

Einzelne Einträge: Antippen auf „✕" entfernt sofort aus der Ansicht, wird
aber erst nach 5 Sekunden wirklich aus IndexedDB gelöscht — der
„Rückgängig"-Toast macht es in der Zwischenzeit rückgängig.

„Alle Einträge löschen": erstes Antippen bewaffnet den Button („Wirklich?
Nochmal tippen", 4 Sekunden Fenster) statt eines blockierenden
Bestätigungsdialogs, zweites Antippen löscht wirklich — ebenfalls mit
Rückgängig-Toast (Snapshot bleibt kurz im Speicher). Kein Cloud-Sync, kein
Backup außer dem Export — nach Ablauf der Undo-Frist ist es wirklich weg.

## Bekannte Grenzen

- Daten liegen pro Browser/Gerät. Browser wechseln oder Website-Daten
  löschen (auch versehentlich über Browser-Einstellungen) heißt: Daten weg,
  wenn vorher nicht exportiert.
- Reverse-Geocoding nutzt den öffentlichen Nominatim-Dienst von
  OpenStreetMap mit reiner Koordinatenübertragung, ohne Speicherung der
  Antwort außer als Vorschlag im Formular. Nur für den geringen
  Anfrageumfang dieses persönlichen Tools gedacht — siehe
  [Nominatim Usage Policy](https://operations.osmfoundation.org/policies/nominatim/),
  kein Bulk-Einsatz.
- Die Umkreissuche nutzt die öffentliche Overpass-API (zwei Spiegel,
  ebenfalls kostenlos, kein Key) — best-effort ohne SLA, kann gelegentlich
  mit Timeout/504 ausfallen. Kein Problem für den Ablauf, die Liste bleibt
  dann einfach leer.
- Repo ist öffentlich (GitHub-Pages-Voraussetzung im Free-Plan) — enthält
  aber bewusst keinerlei Projekt-/Geschäftskontext, nur das generische
  Erfassungswerkzeug.
