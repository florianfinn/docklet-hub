# contract

Was Server und Web beide wissen: zod-Schemas der HTTP-API, gemeinsame
Konstanten (Theme-Presets, Obergrenzen), die Kennungen, die über die
Leitung reisen, und der eine NDJSON-Leser. Seit #272 auch das Protokoll
zwischen Hub und Agent. Das Paket importiert weder aus `server/` noch aus `web/` noch aus `agent/`;
`web/tests/contract-package.test.mjs` und die Grenzprüfung
(`.dependency-cruiser.mjs`) fallen bei jedem Weg hinaus. Die Begründung steht
in `docs/design/feature-architecture.md`, Abschnitt 5.

Der Code läuft in Node und im Browser-Bündel. `process`, `document` und jedes
`node:`-Modul sind hier tabu; `tsconfig.json` lädt deshalb weder die Typen von
Node noch die des DOM.

## Antwortformen der HTTP-API

Jede Antwortform einer Route steht als zod-Schema unter `src/api/`, eine Datei
je Fläche (`src/api/hosts.ts` für die Host-Routen). Server und Web leiten ihre
Typen daraus ab; eine Abschrift der Form auf einer der beiden Seiten gibt es
nicht. Das Muster stammt aus #247 und gilt für jede weitere Form.

### `zod/mini`, nicht `zod`

Die Schemas unter `src/api/` importieren `zod/mini`
(`import * as z from "zod/mini"`). Sie laufen im Browser-Bündel, und die
klassische Schreibweise lässt sich dort kaum zurückschneiden. Gemessen am
2026-10-01 mit `pnpm --filter web run build`, Haupt-Chunk `index-*.js`,
gegen `432f35c` ohne Schema (813,55 kB, gzip 238,97 kB):

| Variante | roh | gzip |
| --- | --- | --- |
| `zod` (klassisch) | +74,79 kB | +20,79 kB |
| `zod/mini` | +16,60 kB | +5,34 kB |

Gemessen mit genau einem Schema-Satz (`src/api/hosts.ts`); der größte Teil
ist der Grundbetrag der Bibliothek, jedes weitere Schema kostet wenig.
`zod/mini` beschreibt dieselben Schemas, nur mit Funktionen statt Methoden:
`z.nullable(z.string())` statt `z.string().nullable()`,
`z.optional(…)` statt `.optional()`. `parse` und `safeParse` bleiben
Methoden am Schema.

### Namen

- Das Schema heißt nach der Form, klein beginnend, mit `Schema` am Ende:
  `hostViewSchema`, `hostListSchema`, `agentUpdateOfferSchema`.
- Der Typ daneben heißt wie die Form ohne Endung und ist `z.infer` des
  Schemas: `export type HostView = z.infer<typeof hostViewSchema>`. Ein
  handgeschriebener Typ neben einem Schema ist eine zweite Wahrheit.
- Der Umschlag einer Route ist ein eigenes Schema und trägt den Namen dessen,
  was er enthält: `GET /api/hosts` sendet `{ hosts: [...] }` und hat
  `hostListSchema`.
- Eine Aufzählung ist `z.enum([...])` mit eigenem Schema
  (`hostStatusSchema`), kein TypeScript-`enum` — `erasableSyntaxOnly` lässt
  keins zu.

### Ort und Tür

- Die Datei liegt unter `src/api/<area>.ts` (englischer Dateiname).
- `src/index.ts` reicht Schema und Typ mit **benannten** Exporten weiter, kein
  `export *`. Server und Web importieren aus `contract`, nie aus einem Pfad
  darunter.
- Was eine bestehende Konstante aus `presets.ts` schon aufzählt, wird daraus
  abgeleitet und nicht wiederholt: `hostDisplaySchema` baut seine Stufen aus
  `HUE_TONES` und `INK_STEPS`.

### Leitung statt Laufzeit

- Ein Zeitpunkt reist als Zeichenkette: `z.iso.datetime()`, nie `z.date()`.
  Der Server schreibt `toISOString()`.
