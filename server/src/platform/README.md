# platform

Der Querschnitt ohne Fachwissen: HTTP-Helfer, Herkunftsschranke, Datenbank
und Migrationen, Auth, Agent-Transport, Ströme, Konfiguration und Prüfstände. Was hier liegt, kennt
weder `domain/` noch ein Feature; die Grenze prüft `.dependency-cruiser.mjs`.

| Ordner             | Inhalt                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `http/`            | Stromantwort, Herkunftsschranke, Übersetzung von Agentenfehlern in Antworten, Sicherheits-Kopfzeilen, CSP, Rückfall auf `index.html` |
| `db/`              | Pool, Migrationsläufer und Migrationsplan, die SQL-Migrationen selbst                                    |
| `auth/`            | better-auth-Einrichtung, Sitzung, Rollen, Sprache, Einrichtungs-Sperre, Break-Glass                      |
| `agent-transport/` | beglaubigte Anfrage an den Agenten, Kopfzeilen, `AgentError`, Strom-`fetch`, Fehlerrumpf einer Ablehnung |
| `streams/`         | `relayAgentStream`: ein Agent-Strom an einer Express-Antwort, mit Gegendruck und Abbruch in beide Richtungen; `relayAgentBytes`: dasselbe für rohe Bytes (Download einer Datei) |
| `config/`          | `loadConfig` aus der Umgebung, `ConfigError`, Auflösung des WireGuard-Endpoints (seit #266 hier, vorher `server/src/config.ts`) |
| `testing/`         | Prüfstände für Tests: `port-test-support.ts` (ein Port, den `fetch` erreicht) und der nachgebaute Anmelde-Client des Agenten `agent-simulator.ts`; beide nur für Tests und per `tsconfig.build.json` aus dem Image |

`relayAgentStream` hat seit #253 einen Nutzer, die Log-Route, `relayAgentBytes`
seit #262 einen, den Datei-Download; die Shell nutzt `relayAgentStream` seit
#260 und das Compose-Anwenden seit #264.

⚠️ Der Migrationsläufer liest seinen Ordner zur Laufzeit relativ zu sich
selbst (`db/migrate.ts`). Das Dockerfile kopiert die `.sql`-Dateien nach
`server/dist/platform/db/migrations`, weil `tsc` sie nicht anfasst; ändert sich
der Ort der Datei, ändert sich die `COPY`-Zeile mit. Dasselbe gilt für das
Break-Glass: der Befehl im README nennt `server/dist/platform/auth/break-glass.js`,
und `web/tests/break-glass-path.test.mjs` hält ihn gegen die Quelldatei.

Begründung: `docs/design/feature-architecture.md`, Abschnitt 2.
