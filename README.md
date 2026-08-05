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
3. Der einzige automatische Netzwerk-Call ist der optionale
   Stadtbezirk-Vorschlag (siehe unten) — dabei gehen ausschließlich rohe
   GPS-Koordinaten an OpenStreetMap Nominatim raus, keine Ortsnamen, keine
   Notizen, keine Fotos. Export passiert nur auf expliziten Klick, über das
   Teilen-Menü des Geräts oder als lokaler Download — nie automatisch.

## Vanilla, keine Abhängigkeiten

HTML/CSS/JS, kein Build-Schritt. Speichert in IndexedDB auf dem Gerät.
Verlässt das Gerät nur beim expliziten Export.

## Live

<!-- URL wird nach dem ersten Pages-Deploy ergänzt -->

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
- **Stadtbezirk-Vorschlag per Reverse-Geocoding**: Nach GPS-Erfassung wird
  bei bestehender Verbindung ein Vorschlag aus den 8 Gruppen aus
  `docs/erhebung/stadtteil-priorisierung.md` (Hauptrepo) befüllt (Mapping
  der offiziellen 25 Münchner Stadtbezirke auf die 8 Gruppen in `app.js`,
  `BEZIRK_MAPPING`) — bitte immer prüfen, ist nur ein Vorschlag. Offline
  bleibt das Feld leer, GPS-Koordinaten werden trotzdem gespeichert.
- **Foto** (optional, rein als eigene Gedächtnisstütze). Bewusst nur für
  dieses private Tool — der Erhebungsbogen schließt Fotos fürs Produkt
  bewusst aus (Moderationsaufwand, Persönlichkeitsrechte, Speicherkosten).
  Das Foto geht beim Export als eigene Datei mit raus, landet aber nicht in
  der CSV und nicht in `mk.observation`.

## Export

Button „Exportieren / Teilen" baut eine CSV (Spalten wie
`docs/erhebung/beobachtungen.csv` im Hauptrepo, plus `lat`/`lon` am Ende —
die werden vom dortigen Auswertungsskript ignoriert, da es Spalten über den
bekannten Header hinaus nicht auswertet) und hängt Fotos als einzelne
Dateien an.

- Unterstützt das Gerät die Web-Share-API mit Dateien (die meisten aktuellen
  Mobil-Browser): öffnet das native Teilen-Menü — direkt an Mail, WhatsApp
  o. Ä. weiterreichbar.
- Sonst: Dateien werden heruntergeladen, manuell anhängen.

Nach dem Export: Zeilen der CSV manuell unten in
`docs/erhebung/beobachtungen.csv` (Hauptrepo) einfügen (Spalten `lat`/`lon`
können beim Einfügen weggelassen werden, siehe oben).

## Löschen

„Alle Einträge löschen" leert die IndexedDB unwiderruflich — vorher
exportieren. Kein Cloud-Sync, kein Backup außer dem Export.

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
- Repo ist öffentlich (GitHub-Pages-Voraussetzung im Free-Plan) — enthält
  aber bewusst keinerlei Projekt-/Geschäftskontext, nur das generische
  Erfassungswerkzeug.
