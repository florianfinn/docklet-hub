# Änderungsverlauf

## Unveröffentlicht

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
- Neue Laufzeitfehler sind `state-changed`, `action-queue-timeout`, `action-caller-disconnected`, `runtime-image-missing`, `runtime-state-unreadable`, `runtime-target-not-reached` und `runtime-stream-failed`. Skalierte Services werden vor einer Containeraktion mit `409 scaled-service-unsupported` abgelehnt.

## 0.32.0

Der erste Quellstand von docklet hub übernimmt Hub und Agent als Monorepo.
Die öffentliche Historie beginnt mit einem bereinigten Root-Commit.
Dieser Quellstand ist kein praktisch abgenommener Produkt-Release.
