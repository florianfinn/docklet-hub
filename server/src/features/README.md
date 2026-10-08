# features

Je Fachbereich ein Ordner `features/<name>/`: Route, Service und Agent-Client
bzw. Speicher einer Fläche. Innerhalb gilt `routes.ts` → `service.ts` →
`agent-client.ts` bzw. `store.ts`; die Route liest Parameter, setzt den Status
und schreibt die Antwort, alles Weitere steht im Service.

Von außen ist ein Feature nur über `index.ts` erreichbar, mit benannten
Re-Exporten. Ein Feature importiert kein anderes. Angemeldet wird es in der
Feature-Liste `server/src/app/features.ts`, an der Stelle, die seine Routen bisher
in der Reihenfolge des Routers hatten.

Regeln und Begründung: `docs/design/feature-architecture.md`, Abschnitte 2
und 3. Die Grenzen prüft `.dependency-cruiser.mjs`.

`live-events/` verteilt die gemeinsamen Host-Monitorhinweise über den
sitzungsgeschützten NDJSON-Strom `/live-events`. Der Lebenszyklus und die
Refresh-Schnittstelle liegen in `domain/live-events/`; die App übergibt dieselbe
Instanz an den Router. Begründung: `docs/design/live-events.md`.
