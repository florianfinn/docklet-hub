# platform

Der Querschnitt der Oberfläche ohne Fachwissen. Was hier liegt, kennt weder
`domain/` noch ein Feature; die Grenze prüft `.dependency-cruiser.mjs`.

| Ordner         | Inhalt                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------- |
| `editor/`      | Gemeinsamer Textkern, Hervorhebung und Hülle mit Bytegrenze, Maskierungsbereichen, Hash-Konflikten und zielgebundenen Entwürfen im Arbeitsspeicher |
| `http/`        | Transport zum Hub (`request`, `parseResponse`, `ApiError`) und der Umgang mit abgelaufener Sitzung |
| `streams/`     | Strom-Store für NDJSON-Ströme (`createStreamStore`, `sharedStream`) und `useStream`: ein Strom je Schlüssel, Deckel, Abbruch nach dem letzten Leser |
| `query/`       | TanStack Query: `createQueryClient` (Wiederholung, kein Nachladen bei Fokus) und alle Query-Schlüssel in `query-keys.ts` |
| `i18n/`        | Sprachschicht: Anbieter, Sprachen, Zeitformat, Übersetzung der Werte vom Draht, die Sprachdateien; `api.ts` speichert die Sprache des Kontos |
| `session/`     | Das angemeldete Konto (`SessionUser`, `Role`) und die Aufrufe der eigenen Sitzung in `api.ts` (`fetchSetupState`, `fetchSession`, `signOut`) |
| `routes/`      | Die Adressen der Stack- und der Container-Seite (`stackPath`, `containerPath`): reine Funktionen, die die Zeilen der Container-Listen und die Bildschirme gemeinsam brauchen |
| `ui/shadcn/`   | übernommene shadcn-Bausteine mit Herkunftskopf; das Register ist `ui/shadcn/PROVENANCE.md`         |
| `ui/lib/`      | `cn` und `initials`, kleine Helfer der Bausteine                                                    |

⚠️ `i18n/messages/` trägt die Texte jeder Fläche, die noch nicht in einem
Feature liegt. Die Sprachdatei eines Features liegt in
`features/<name>/messages/`; zusammengesetzt wird sie in `app/`, nicht hier,
weil `platform/` kein Feature importieren darf.

⚠️ Jedes Modul, das den Hub ruft, heißt `api.ts` (seit #271, als
`web/src/api/client.ts` aufgelöst wurde): `session/api.ts`, `i18n/api.ts`,
`domain/hosts/api.ts` und `features/<name>/api.ts`, daneben der Transport in
`http/`. Daran erkennt die ESLint-Regel `local/no-api-call-in-effect` einen
Aufruf in einem `useEffect`; `web/tests/no-api-call-in-effect.test.mjs` hält
die Benennung.

Bauteile mit eigenem Ton oder Fachbezug (Punktwelle, Marken, Sparklines)
liegen nicht in einem Feature; dorthin verlangt sie der Wächter
`web/tests/host-palette.test.mjs`. Sie stehen unter `web/src/platform/ui/` (die Marken seit #268, die
Punktwelle seit #269, die Sparklines seit #283); `web/src/ui/` gibt es seit #270 nicht mehr.

Begründung: `docs/design/feature-architecture.md`, Abschnitt 2.
