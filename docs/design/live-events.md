# Live-Ereignisse und Wiederverbindung

## Transport und Vertrauensgrenzen

Der Hub hält pro registriertem Host einen gemeinsamen `GET /monitor-events`-
Strom. Das Host-Geheimnis kommt aus `HostAccess`, der Akteur ist ausschließlich
`system:monitor`. Der Monitor überträgt Container-ID und Aktion, keine Namen,
Labels, Umgebungswerte oder Docker-Rohdaten. Start, Stop, Restart, Die und Health
werden direkt zugeordnet; Create und Destroy markieren eine mögliche Recreate-
Änderung. Die Host-ID stammt aus dem Abonnement, niemals aus Agentendaten.

`GET /api/live-events` verteilt Invalidierungshinweise als NDJSON an angemeldete
Web-Sitzungen. NDJSON nutzt den vorhandenen gemeinsamen Leser mit begrenzter
Zeilenlänge und Abbruchweg. SSE würde zusätzlich eine zweite Rahmung und einen
zweiten Leser verlangen; bidirektionale Kommunikation ist nicht erforderlich.
Die bestehende Herkunftsprüfung schützt auch die begrenzten Hub-Verbindungen.
Die Sitzung wird vor dem Abonnement und danach alle 30 Sekunden erneut geprüft.
Ein Konto darf höchstens acht Verbindungen halten, der Router insgesamt 128.
Ein langsamer Empfänger wird beim ersten Gegendruck getrennt und kann danach
neu lesen. Er hält weder andere Web-Sitzungen noch einen Agent-Slot auf.

Die Hinweise sind keine Containerdaten und keine Berechtigungen. Das Web liest
`GET /api/hosts/:hostId/overview` für den betroffenen Host unter seiner eigenen
Sitzung. Gruppierung und Marken bleiben beim vorhandenen Übersichtsservice;
der Agent sieht bei diesem Abruf weiterhin `user:<id>`. Interne Bestandsabgleiche
und Neu-Lesen nach Wiederverbindung erscheinen dagegen als `system:hub`.

## Lebenszyklus und begrenzter Rücklauf

Der Hub gleicht die Hostliste alle fünf Sekunden ab und prüft erreichbare
Agenten unabhängig vom Ereignisfluss alle 15 Sekunden mit drei Sekunden
Verbindungsfrist. Eine negative Sonde bricht auch einen stillen Monitorstrom ab.
Ein ruhiger Strom ist bei einem Host ohne Lifecycle-Änderungen zulässig. Antwortet
`/health` weiterhin erfolgreich, erkennt die Sonde einen halboffenen oder nur
auf `/monitor-events` hängenden Strom nicht. Der Monitorvertrag enthält keinen
Heartbeat; eine reine Ruhezeitgrenze könnte daher gesunde Verbindungen abbrechen
und belegt keinen Ereignisverlust. Diese Grenze bleibt für die praktische Abnahme
relevant; die Web-Heartbeats bestätigen nur den Web-Hub-Transport.
Host-Entfernung über die Hub-Route bricht sofort ab; ein Listenausgleich erkennt
anderweitig entfernte Hosts. Geänderte Endpoints warten auf das Ende des alten
Abonnements. Entfernte Hosts können durch einen bereits begonnenen Listenabruf
nicht wieder aktiviert werden.

Nach einem Fehler warten Hub und Web 1, 2, 4, 8, 16 und höchstens 30 Sekunden.
Erst eine mindestens 30 Sekunden stabile Verbindung setzt die Wartezeit zurück;
ein sofort wieder endender Strom kann deshalb keine schnelle Schleife erzeugen.
Die Wiederholung läuft weiter, solange der Host registriert beziehungsweise die
Web-Sitzung eingehängt ist. Abbruch beendet Leser, Verbindung und Wartezeit.
Der Hub beendet beim Shutdown zusätzlich seine Web-Empfänger und wartet auf die
laufenden Aufgaben, bevor der Datenbankpool geschlossen wird.

Der Hub öffnet den Monitor vor dem Bestandsabgleich, synchronisiert die Registry,
überträgt die aktuelle Selbstheilungskonfiguration über den Verbindungshaken und
liest `GET /containers` einmal je erfolgreichem Verbindungsaufbau. Die vorhandene
15-Sekunden-Sonde wiederholt fehlgeschlagene Konfigurationsübertragungen bei
erreichbaren Hosts; eine weitere Verbindungserkennung ist nicht erforderlich. Ereignisse
währenddessen liegen nur im begrenzten Transportpuffer. Es gibt keine Ereignis-
Historie, Cursor oder Rücklaufparameter. Neue Web-Verbindungen erhalten eine
Momentaufnahme der Monitorzustände und lesen betroffene Hosts gezielt neu.
Ein Heartbeat alle 15 Sekunden hält den Web-Strom beobachtbar; nach 45 Sekunden
ohne gültigen Umschlag bricht das Web ab und verbindet erneut.

