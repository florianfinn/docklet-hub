# Begrenzte Selbstheilung

Unerwartete Crashes und Stops werden mit begrenzten erlaubten Aktionen behandelt. Manuelle Stops, Wartung und erfolgreich beendete Einmalaufträge werden unterschieden.

Nach ausgeschöpftem Budget wird ein Vorfall gemeldet und auf Nutzereingabe gewartet. Automatisches Recreate ist ausdrücklich optional, gilt nur für Hub-eigene Projekte und erhält Daten. Docker-Neustartregeln dürfen keinen konkurrierenden endlosen Reparaturablauf erzeugen.

## Manuelle Stopp-Absicht

Der Agent erkennt einen manuellen Stopp an den Docker-Ereignissen: Geht dem `die` eines Containers innerhalb des Zuordnungsfensters ein `kill` mit dem konfigurierten Stoppsignal (`Config.StopSignal`, ab Werk `SIGTERM`) oder `SIGKILL` voraus, war der Stopp gewollt, gleich ob er über den Hub, die Docker-CLI oder die Unraid-Oberfläche kam. Auch `docker stop` und `compose stop` senden zuerst ein `kill` mit dem Stoppsignal; das Ereignis `stop` folgt erst nach `die`. Vom konfigurierten Stoppsignal abweichende Signale wie `SIGHUP` erzeugen keine Stopp-Vorbereitung und verlängern kein bestehendes Fenster. Ein `die` ohne zugeordnetes Stoppsignal ist ein unerwarteter Ausfall. Fährt der Docker-Daemon selbst herunter, etwa beim Neustart des Hosts, stoppt er die Container auf demselben Weg; diese Stopps sind keine Absicht, und der Agent verwirft sie bei einer erkannten Unterbrechung der Daemon-Kontinuität. Der Agent speichert die Absicht dauerhaft unter Projekt und Service, bei Einzelcontainern unter dem Namen, weil ein Recreate die Container-ID ersetzt. Bei einem Stopp über den Hub hält er den Akteur fest. Der nächste Start des Containers löscht die Absicht. So übersteht sie Neustarts von Hub und Agent und gilt auch, solange der Tunnel getrennt ist. Würde allein der Hub die Absicht führen, gälten Stopps über andere Wege als Ausfall, und die Selbstheilung hinge an der Verbindung zum Hub.

Ein Neustart verlangt einen anschließend laufenden Container. Hub-Aktionen für
Container und Stacks kennzeichnen deshalb den Neustart unmittelbar vor dem
Engine- oder Compose-Aufruf: Eine vorhandene Stopp-Absicht wird gelöscht, und
das folgende `kill` → `die` zählt als unerwarteter Ausfall. Solange die
Neustartaktion läuft, wartet die Selbstheilung. Scheitert deren Start und bleibt
der Container gestoppt, darf sie bei passender Neustartregel eingreifen; das
gilt auch bei Exit-Code 0 aus dem gewollten Stoppteil. Ein bestätigtes `start`
hebt die ausstehende Heilung auf. Die Ereigniszuordnung gilt auch für verzögert
verarbeitete Ereignisse anhand ihrer Zeit; ein späterer eigenständiger Stopp
bleibt manuell.

Ein beobachtetes CLI-Ereignis `restart` löscht ebenfalls die Stopp-Absicht und
klassifiziert das letzte beobachtete `die` neu; ein danach noch gestoppter
Container kann geheilt werden. Bei `kill` → `die` → `start` löscht schon der
Start die Absicht und beendet die Ausfallbehandlung. Fehlen sowohl `restart`
als auch `start`, ist ein fehlgeschlagenes CLI-`docker restart` anhand von
`kill` → `die` nicht von einem manuellen Stopp unterscheidbar: Die Absicht
bleibt vorsorglich bestehen. Der Agent erfindet keinen Neustartnachweis aus
einem gestoppten Endzustand.

Das Zuordnungsfenster beginnt beim letzten passenden `kill` derselben Container-ID und endet nach `Config.StopTimeout` in Sekunden plus 5 Sekunden Puffer. Der Puffer deckt die Verarbeitung der Engine-Ereignisse nach der Grace-Period ab. Ein weiteres passendes `kill` beginnt ein neues Zuordnungsfenster, weil auch ein später gestarteter manueller Stopp erkannt werden muss. Fehlt ein endlicher nichtnegativer Stop-Timeout (einschließlich `-1` für unbegrenztes Warten), gilt die Docker-Standardfrist von 10 Sekunden plus Puffer. Ein manuell gestoppter Container mit unbegrenzter Grace-Period kann daher nach mehr als 15 Sekunden als unerwartet enden; eine unbegrenzte Zuordnung würde einen späteren Ausfall dauerhaft dem alten Stoppsignal zuordnen. Die Zuordnung verwendet die Docker-Ereigniszeit, nicht die spätere Bearbeitungszeit im Agent.

