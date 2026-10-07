# Änderungsverlauf

## Unveröffentlicht

### Vertragsversion 11

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

### Vertragsversion 12

Protokollbruch: Hub und Agenten müssen gemeinsam aktualisiert werden.
`CONTRACT_VERSION` steigt von 11 auf 12.

- Hub-Neustarts für Container und Stacks löschen die Stopp-Absicht und
  klassifizieren den Stoppteil als unerwartet. Die Heilung wartet bis zum Ende
  der Aktion und kann einen gescheiterten Start auch nach Exit-Code 0 beheben.
  Erkannte CLI-Neustartereignisse löschen die Absicht; ein nicht erkennbarer
  gescheiterter CLI-Neustart bleibt ein manueller Stopp. Tests sichern die
  Richtung von Echtzeitsignal-Versätzen bei `SIGRTMIN` und `SIGRTMAX` (#19).
- Ein Verlust der Docker-Beobachtung verwirft vorgemerkte Heilungen und
  unterbricht das Stabilitätsfenster. Nach Wiederverbindung gleicht der Watcher
  das Inventar ab, bevor neue Ausfälle heilen können; injizierter Backoff und
  Signalprüfung bleiben erhalten (#20).

- Begrenzte Selbstheilung startet bestehende erlaubte Container nach unerwartetem
  `die` mit Exit-Code ungleich 0. Die Neustartregel `no` gibt den Agent frei;
  `on-failure:N` erst nach ausgeschöpften Docker-Wiederholungen im gestoppten
  Zustand. Unbegrenztes `on-failure`, `always` und `unless-stopped` werden beobachtet.
  Manuelle Aktionen und Heilung teilen Prüfkette, Zustandsprüfung, Warteschlange
  und genau einen Aktionsaudit mit `system:self-healing`.
- `self-healing-state.json` speichert Budget, absolute Abstände, Startkennzeichnung,
  Stabilitätsfenster, Wartungen und Vorfälle atomar mit Modus 0600 sowie Datei-
  und Verzeichnissynchronisierung. `RestartCount` wird relativ zum letzten
  beobachteten Start ausgewertet. Unsichere reservierte Versuche nach einem
  Agent-Abbruch bleiben verbraucht. Manuelle Starts und Quittieren füllen auf;
  Docker-Wiederholungen und Heilungsstarts füllen nicht auf.
- Budgetzustände bleiben auf 256 Ziele begrenzt. Der Inventarabgleich entfernt
  verschwundene unbelastete Ziele; bei Überlauf werden zuerst die ältesten
  unbelasteten Einträge verdrängt. Verbrauchte Versuche, ausstehende Heilungen,
  Startkennzeichnungen und offene Vorfälle schützen einen Eintrag. Sind alle
  256 Plätze geschützt, nimmt der Heiler keine neuen Ziele auf und startet sie
  nicht, bis durch Auffüllen und Bereinigen oder Verdrängen wieder Platz entsteht.
- Versuchspausen, Stabilitätsfenster, Wartungsablauf und Wiederanlauf nach
  internen Fehlern verwenden im laufenden Prozess monotone Fristen. Uhrsprünge
  ändern diese Abstände nicht; nach einem Agent-Neustart wird die Restdauer aus
  den gespeicherten Wanduhrwerten übernommen. Der Wiederanlauf wartet 1, 2, 4,
  8, 16 und höchstens 30 Sekunden; ein erfolgreicher Takt setzt ihn zurück.
  Beim kontrollierten Agent-Ende bleiben ausstehende Heilungen und Budgets
  erhalten. Der nächste Inventarabgleich verwirft inzwischen überholte Heilungen.
- Vertragsversion 12 erhält `GET /self-healing/status`,
  `PUT`/`DELETE /self-healing/maintenance` und
  `POST /self-healing/incidents/acknowledge`. Die Schreibwege benötigen
  `system:hub` oder einen menschlichen Akteur. Wartung gilt für ein Containerziel
  oder alle aktuellen und späteren Services eines Projekts. Ihr Ende startet
  nichts. Der Status liefert ohne Beobachtung `503`.
- Ein Vorfall am Budget-Ende enthält stabile ID, Ursache, Versuchsergebnisse,
  Handlungsschlüssel und höchstens 50 bereinigte Logzeilen mit jeweils höchstens
  500 Unicode-Zeichen und insgesamt höchstens 16 KiB UTF-8 einschließlich
  Zeilentrennern. Die neuesten Zeilen haben Vorrang; die Kürzung nach der
  Bereinigung trennt keine Unicode-Zeichen. Ohne Bereinigung
  fehlt der Auszug mit `redaction-unavailable`; ohne lesbare Logs mit
  `logs-unavailable`. Geschlossene Vorfälle tragen Abschlusszeit und Grund.
  Es bleiben alle offenen und die letzten 256 geschlossenen Vorfälle gespeichert.

- Der Stack-Aktionsstrom meldet `{ kind: "queued" }`, sobald die Aktion hinter
  einem laufenden Projektvorgang warten muss. Danach folgen `start` und Fortschritt
  oder ein terminaler Fehler mit Status und bereinigtem Ergebnis. Der Hub reicht
  das Wartesignal weiter. Die neue NDJSON-Art gehört zur unveröffentlichten
  Vertragsversion 12 (#98).

- `PUT /self-healing/config` übernimmt die globale Selbstheilungskonfiguration,
  gebunden an `system:hub`. Alle fünf Konfigurationsfelder sind Pflichtwerte;
  der gemeinsame Vertrag prüft Grenzen und einen Abstand je Versuch.
  Die Antwort `{ config }` quittiert die atomar mit Modus 0600 gespeicherten Werte.
  Bis zur ersten Übertragung gelten die Werkswerte. `GET /contract` nennt
  Konfigurationsfelder, Grenzen und `null` als unbegrenzte Wartungsdauer-Vorgabe.
  Ab Werk bleibt die Vorgabe eine Stunde.
- Die Konfigurationsroute protokolliert jede Anfrage genau einmal: gültige
  Speicherung als `allowed`, Eingabefehler als `denied`, Speicherfehler als `error`.
  Engine- und Dateifehler werden über `actionFailureOf` beantwortet; Diagnosen
  bleiben im Audit. Konfigurationsannahme bleibt im Nur-Lese-Modus erlaubt,
  weil sie keine Containeraktion ausführt.

- Container- und Stack-Aktionen verlangen den gesehenen Laufzustand einschließlich Startzeit. Stack-Start und -Neustart verlangen `applyDefinition`; `allowFallbackUp` und `capabilities.startRequiresApply` entfallen.
- Hub-eigene Stacks starten fehlende Services mit `up --no-build --pull never` ohne `--wait`. Der Modus „Aus“ erhält bestehende Container mit `--no-recreate`, auch nach dem Stopp beim Neustart. Der Modus „An“ übernimmt Änderungen und erzwingt beim Neustart das Ersetzen. Definition und lokale Images werden vor einer Mutation geprüft. Fremdverwaltete Stacks verwenden ausschließlich vorhandene Container.
- Aktionen warten höchstens 60 Sekunden auf ihre Sperre; getrennte Aufrufer und geänderte Zustände werden vor der Mutation abgelehnt. Stoppfristen folgen der Grace-Period mit Puffer; Container-HTTP-Fristen berücksichtigen höchstens 600 Sekunden Grace-Period, ohne die Docker-Konfiguration zu ändern; Container-Neustarts erhalten zusätzlich 30 Sekunden Startreserve. Stopp und Start beim Stack-Neustart teilen höchstens 600 Sekunden mit mindestens 30 Sekunden für den Start. Alle Fristen werden aus `contract/` abgeleitet: höchstens 640 Sekunden Containeraktion, 600 Sekunden Stack-Aktion, 760 Sekunden Hub-Frist einschließlich Warteschlange und je 30 Sekunden Nachlese- und Transportreserve sowie 770 Sekunden Browserfrist.
- Ergebnisse enthalten nachgelesene Zustände, Exit-Code, Health und aktuelle Container-IDs; Stack-Aktionen liefern optional NDJSON-Fortschritt. Ein fehlender Service erfüllt das Stoppziel, Exit-Code 0 nach dem Start gilt als abgeschlossener Einmalauftrag. Health ist kein zusätzliches Erfolgskriterium.
- Neue Laufzeitfehler sind unter anderem `state-changed`, `action-queue-timeout`, `action-caller-disconnected`, `runtime-image-missing`, `runtime-state-unreadable` und `runtime-target-not-reached`. Skalierte Services werden vor einer Containeraktion mit `409 scaled-service-unsupported` abgelehnt.

- Laufzeitaktionen protokollieren Fehler vom ersten Gate bis zur Neuverankerung genau einmal: vor der Mutation als `denied`, danach als `error`. Delegationshinweise stehen im selben Eintrag: Fehlerschlüssel, ein zusammengeführter Delegationsnachweis, dann Diagnose. Auch Fehler der Stack-Vorbereitung und der Warteschlange werden lokal beantwortet.
- Engine-, Compose- und unbekannte Laufzeitfehler erhalten den ursprünglichen HTTP-Status beziehungsweise `502` oder `500` und die Schlüssel `engine-action-failed`, `compose-action-failed` und `internal-error`. Neuverankerungsfehler behalten `registry-reanchor-failed` beziehungsweise `container-anchor-mismatch`. Engine-Text, Compose-Exitcode und stderr werden an das Audit übergeben, nicht an die Laufzeitantwort. Bei zwei fehlgeschlagenen Neustartbefehlen bleiben beide Diagnosen erhalten.
- Fehler bei `compose config` werden für Laufzeitaktionen vor der Mutation abgefangen. Apply, Down und Stack-Kontext melden eine unlesbare Definition mit `409 compose-config-failed`. Nach einer fehlgeschlagenen Mutation wird der Zustand weiterhin nachgelesen; scheitert auch die Nachlese, bleiben beide Diagnosen erhalten und der Zustand wird als unbekannt gemeldet.
- Stack-Streams beantworten Fehler vor der ersten Zeile mit JSON und HTTP-Status. Danach tragen Fehlerzeilen den spezifischen Schlüssel in `reason`, den Fehlerstatus in `status` und das bereinigte Ergebnis in `body`.

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
  sind dokumentiert (#19).

## 0.32.0

Der erste Quellstand von docklet hub übernimmt Hub und Agent als Monorepo.
Die öffentliche Historie beginnt mit einem bereinigten Root-Commit.
Dieser Quellstand ist kein praktisch abgenommener Produkt-Release.
