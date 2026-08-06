# Direktversand-Bridge — Setup

Ergaenzt die PWA um einen dritten Export-Weg ("Direkt senden") neben
"Teilen" und "Herunterladen". Details und Risikoabwaegung siehe Plan in der
Session (wird bei Bedarf nachdokumentiert). Dieser Ordner enthaelt nur die
Server-Seite (`Code.gs`); die PWA-Seite folgt in einem spaeteren Schritt.

Aktueller Stand: **Spike** — validiert, ob der Ansatz technisch funktioniert
(Datei-Upload per FormData, lesbare JSON-Antwort im Browser trotz Cross-
Origin-Aufruf), bevor die volle Fehlerbehandlung in `app.js` gebaut wird.

## Einmaliges Setup (musst du selbst machen, Google-Konto-Aktionen)

1. Neues Google Sheet anlegen (z. B. ueber sheet.new), Namen vergeben, z. B.
   "Wickelkompass Feld-Erfassung — Eingang".
2. Im Sheet: **Erweiterungen > Apps Script** oeffnen. Das erzeugt ein an
   dieses Sheet gebundenes Skript-Projekt.
3. Den Beispielcode im Editor loeschen, Inhalt von `Code.gs` aus diesem
   Ordner einfuegen.
4. Google Drive: neuen Ordner fuer Fotos anlegen, ID aus der URL kopieren
   (der Teil nach `/folders/`).
5. Im Apps-Script-Editor: Zahnrad-Icon **Projekteinstellungen** > runter zu
   **Script Properties** > **Script-Property hinzufuegen**:
   - `SHARED_SECRET` — ein beliebiger String. Fuer den Spike reicht ein
     Platzhalter wie `spike-test`, vor dem echten Rollout durch einen
     zufaelligen Wert ersetzen (siehe Hauptplan: das Secret ist nur ein
     Grundrauschen-Filter, kein echter Schutz, weil es in `app.js`
     oeffentlich sichtbar sein wird).
   - `DRIVE_FOLDER_ID` — die ID aus Schritt 4.
6. **Bereitstellen > Neue Bereitstellung > Typ: Web-App**:
   - Ausfuehren als: **Ich**
   - Zugriff: **Jeder**
   - Bereitstellen klicken, Google fragt nach Autorisierung fuer das
     eigene Skript (Zugriff auf das eigene Sheet/Drive) — das ist eine
     reine Selbst-Autorisierung, kein Login von aussen.
7. Die angezeigte Web-App-URL (endet auf `/exec`) hier im Chat mitteilen,
   zusammen mit dem gewaehlten `SHARED_SECRET`-Wert — fuer den Spike-Test
   reicht ein Wegwerf-Wert, das Deployment wird vor dem echten Rollout
   ohnehin neu aufgesetzt.

## Rotation im Ernstfall

Bei Missbrauch: **Bereitstellen > Bereitstellungen verwalten** > alte
Bereitstellung archivieren/deaktivieren, neue erzeugen, neue URL in `app.js`
eintragen, committen. Alte URL funktioniert danach nicht mehr.