Der Agent schreibt `stop-intents.json` neben seine lokale Registry im persistenten Zustandsverzeichnis. Das versionierte JSON enthält die Daemon-Generation, bestätigte Absichten und aktuelle `kill`-Zuordnungen einschließlich der Kennzeichnung erkannter Neustarts. Eine temporäre Datei mit Modus `0600`, Dateisynchronisierung, atomarem Umbenennen und anschließender Synchronisierung des Verzeichnisses verhindert halbe Zustände. Compose-Schlüssel verwenden Projekt und Service, Einzelcontainer-Schlüssel den normalisierten Namen; die Container-ID bleibt nur Ereignisanker. Akteure werden unmittelbar vor dem tatsächlichen Engine- oder Compose-Stopp annotiert und erst bei der bestätigenden Ereignisfolge gespeichert. Ein fehlgeschlagener oder bereits erfüllter Stopp erzeugt allein keine Absicht.

Alle Replikas eines Compose-Services teilen sich den Projekt-Service-Schlüssel: Ein bestätigter Stopp einer Replika setzt die Absicht für den Service, ein Start einer beliebigen Replika löscht sie. Auch der Abgleich mit einer laufenden Replika löscht die gemeinsame Absicht. Eine getrennte Absicht je Replika wird nicht geführt. Beim vollständigen Containerabgleich entfernt der Agent Einzelcontainernamen und Compose-Services, für die kein Container mehr vorhanden ist; ein Recreate unter demselben Schlüssel erhält die Absicht, solange kein neuer Start erkannt wird. Bestätigte Absichten und aktuelle Signalzuordnungen sind jeweils auf 256 Einträge begrenzt. Beim Überschreiten werden die nach Ereigniszeit ältesten Einträge verdrängt; eine verdrängte Absicht steht danach nicht mehr als Stoppnachweis zur Verfügung.

Ist `stop-intents.json` syntaktisch oder nach dem Zustandsschema beschädigt, legt der Agent sie als `stop-intents.json.corrupt-<Zeit>-<Kennung>` beiseite, synchronisiert das Verzeichnis und startet mit leeren Absichten und Signalzuordnungen. Er protokolliert eine Warnung ohne Dateiinhalt. Die gesicherte Datei bleibt zur lokalen Untersuchung erhalten; die Wiederherstellung importiert daraus keine Daten. Scheitert das Lesen aus anderen Gründen oder das Beiseitelegen beziehungsweise Synchronisieren, bleibt der Speicherfehler sichtbar und der Start wird abgebrochen.

Die Linux-Boot-ID sowie Gerät, Inode und Änderungszeit des Docker-Sockets bilden die lokale Daemon-Generation. Ein Host-Neustart ändert die Boot-ID, ein neu angelegter Socket seine Dateigeneration. Ändert sich diese Kennung beim Verbindungsaufbau, werden alle Absichten und aktuellen Zuordnungen verworfen; damit gehen bei geänderter Generation auch gewollte Stopps kurz vor einem Host-Neustart verloren. Die Engine liefert kein eigenes verlässliches Shutdown-Ereignis. Ein unbeabsichtigtes Ende oder ein Fehler des Engine-Ereignisstroms gilt deshalb vorsorglich als Unterbrechung der Daemon-Kontinuität und verwirft ebenfalls alle Absichten. Ein kontrolliertes Ende des Agent-Watchers verwirft keine Absichten, auch wenn es während eines Daemon-Shutdowns geschieht. Bleibt bei Socket-Aktivierung der Socket erhalten und die Generation gleich, bleiben auch kurz zuvor erkannte Absichten beim nächsten Agent-Start erhalten. Bei Socket-Aktivierung kann ein Daemon-Neustart innerhalb desselben Host-Boots den Socket erhalten: Läuft der Agent dabei, erkennt er die Streamunterbrechung; endet er kontrolliert oder ist er während des gesamten Neustarts aus, lässt sich dieser Sonderfall mit diesen Quellen nicht sicher erkennen.

