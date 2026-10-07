# Änderungsverlauf

## Unveröffentlicht

- Der Stack-Aktionsstrom meldet `{ kind: "queued" }`, sobald die Aktion hinter
  einem laufenden Projektvorgang warten muss. Danach folgen `start` und Fortschritt
  oder ein terminaler Fehler mit Status und bereinigtem Ergebnis. Der Hub reicht
  das Wartesignal weiter. Die neue NDJSON-Art gehört zur unveröffentlichten
  Vertragsversion 12; `CONTRACT_VERSION` bleibt 12 und der Fingerabdruck ändert sich (#98).

- `PUT /self-healing/config` übernimmt die globale Selbstheilungskonfiguration,
  gebunden an `system:hub`. Alle fünf Konfigurationsfelder sind Pflichtwerte;
  der gemeinsame Vertrag prüft Grenzen und einen Abstand je Versuch.
  Die Antwort `{ config }` quittiert die atomar mit Modus 0600 gespeicherten Werte.
  Bis zur ersten Übertragung gelten die Werkswerte. `GET /contract` nennt
  Konfigurationsfelder, Grenzen und `null` als unbegrenzte Wartungsdauer-Vorgabe.
  Ab Werk bleibt die Vorgabe eine Stunde. Die Route gehört zu Vertragsversion 12;
  `CONTRACT_VERSION` bleibt für diesen unveröffentlichten Stand 12.
- Die Konfigurationsroute protokolliert jede Anfrage genau einmal: gültige
  Speicherung als `allowed`, Eingabefehler als `denied`, Speicherfehler als `error`.
  Engine- und Dateifehler werden über `actionFailureOf` beantwortet; Diagnosen
  bleiben im Audit. Konfigurationsannahme bleibt im Nur-Lese-Modus erlaubt,
  weil sie keine Containeraktion ausführt.

Protokollbruch: Hub und Agenten müssen gemeinsam aktualisiert werden.

- Die Kopfzeile `x-docker-agent-tier` entfällt. Der Agent verlangt und
  wertet sie nicht mehr aus; eine weiterhin gesendete Kopfzeile wird
  ignoriert. Jede Route verhält sich wie bisher für `internal`.
- `CONTRACT_VERSION` steigt von 10 auf 11.
- `GET /contract` meldet keine Netzstufen mehr: `headers.tier`, `tiers` und
  das Feld `tier` je Route entfallen; `/health` trägt `public: true`.
- `GET /monitor-events` beantwortet einen fremden Aufrufer mit
  `403 actor-not-allowed`. Die Schlüssel `tier-missing` und
  `internal-only-action` entfallen. `hardening-violated` steht nicht mehr
  unter den Ablehnungen der Shell, weil `gate()` ihn nicht mehr erzeugt.
- Audit-Einträge tragen kein Feld `networkTier` mehr.
- Eine mutierende Aktion auf einem Container mit Delegationssperre wird mit
  dem Grund `delegation-lock-allowed: <Regeln>` protokolliert.

- `CONTRACT_VERSION` steigt für die Laufzeitaktionen auf 12 (#98).
- Container- und Stack-Aktionen verlangen den gesehenen Laufzustand einschließlich Startzeit. Stack-Start und -Neustart verlangen `applyDefinition`; `allowFallbackUp` und `capabilities.startRequiresApply` entfallen.
- Hub-eigene Stacks starten fehlende Services mit `up --no-build --pull never` ohne `--wait`. Der Modus „Aus“ erhält bestehende Container mit `--no-recreate`, auch nach dem Stopp beim Neustart. Der Modus „An“ übernimmt Änderungen und erzwingt beim Neustart das Ersetzen. Definition und lokale Images werden vor einer Mutation geprüft. Fremdverwaltete Stacks verwenden ausschließlich vorhandene Container.
- Aktionen warten höchstens 60 Sekunden auf ihre Sperre; getrennte Aufrufer und geänderte Zustände werden vor der Mutation abgelehnt. Stoppfristen folgen der Grace-Period mit Puffer; Stopp und Start beim Stack-Neustart teilen höchstens 600 Sekunden mit mindestens 30 Sekunden für den Start.
- Ergebnisse enthalten nachgelesene Zustände, Exit-Code, Health und aktuelle Container-IDs; Stack-Aktionen liefern optional NDJSON-Fortschritt. Ein fehlender Service erfüllt das Stoppziel, Exit-Code 0 nach dem Start gilt als abgeschlossener Einmalauftrag. Health ist kein zusätzliches Erfolgskriterium.
- Neue Laufzeitfehler sind `state-changed`, `action-queue-timeout`, `action-caller-disconnected`, `runtime-image-missing`, `runtime-state-unreadable` und `runtime-target-not-reached`. Skalierte Services werden vor einer Containeraktion mit `409 scaled-service-unsupported` abgelehnt.

- Laufzeitaktionen protokollieren Fehler vom ersten Gate bis zur Neuverankerung genau einmal: vor der Mutation als `denied`, danach als `error`. Delegationshinweise stehen im selben Eintrag. Auch Fehler der Stack-Vorbereitung und der Warteschlange werden lokal beantwortet.
- Engine-, Compose- und unbekannte Laufzeitfehler erhalten den ursprünglichen HTTP-Status beziehungsweise `502` oder `500` und die Schlüssel `engine-action-failed`, `compose-action-failed` und `internal-error`. Neuverankerungsfehler behalten `registry-reanchor-failed` beziehungsweise `container-anchor-mismatch`. Engine-Text, Compose-Exitcode und stderr werden an das Audit übergeben, nicht an die Laufzeitantwort. Bei zwei fehlgeschlagenen Neustartbefehlen bleiben beide Diagnosen erhalten.
- Fehler bei `compose config` werden für Laufzeitaktionen vor der Mutation abgefangen; die bisherige Toleranz unlesbarer Definitionen anderer Kontextabfragen bleibt erhalten. Nach einer fehlgeschlagenen Mutation wird der Zustand weiterhin nachgelesen; scheitert auch die Nachlese, bleiben beide Diagnosen erhalten und der Zustand wird als unbekannt gemeldet.
- Stack-Streams beantworten Fehler vor der ersten Zeile mit JSON und HTTP-Status. Danach tragen Fehlerzeilen den spezifischen Schlüssel in `reason`, den Fehlerstatus in `status` und das bereinigte Ergebnis in `body`. `CONTRACT_VERSION` bleibt für diesen unveröffentlichten Stand 12; der Vertragsfingerabdruck wird aktualisiert.

- Manuelle Stopp-Absichten entstehen aus `kill` → `die` und bleiben unter Projekt und Service beziehungsweise Containername im lokalen Zustandsverzeichnis erhalten. Der nächste Start löscht sie; eine erkannte Unterbrechung der Daemon-Kontinuität verwirft sie. Hub-Stopps annotieren den Akteur erst beim tatsächlichen Engine- oder Compose-Aufruf; ohne bestätigende Ereignisse entsteht keine Absicht (#19).
- Ein Hintergrund-Watcher liest den einzigen Docker-Ereignisstrom auch ohne Hub-Verbindung und verteilt alle bisherigen Lifecycle- und Health-Aktionen an `/monitor-events`. `kill` und Container-Metadaten bleiben lokal. `GET /stop-intents` liefert Absichten, die letzten 256 Ausfallklassifikationen und den Beobachtungsstatus; fehlende Beobachtung ergibt `503`. Diese Ergänzung gehört zur unveröffentlichten Vertragsversion 12.

- Inspect- und Speicherfehler beenden nur die aktuelle Watcher-Verbindung. Der
  Agent verwirft Absichten und Signalzuordnungen und verbindet sich mit Backoff
  von 1 bis höchstens 30 Sekunden erneut. `/monitor-events` liefert ohne
  Beobachtung `503` und beendet offene Leser bei Beobachtungsverlust (#19).
- Als Stopp-Vorbereitung zählen nur das konfigurierte Container-Stoppsignal
  (ab Werk `SIGTERM`) und `SIGKILL`. Andere Signale bleiben ohne Zuordnung.
  Der Containerabgleich entfernt nicht mehr vorhandene Namen und Services;
  Absichten und Signalzuordnungen sind jeweils auf 256 Einträge begrenzt und
  verdrängen die nach Ereigniszeit ältesten Einträge (#19).
- Beschädigte `stop-intents.json` wird mit einer Warnung ohne Inhalt beiseitegelegt;
  der Agent startet leer. Atomarer Dateiersatz und das Beiseitelegen synchronisieren
  anschließend das Verzeichnis. Die gemeinsame Absicht aller Compose-Replikas
  und die Grenze bei kontrolliertem Agent-Ende während eines Daemon-Shutdowns
  sind dokumentiert. `CONTRACT_VERSION` bleibt 12 (#19).

## 0.32.0

Der erste Quellstand von docklet hub übernimmt Hub und Agent als Monorepo.
Die öffentliche Historie beginnt mit einem bereinigten Root-Commit.
Dieser Quellstand ist kein praktisch abgenommener Produkt-Release.
