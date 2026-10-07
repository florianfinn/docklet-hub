# Bedienvertrag für Start, Stopp und Neustart

Dieser Vertrag legt fest, wie die Oberfläche die Lifecycle-Aktionen anbietet (#86). Er beschreibt nur die Bedienung. Semantik, Ergebnisse und Fehlerschlüssel der Laufzeitaktionen stehen in [container-lifecycle.md](container-lifecycle.md) (#97) und kommen aus der technischen Umsetzung (#98), damit UI und API denselben Vertrag umsetzen; fehlt dort etwas, wird es dort ergänzt und nicht in der Oberfläche nachgebaut. Die Grenzen für fremdverwaltete Container folgen #5.

## Zustände und Aktionen

Ein Ziel ist ein einzelner Container, auch ein Service eines Stacks, oder ein ganzer Stack. Die Oberfläche ordnet jedes Ziel einem von vier Zuständen zu:

| Zustand | Container | Stack |
| --- | --- | --- |
| läuft | Stopp, Neustart | Stopp, Neustart; Start, solange nicht alle Services laufen |
| gestoppt | Start | Start |
| im Übergang | gesperrt, Fortschritt sichtbar | gesperrt, Fortschritt je Service |
| unbekannt oder offline | gesperrt mit Grund | gesperrt mit Grund |

Im Übergang ist ein Ziel nur, solange ein Vorgang des Hubs darauf läuft. Meldet Docker `restarting`, zählt der Container als laufend und zeigt, dass er wiederholt neu startet; gerade bei einem Absturz-Loop braucht der Nutzer Stopp und Neustart. `paused` zählt ebenfalls als laufend, `created` und `exited` als gestoppt. `dead`, `removing` und unbekannte Zustände sperren die Aktionen mit Grund. Ein Stack mit laufenden und gestoppten Services bietet alle drei Aktionen an, weil jede davon eine sinnvolle Absicht ausdrückt. Ein Service, der als Einmalauftrag mit Exit-Code 0 beendet ist, gilt dabei als erledigt und hält den Start nicht dauerhaft angeboten.

Die Aktionen stehen direkt in der Zeile jedes Containers und Stacks und in der Detailansicht, nicht nur im Kontextmenü. Auf schmalen Ansichten bleiben sie als Schaltflächen mit ausreichender Trefferfläche erreichbar; nichts hängt allein an Hover oder Rechtsklick. Jede Schaltfläche ist per Tastatur erreichbar und trägt ihren Namen auch für Screenreader.

## Beschriftung nach wirksamem Modus

Bei Stack-Aktionen Hub-eigener Projekte mit eingeschalteter Einstellung „Compose-Definition bei Start und Neustart anwenden“ nennt die Schaltfläche die Wirkung: „Start · Definition anwenden“ und „Neustart · neu erstellen“. Fremdverwaltete Stacks, Einzelcontainer und einzelne Services zeigen immer die reine Laufzeitaktion, weil sie nie neu erstellt werden. Den Schalter selbst fragt die Ersteinrichtung mit kurzer Erklärung und der Vorauswahl „An“ ab; danach steht er in den Einstellungen. So wird ein Neustart nie stillschweigend zum Recreate.

## Gesperrte Aktionen

Eine gesperrte Schaltfläche bleibt sichtbar und nennt ihren Grund als Hinweis und zugängliche Beschreibung: Host offline, Agent im Nur-Lese-Modus, Container nicht in der Allowlist oder nur zur Beobachtung freigegeben, Selbstverwaltungssperre für Hub und Agent, fehlende Fähigkeit des Agents oder ein laufender Vorgang. Ist der Host offline, merkt der Hub nichts vor; die Aktion ist erst nach der Wiederverbindung möglich. Eine verschwundene Schaltfläche ließe offen, ob die Aktion fehlt oder nur gerade nicht möglich ist.

## Bestätigung

Start, Stopp und Neustart eines einzelnen Containers laufen ohne Rückfrage, weil sie den Container nicht verändern und sich direkt umkehren lassen. Eine Rückfrage erscheint, wenn die Wirkung über das angeklickte Ziel hinausgeht oder Container ersetzt:

- Stopp und Neustart eines ganzen Stacks nennen die betroffenen Services.
- „Neustart · neu erstellen“ nennt die betroffenen Services und dass Volumes und Bind-Mounts erhalten bleiben.

„Start · Definition anwenden“ fragt nicht: Er ersetzt nur Container, deren Definition sich geändert hat, und genau das ist die gewählte Einstellung. Welche Services ersetzt wurden, nennt das Ergebnis.

Rückfragen vor jeder Aktion würden zum Wegklicken erziehen und die wenigen wichtigen Rückfragen entwerten.

## Fortschritt, gleichzeitige Vorgänge und Ergebnis

Nach dem Klick sperrt die Oberfläche das Ziel sofort, damit ein Doppelklick keinen zweiten Vorgang auslöst. Wartet eine Stack-Aktion auf einen anderen Vorgang auf demselben Projekt, zeigt sie nach der Stromzeile `{ kind: "queued" }` „wartet auf laufenden Vorgang“. Synchrone Containeraktionen liefern kein Wartesignal; dort zeigt die Oberfläche während der gesamten Anfrage nur allgemeinen Fortschritt. Antwortet der Agent mit `state-changed`, liest sie den Stand neu, nennt die Änderung und fragt erneut, statt automatisch zu wiederholen; der Nutzer hat einen anderen Stand gesehen als den, auf den die Aktion jetzt träfe.

Stack-Aktionen zeigen den Fortschritt je Service aus dem Strom. Das Ergebnis erscheint so:

- `ok`: kurzer Erfolgshinweis, der von selbst verschwindet.
- `partial` und `failed`: bleibende Meldung mit jedem Service und seinem Zustand. „Nicht erzeugt (fremdverwaltet)“ ist ein eigener, erklärter Teilstatus und kein Fehler.
- Zeitgrenze überschritten: Der Vorgang kann auf dem Host weiterlaufen; die Meldung sagt das, und die Oberfläche liest den Stand neu.
- Fristablauf oder Verbindungsverlust nach dem Versand: `runtime-outcome-unknown` bei synchronen Antworten beziehungsweise `runtime-stream-broken` bei geöffneten Stack-Strömen. Das Ergebnis ist unbekannt, nicht gescheitert; die Oberfläche liest den Stand nach der Wiederverbindung neu.

Nach jedem Vorgang zeigt die Oberfläche den tatsächlichen Stand aus dem Live-Stand, nicht den erwarteten.

## Absicht, Wartung und Vorfall

Ein gestoppter Container mit Stopp-Absicht zeigt „manuell gestoppt“ mit Zeitpunkt und, wenn bekannt, wer gestoppt hat. Ein gestoppter Container ohne Absicht mit Exit-Code ungleich 0 zeigt „abgestürzt“. Aktive Wartung erscheint als Kennzeichen mit Ablaufzeit; ein- und ausgeschaltet wird sie in der Detailansicht und im Menü des Ziels, mit wählbarer Dauer, ab Werk eine Stunde, auf Wunsch unbegrenzt. Ein offener Vorfall der Selbstheilung erscheint am Container mit Ursache, Versuchen, empfohlener Handlung und Log-Auszug und lässt sich dort quittieren. Die Regeln dahinter stehen in [self-healing.md](self-healing.md).

## Update, Recreate und Entfernen

Diese Aktionen folgen denselben Zuständen, Sperrgründen und Fortschrittsregeln, verändern aber Container oder Definitionen und fragen deshalb immer. Die Rückfrage nennt das Ziel, die betroffenen Services, was mit Daten geschieht und den Rückweg: Ein Update fällt beim Fehlschlag auf das vorherige Image mit der vorherigen Definition zurück ([update-and-rollback.md](update-and-rollback.md)), und Entfernen erhält Daten im Standardweg. Bei fremdverwalteten Containern sind sie gesperrt und nennen den zuständigen Verwalter. Vorschau, Ablauf und Rückweg im Einzelnen bedient #88; die Erfolgskriterien eines Updates entscheidet #13.
