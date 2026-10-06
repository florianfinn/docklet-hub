# Bedienvertrag für Start, Stopp und Neustart

Dieser Vertrag legt fest, wie die Oberfläche die Laufzeitaktionen aus [container-lifecycle.md](container-lifecycle.md) anbietet (#86). Er beschreibt nur die Bedienung; Semantik, Ergebnisse und Fehlerschlüssel kommen aus der technischen Umsetzung, damit UI und API denselben Vertrag umsetzen. Update, Recreate und Entfernen bedient #88.

## Zustände und Aktionen

Ein Ziel ist ein einzelner Container, auch ein Service eines Stacks, oder ein ganzer Stack. Die Oberfläche ordnet jedes Ziel einem von vier Zuständen zu:

| Zustand | Container | Stack |
| --- | --- | --- |
| läuft | Stopp, Neustart | Stopp, Neustart; Start, solange nicht alle Services laufen |
| gestoppt | Start | Start |
| im Übergang | gesperrt, Fortschritt sichtbar | gesperrt, Fortschritt je Service |
| unbekannt oder offline | gesperrt mit Grund | gesperrt mit Grund |

Im Übergang ist ein Ziel, solange Docker `restarting` meldet oder ein Vorgang des Hubs darauf läuft. Ein Stack mit laufenden und gestoppten Services bietet alle drei Aktionen an, weil jede davon eine sinnvolle Absicht ausdrückt.

Die Aktionen stehen direkt in der Zeile jedes Containers und Stacks und in der Detailansicht, nicht nur im Kontextmenü. Auf schmalen Ansichten bleiben sie als Schaltflächen mit ausreichender Trefferfläche erreichbar; nichts hängt allein an Hover oder Rechtsklick. Jede Schaltfläche ist per Tastatur erreichbar und trägt ihren Namen auch für Screenreader.

## Beschriftung nach wirksamem Modus

Bei Hub-eigenen Projekten mit eingeschalteter Einstellung „Compose-Definition bei Start und Neustart anwenden“ nennt die Schaltfläche die Wirkung: „Start · Definition anwenden“ und „Neustart · neu erstellen“. Fremdverwaltete Stacks und Einzelcontainer zeigen immer die reine Laufzeitaktion. So wird ein Neustart nie stillschweigend zum Recreate.

## Gesperrte Aktionen

Eine gesperrte Schaltfläche bleibt sichtbar und nennt ihren Grund als Hinweis und zugängliche Beschreibung: Host offline, Agent im Nur-Lese-Modus, Selbstverwaltungssperre für Hub und Agent, fehlende Fähigkeit des Agents oder ein laufender Vorgang. Eine verschwundene Schaltfläche ließe offen, ob die Aktion fehlt oder nur gerade nicht möglich ist.

## Bestätigung

Start, Stopp und Neustart eines einzelnen Containers laufen ohne Rückfrage, weil sie den Container nicht verändern und sich direkt umkehren lassen. Eine Rückfrage erscheint, wenn die Wirkung über das angeklickte Ziel hinausgeht oder Container ersetzt:

- Stopp und Neustart eines ganzen Stacks nennen die betroffenen Services.
- Jede Aktion, die Container neu erstellt, nennt die betroffenen Services und dass Volumes und Bind-Mounts erhalten bleiben.

Rückfragen vor jeder Aktion würden zum Wegklicken erziehen und die wenigen wichtigen Rückfragen entwerten.

## Fortschritt, gleichzeitige Vorgänge und Ergebnis

Nach dem Klick sperrt die Oberfläche das Ziel sofort, damit ein Doppelklick keinen zweiten Vorgang auslöst. Wartet der Vorgang auf einen anderen auf demselben Ziel, zeigt sie „wartet auf laufenden Vorgang“. Antwortet der Agent mit `state-changed`, liest sie den Stand neu, nennt die Änderung und fragt erneut, statt automatisch zu wiederholen; der Nutzer hat einen anderen Stand gesehen als den, auf den die Aktion jetzt träfe.

Stack-Aktionen zeigen den Fortschritt je Service aus dem Strom. Das Ergebnis erscheint so:

- `ok`: kurzer Erfolgshinweis, der von selbst verschwindet.
- `partial` und `failed`: bleibende Meldung mit jedem Service und seinem Zustand. „Nicht erzeugt (fremdverwaltet)“ ist ein eigener, erklärter Teilstatus und kein Fehler.
- Zeitgrenze überschritten: Der Vorgang kann auf dem Host weiterlaufen; die Meldung sagt das, und die Oberfläche liest den Stand neu.
- Verbindungsverlust während des Vorgangs: Das Ergebnis ist unbekannt, nicht gescheitert; die Oberfläche liest den Stand nach der Wiederverbindung neu.

Nach jedem Vorgang zeigt die Oberfläche den tatsächlichen Stand aus dem Live-Stand, nicht den erwarteten.

## Absicht, Wartung und Vorfall

Ein gestoppter Container mit Stopp-Absicht zeigt „manuell gestoppt“ mit Zeitpunkt und, wenn bekannt, wer gestoppt hat. Ein gestoppter Container ohne Absicht mit Exit-Code ungleich 0 zeigt „abgestürzt“. Aktive Wartung erscheint als Kennzeichen mit Ablaufzeit; ein- und ausgeschaltet wird sie in der Detailansicht und im Menü des Ziels. Ein offener Vorfall der Selbstheilung erscheint am Container mit Ursache, Versuchen, empfohlener Handlung und Log-Auszug und lässt sich dort quittieren. Die Regeln dahinter stehen in [self-healing.md](self-healing.md).