Ein einziger Hintergrund-Watcher liest `/events` auch ohne Hub-Verbindung und verteilt die bisherigen Monitorereignisse an die Hub-Leser. Beim Verbindungsaufbau gleicht er gespeicherte Absichten mit `Running` und `StartedAt` der aktuellen Container ab, damit ein während seiner Abwesenheit erfolgter Start die Absicht ebenfalls löscht. Er fordert Ereignisse ab Beginn des Abgleichs an und filtert ältere Ereignisse aus dem Docker-Rückblick lokal aus. Vollständige Ausfallfolgen während der Agent-Abwesenheit lassen sich damit nicht garantieren. `GET /stop-intents` liefert Absichten, die letzten 256 lokalen Ausfallklassifikationen und den Beobachtungsstatus. Ist die Beobachtung nicht verfügbar, antwortet die Route mit `503`; ein leerer Datensatz darf dann nicht als Nachweis fehlender Stopp-Absicht gelten. Auch `/monitor-events` antwortet ohne Beobachtung mit `503`. Bei Verlust der Beobachtung beendet der Watcher bestehende Monitor-Leser, damit der Hub neu verbindet und den Zustand abgleicht. Inspect- und Speicherfehler beenden nur die aktuelle Verbindung und verwerfen Absichten sowie Signalzuordnungen wie ein unbeabsichtigtes Stromende. Der Watcher versucht den Verbindungsaufbau erneut mit Pausen von 1, 2, 4, 8, 16 und höchstens 30 Sekunden; ein erfolgreich verarbeitetes aktuelles Ereignis setzt die Pause auf 1 Sekunde zurück. Die Ausfallklassifikationen bleiben flüchtig.

## Wer heilt und wann

Die Selbstheilung läuft im Agent. Er erkennt Ausfälle und Stopp-Absichten aus denselben Docker-Ereignissen und heilt deshalb auch, solange der Tunnel zum Hub getrennt ist. Ein Hub als Auslöser würde jeden Verbindungsabbruch zu einer Lücke in der Selbstheilung machen.

Bei Verlust der Ereignisbeobachtung verwirft der Heiler vorgemerkte Ausfälle,
beendet wartende Heilungsaktionen und unterbricht das Stabilitätsfenster. Nach
der Wiederverbindung gleicht er Startzeit, Container-ID und Neustartzähler mit
dem aktuellen Inventar ab. Ein gestoppter Endzustand allein löst keine Heilung
aus: Ereignisfolgen aus der Beobachtungslücke werden nicht rekonstruiert. Erst
ein neu beobachteter unerwarteter Ausfall kann wieder einen Versuch auslösen;
verbrauchtes Budget und offene Vorfälle bleiben erhalten.

Auslöser ist ein unerwarteter Ausfall: ein `die` ohne manuelle Stopp-Absicht mit einem Exit-Code ungleich 0 oder der beobachtete Stoppteil eines erkannten Neustarts, dessen Container gestoppt bleibt. Ein erfolgreich gestarteter Einmalauftrag mit Exit-Code 0 ist kein Ausfall. Ein beobachteter `start` beendet den Neustartbeleg für diesen Container auch während einer noch laufenden Hub-Neustartaktion; deren Aktionssperre bleibt bis zum Befehlsende bestehen. Die Neustartregel des Containers entscheidet, ob der Agent eingreift:

| Neustartregel | Verhalten des Agents |
| --- | --- |
| `no` | heilt |
| `on-failure:N` | heilt erst, wenn Docker nach N Versuchen aufgegeben hat |
| `on-failure` ohne Grenze, `always`, `unless-stopped` | beobachtet nur |

Wo Docker selbst neu startet, würde ein zweiter Reparaturablauf mit ihm um denselben Container konkurrieren. Ob Docker bei `on-failure:N` aufgegeben hat, liest der Agent am Container ab: Der Container steht, und sein `RestartCount` hat `MaximumRetryCount` erreicht. Ist Docker noch nicht am Versuchslimit, beendet der Agent die ausstehende Behandlung und wartet auf ein neues Start- oder Ausfallereignis. Er fragt diesen Endzustand nicht jede Sekunde erneut ab und zeigt keinen fälligen Heilungsversuch an. Das gilt auch für Exit 0 beim fehlgeschlagenen Neustart oder einen API-Stopp unterhalb des Limits: Ohne ausgeschöpftes Docker-Budget übernimmt der Agent nicht. Ein Container, der `unhealthy` meldet oder `healthy` meldet und trotzdem nicht erreichbar ist, löst die Selbstheilung nicht aus; diese Fälle evaluiert #156.

