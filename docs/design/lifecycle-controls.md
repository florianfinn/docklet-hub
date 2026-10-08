# Bedienvertrag für Start, Stopp und Neustart

Dieser Vertrag legt fest, wie die Oberfläche die Lifecycle-Aktionen anbietet (#86). Er beschreibt nur die Bedienung. Semantik, Ergebnisse und Fehlerschlüssel der Laufzeitaktionen stehen in [container-lifecycle.md](container-lifecycle.md) (#97) und kommen aus der technischen Umsetzung (#98), damit UI und API denselben Vertrag umsetzen; fehlt dort etwas, wird es dort ergänzt und nicht in der Oberfläche nachgebaut. Die Grenzen für fremdverwaltete Container stehen in [phase-5-write-access.md](phase-5-write-access.md).

## Zustände und Aktionen

Ein Ziel ist ein einzelner Container, auch ein Service eines Stacks, oder ein ganzer Stack. Die Oberfläche ordnet jedes Ziel einem von vier Zuständen zu:

| Zustand | Container | Stack |
| --- | --- | --- |
| läuft | Stopp, Neustart | Stopp, Neustart; Start, solange nicht alle Services laufen |
| gestoppt | Start | Start |
| im Übergang | gesperrt, Fortschritt sichtbar | gesperrt, Fortschritt je Service |
| unbekannt oder offline | gesperrt mit Grund | gesperrt mit Grund |

Im Übergang ist ein Ziel nur, solange ein Vorgang des Hubs darauf läuft. Meldet Docker `restarting`, zählt der Container als laufend und zeigt, dass er wiederholt neu startet; gerade bei einem Absturz-Loop braucht der Nutzer Stopp und Neustart. `paused` zählt ebenfalls als laufend, `created` und `exited` als gestoppt. `dead`, `removing` und unbekannte Zustände sperren die Aktionen mit Grund. Ein Stack mit laufenden und gestoppten Services bietet alle drei Aktionen an, weil jede davon eine sinnvolle Absicht ausdrückt. Nur ein ausdrücklich mit dem Compose-Label `com.docker.compose.oneoff=True` gekennzeichneter Container gilt nach Exit-Code 0 als erledigter Einmalauftrag und hält das Startangebot des Stacks nicht offen. Exit-Code 0 oder Restart-Policy `no` allein beweisen keinen Einmalauftrag. Eine Stopp-Absicht hat immer Vorrang, auch bei einem gekennzeichneten Einmalauftrag. Ist die Absichtsbeobachtung unbekannt, bleibt Start verfügbar. Regulär oder manuell gestoppte Services halten Start auch nach Exit-Code 0 offen.

Die Einmalauftragserkennung der Laufzeitaktionen ist von der Update-Abnahme
getrennt. Das Update erkennt Abschlussaufträge aus der aufgelösten
Compose-Definition: keine Restart-Policy oder `restart: "no"` und mindestens
ein abhängiger Service desselben Projekts mit
`condition: service_completed_successfully`. Nur dann zählt Exit 0 innerhalb
der Startfrist als erfolgreiche Update-Abnahme. Alle anderen Services und
Einzelcontainer sind im Update Dienste; jeder Exit scheitert. Container mit
`com.docker.compose.oneoff=True` sind keine Update-Ziele.
Prüfkriterium: Die Laufzeitansicht erkennt einen erledigten Einmalauftrag nur
am oneoff-Label mit Exit 0 und erhält bei fehlendem Label das Startangebot;
die Update-Vorschau und -Abnahme wenden ausschließlich die beiden
Compose-Bedingungen an. Die vollständigen Update-Kriterien stehen in
[update-and-rollback.md](update-and-rollback.md).

Die Aktionen stehen nur auf der Seite des Containers und auf der Seite des Stacks. Übersicht und Container-Liste zeigen Zustand und Navigation, aber keine Aktionen, Selbstheilungs- oder Absturzzeilen; das Kontextmenü eines Stacks bietet nur Öffnen und Ausblenden. Auf schmalen Ansichten bleiben sie als Schaltflächen mit ausreichender Trefferfläche erreichbar; nichts hängt allein an Hover oder Rechtsklick. Jede Schaltfläche ist per Tastatur erreichbar und trägt ihren Namen auch für Screenreader.

## Beschriftung nach wirksamem Modus

Bei Stack-Aktionen Hub-eigener Projekte mit eingeschalteter Einstellung „Compose-Definition bei Start und Neustart anwenden“ nennt die Schaltfläche die Wirkung: „Start · Definition anwenden“ und „Neustart · neu erstellen“. Fremdverwaltete Stacks, Einzelcontainer und einzelne Services zeigen immer die reine Laufzeitaktion, weil sie nie neu erstellt werden. Den Schalter selbst fragt die Ersteinrichtung mit kurzer Erklärung und der Vorauswahl „An“ ab; danach steht er in den Einstellungen. Die Übersicht und der Vorab-Kontext verwenden dieselbe Ableitung: eine vorhandene Compose-Datei mit Verwaltung `full` und keine bekannte Fremdverwaltung. Fällt die Discovery aus, bleibt die Verwaltung unbekannt; die Beschriftung bleibt neutral. Vor dem Versand erscheint dann auch bei Start eine Rückfrage, die den unbekannten Verwaltungszustand und bei eingeschalteter Definitionseinstellung die mögliche Anwendung der Definition beziehungsweise Neuerstellung erläutert. So wird ein Neustart nie stillschweigend zum Recreate.

## Gesperrte Aktionen

Eine gesperrte Schaltfläche bleibt sichtbar und nennt ihren Grund als Hinweis und zugängliche Beschreibung: Host offline, Agent im Nur-Lese-Modus, Container nicht in der Allowlist oder nur zur Beobachtung freigegeben, Selbstverwaltungssperre für Hub und Agent, fehlende Fähigkeit des Agents oder ein laufender Vorgang. Ist der Host offline, merkt der Hub nichts vor; die Aktion ist erst nach der Wiederverbindung möglich. Eine verschwundene Schaltfläche ließe offen, ob die Aktion fehlt oder nur gerade nicht möglich ist.

## Bestätigung

Start, Stopp und Neustart eines einzelnen Containers laufen ohne Rückfrage, weil sie den Container nicht verändern und sich direkt umkehren lassen. Eine Rückfrage erscheint, wenn die Wirkung über das angeklickte Ziel hinausgeht oder Container ersetzt:

- Stopp und Neustart eines ganzen Stacks nennen die betroffenen Services.
- „Neustart · neu erstellen“ nennt die betroffenen Services und dass Volumes und Bind-Mounts erhalten bleiben.

„Start · Definition anwenden“ fragt nicht: Er ersetzt nur Container, deren Definition sich geändert hat, und genau das ist die gewählte Einstellung. „Neustart · neu erstellen“ ersetzt dagegen alle betroffenen Container und fragt deshalb nach. Welche Services ersetzt wurden, nennt das Ergebnis.

Rückfragen vor jeder Aktion würden zum Wegklicken erziehen und die wenigen wichtigen Rückfragen entwerten.

## Fortschritt, gleichzeitige Vorgänge und Ergebnis

Nach dem Klick sperrt die Oberfläche das Ziel sofort, damit ein Doppelklick keinen zweiten Vorgang auslöst. Wartet eine Stack-Aktion auf einen anderen Vorgang auf demselben Projekt, zeigt sie nach der Stromzeile `{ kind: "queued" }` „wartet auf laufenden Vorgang“. Synchrone Containeraktionen liefern kein Wartesignal; dort zeigt die Oberfläche während der gesamten Anfrage nur allgemeinen Fortschritt. Antwortet der Agent mit `state-changed`, liest sie den Stand neu, nennt die Änderung und fragt erneut, statt automatisch zu wiederholen; der Nutzer hat einen anderen Stand gesehen als den, auf den die Aktion jetzt träfe.

Stack-Aktionen zeigen den Fortschritt je Service aus dem Strom. Das Ergebnis erscheint so:

- `ok`: kurzer Erfolgshinweis, der von selbst verschwindet.
- `partial` und `failed`: bleibende Meldung mit jedem Service und seinem Zustand. „Nicht erzeugt (fremdverwaltet)“ ist ein eigener, erklärter Teilstatus und kein Fehler.
- Zeitgrenze überschritten: Der Vorgang kann auf dem Host weiterlaufen; die Meldung sagt das, und die Oberfläche liest den Stand neu.
- Fristablauf oder Verbindungsverlust nach dem Versand: `runtime-outcome-unknown` bei synchronen Antworten beziehungsweise `runtime-stream-broken` bei geöffneten Stack-Strömen. Das Ergebnis ist unbekannt, nicht gescheitert; die Oberfläche liest den Stand nach der Wiederverbindung neu.

Nach jedem Vorgang zeigt die Oberfläche den tatsächlichen Stand aus dem Live-Stand, nicht den erwarteten. Die Browserfrist kommt aus `contract/`: 760 Sekunden Hub-Frist (60 Sekunden Warteschlange, höchstens 640 Sekunden Aktion einschließlich Startreserve, 30 Sekunden Nachlesereserve und 30 Sekunden Transportreserve) plus 10 Sekunden Reserve für die Zustellung der abschließenden Hub-Antwort.

## Absicht, Wartung und Vorfall

Ein gestoppter Container mit Stopp-Absicht zeigt „manuell gestoppt“ mit Zeitpunkt und, wenn bekannt, wer gestoppt hat. Der Hub löst `user:<id>` zum Kontonamen auf und entfernt E-Mail-Adressen aus dem Namen; bei gelöschtem Konto, leerem Namen oder fehlgeschlagener Auflösung steht „Akteur unbekannt“. Systemakteure heißen „Hub“ beziehungsweise „Selbstheilung“. Ein gestoppter Container ohne Absicht mit Exit-Code ungleich 0 zeigt „abgestürzt“. Aktive Wartung erscheint auf der Seite des Containers bzw. Stacks als Kennzeichen mit Ablaufzeit; ein- und ausgeschaltet wird sie dort über einen Umschalter, mit wählbarer Dauer, ab Werk eine Stunde, auf Wunsch unbegrenzt. Ein offener Vorfall der Selbstheilung erscheint am Container mit Ursache, Versuchen, empfohlener Handlung und Log-Auszug und lässt sich dort quittieren. Die Regeln dahinter stehen in [self-healing.md](self-healing.md).

## Update, Recreate und Entfernen

Diese Aktionen folgen denselben Zuständen, Sperrgründen und Fortschrittsregeln, verändern aber Container oder Definitionen und fragen deshalb immer. Die Rückfrage nennt das Ziel, die betroffenen Services, was mit Daten geschieht und den Rückweg: Ein Update fällt beim Fehlschlag auf das vorherige Image mit der vorherigen Definition zurück ([update-and-rollback.md](update-and-rollback.md)), und Entfernen erhält Daten im Standardweg. Bei fremdverwalteten Containern sind sie gesperrt und nennen den zuständigen Verwalter. Vorschau, Ablauf, Erfolgskriterien und Rückweg eines Updates beschreibt [update-and-rollback.md](update-and-rollback.md).