- Ein Zeitpunkt, den der Hub nur vom Agenten weiterreicht (`sampledAt`,
  `startedAt` in `src/api/containers.ts`), ist `z.string()`. Der Hub schreibt
  ihn nicht selbst und kann sein Format nicht zusichern; ein geändertes Format
  des Agenten darf nicht die ganze Übersicht umwerfen. Dieselbe Regel wie für
  jeden Wert der Gegenseite (`AGENTS.md`, „Sprache").
- `null` und ein fehlendes Feld sind verschieden. Was die Route immer sendet,
  auch als `null`, ist `z.nullable(…)`; `z.optional(…)` steht nur dort, wo die
  Route das Feld wirklich weglässt.
- Unbekannte Zusatzfelder werden verworfen, nicht abgelehnt: `z.object`, nicht
  `z.strictObject`. Hub und Bündel können kurz auseinanderliegen — ein
  zwischengespeichertes Bündel gegen einen neueren Hub —, und ein Feld, das
  das Bündel noch nicht kennt, darf keine Liste brechen.
- Ein unbekannter **Wert** in einer Aufzählung ist schwerer als ein
  unbekanntes Feld, und die Antwort hängt davon ab, ob es einen wahren
  Ersatz gibt:
  - Hat das Feld eine harmlose Rückfallstufe, fängt `z.catch(…, Ersatz)` den
    Wert ab: ein Farbton, den das Bündel nicht kennt, wird
    `DEFAULT_HOST_THEME`, ein unlesbares Update-Angebot wird `null` (kein
    Knopf). `z.catch` ersetzt dabei auch ein fehlendes Feld — die Ausnahme
    von der Regel darüber, und deshalb nur dort, wo der Ersatz nichts
    Falsches behauptet.
  - Ohne wahren Ersatz bleibt die Aufzählung streng: einen neuen Status als
    `offline` zu zeigen, sagte dem Betreiber etwas, das der Hub nie gesagt
    hat. Die Antwort fällt dann beim Parsen, und der Fehler steht in der
    Konsole, bis ein Neuladen das passende Bündel bringt.

### Die `io`-Seite bei Transformationen

Ein Schema ohne `z.transform(…)`, `z.pipe(…)` oder `z.coerce` hat eine Form, und
`z.infer` beschreibt sie. Verwandelt ein Schema beim Parsen einen Wert, hat es
zwei:

- Der **Server** baut die Leitungsform und tippt sie mit
  `z.input<typeof …Schema>` — das, was über die Leitung geht.
- Das **Web** bekommt das Ergebnis von `parse` und tippt es mit
  `z.output<typeof …Schema>` (gleich `z.infer`).

Beide Typen tragen dann eigene Namen (`…Wire` für die Eingabe), und das Schema
sagt im Kommentar, welche Seite welchen liest.

### Wer prüft

- Das **Web** parst die Antwort an der Transportgrenze:
  `parseResponse(path, schema, await request(path))` aus
  `web/src/platform/http/transport.ts`. Eine Antwort, die nicht passt, wirft
  `ResponseShapeError` und kommt nicht als `undefined` im Bildschirm an.
  `parseResponse` schreibt den Fehler mit Pfad und Feld in die Konsole — die
  Bildschirme zeigen für jeden Fehler denselben Satz, und ohne die Zeile dort
  erführe niemand, welches Feld fehlte. Die Fehlerklasse geht wie `ApiError`
  aus `web/src/platform/http/transport.ts` hinaus.
- Ein `z.catch` macht ein Schema auf der Seite des Servers nicht nachsichtig:
  der Servertest vergleicht das geparste Ergebnis mit dem Rumpf, und ein
  ersetzter Wert fällt dort genauso auf wie ein verworfenes Feld.
- Der **Server** prüft seine Antwort im Test gegen dasselbe Schema, über eine
  echte Anfrage durch den Router (Muster: „Antwort von GET /hosts erfüllt das
  Schema" in `server/src/app/theme-routes.test.ts`). Der Test vergleicht
  zusätzlich das geparste Ergebnis mit dem Rumpf: ein Feld, das der Server
  sendet und das Schema nicht kennt, fällt dort auf.
- `web/tests/api-mirror.test.mjs` hält für eine geparste Antwort weiter Pfad
  und Methode gegen den Router, den Umschlag aber nicht mehr: den hält das
  Schema. Der Pfad darf dafür in einer `const` derselben Funktion stehen
  (`const path = …; parseResponse(path, …Schema, await request(path))`).

Kein OpenAPI; `zod-openapi` ist eine spätere Option und nicht Teil dieses
Musters.

## Der NDJSON-Leser

`src/stream/ndjson.ts` ist der einzige Laufzeitbaustein des Pakets (#252):
`readNdjson` liest jeden NDJSON-Strom, der Server den des Agenten, das Web den
des Servers. Die Begründung für die Ausnahme steht in
`docs/design/feature-architecture.md`, Abschnitt 5.

- Zwei benannte Obergrenzen: `NDJSON_MAX_LINE_CHARS` für eine Zeile und
  `NDJSON_MAX_BUFFERED_CHARS` für das, was der Leser zwischen zwei Blöcken
  hält. Beide Seiten lesen mit derselben Zahl, weil es nur noch eine gibt.
- Strom, Signal und `TextDecoder` sind strukturell getippt, weil das Paket
  weder die Typen des DOM noch die von Node lädt. Ein echter
  `ReadableStream<Uint8Array>` und ein echtes `AbortSignal` passen hinein.
- Die Fälle stehen in `web/tests/ndjson-reader.test.mjs`. Unter `contract/`
  können sie nicht liegen: `node:test` ist ein Node-Modul.

## Das Agent-Protokoll

`src/agent/` beschreibt, was Hub und Agent austauschen (#272): Anfragerümpfe
und Abfragen (`requests.ts`, `compose-requests.ts`, `spec.ts`), die Zeilen der
NDJSON-Ströme (`streams.ts`), Fehlerschlüssel (`reasons.ts`,
`compose-reasons.ts`), Kopfzeilen (`headers.ts`), Obergrenzen (`limits.ts`) und
die Vertragsnummer (`version.ts`). Die Regeln oben gelten, mit drei Zusätzen:

- **Der Agent prüft, der Hub baut.** Der Agent liest jede Anfrage mit
  `safeParse` und lehnt mit `400 { error, field }` ab (`requestRejectionOf`).
  Der Hub baut seine Anfragen in der Form der Schemas und prüft jede
  Stromzeile, bevor er sie liest; eine Zeile, die nicht passt, fällt weg.
  Was vom Host abhängt (Basispfad, Allowlist, Härtung), prüft weiter der
  Agent selbst und nicht das Schema.
- **Ein Fehlerschlüssel ist im Schema ein Text.** Die Aufzählungen in
  `reasons.ts` tippen, was der Agent sendet. Der Leser reicht einen Schlüssel,
  den er nicht kennt, wörtlich als `reason` weiter, damit ein neuerer Agent
  einen älteren Hub nicht bricht. Eine unbekannte `kind` scheitert mit einem
  Issue auf `kind`.
- **Ein Feld, das nach dem ersten nummerierten Vertrag dazukommt, trägt seine
  Grenze:** `since(z.optional(…), 3)` (`version.ts`) trägt es in
  `contractSince` ein und lässt das Schema unverändert. Optional ist es, weil
  ein Agent unter dieser Nummer es weder sendet noch liest. Ändert sich, was
  ein Aufrufer bemerkt, steigt `CONTRACT_VERSION`; die Geschichte steht
  im Abschnitt „Vertragsversionen“.

Jeder Wert ist englisch, seit Vertrag 6 (#278); ein Wächter
(`web/tests/agent-contract-language.test.mjs`) geht die Schemas durch. Der
Vertragstest
(`server/src/features/*/agent-roundtrip.test.ts`,
`server/src/domain/hosts/self-update-roundtrip.test.ts`) lässt den Agent-Client des Hubs
im selben Prozess gegen die echten Handler sprechen.

## Vertragsversionen

| Version | Änderung |
| --- | --- |
| 1 | v0.28.0: erster nummerierter Vertrag (#79). |
| 2 | v0.29.0: Registry-Feld `observeOnly` (#78). |
| 3 | v0.31.0: Registry-Feld `externallyManaged` (#78). |
| 4 | Games-Laufzeitrouten entfallen aus der Routentabelle (#276). |
| 5 | Jede Anfrage wird gegen ihr Schema geprüft; ungültige Anfragen erhalten `400 invalid-request` oder einen bestehenden Schlüssel mit `field` (#272). |
| 6 | Alle ausgetauschten Werte sind englisch: Fehler, Stream-Arten, Schritte, Enums, Audit-Namen und die Route `/containers/:id/configuration` (#278). |
| 7 | Der rohe Compose-Editor lehnt fremdverwaltete Stacks mit `403 externally-managed` ab (#56). |
| 8 | Host-Erkennung meldet `externalManagement` mit `unraid`, `unraid-compose` und `unknown` (#5). |
| 9 | Neue Stacks erhalten `POST /stacks/raw-preview`, Mount-Quellen und Einzelbestätigungen externer Bind-Quellen (#3). |
| 10 | `GET /resources` liest Images, Volumes und Netzwerke (#10). |
| 11 | Die Netzstufen-Kopfzeile entfällt; `GET /contract` meldet keine Netzstufen, fremde Aufrufer von `GET /monitor-events` erhalten `403 actor-not-allowed` (#152). |
| 12 | Laufzeitaktionen für Container und Stacks mit erwartetem Status und Startzeit, Pflichtfeld `applyDefinition` bei Stack-Start und -Neustart, begrenzter Warteschlange, abgeleiteten Fristen, nachgelesenen Service-Ergebnissen und NDJSON-Fortschritt; `allowFallbackUp` und `capabilities.startRequiresApply` entfallen. `PUT /self-healing/config` verlangt `system:hub` und fünf Pflichtfelder, quittiert die atomar gespeicherte Konfiguration und erlaubt `null` als unbegrenzte Wartungsdauer-Vorgabe (#98). `GET /stop-intents` liefert dauerhaft gespeicherte manuelle Stopp-Absichten mit Akteur, die letzten 256 Ausfallklassifikationen und den Beobachtungsstatus; bei fehlender Beobachtung antwortet die Route mit `503` (#19). |
