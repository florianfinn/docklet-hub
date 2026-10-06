# Begrenzte Selbstheilung

Unerwartete Crashes und Stops werden mit begrenzten erlaubten Aktionen behandelt. Manuelle Stops, Wartung und erfolgreich beendete Einmalaufträge werden unterschieden.

Nach ausgeschöpftem Budget wird ein Vorfall gemeldet und auf Nutzereingabe gewartet. Automatisches Recreate ist ausdrücklich optional, gilt nur für Hub-eigene Projekte und erhält Daten. Docker-Neustartregeln dürfen keinen konkurrierenden endlosen Reparaturablauf erzeugen.

## Manuelle Stopp-Absicht

Der Agent erkennt einen manuellen Stopp an den Docker-Ereignissen: Geht dem `die` eines Containers ein `kill` voraus, war der Stopp gewollt, gleich ob er über den Hub, die Docker-CLI oder die Unraid-Oberfläche kam. Auch `docker stop` und `compose stop` senden zuerst ein `kill` mit dem Stoppsignal; das Ereignis `stop` folgt erst nach `die`. Ein `die` ohne vorheriges `kill` ist ein unerwarteter Ausfall. Fährt der Docker-Daemon selbst herunter, etwa beim Neustart des Hosts, stoppt er die Container auf demselben Weg; diese Stopps sind keine Absicht, und der Agent verwirft sie beim nächsten Start des Daemons. Der Agent speichert die Absicht dauerhaft unter Projekt und Service, bei Einzelcontainern unter dem Namen, weil ein Recreate die Container-ID ersetzt. Bei einem Stopp über den Hub hält er den Akteur fest. Der nächste Start des Containers löscht die Absicht. So übersteht sie Neustarts von Hub und Agent und gilt auch, solange der Tunnel getrennt ist. Würde allein der Hub die Absicht führen, gälten Stopps über andere Wege als Ausfall, und die Selbstheilung hinge an der Verbindung zum Hub.

## Wer heilt und wann

Die Selbstheilung läuft im Agent. Er erkennt Ausfälle und Stopp-Absichten aus denselben Docker-Ereignissen und heilt deshalb auch, solange der Tunnel zum Hub getrennt ist. Ein Hub als Auslöser würde jeden Verbindungsabbruch zu einer Lücke in der Selbstheilung machen.

Auslöser ist nur ein unerwarteter Ausfall: ein `die` ohne vorheriges `kill` mit einem Exit-Code ungleich 0. Ein Einmalauftrag mit Exit-Code 0 ist kein Ausfall. Die Neustartregel des Containers entscheidet, ob der Agent eingreift:

| Neustartregel | Verhalten des Agents |
| --- | --- |
| `no` | heilt |
| `on-failure:N` | heilt erst, wenn Docker nach N Versuchen aufgegeben hat |
| `on-failure` ohne Grenze, `always`, `unless-stopped` | beobachtet nur |

Wo Docker selbst neu startet, würde ein zweiter Reparaturablauf mit ihm um denselben Container konkurrieren. Ob Docker bei `on-failure:N` aufgegeben hat, liest der Agent am Container ab: Der Container steht, und sein `RestartCount` hat `MaximumRetryCount` erreicht. Ein Container, der `unhealthy` meldet oder `healthy` meldet und trotzdem nicht erreichbar ist, löst die Selbstheilung nicht aus; diese Fälle evaluiert #156.