Ein neuer Container kann beim Create-Ereignis noch außerhalb der alten Allowlist
liegen. Deshalb melden auch Bestandsänderungen des vorhandenen periodischen
Registry-Abgleichs einen Refresh. Das ist insbesondere nach einem Recreate
relevant, wenn Destroy vor dem Entstehen des neuen Containers eintraf.
Create- und Destroy-Hinweise werden je Host über 150 Millisekunden gebündelt.
Der Monitorleser wartet nicht auf diesen Abgleich. Weitere Hinweise während
eines laufenden Abgleichs setzen nur einen weiteren Bedarf; nach dem Abgleich
invalidiert ein Recreate-Hinweis ohne IDs den gesamten Host und seine Ressourcen.
Hintergrundlauf, Live-Abgleich und expliziter Abgleich teilen eine Sperre je Host.
Wartende Anforderungen desselben Akteurs teilen einen frischen Folgeabgleich;
unterschiedliche Akteure behalten ihre eigene Audit-Zuordnung. Andere Hosts
können unabhängig weiterlaufen.
Ein abgeschalteter Hostzyklus bietet diesen zusätzlichen periodischen Abgleich
nicht; bekannte Lifecycle-Ereignisse und explizite Refresh-Aufrufe bleiben aktiv.

## Web-Cache und Kennzeichnung

Das Web bündelt Ereignisse desselben Hosts für 150 Millisekunden. Während einer
gezielten Abfrage reicht ein weiteres Ereignis für genau einen anschließenden
Abruf; eine Ereignisliste wird nicht gesammelt. Ein vollständiger Übersichtsabruf
endet vor einem nachfolgenden gezielten Abruf, damit eine ältere Antwort keinen
neueren Zustand überschreibt. Andere Hosts und nicht betroffene Messabfragen
bleiben erhalten. Lifecycle-Hinweise invalidieren die Containerabfrage des Hosts
und die Messabfragen der genannten IDs; Recreate zusätzlich dessen Ressourcen.
Ein Refresh ohne IDs invalidiert die Messabfragen dieses Hosts.

Bei einem Ausfall bleiben die letzten Containerzeilen, Hostlast und Messverläufe
im Sitzungscache erhalten. Die Hostdaten und Fehlermeldungen zeigen weiterhin
den aktuellen Fehler. Eine getrennte Verbindung, ein fehlender Monitorstand
oder eine fehlgeschlagene gezielte Abfrage kennzeichnet den Live-Stand als
veraltet. Noch nicht registrierte Hosts erhalten keine Live-Marke. Eine
Monitor-Momentaufnahme ist keine vollständige Hostliste: fehlende Hosts bleiben
mit ihrer Reihenfolge im Cache, bis eine explizite Entfernung oder ein HTTP 404
sie entfernt. Messwerte tragen zusätzlich eine Veraltet-Marke, wenn ihr Zeitstempel
fehlt, unlesbar ist oder länger als 30 Sekunden zurückliegt. Die Prüfung läuft
alle zehn Sekunden und berücksichtigt die Zehn-Sekunden-Samplingrate. Null wird
nicht als Null-Prozent-Messung dargestellt. Ein neuer Container mit neuer ID
bekommt einen eigenen Messcache. Beim Sitzungsende werden Verbindung und Cache
beendet beziehungsweise geleert.

## Schnittstelle für Aktionsrouten und Vorfälle

`server/src/domain/live-events/index.ts` exportiert `LiveEvents` und
`RefreshTarget`. `await liveEvents.refresh(hostId, target)` synchronisiert die
Registry, liest den aktuellen Bestand, gibt die ausgewählten `ContainerEntry[]`
zurück und meldet einen Refresh an alle Web-Sitzungen. `target` ist
`{ containerId }`, `{ project }` oder `{ host: true }`. Eine verschwundene
Container-ID liefert eine leere Liste und wird trotzdem invalidiert. Der Aufruf
vergibt keine Aktionsberechtigung und führt keine Laufzeitaktion aus.
Ein bereits erfolgreich synchronisierter Hintergrundlauf verwendet
`refresh(hostId, { host: true }, { resync: false })`: er liest den aktuellen
Bestand und meldet den Refresh, ohne die Registry erneut abzugleichen.

Die App reicht dieselbe Instanz über `ApiOptions.liveEvents` an Routen weiter.
Spätere Aktionsrouten rufen die Schnittstelle nach ihrer abgeschlossenen Aktion
auf; Selbstheilungsvorfälle können denselben Weg verwenden. Ein fehlender Host,
beendeter Dienst oder fehlgeschlagener Abgleich lässt das Promise scheitern.
Parallele Bestandsleser desselben Hosts teilen eine laufende Abfrage. Ein
Aktions-Refresh wartet zunächst auf einen schon begonnenen Leser und startet
seine eigene Abfrage erst danach; er übernimmt keinen Stand von vor der Aktion.
Fehler im Hostlisten-Abgleich oder Monitor werden mit lokalen Fehlerkategorien,
HTTP-Status und bekannten Transportcodes protokolliert. Freie Fehlermeldungen,
Antworttexte und Zugangsdaten werden nicht übernommen. Gleichartige Fehler
erscheinen höchstens alle 30 Sekunden; die nächste Meldung zählt unterdrückte
Wiederholungen mit. Die Drossel hält höchstens 32 Kategorien.

## Prüfgrenzen

Dienstlose Tests prüfen Zuordnung, einzelne Abonnements, Wiederverbindung,
Abbruch, Hostwechsel, Akteursheader, Authentifizierung, Fan-out, begrenzte
Web-Sitzungen und Cache-Aktualisierung. happy-dom prüft sichtbare Werte und
Veraltet-Marken über Booleans. Tunnelabbrüche, reale Docker-Ereignisfolgen und
Proxy-Pufferung gehören zusätzlich zur praktischen Feature- und Release-Abnahme
nach #40; lokale Tests ersetzen diese Abnahme nicht.