Geheilt wird mit dem Start des bestehenden Containers, demselben Weg wie die Containeraktion aus [container-lifecycle.md](container-lifecycle.md); ein Neustart ist für einen gestoppten Container nicht nötig. Der Start läuft durch dieselbe Prüfkette wie eine manuelle Aktion und durch dieselbe Warteschlange mit erwartetem Zustand, damit sich manuelle und automatische Vorgänge nicht überholen. Der Agent heilt deshalb nur Container, die die Allowlist freigibt und die weder nur zur Beobachtung freigegeben sind (`observe-only`) noch unter die Selbstverwaltungssperre fallen; im Nur-Lese-Modus heilt er nichts. Ein dort gesperrter Ausfall bleibt als Container-Ereignis sichtbar, erzeugt aber keinen Vorfall, weil es keinen Heilungsversuch gab. Weil dabei nichts erzeugt oder ersetzt wird, gilt die Selbstheilung auch für fremdverwaltete Container; ein automatisches Recreate bleibt gesperrt und ist eine eigene Entscheidung (#21).

## Budget

Ab Werk hat jeder heilbare Container drei Versuche. Vor dem ersten wartet der Agent 10 Sekunden, vor dem zweiten 60 Sekunden und vor dem dritten 5 Minuten. Läuft der Container danach 10 Minuten ohne unerwarteten Ausfall, ist das Budget wieder voll. Ein kurzer erster Abstand fängt einzelne Abstürze ab, die wachsenden Abstände geben einem abhängigen Dienst Zeit, wieder erreichbar zu werden, und begrenzen die Last eines Containers, der sofort wieder abstürzt.

Die Selbstheilung ist ab Werk eingeschaltet. Schalter, Anzahl der Versuche, Abstände und Stabilitätsfenster stehen global in den Einstellungen des Hubs. Der Hub überträgt sie an jeden Agent, der sie speichert; bis zur ersten Übertragung gelten die Werte ab Werk. Auch den Stand des Budgets speichert der Agent dauerhaft, damit ein Neustart des Agents das Budget weder auffüllt noch eine neue Versuchsreihe beginnt.

Budgeteinträge sind auf 256 Zielschlüssel begrenzt, entsprechend der Grenze der
Stopp-Absichten. Neue Einträge entstehen nur für Ziele, deren Freigabe und
Mutationssperren anhand der bereits vorhandenen Registry, Konfiguration und
Inspect-Daten eine Heilung zulassen; die vollständige Prüfkette läuft weiterhin
vor jedem Versuch. Der vollständige Inventarabgleich entfernt nicht mehr
vorhandene Ziele nur dann, wenn sie keine Versuche, ausstehenden Heilungen,
reservierten Heilungsstarts oder offenen Vorfälle besitzen. Beim Überschreiten
werden zuerst unbelastete Einträge nach der ältesten beobachteten Startzeit verdrängt; fehlende
Startbelege gelten als älteste, Gleichstände folgen der Einfügereihenfolge.
Verbrauchtes Budget und offene Vorgänge werden nicht verdrängt. Sind alle 256
Plätze geschützt, nimmt der Heiler neue Ziele nicht auf und startet sie nicht;
ein freier Platz entsteht erst durch Auffüllen und anschließendes Bereinigen
oder Verdrängen. Diese Grenze verhindert Wachstum durch wechselnde Namen und
verhindert zugleich, dass Verdrängung eine neue kostenlose Versuchsreihe eröffnet.

Innerhalb eines Agent-Prozesses bestimmen monotone Zeitabstände die
Versuchspausen, das Stabilitätsfenster, den Wartungsablauf und den Wiederanlauf
nach Speicherfehlern. Ein Vor- oder Zurückstellen der Wanduhr verändert diese
Fristen nicht. Gespeicherte und im Status angezeigte Zeitpunkte bleiben
Wanduhrwerte; nach einem Prozessneustart wird die verbleibende Dauer aus diesen
Werten und der dann aktuellen Wanduhr auf die neue monotone Uhr übertragen.
Uhrsprünge während der Agent-Abwesenheit lassen sich damit nicht korrigieren;
angezeigte absolute Fristen können nach einem Sprung im laufenden Prozess von
der tatsächlichen Restdauer abweichen. Docker-Ereigniszeiten und Startzeitbelege
bleiben Wanduhrwerte für die Zuordnung, keine Prozessfristen.

Die Konfiguration verwendet ganze Sekunden. Zulässig sind 1 bis 10 Versuche,
mit genau einem Abstand pro Versuch von 1 bis 86.400 Sekunden. Das
Stabilitätsfenster liegt zwischen 1 und 86.400 Sekunden; die Wartungsdauer-Vorgabe
zwischen 60 und 604.800 Sekunden (eine Minute bis sieben Tage) oder ist
unbegrenzt (`maintenanceDurationSeconds: null`). Ab Werk beträgt die globale
Vorgabedauer 3.600 Sekunden; sie bestimmt die Vorauswahl einer neuen Wartung. Auch bei
abgeschalteter Selbstheilung bleibt eine vollständige, gültige Konfiguration
abgelegt. Die Grenzen verhindern unbeschränkte Versuchsreihen und Zeitwerte,
die bei einer späteren Aktivierung keine sinnvolle Wirkung hätten.

Der Hub speichert zuerst und überträgt anschließend mit `PUT /self-healing/config`
als `system:hub`. Der Agent quittiert die gespeicherte Konfiguration erst nach
atomarem Dateiersatz mit Modus `0600`. Diese reine Konfigurationsübertragung ist
auch im Nur-Lese-Modus erlaubt; sie startet keinen Container und der Modus
sperrt weiterhin jede Heilungsaktion. Die Route schreibt genau einen Audit-Eintrag:
Erfolg als `allowed`, ungültige Eingaben als `denied` und Fehler beim Speichern
als `error`. Engine- und Dateidiagnosen bleiben im Audit; Antworten enthalten nur
Status und Fehlerschlüssel.
Eine beschädigte vorhandene Konfigurationsdatei bricht das Laden ab, statt eine
abgeschaltete Selbstheilung durch einen Rückfall auf Werkswerte einzuschalten.

Jede Änderung im Hub erhält eine Revision. Die Einstellungen zeigen je Host,
ob diese Revision bestätigt wurde, die Übertragung aussteht oder fehlgeschlagen
ist. Die Bestätigung belegt die Speicherung, keine ausgeführte Heilung. Ein
Übertragungsfehler nimmt die Speicherung im Hub nicht zurück. Nach Registrierung,
nach jeder Live-Verbindung und nach einem Neustart des Hubs wird der aktuelle
Stand erneut gesendet. Der Live-Dienst öffnet zuerst `/monitor-events`, gleicht
die Registry über die gemeinsame Host-Sperre ab und überträgt anschließend die
Konfiguration, bevor er den Verbindungsaufbau als abgeschlossen meldet. Auch
neu registrierte Hosts kommen über diesen Weg hinzu. Fehlgeschlagene
Übertragungen werden bei der nächsten erfolgreichen 15-Sekunden-Sonde des
Live-Dienstes wiederholt. Der Weg bleibt bei abgeschaltetem Hintergrundlauf
aktiv und benötigt keine zusätzliche Wiederverbindungserkennung in Lesewegen.
Übertragungen je Host laufen nacheinander und lesen vor dem Senden den aktuellen
Stand, damit verzögerte Antworten keine neueren Einstellungen überschreiben.

Ist das Budget erschöpft, legt der Agent einen Vorfall an und unternimmt nichts mehr, bis jemand handelt. Ein manueller Start füllt das Budget wieder auf und schließt den Vorfall, gleich ob er über den Hub, die Docker-CLI oder die Unraid-Oberfläche kam. Manuell ist ein Start, den weder die Selbstheilung noch Docker über seine Neustartregel ausgelöst hat; einen Neustart durch Docker erkennt der Agent am gestiegenen `RestartCount`. Würde jeder Start auffüllen, setzten sich Docker-Wiederholungen nach einem Heilungsstart und das Budget gegenseitig zurück, und Agent und Docker wechselten sich endlos ab. Wiederholt Docker bei `on-failure:N` nach einem Heilungsstart selbst, verbraucht das keinen weiteren Versuch; erst wenn Docker wieder aufgibt, folgt der nächste. Quittiert jemand den Vorfall im Hub, füllt das ebenfalls das Budget auf, ohne den Container zu starten.

## Wartung

Die Stopp-Absicht deckt nur einen gestoppten Container ab. Wer an einem Container arbeitet, der dabei absichtlich abstürzt, oder einen abgestürzten Container zur Untersuchung so liegen lassen will, wie er ist, schaltet die Wartung ein. Sie gilt für einen Container oder einen ganzen Stack und läuft nach einer wählbaren Zeit ab, ab Werk nach einer Stunde, auf Wunsch auch unbegrenzt. So bleibt eine vergessene Wartung nicht dauerhaft bestehen.

Während der Wartung heilt der Agent nicht, und Ausfälle zählen nicht ins Budget. Endet die Wartung mit einem gestoppten Container, startet der Agent ihn nicht nachträglich; erst der nächste unerwartete Ausfall löst wieder aus. Die Wartung eines Containers gilt unter demselben Schlüssel wie die Stopp-Absicht; die Wartung eines Stacks gilt für das Projekt und damit auch für Services, die erst während der Wartung hinzukommen. Der Hub setzt sie, der Agent speichert sie und prüft den Ablauf selbst, damit sie auch bei getrenntem Tunnel gilt. Beginn und Ende der Wartung lassen einen offenen Vorfall unverändert.

## Vorfall

Ein Vorfall nennt das Ziel, die Ursache mit Exit-Code und Fehlermeldung der Engine, jeden Versuch mit Zeitpunkt und Ergebnis, eine empfohlene Handlung und einen Auszug aus den letzten 50 Logzeilen des Containers. Jede Zeile ist auf 500 Unicode-Zeichen begrenzt; der gesamte Auszug einschließlich Zeilentrennern auf 16 KiB UTF-8. Die neuesten Zeilen haben Vorrang, die Reihenfolge bleibt erhalten. Diese Grenzen erhalten kurze Fehlermeldungen und ihren Kontext, ohne dass einzelne endlose oder mehrbytekodierte Zeilen den dauerhaft gespeicherten Vorfall beliebig vergrößern. Die Kürzung erfolgt nach der Bereinigung und trennt keine Unicode-Zeichen. Der Log-Auszug durchläuft die Bereinigung, die auch für Log-Ansichten gilt. Ist die Bereinigung nicht verfügbar, entsteht der Vorfall ohne Log-Auszug und nennt den Grund; ungeprüfte Logzeilen gibt er nicht weiter. Je Ziel gibt es höchstens einen offenen Vorfall. Der Agent speichert ihn, der Hub liest und zeigt ihn. Der Aufbau ist so gewählt, dass ihn das Ticket- und Hinweissystem aus #157 ohne Umbau übernehmen kann; der Versand über Meldekanäle folgt [notification-channels.md](notification-channels.md).

## Lokaler Zustand und Agent-Routen

`self-healing-state.json` liegt neben der Registry. Speicherformat 1 enthält
Budgeteinträge unter demselben Zielschlüssel wie die Stopp-Absicht, Wartungen und
Vorfälle. Ein Budgeteintrag hält Versuche, den letzten beobachteten Start mit
Container-ID, Startzeit und `RestartCount`, den Beginn des laufenden
Stabilitätsfensters sowie eine ausstehende Ausfallbehandlung mit erwartetem
Laufzustand und absolutem Fälligkeitszeitpunkt fest. Die neue Datei wird mit
Modus `0600` geschrieben, synchronisiert und atomar ersetzt; anschließend wird
das Verzeichnis synchronisiert. Ein beschädigter Zustand bricht den Agent-Start
ab, statt ein frisches Budget anzunehmen.

Beim kontrollierten Agent-Ende bleiben ausstehende Heilungen und Budgetstände
erhalten; der Agent bricht nur wartende Aktionen ab. Der Startzeitvergleich beim
nächsten Inventarabgleich verwirft inzwischen überholte Heilungen. Nur ein
Beobachtungsverlust im laufenden Betrieb verwirft ausstehende Ausfallbelege und
unterbricht das Stabilitätsfenster wie oben beschrieben.

Nach einem Speicher- oder internen Verarbeitungsfehler bleibt der Status mit
`503` und `observing: false` sichtbar. Der Heiler versucht eine synchronisierte
Zustandsschreibung erneut mit Pausen von 1, 2, 4, 8, 16 und höchstens 30 Sekunden.
Erst eine erfolgreiche Schreibung erlaubt weitere Verarbeitung; ein zuvor
fehlgeschlagenes Verwerfen bei Beobachtungsverlust muss zuerst gelingen.
Reservierte Versuche bleiben auch nach einem Dateiersatz mit fehlgeschlagener
Verzeichnissynchronisierung erhalten und werden beim Wiederanlauf als
`interrupted` verbraucht behandelt. Ein erfolgreich durchlaufener Takt setzt
die Pause auf 1 Sekunde zurück.

Der Vergleich des `RestartCount` erfolgt gegenüber dem Wert beim letzten
beobachteten Start desselben Containers. Ein manueller Start, der den Zähler
zurücksetzt, wird dadurch zur neuen Vergleichsbasis. Ein anschließender
Docker-Start mit Zähler 1 zählt wieder als Docker-Wiederholung, auch wenn vor
dem manuellen Start bereits Zähler 2 beobachtet wurde. Container-ID und
`StartedAt` ermöglichen den Abgleich beim Agent-Start. Starts während der
Agent-Abwesenheit lassen sich nur anhand des aktuellen Endstands zuordnen;
vollständige Zwischenfolgen liefert dieser Abgleich nicht.

Unmittelbar vor dem Engine-Aufruf reserviert der Agent den Versuch dauerhaft
und kennzeichnet den geplanten Heilungsstart. Eine Unterbrechung in diesem
Zeitfenster bleibt als `interrupted` verbraucht, auch wenn der Engine-Aufruf
möglicherweise noch nicht begonnen hatte. Diese vorsichtige Zuordnung verhindert
kostenlose Wiederholungen nach einem Prozessabbruch. Der nächste Abstand bleibt
als absoluter Zeitpunkt erhalten. Ein fehlgeschlagener Start kann ohne weiteres
`die` den nächsten begrenzten Versuch auslösen. Ein erfolgreicher Start schöpft
das Budget zunächst nur aus; ein Vorfall entsteht bei einem erneuten Ausfall
oder einem gescheiterten letzten Start. Das Stabilitätsfenster kann das Budget
eines durchgehend laufenden Containers vorher wieder auffüllen.

Vorfälle tragen eine stabile ID, Ziel, Ursache, Versuchsergebnisse, den
Handlungsschlüssel `inspect-container-logs-and-configuration` und entweder einen
bereinigten Log-Auszug oder `redaction-unavailable` beziehungsweise
`logs-unavailable`. Auch die Engine-Ursache wird mit den bekannten Log-Geheimnissen
bereinigt; fehlt die Bereinigung, bleibt die Fehlermeldung leer. Diagnosen von
fehlgeschlagenen Agent-Aktionen bleiben im Audit. Geschlossene Vorfälle behalten
Abschlusszeit und Grund (`manual-start` oder `acknowledged`), damit #157 ihren
Lebenszyklus übernehmen kann. Alle offenen und die letzten 256 geschlossenen
Vorfälle bleiben gespeichert. Beginn und Ende der Wartung ändern sie nicht.

Die neuen Routen gehören zum unveröffentlichten Vertrag 12:

- `GET /self-healing/status` liefert `observing`, `budgets`, `maintenance` und
  `incidents`. Die Antwort ist nicht cachebar. Fehlende Docker-Beobachtung oder
  ein ausgefallener Heiler ergeben `503` mit `observing: false`.
- `PUT /self-healing/maintenance` erhält `target` und optional
  `durationSeconds`. Ohne Dauer gilt die gespeicherte Konfigurationsvorgabe;
  `null` bedeutet unbegrenzt. Das Ziel ist ein Containername, Projekt und
  Service oder `kind: stack` mit Projektname.
- `DELETE /self-healing/maintenance` erhält `target` und hebt diese Wartung auf.
- `POST /self-healing/incidents/acknowledge` erhält das Containerziel `target`,
  schließt dessen offenen Vorfall und füllt das Budget ohne Start auf.

Die drei Schreibwege erlauben `system:hub` oder einen nicht leeren menschlichen
Akteur über den authentifizierten Hub-Zugang. Andere `system:`-Akteure und
fehlende Akteure werden von der Routenpolitik abgewiesen. Die Zustandsänderungen
bleiben im Nur-Lese-Modus möglich und schreiben je Anfrage genau einen
Audit-Eintrag. Die Containeraktion des Heilers verwendet dagegen
`system:self-healing` und bleibt vollständig durch die Mutationsprüfkette gesperrt.
