# Projektpfade und Container-Lebenszyklus

Ein Hub-eigenes Compose-Projekt besitzt ein Verzeichnis mit eigener Compose-Datei unter dem eingerichteten Basispfad und ist nicht fremdverwaltet. Ob der Hub den Ordner angelegt hat oder er von Hand entstanden ist, spielt keine Rolle (#136). Services teilen dieses Projekt. Bind-Mounts liegen primär im Projekt; externe Mounts und Volumes bleiben möglich. Entfernen erhält Daten standardmäßig.

Unraid verwaltet Templates und Definitionen. Erlaubte Laufzeitaktionen ändern keine Definition. Update, Recreate und Entfernen gehören dort Unraid. Diese Grenze gilt auch für rohe Compose-Schreibwege und Selbstheilung.

Der Agent ordnet den Verwalter über das Label `net.unraid.docker.managed` und dessen Umfeld zu. `dockerman` ohne Compose-Labels bedeutet native Unraid-Verwaltung, `composeman` mit Compose-Projekt das Compose-Manager-Plugin. Das Label allein ist kein Beweis, weil Docker Image- und Container-Labels zusammenführt. Trägt schon das Image denselben Wert, ist das Image nicht lesbar oder passen Wert und Compose-Labels nicht zusammen, meldet der Agent `unknown`. Jede gemeldete Fremdverwaltung, auch `unknown`, setzt in der Allowlist `externallyManaged` und sperrt damit Pull, Recreate, Apply-Spec, Entfernen und die Compose-Definitionswege; Start, Stopp, Neustart, Logs, Shell, Dateien und Metriken bleiben erlaubt. Die Zuordnung kann nur einschränken: Ein fehlendes Label ist nicht erkennbar und lässt den Container beim Hub.

## Hub-eigene Projekte anlegen

Ein neues Projekt entsteht im Hub aus Name und Compose-Entwurf im bestehenden Editor. Der Agent nutzt dafür dieselbe Kette wie der rohe Compose-Editor: Prüfung mit `docker compose config`, Bestätigung neuer Dienste und fehlender Images, Start, Härtungsprüfung am laufenden Container und Rollback. Ein zweiter Anlegeweg neben dieser Kette würde dieselben Grenzen doppelt führen. Ein Formular für einzelne Dienste ist deshalb kein eigener Weg; es könnte später nur einen Entwurf für den Editor erzeugen.

Der Projektordner folgt aus dem Namen unter dem Basispfad. Der Agent prüft die Belegung unter der Projektsperre, damit zwei gleichzeitige Anlagen desselben Namens nicht beide durchkommen. Eine Vorschau ohne Container-Anker zeigt Dienste, fehlende Images und Mount-Quellen, bevor etwas geschrieben wird. Sie legt den Ordner nur für die Prüfung an und entfernt ihn danach wieder; ein leerer Ordner gilt als frei. Ein Agent im Nur-Lese-Modus führt auch die Vorschau nicht aus.

Das Anlegen hinterlässt keine eigene Herkunftsmarke. Der Hub arbeitet nur mit dem, was am Server liegt: Basispfad, Compose-Datei und die Fremdverwaltung nach `externallyManaged` bestimmen, was er darf. Eine Marke hätte zwei Klassen gleich aufgebauter Projekte geschaffen, ohne Daten besser zu schützen, denn das Entfernen nach #4 verlangt ohnehin die Bestätigung konkreter Quellen. Die Registry-Herkunft bleibt `adopted`, weil der Hub-Abgleich alles einträgt, was der Agent meldet.

Mount-Quellen werden aus der normalisierten Compose-Ausgabe gelesen, in der relative Pfade schon aufgelöst sind. Eine Quelle ist `project`, wenn sie im Projektordner liegt, sonst `external`; benannte und anonyme Volumes sind `volume`, extern deklarierte Volumes zusätzlich `shared`. Ein benanntes Volume mit `driver_opts` auf einen Host-Pfad erscheint als `volume`, obwohl es Host-Daten einbindet; die Härtungsprüfung löst es auf und verlangt die getippte Bestätigung, der Dateizugriff nach #6 muss es gesondert zuordnen. Externe Bind-Quellen bestätigt der Betreiber beim Anlegen einzeln mit ihrem Host-Pfad. Diese Bestätigung ersetzt für genau diese Quelle die allgemeine Härtungsbestätigung von `bind-outside-base`. Sensible Host-Pfade, der Docker-Socket und die eigenen Betriebsverzeichnisse brauchen weiter die getippte Härtungsbestätigung.

Scheitert das Anlegen und gelingt der Rollback, entfernt der Agent den Entwurf und alle leeren Verzeichnisse. Dateien, die ein Container bereits geschrieben hat, bleiben liegen; die Antwort meldet dann `projectDirRemoved: false`. Scheitert der Rollback, bleibt alles unverändert, weil noch Container bestehen können.

## Laufzeitaktionen

Start, Stopp und Neustart gibt es für einzelne Container und für ganze Stacks (#97). Eine Containeraktion läuft über die Docker Engine und ist auch für fremdverwaltete Container erlaubt. Läuft ein Container beim Start schon oder steht er beim Stopp schon, gilt die Aktion als erfolgreich. Eine Stack-Aktion betrifft immer alle Services des Projekts; einzelne Services laufen über die Containeraktion. Eine Teilauswahl würde einen zweiten Weg mit eigener Reihenfolge- und Abhängigkeitslogik neben Compose schaffen.

Kein Laufzeitweg zieht Images, baut oder entfernt Waisen. Ein fehlendes Image lässt die Aktion sichtbar scheitern, statt fremden Code nebenbei auf den Host zu holen.

### Definition anwenden

Ein Neustart über die Laufzeit verwendet den bestehenden Container weiter. Änderungen an Umgebung, Image, Ports oder Mounts in der Compose-Datei bleiben dabei wirkungslos. Ein Container mit `network_mode: container:<X>` behält außerdem den Namensraum eines inzwischen ersetzten X. Wer die Compose-Datei als Quelle der Wahrheit pflegt, erwartet von Start und Neustart deshalb, dass danach die Definition läuft. Die Einstellung „Compose-Definition bei Start und Neustart anwenden“ macht dieses Verhalten zu einer bewussten Wahl:

| Aktion | An | Aus |
| --- | --- | --- |
| Start | `up -d` | `up -d --no-recreate` |
| Neustart | `up -d --force-recreate` | Stopp und Start |
| Stopp | `compose stop` | `compose stop` |

In beiden Stellungen erzeugt der Start fehlende Services. Mit „Aus“ ersetzt er keinen bestehenden Container; mit „An“ ersetzt er Container, deren Definition sich geändert hat, und der Neustart ersetzt alle. Jeder `up` trägt zusätzlich `--no-build` und `--pull never` und läuft ohne `--wait`. Vor einem erzeugenden Vorgang, beim Neustart also bereits vor dem Stopp, prüft der Agent die Definition mit `compose config` und die lokalen Images. Scheitert eine Prüfung, bleibt der Stack unverändert.

Der Neustart mit „Aus“ verwendet nach `compose stop` denselben `up -d --no-recreate --no-build --pull never` ohne `--wait` wie der Start. Compose bestimmt die Reihenfolge anhand von `depends_on`, `links`, `volumes_from` und Service-Verweisen in `network_mode`, `ipc` und `pid`; damit bleiben die S11-Kopplungen im selben Projekt abhängigkeitssicher. Vorhandene Container werden erhalten, fehlende Services werden erzeugt. Fremdverwaltete Stacks bleiben bei `compose stop` und `compose start` mit der Compose-Reihenfolge für vorhandene Container.

Die Einstellung gilt global; die Ersteinrichtung fragt sie mit der Vorauswahl „An“ ab. Eine Übersteuerung je Projekt und die Anzeige abweichender Definitionen verfolgt #149. Die Einstellung wirkt nur auf Hub-eigene Projekte. Fremdverwaltete Stacks ersetzen nie einen Container und erzeugen auch beim Start nichts: Dort startet `compose start` nur die bestehenden Container, und fehlende Services erscheinen im Ergebnis als nicht erzeugt, weil Erzeugen und Ersetzen dem Verwalter gehören. Ihr Neustart ist Stopp und Start auf demselben Weg. Der Button nennt den wirksamen Modus, damit ein Neustart nie stillschweigend zum Recreate wird.

`down` und `up` als Ersatz für Stopp und Start scheiden aus. Nach `down` fehlen die Container und mit ihnen die Logs, an denen sich ein Fehler nachvollziehen ließe, und der Hub verliert den Anker, über den er den Stack wieder starten kann. Scheitert das anschließende `up`, ist der Stack aus, ohne dass ein alter Container zurückbleibt. Anonyme Volumes bleiben verwaist zurück, während `up --force-recreate` sie in den neuen Container übernimmt.

### Ergebnis und Abschluss

Ein Vorgang ist abgeschlossen, wenn der Agent den Laufzustand jedes betroffenen Containers nachgelesen hat. Erfolgreich ist er, wenn jeder Container den Zielzustand `running` oder `exited` erreicht hat. Ein Container, der nach dem Start mit Exit-Code 0 endet, hat einen Einmalauftrag erledigt und zählt beim Start als erfolgreich; ein anderer Exit-Code ist ein Fehler. Health meldet der Agent mit, macht sie aber nicht zum Erfolgskriterium; deshalb fehlt `--wait`. Nur wo `depends_on` mit `service_healthy` die Reihenfolge bestimmt, wartet Compose vor dem Start des abhängigen Service auf die Health seiner Voraussetzung. Ein Health-Kriterium würde Start und Neustart an Zeitgrenzen binden, die zum Update-Erfolg gehören (#13).

Ein fehlender Service erfüllt beim Stopp bereits den Zielzustand, auch bei Fremdverwaltung. Beim Start oder Neustart bleibt er ein Teilfehler; bei Fremdverwaltung wird er als nicht erzeugt gemeldet.

Das Ergebnis nennt jeden Service mit seinem Zustand und fasst den Vorgang als `ok`, `partial` oder `failed` zusammen. Auch ein gescheiterter Vorgang kann Container ersetzt haben, deshalb verankert der Agent die Container-IDs vor jeder Antwort neu.

Stack-Aktionen melden Fortschritt je Service als NDJSON-Strom wie die übrigen Compose-Wege und fallen auf eine synchrone Antwort zurück. Containeraktionen antworten synchron.

Der Stream für Start, Stopp und Neustart ist über den Suffix `-stream` am Aktionsnamen oder den Accept-Header `application/x-ndjson` erreichbar. Ohne Stream-Anforderung antwortet derselbe Vorgang synchron. Vorprüfungsfehler vor der ersten Stream-Zeile behalten ihren HTTP-Status und liefern JSON. Während des Compose-Vorgangs liest der Agent vorhandene erlaubte Container im Sekundentakt nach und meldet Zustandsänderungen je Service; das Abschlussresultat enthält die neu verankerten IDs. Nach Beginn einer Mutation läuft der Vorgang auch bei getrennter Verbindung bis zum Nachlesen zu Ende. Die Gesamtbewertung beschreibt die nachgelesenen Zielzustände; ein zusätzlicher Ausführungs- oder Vorprüfungsfehler wird als Fehler mitgemeldet und verhindert `ok: true`, auch wenn der Zielzustand bereits erreicht war. Ein Accept-Header für NDJSON bei `apply` oder `down` führt zur synchronen JSON-Antwort; ein Fehler nach Stream-Beginn meldet eine Fehlerzeile mit spezifischem Schlüssel in `reason`, Fehlerstatus in `status` und bereinigtem Ergebnis in `body`.

Eine Fehlergrenze je Laufzeithandler umfasst das erste Gate, die Vorbereitung, die Warteschlange, die Mutation, die Nachlese und die Neuverankerung. Jeder Fehler wird genau einmal auditiert: vor Mutationsbeginn als `denied`, danach als `error`. Delegationshinweise aus den Gates stehen im selben Eintrag. Engine-Fehler behalten ihren HTTP-Status und `engine-action-failed`, Compose-Fehler erhalten `502 compose-action-failed`, unbekannte Fehler `500 internal-error`. Auch eine fehlgeschlagene Definitionsabfrage wird vor der Mutation so beantwortet. Ankerkonflikte behalten ihren eigenen Schlüssel. Engine-Text, Compose-Exitcode und stderr werden an das Audit übergeben und fehlen in der Antwort; bei fehlgeschlagenem Wiederanlauf oder zusätzlichem Nachlesefehler bleiben beide Diagnosen erhalten. Die allgemeine Audit-Feldgrenze bleibt bestehen.

### Gleichzeitige Vorgänge und Zeitgrenzen

Vorgänge auf denselben Container oder dasselbe Projekt laufen nacheinander. Ein wartender Vorgang wartet begrenzt und entfällt, wenn sein Aufrufer die Verbindung getrennt hat. Er läuft nur, wenn der Ist-Stand noch dem entspricht, den der Aufrufer gesehen hat; sonst antwortet der Agent mit `state-changed`. Eine unbegrenzte Warteschlange würde Aufträge ausführen, deren Absender nicht mehr wartet oder einen längst überholten Stand gesehen hat, und das Ergebnis hinge von der Reihenfolge ab. Sofortiges Ablehnen würde dagegen jeden Doppelklick und jedes zweite Gerät zum Fehler machen.

Ein Stopp wartet so lange, wie Docker dem Container zum Beenden gibt (`StopTimeout` bzw. `stop_grace_period`), zuzüglich eines Puffers. Eine feste Zeitgrenze darunter würde einen korrekt laufenden Stopp als gescheitert melden. Stack-Zeitgrenzen leiten sich aus der längsten dieser Fristen ab und sind nach oben begrenzt. Ist ein Host nicht erreichbar, lehnt der Hub die Aktion sofort ab und merkt sie nicht vor.

Einen manuellen Stopp erkennt der Agent als Absicht für die Selbstheilung (siehe [self-healing.md](self-healing.md)).

Der Agent begrenzt die Wartezeit auf eine Vorgangssperre auf 60 Sekunden. Containeraktionen prüfen Container-ID, Status und Startzeit unter dieser Sperre; bei Stacks enthält `expectedStack` dieselben Laufzeitwerte je Service. Health gehört nicht zur Erwartung, weil sie sich auch ohne einen Laufzeitvorgang ändert.

Ein nie gestarteter Container im Zustand `created` gilt beim Stopp bereits als gestoppt; die idempotente Engine-Antwort 304 bleibt erfolgreich.

Die HTTP-Frist für einen Container-Stopp oder -Neustart beträgt `StopTimeout` plus 10 Sekunden. Ohne gesetzten Wert gelten Dockers 10 Sekunden. Ein explizit unbegrenzter Docker-Stopp (`StopTimeout: -1`) erhält eine Agent-Frist von 610 Sekunden. Die Stack-Frist beträgt die längste konfigurierte oder nachgelesene Stoppfrist plus 30 Sekunden, mindestens 60 Sekunden. Beim Neustart wird dieser Wert für die beiden Phasen verdoppelt; der gesamte Compose-Vorgang ist auf 600 Sekunden begrenzt. Beide Neustartphasen teilen diese Frist, auch beim bestmöglichen Start nach einem fehlgeschlagenen Stopp. Der Stopp erhält höchstens die Gesamtfrist abzüglich 30 Sekunden; dieser feste Anteil bleibt für den Start reserviert. Er entspricht dem Stack-Puffer und verhindert, dass ein ausgeschöpfter Stopp dem Wiederanlauf nur eine praktisch unbrauchbare Restfrist lässt.
