# Mock-up (Referenz für die Umsetzung)

Abgenommenes Design des Terminbuchungstools (Stand 18.11.2026). Die Dateien stammen aus dem
Design-Canvas und dienen als **Referenz für Aufbau, Inhalte, Zustände und Verhalten** – sie
sind kein Produktionscode und laufen nicht eigenständig im Browser.

## Dateien

| Datei | Inhalt | Status |
|---|---|---|
| `1-pipedrive-panel.dc.html` | Vertriebs-Panel in der Pipedrive-Deal-Ansicht (Custom Panel): Kontakt mit Status, Veranstaltung wählen, Termine an-/abwählen, Buchungslink per E-Mail senden, persönlicher Link, Link zum Admin. Umgebung (dunkles Pipedrive-Theme, Fokus, Verlauf) ist nur nachempfunden – gebaut wird nur das Panel. | vom Kunden abgenommen |
| `2-emails.dc.html` | Einladung mit Buchungslink, Buchungsbestätigung mit .ics-Anhang | Inhalt gültig; Gestaltung muss dem Mandanten-Theme und der Anrede folgen (noch neutral, „Sie“) |
| `3-buchungsseite.dc.html` | Buchungsseite für den Kunden inkl. Bestätigungsansicht. Enthält die beiden Mandanten-Themes (ANTENNE VORARLBERG und neutrale Demo) als Referenz für das Theme-System | Design ANTENNE VORARLBERG, maßgeblich |
| `4-admin-backend.dc.html` | Admin-Backend: KPIs, Terminliste mit Belegung, Kapazität erhöhen, Buchungen je Termin mit Deal-Verknüpfung, Termin anlegen | Inhalt gültig; Gestaltung neutral |

## So liest man die Dateien

- Markup steht in `<x-dc>`; Stile sind inline (`style="…"`), Seitengrundlagen in `<helmet>`.
- `{{ name }}` sind Platzhalter, die aus `renderVals()` im `<script type="text/x-dc">`-Block
  am Dateiende befüllt werden. Dort stehen auch Beispieldaten und Interaktionslogik.
- `<sc-for list="{{ … }}" as="x">` = Schleife, `<sc-if value="{{ … }}">` = Bedingung.
- `data-props` am Script-Tag = Design-Schalter im Canvas (z. B. Mandant), keine Fachlogik.
- In `3-buchungsseite.dc.html` sind `THEMES` und `COPY` die Vorlage für das Theme-JSON und
  die anredeabhängigen Texte der Mandanten.

## Was übernommen werden soll – und was nicht

- Übernehmen: Informationsarchitektur, Texte, Zustände (frei / fast voll / ausgebucht,
  nichts gewählt, gebucht), Farben und Abstände des ANTENNE-Themes, Barrierefreiheit.
- Nicht übernehmen: das Canvas-Format selbst (`support.js`, `DCLogic`), inline-Styles als
  Architektur (stattdessen CSS-Variablen aus dem Theme), Beispieldaten (stattdessen Seed).
- Alle Kundennamen, Termine und Buchungen sind fiktiv.
