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

## 0.32.0

Der erste Quellstand von docklet hub übernimmt Hub und Agent als Monorepo.
Die öffentliche Historie beginnt mit einem bereinigten Root-Commit.
Dieser Quellstand ist kein praktisch abgenommener Produkt-Release.
