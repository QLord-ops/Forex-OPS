# OPS Disponent

Lokale Dispositionsanwendung für berechnete LKW-Bewegungen, ETA, Verspätungsrisiken und verkettete Touren.

> **Berechnete Position – keine GPS-Daten.** Die Anwendung nutzt weder Webfleet noch GPS- oder Fahrerdaten. Fahrzeugpositionen werden ausschließlich aus bestätigten Lade-/Entladeereignissen, gespeicherten Straßengeometrien und der simulierten Fahrtdauer berechnet.

## Voraussetzungen (macOS)

1. Installiere Node.js 22.12 oder neuer (aktuelle LTS). Mit Homebrew:

   ```bash
   brew install node@22
   ```

2. Prüfe die Versionen:

   ```bash
   node --version
   npm --version
   ```

3. Öffne Terminal und wechsle in das Projekt:

   ```bash
   cd "/Users/rader1410gmail.com/Documents/OPS Disponent"
   ```

## Erste Installation

```bash
npm install
npm run db:setup
npm run dev
```

Danach öffnen:

- Web-App: [http://localhost:5173](http://localhost:5173)
- Backend-Healthcheck: [http://localhost:3001/health](http://localhost:3001/health)

`npm run db:setup` erzeugt den Prisma Client, führt die versionierten SQL-Migrationen aus und lädt die Demo-Daten. Die Migrationen liegen unter `apps/api/prisma/migrations/`. Die Demo enthält die Fahrzeuge 936, 728, 414 und 563 sowie eine aktive und eine nachfolgende Tour für LKW 936.

## Normaler Start

```bash
npm run dev
```

Der Befehl startet Backend und Frontend gemeinsam. Mit `Ctrl+C` werden beide Prozesse beendet. Der Zustand bleibt in SQLite erhalten.

## Bedienung

### Fahrzeug anlegen

1. Navigation **Fahrzeuge** öffnen.
2. LKW-Nummer, optional Kennzeichen und Höchstgeschwindigkeit im Formular eingeben.
3. **Fahrzeug anlegen** wählen. Ohne Angabe gilt 85 km/h.

Alternativ per API:

```bash
curl -X POST http://localhost:3001/vehicles \
  -H 'Content-Type: application/json' \
  -d '{"vehicleNumber":"999","licensePlate":"GÖ-OP 999","maxSpeedKmh":85}'
```

### Auftrag anlegen

1. Navigation **Neuer Auftrag** öffnen.
2. Einen PDF-Auftrag bis 20 MB, eine Excel-Datei `.xlsx` bis 5 MB oder einen Screenshot als PNG/JPG/WebP bis 10 MB auswählen oder in die Dropzone ziehen. Der Agent extrahiert Auftragsnummer, einen eventuell angegebenen LKW, Lade-/Entladestellen und vorhandene Termine.
3. Die Vorschau kontrollieren und den konkreten LKW auswählen. Ein im Dokument erkannter LKW wird nur vorgeschlagen, nie automatisch gespeichert.
4. **Für LKW übernehmen und prüfen** wählen. Erst jetzt werden die Daten in das Formular übertragen und die Adressen nacheinander über Nominatim geokodiert.
5. Fehlende oder unsichere Daten korrigieren. Termine dürfen leer bleiben; zusätzliche Stopps können über **Laden** oder **Entladen** ergänzt werden.
6. **Auftrag speichern** wählen. Erst dieser zweite ausdrückliche Schritt legt Tour, Stopps und Straßenabschnitte an. Ist bereits eine Tour aktiv, wird der neue Auftrag als `QUEUED` angehängt.

Verarbeitet werden PDF-Aufträge, Excel-Dateien `.xlsx` und Screenshots von Aufträgen oder Excel-Tabellen. Die Originaldatei wird weder auf der Festplatte noch in der Datenbank gespeichert. Excel wird zuerst lokal gelesen; unbekannte Layouts können optional mit OpenAI ausgewertet werden. PDF- und Bildimporte werden mit `store: false`, hoher Detailstufe und Strict Structured Output an die OpenAI Responses API gesendet. Dokumentinhalt gilt als nicht vertrauenswürdig und kann die Extraktionsanweisungen nicht überschreiben. Das Ergebnis ist immer nur eine Vorschau und erzeugt niemals automatisch eine Tour.

Für die spätere Aktivierung in der bestehenden `apps/api/.env` ergänzen (andere Werte nicht überschreiben):

```dotenv
OPENAI_API_KEY="Ihr-Schlüssel"
OPENAI_IMPORT_MODEL="gpt-5.4-mini"
```

Danach das Backend neu starten. Der Schlüssel bleibt ausschließlich auf dem Server; niemals in `VITE_*` eintragen. Die OpenAI-Nutzung des PDF- und Screenshot-Imports ist kostenpflichtig und ohne Schlüssel nicht verfügbar, unabhängig von den kostenlosen Karten. Für den Produktionsstart sollte ein repräsentativer echter Auftrag getestet werden. Fehlende Zeiten, Auftragsnummern und LKW müssen vor dem Speichern ergänzt werden. Zeitangaben ohne Zone werden als lokale Zeit des Browsers behandelt. Mehrere erkannte Aufträge können einzeln ausgewählt werden; es gibt keinen automatischen Massenimport.

Beim Screenshot-Import extrahiert das KI-Schema den Ort zusätzlich zur vollständigen Adresse. Fehlt der Ort oder ist er unsicher, übernimmt die Adressprüfung anschließend den strukturierten Ort aus Nominatim. Vor dem Speichern bleibt der erkannte Ort sichtbar und korrigierbar.

### Später eingegangenen Termin anhängen

1. Den betroffenen LKW öffnen. Bei einer aktiven oder wartenden Tour **Termin hinzufügen oder ändern** wählen.
2. Die noch nicht abgeschlossene Lade- oder Entladestelle und den neu eingegangenen Termin auswählen.
3. **ETA und Abfahrtszeit berechnen** wählen. Die Vorschau zeigt das ETA-Fenster, den Zeitpuffer, das Verspätungsrisiko und – solange der LKW noch nicht unterwegs ist – die späteste empfohlene Abfahrt.
4. Erst **Termin bestätigen und anhängen** speichert den Termin. Dabei wird die Planversion atomar geprüft, die Historie ergänzt und die Warnungsberechnung aktualisiert.

Ohne GPS oder bekannte Ausgangszeiten des LKW bleibt der Hinweis ausdrücklich vorläufig. Für die erste Stelle einer Tour kann ohne bekannte aktuelle Position keine verlässliche Abfahrtszeit berechnet werden; laufende und geplante Anfahrtsstrecken werden dagegen berücksichtigt.

### BELADEN und ENTLADEN

1. Auf dem Dashboard den LKW öffnen.
2. Eine rechnerische Ankunft zuerst über **Ankunft bestätigen** als tatsächliche Ankunft erfassen. Dadurch startet der gemeinsame Aufenthaltstimer.
3. Beim aktuellen `LOAD`-Stop **BELADEN** beziehungsweise beim `UNLOAD`-Stop **ENTLADEN** anklicken. Erst der Abschlusszeitpunkt beendet den Aufenthalt und gibt den nächsten Abschnitt beziehungsweise die nächste Wartetour frei.

Ein rechnerisch angekommener LKW bleibt am Ziel mit **ANGEKOMMEN – wartet auf Bestätigung** stehen. Ein Folgeabschnitt startet niemals allein wegen abgelaufener Fahrzeit.

### Zukünftige Tour bearbeiten oder stornieren

1. Navigation **Touren** öffnen.
2. Bei einer `QUEUED`-Tour **Bearbeiten** wählen, um LKW, Auftragsnummer, Termine, Adressen oder die Stoppliste anzupassen.
3. Geänderte Adressen erneut über **Prüfen** bestätigen und speichern.
4. Über **Stornieren** kann die letzte zukünftige Tour einer Warteschlange abgebrochen werden.

Bereits bestätigte `BELADEN`-/`ENTLADEN`-Events werden niemals durch eine Planänderung gelöscht. Deshalb sind laufende oder historisierte Touren bewusst nicht über diesen Planeditor änderbar.
Bearbeitbar ist nur die letzte Tour der Warteschlange: Sonst könnten gespeicherte Transferstrecken nachfolgender Touren ungültig werden.

### Berechnete Bewegung ansehen

Im Dashboard auf einen LKW klicken. Die Fahrzeugseite zeigt:

- vollständige Straßengeometrie und alle Stops;
- bereits gefahrene und verbleibende Route;
- simulierten Marker direkt auf der Route;
- Start, Termin, ETA-Bereich, Strecke, Fortschritt und Verspätung;
- den berechneten Fahrzeug-Zeitstand, Pausen, Ruhezeiten und verbleibende Ausnahmen;
- den Stand der Verkehrsdaten, die kostenlose Monatsquote und freizugebende Umleitungsvorschläge;
- Tour- und Stop-Timeline einschließlich nachfolgender Touren.

Die Backend-Daten werden alle 30 Sekunden aktualisiert. Die Markerposition wird alle 5 Sekunden dynamisch vom Backend berechnet und abgefragt, ohne die Datenbank zu beschreiben.

## Datenbank

SQLite ist die dauerhafte Source of Truth:

```text
apps/api/prisma/dev.db
```

Migrationen und Seed liegen unter `apps/api/prisma/`.

Zum vollständigen Neuaufbau der Demo-Daten:

```bash
npm run db:reset
```

Dieser Befehl ersetzt den Inhalt der lokalen Entwicklungsdatenbank durch frische, relativ zur aktuellen Uhrzeit erzeugte Demo-Daten. Er ist deshalb nur für Demo-/Entwicklungsdaten gedacht.

## Kostenlose Karte, Routing und ETA

`RoutingProvider` trennt Routing vollständig von Simulation, ETA und Tourlogik.

- Die Oberfläche verwendet MapLibre GL JS mit Rasterkarten von OpenStreetMap; ein Google-Maps-Schlüssel ist nicht erforderlich.
- `OsrmRoutingProvider` nutzt Nominatim zur Adresssuche und OSRM für reale Straßengeometrie, Distanz und Dauer.
- Die ETA berücksichtigt den gespeicherten Zeitstand der Maschine, automatische 45-Minuten-Pausen, Tagesruhe und die geplanten Aufenthaltsbereiche der Stopps. Fahrer- oder GPS-Daten werden nicht geführt.
- Ohne TomTom-Key verwendet der öffentliche OSRM-Dienst ein PKW-Profil: LKW-Höhe, Gewicht, Gefahrgut, Fahrverbote und Live-Verkehr werden dann nicht berücksichtigt. Die App kennzeichnet diesen Fallback sichtbar. Die ETA bleibt eine Planungsschätzung, keine garantierte Ankunftszeit oder LKW-Navigation.
- Wenn Nominatim nicht erreichbar ist, wird eine Kundenadresse nicht mit erfundenen Koordinaten bestätigt. Der Mock-Fallback ist ausschließlich über `ROUTING_ALLOW_MOCK=true` für Demo-Entwicklung aktivierbar.
- Bereits gespeicherte Touren benötigen beim Anzeigen keine erneute Routing-Anfrage.
- Bereits gespeicherte Demo-Routen werden nicht automatisch ersetzt; echte Straßenrouten gelten für neu angelegte oder neu berechnete Touren.

Die öffentlichen Nominatim-/OSRM-Endpunkte sind für lokale Entwicklung und geringe Last gedacht. Ihre Basis-URLs sind über `NOMINATIM_BASE_URL` und `OSRM_BASE_URL` konfigurierbar; für produktive Nutzung sollte ein eigener oder vertraglich betriebener Dienst verwendet werden. Gleiche Geocode-Anfragen werden im Prozess gecacht und Nominatim-Aufrufe werden serialisiert.

### Optional: TomTom Live Traffic

Für echte Verkehrs-ETA und LKW-Parameter kann serverseitig `TomTomRoutingProvider` aktiviert werden. Benötigt werden ein TomTom-Key und die bewusste Bestätigung der Free-Tier-Bedingungen:

```dotenv
TOMTOM_API_KEY="Ihr-TomTom-Key"
TOMTOM_FREE_TIER_CONFIRMED="true"
TOMTOM_ROUTING_MONTHLY_CAP="18000"
TOMTOM_MANUAL_RESERVE_RATIO="0.2"
```

Der interne Default bleibt unter der aktuell dokumentierten kostenlosen Routing-API-Grenze von 20.000 Requests pro Monat. Hintergrundabfragen verbrauchen nur den nicht reservierten Anteil; der Rest bleibt für manuelle Dispatcher-Aktionen wie Route ändern oder aktualisieren frei. Ohne Key oder bei ausgeschöpfter Quote fällt die App auf OSRM zurück und markiert die Route ausdrücklich mit **Ohne aktuelle Staus und Prüfung von LKW-Einschränkungen**.

TomTom-Antworten werden nur als Planungsvorschlag übernommen: aktive Routen werden nicht automatisch ersetzt. Alternativen werden bis maximal zwei Vorschläge geliefert, wenn sie mindestens 10 Minuten sparen oder eine Sperrung umgehen. Hintergrundprüfungen laufen nur für berechnet fahrende Maschinen und werden bei knapper Quote automatisch seltener.

## Qualitätssicherung

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Die Unit-Tests decken unter anderem Speed-Cap, Fortschritt, Distanz, ETA, Verspätung, Tour-Queue, Folgeaktivierung, Alerts und Positionsinterpolation auf der Polyline ab.

## Projektstruktur

```text
.
├── apps/
│   ├── api/       # Fastify, Prisma, SQLite, Services und Tests
│   └── web/       # React, Vite, Tailwind, MapLibre
├── DESIGN.md      # UI-/UX-Vertrag
├── PROJECT_STATUS.md
└── package.json   # npm workspaces und gemeinsame Befehle
```

## Wichtige API-Endpunkte

- `GET/POST /vehicles`
- `GET /vehicles/:id`
- `GET /vehicles/:id/tours`
- `GET /vehicles/:id/current-position`
- `GET /vehicles/:id/timeline`
- `GET /vehicles/:id/operations`
- `PUT /vehicles/:id/operations/clock`
- `POST /vehicles/:id/operations/manual-stop`
- `POST /vehicles/:id/operations/resume`
- `GET /vehicles/:id/traffic`
- `POST /vehicles/:id/traffic/refresh`
- `POST /vehicles/:id/replan/preview`
- `POST /vehicles/:id/replan/apply`
- `POST /tours`
- `GET/PATCH /tours/:id`
- `POST /stops/:id/arrival`
- `POST /stops/:id/not-arrived`
- `POST /stops/:id/loaded`
- `POST /stops/:id/unloaded`
- `GET /notifications`
- `GET /notifications/stream`
- `GET /alerts`
- `GET /dashboard`
- `GET /history`
- `GET /geocode`
- `POST /imports/excel/preview`
- `POST /imports/pdf/preview`