Geheilt wird mit dem Start des bestehenden Containers, demselben Weg wie die Containeraktion aus [container-lifecycle.md](container-lifecycle.md); ein Neustart ist für einen gestoppten Container nicht nötig. Der Start läuft durch dieselbe Prüfkette wie eine manuelle Aktion und durch dieselbe Warteschlange mit erwartetem Zustand, damit sich manuelle und automatische Vorgänge nicht überholen. Der Agent heilt deshalb nur Container, die die Allowlist freigibt und die weder zur Beobachterklasse gehören noch unter die Selbstverwaltungssperre fallen; im Nur-Lese-Modus heilt er nichts. Ein dort gesperrter Ausfall bleibt als Container-Ereignis sichtbar, erzeugt aber keinen Vorfall, weil es keinen Heilungsversuch gab. Weil dabei nichts erzeugt oder ersetzt wird, gilt die Selbstheilung auch für fremdverwaltete Container; ein automatisches Recreate bleibt gesperrt und ist eine eigene Entscheidung (#21).

## Budget

Ab Werk hat jeder heilbare Container drei Versuche. Vor dem ersten wartet der Agent 10 Sekunden, vor dem zweiten 60 Sekunden und vor dem dritten 5 Minuten. Läuft der Container danach 10 Minuten ohne unerwarteten Ausfall, ist das Budget wieder voll. Ein kurzer erster Abstand fängt einzelne Abstürze ab, die wachsenden Abstände geben einem abhängigen Dienst Zeit, wieder erreichbar zu werden, und begrenzen die Last eines Containers, der sofort wieder abstürzt.

Die Selbstheilung ist ab Werk eingeschaltet. Schalter, Anzahl der Versuche, Abstände und Stabilitätsfenster stehen global in den Einstellungen des Hubs. Der Hub überträgt sie an jeden Agent, der sie speichert; bis zur ersten Übertragung gelten die Werte ab Werk. Auch den Stand des Budgets speichert der Agent dauerhaft, damit ein Neustart des Agents das Budget weder auffüllt noch eine neue Versuchsreihe beginnt.

Die Konfiguration verwendet ganze Sekunden. Zulässig sind 1 bis 10 Versuche,
mit genau einem Abstand pro Versuch von 1 bis 86.400 Sekunden. Das
Stabilitätsfenster liegt zwischen 1 und 86.400 Sekunden; die Wartungsdauer-Vorgabe
zwischen 60 und 604.800 Sekunden (eine Minute bis sieben Tage). Auch bei
abgeschalteter Selbstheilung bleibt eine vollständige, gültige Konfiguration
abgelegt. Die Grenzen verhindern unbeschränkte Versuchsreihen und Zeitwerte,
die bei einer späteren Aktivierung keine sinnvolle Wirkung hätten.

Der Hub speichert zuerst und überträgt anschließend mit `PUT /self-healing/config`
als `system:hub`. Der Agent quittiert die gespeicherte Konfiguration erst nach
atomarem Dateiersatz mit Modus `0600`. Diese reine Konfigurationsübertragung ist
auch im Nur-Lese-Modus erlaubt; der Modus sperrt weiterhin jede Heilungsaktion.
Eine beschädigte vorhandene Konfigurationsdatei bricht das Laden ab, statt eine
abgeschaltete Selbstheilung durch einen Rückfall auf Werkswerte einzuschalten.

Jede Änderung im Hub erhält eine Revision. Die Einstellungen zeigen je Host,
ob diese Revision bestätigt wurde, die Übertragung aussteht oder fehlgeschlagen
ist. Die Bestätigung belegt die Speicherung, keine ausgeführte Heilung. Ein
Übertragungsfehler nimmt die Speicherung im Hub nicht zurück. Nach Registrierung,
nach erkannter Wiederverbindung und nach einem Neustart des Hubs wird der aktuelle
Stand erneut gesendet; fehlgeschlagene Übertragungen werden bei der nächsten
erfolgreichen Erreichbarkeitssonde wiederholt. Solange der Hintergrundlauf
abgeschaltet ist, erkennen die Lesewege für Hosts und Übersicht die Verbindung.
Übertragungen je Host laufen nacheinander und lesen vor dem Senden den aktuellen
Stand, damit verzögerte Antworten keine neueren Einstellungen überschreiben.

Ist das Budget erschöpft, legt der Agent einen Vorfall an und unternimmt nichts mehr, bis jemand handelt. Ein manueller Start füllt das Budget wieder auf und schließt den Vorfall, gleich ob er über den Hub, die Docker-CLI oder die Unraid-Oberfläche kam. Manuell ist ein Start, den weder die Selbstheilung noch Docker über seine Neustartregel ausgelöst hat; einen Neustart durch Docker erkennt der Agent am gestiegenen `RestartCount`. Würde jeder Start auffüllen, setzten sich Docker-Wiederholungen nach einem Heilungsstart und das Budget gegenseitig zurück, und Agent und Docker wechselten sich endlos ab. Wiederholt Docker bei `on-failure:N` nach einem Heilungsstart selbst, verbraucht das keinen weiteren Versuch; erst wenn Docker wieder aufgibt, folgt der nächste. Quittiert jemand den Vorfall im Hub, füllt das ebenfalls das Budget auf, ohne den Container zu starten.

## Wartung

Die Stopp-Absicht deckt nur einen gestoppten Container ab. Wer an einem Container arbeitet, der dabei absichtlich abstürzt, oder einen abgestürzten Container zur Untersuchung so liegen lassen will, wie er ist, schaltet die Wartung ein. Sie gilt für einen Container oder einen ganzen Stack und läuft nach einer wählbaren Zeit ab, ab Werk nach einer Stunde, auf Wunsch auch unbegrenzt. So bleibt eine vergessene Wartung nicht dauerhaft bestehen.

Während der Wartung heilt der Agent nicht, und Ausfälle zählen nicht ins Budget. Endet die Wartung mit einem gestoppten Container, startet der Agent ihn nicht nachträglich; erst der nächste unerwartete Ausfall löst wieder aus. Die Wartung eines Containers gilt unter demselben Schlüssel wie die Stopp-Absicht; die Wartung eines Stacks gilt für das Projekt und damit auch für Services, die erst während der Wartung hinzukommen. Der Hub setzt sie, der Agent speichert sie und prüft den Ablauf selbst, damit sie auch bei getrenntem Tunnel gilt. Beginn und Ende der Wartung lassen einen offenen Vorfall unverändert.

## Vorfall

Ein Vorfall nennt das Ziel, die Ursache mit Exit-Code und Fehlermeldung der Engine, jeden Versuch mit Zeitpunkt und Ergebnis, eine empfohlene Handlung und die letzten 50 Logzeilen des Containers. Der Log-Auszug durchläuft die Bereinigung, die auch für Log-Ansichten gilt. Ist die Bereinigung nicht verfügbar, entsteht der Vorfall ohne Log-Auszug und nennt den Grund; ungeprüfte Logzeilen gibt er nicht weiter. Je Ziel gibt es höchstens einen offenen Vorfall. Der Agent speichert ihn, der Hub liest und zeigt ihn. Der Aufbau ist so gewählt, dass ihn das Ticket- und Hinweissystem aus #157 ohne Umbau übernehmen kann; der Versand über Meldekanäle folgt [notification-channels.md](notification-channels.md).
