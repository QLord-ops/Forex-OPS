# Project Status — 12. Oktober 2026

## DONE

- Lokale Fastify/React-Anwendung mit SQLite, versionierten Prisma-Migrationen und unveränderter Bestandsdatenbank.
- MapLibre/OpenStreetMap, OSRM-Fallback und optionales TomTom-Live-Routing mit LKW-Profil, Straßen, Ausfahrten und bis zu zwei Dispatcher-Vorschlägen.
- Persistente kostenlose Routing-Quote: harter interner Grenzwert 18.000/Monat, 20% Reserve für manuelle Aktionen; Hintergrundabfragen ausschließlich für berechnet fahrende LKW.
- Fahrzeugbezogenes Zeitmodell ohne Fahrerobjekte: 4 h / 45 min, 9/11, 10/11, 9/9, 10/9, 13/15-h-Arbeitsfenster, Wochen- und Ruhe-Ausnahmezähler.
- Ausgangszeiten bestehender Fahrzeuge bleiben ausdrücklich unbekannt, bis der Disponent sie mit Begründung setzt.
- Unabhängige, reservierte Ausnahmen: 10-h-Fahrt maximal zweimal je Kalenderwoche; 9-h-Ruhe maximal dreimal zwischen bestätigten Wochenruhen.
- Termine optional; ETA läuft weiter, undatierte Stopps erzeugen keine Verspätung und keine Ausnahmevorschläge.
- ETA-Spannen mit 60–120 Minuten Servicezeit je Stopp; Aufenthalt zählt zum Arbeitsfenster, nicht automatisch als Ruhe.
- Persistente globale Ankunftsmeldungen, tatsächliche Ankunftsbestätigung, gemeinsamer Aufenthaltstimer und Warnung bei Überschreitung.
- Manuelles Stoppen/Fortsetzen; berechnete Position und Zeitmodell werden nach Neustart wiederhergestellt.
- Versionierter Editor der aktiven Route mit Vorschau; erledigte/bestätigte Stopps, Historie, Uhrzustand und gefahrene Geometrie bleiben erhalten.
- Dashboard zeigt strukturierte Orte statt Firmen; unbekannte Alt-Orte bleiben explizit manuell korrigierbar.
- Sofortiger, race-sicherer Fahrzeugfilter der Historie; Zeitberichte und Änderungsprotokoll.
- Drag-and-drop-Vorschauimport für PDF-Aufträge, Excel `.xlsx` und Screenshots von Aufträgen/Excel-Tabellen; Originaldateien werden nicht gespeichert.
- Excel-Import mit lokalem Parser und optionalem OpenAI-Fallback; PDF- und Screenshot-Import über OpenAI Structured Output. Screenshot-Orte werden separat extrahiert und bei Bedarf durch strukturiertes Nominatim-Geocoding ergänzt.
- Später eingegangene Termine lassen sich an eine offene Lade-/Entladestelle einer aktiven oder wartenden Tour anhängen. Vor dem Speichern zeigt die Vorschau ETA-Fenster, Risiko, Puffer und empfohlene späteste Abfahrt; Änderungen sind versioniert und historisiert.
- Validierung: 115/115 API-Tests, Typecheck, Lint und Produktions-Build erfolgreich; Browser-Smoke ohne Console-Fehler.

## CONFIGURATION PENDING

- Für Live-Traffic fehlt noch der Benutzer-Key `TOMTOM_API_KEY` plus `TOMTOM_FREE_TIER_CONFIRMED=true`. Ohne diese Werte ist der sichtbare OSRM-Fallback aktiv.
- `OPENAI_API_KEY` ist lokal konfiguriert und der Screenshot-Import wurde mit einem synthetischen Auftrag gegen die echte API geprüft; für jede weitere Umgebung muss der Schlüssel separat als nicht versioniertes Server-Secret gesetzt werden. Standardtabellen funktionieren weiterhin ohne KI.
- Bestehende Alt-Stopps haben teilweise noch keinen strukturierten Ort; dieser wird bewusst nicht aus Firmen- oder Kommatext geraten.

## KNOWN LIMITATIONS

- Alle Positionen sind Berechnungen, keine GPS-/Telematikdaten und kein Tachographen- oder Rechtsnachweis.
- Die TomTom-Live-Integration ist vollständig gemockt/integrativ getestet, aber ohne echten Key noch nicht gegen das Benutzerkonto geprüft.
- Öffentliche OSM/Nominatim/OSRM-Dienste sind Best-Effort und nicht für hohe Produktionslast garantiert.
- Lokale Anwendung ohne Anmeldung/Rollen; vor Betrieb außerhalb des lokalen Rechners sind Authentifizierung und Request-Limits erforderlich.
- Der Vite-Build meldet wegen MapLibre einen großen Haupt-Chunk; funktional unkritisch, später per Route-Splitting optimierbar.
