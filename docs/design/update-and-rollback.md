# Updates, Rollback und Sicherungen

Dieser Vertrag legt die fachlichen Entscheidungen für ausdrücklich angeforderte
Image-Updates (#13, #14), Konsistenz und Restore (#15) sowie das Angebot einer
Sicherung im Update (#16) fest. Er beschreibt das Zielverhalten. Die
[Verwaltungsgrenzen](container-lifecycle.md) gelten für jeden Einstieg, auch für
rohe Compose-Wege. Updates der Agent-Software sind ein eigener Vorgang.

## Auftrag und Image-Ziel

Ziele sind Hub-verwaltete Compose-Services und Einzelcontainer. Bei Compose ist
die Definition die geltende Compose-Definition; bei Einzelcontainern ist sie
die aus Inspect übernommene Erzeugungskonfiguration, wie in
[agent/src/recreate.ts](../../agent/src/recreate.ts). Fremdverwaltete Ziele bleiben
gesperrt. `compose run`-Container mit dem Label
`com.docker.compose.oneoff=True` sind keine Update-Ziele. Damit erhält jedes Ziel
eine verlässliche Grundlage für Austausch und Rückweg, ohne fremde Definitionen
oder vorübergehende Ausführungen zu übernehmen.

Skalierte Compose-Services mit mehr als einer Replika sind weder Update-,
Sicherungs- noch Restore-Ziele. Jeder Einstieg lehnt sie mit
`scaled-service-unsupported` ab; es wird keine Replika willkürlich ausgewählt.

Ein Update wird ausdrücklich angefordert und immer vorab mit Vorschau bestätigt.
Die Vorschau nennt Ziel, betroffene Services, bisherige und angebotene Digests,
den Rückweg und die gewählte Sicherung. Bei einem vor dem Update `unhealthy`, `restarting` oder `paused`
gemeldeten Dienst zeigt sie zusätzlich die entsprechende Warnung. Den angebotenen Digest
ermittelt sie per Registry-Manifest-Abfrage ohne Pull. Lokal gebaute Images ohne
Registry-Digest sind keine Update-Ziele; die Vorschau erklärt dies mit
`local-image-no-registry-digest`, statt einen Pull zu versuchen.

Die Reihenfolge ist: Digest prüfen, dieselbe Image-Referenz ziehen, dann sichern
und im Stoppmodus stoppen, dann austauschen. Nur ein vom bisherigen Image
abweichender Digest führt zum Austausch. Bei gleichem Digest endet der Auftrag
ohne Pull, Sicherung, Stopp oder Austausch. Das gezogene Image muss dem bestätigten
Digest entsprechen. Eine Abweichung bricht den Lauf vor jeder Daten- oder
Containeränderung ab und verlangt eine neue Vorschau. Bei einem Stack werden
alle benötigten Images gezogen und ihre Digests geprüft, bevor die erste
Sicherung oder der erste Stopp beginnt. Damit bleibt bei einem Pull-Fehler oder
abweichenden Angebot der bisherige Containerzustand unberührt.

Ein Tag- oder Versionswechsel erfolgt ausschließlich über eine Änderung der
Definition. Eine Versionsauswahl gehört nicht zum Update. #70 behandelt die
Anzeige und Erklärung von Pins und Versionen. So bleibt die Definition die
Quelle der Wahrheit, und ein Update wechselt nicht unbemerkt auf eine andere
Versionslinie.

Vor der ersten Containeränderung hält der Agent die vorherige Definition,
den vorherigen Laufzustand einschließlich Health, Pause und Neustartzustand
sowie das tatsächlich verwendete Image als unveränderliche Image-ID
beziehungsweise Digest fest. Ein beweglicher Tag genügt für den Rückweg nicht:
Nach dem Ziehen kann er schon auf das neue Image zeigen. Fehlt eine verlässlich
verwendbare Rückweggrundlage, findet kein Austausch statt. Ein nur für die
Sicherung gestoppter Container behält seinen vor dem Auftrag erfassten
Laufzustand als Zielzustand.

## Erfolg und automatischer Rückweg

Ein vor dem Auftrag gestoppter Container wird mit dem neuen Image erzeugt und
bleibt gestoppt. Erfolg verlangt das bestätigte neue Image und die übernommene
Definition am erzeugten Container; eine Lauf- oder Health-Prüfung findet nicht
statt. Ein Update ist dadurch kein unbeabsichtigter Start.

Für einen laufenden Dienst stellt der Agent den wirksamen Healthcheck am Inspect
des neuen Containers fest. `healthcheck: disable`, `NONE` oder ein fehlender
Healthcheck zählen als ohne Healthcheck. Ein wirksamer Healthcheck verlangt,
dass der neue Container innerhalb seiner Startfrist `healthy` wird und läuft.
Die Startfrist ist eine Hub-Einstellung je Container: Standard 120 Sekunden,
erlaubt 10 bis 1.800 Sekunden. Der Hub überträgt sie mit dem Auftrag; sie beginnt
mit dem Start des Ersatzcontainers. Dockers `start_period` läuft innerhalb
dieser Frist und verlängert sie nicht. Ein Exit, ein fehlgeschlagener Start
oder das Ausbleiben von `healthy` bis zum Fristende ist ein Fehlschlag. Ein
vorübergehendes `starting` oder `unhealthy` innerhalb der Frist lässt den
Healthcheck weiterlaufen. Damit entscheidet der Healthcheck der Anwendung über
ihre Startbereitschaft, ohne langsame Starts pauschal abzulehnen.

Ohne Healthcheck muss ein laufender Dienst nach dem Start seines Ersatzcontainers
30 Sekunden ohne Neustart und ohne Exit laufen. Ein Neustart innerhalb dieses
Stabilitätsfensters beendet die Prüfung sofort als Fehlschlag; das Fenster wird
nicht neu begonnen. Auch ein Exit mit Code 0 scheitert bei einem Dienst. Ein
einmaliges Nachlesen von `running` würde eine Startschleife übersehen. Das
Fenster ist keine Zusage fachlicher Erreichbarkeit und ersetzt keinen Healthcheck.

Ein Compose-Service gilt nur bei Updatebeginn in `running` oder `restarting`
als Abschlussauftrag, wenn beide Bedingungen
aus der aufgelösten Compose-Definition erfüllt sind: Er hat keine Restart-Policy
oder `restart: "no"`, und mindestens ein anderer Service im selben Projekt hängt
mit `condition: service_completed_successfully` von ihm ab. Ein Abschlussauftrag
besteht mit Exit-Code 0 innerhalb der Startfrist. Für ihn gilt dieselbe je
Container konfigurierte und mit dem Auftrag übertragene Startfrist; sie beginnt
mit seinem Start. Ein anderer Exit-Code oder Zeitüberschreitung ist ein Fehlschlag. Jeder andere Service und jeder
Einzelcontainer gilt als Dienst; bei ihm ist jeder Exit ein Fehlschlag,
auch Exit-Code 0. Die Regel für ursprünglich gestoppte Ziele hat Vorrang:
Sie werden nur neu erzeugt (`created`), bleiben gestoppt und erhalten keine Laufprüfung.
Das gilt insbesondere für bereits erfolgreich beendete Abschlussaufträge.
So beruht eine erfolgreiche Beendigung auf einer ausdrücklichen
Compose-Abhängigkeit und nicht auf der Vermutung, ein Exit-Code 0 reiche aus.

Laufzeitaktionen erkennen Einmalaufträge ausschließlich am Label
`com.docker.compose.oneoff=True`, wie in
[container-lifecycle.md](container-lifecycle.md) und
[lifecycle-controls.md](lifecycle-controls.md). Diese Label-Regel bestimmt
nicht die Update-Abnahme; die so gekennzeichneten Container sind gerade
keine Update-Ziele. Die Update-Regel für Abschlussaufträge gilt für die
Abnahme jedes aktualisierten Service im Stack.

Scheitert der Austausch oder die Ergebnisprüfung, setzt der Agent automatisch
auf das festgehaltene vorherige Image und die vorherige Definition zurück und
stellt den vorherigen Laufzustand wieder her. Erfolgreich ist der Rückweg,
wenn dieselbe Image-ID, dieselbe Definition und derselbe Laufzustand wie vor
dem Update wiederhergestellt sind. Maßstab ist der erfasste Vorzustand,
nicht eine erneute Update-Abnahme als Dienst oder Abschlussauftrag.
Ein vorher gestopptes Ziel bleibt gestoppt; ein erledigter Abschlussauftrag
wird nicht allein für eine erneute Prüfung gestartet.

Erzeugt wird stets mit der ursprünglichen Image-Referenz; Inspect muss danach
die erwartete Image-ID bestätigen. Vor dem Rückweg setzt der Agent einen
beweglichen Tag auf die gesicherte alte Image-ID zurück. Dieser Tag gilt
hostweit, auch für andere Container und Projekte mit derselben Referenz.
Nach dem Rückweg zeigt er auf das alte Image; digestgebundene Referenzen
benötigen keinen Retag und bleiben bei gleichem Digest unverändert.
Compose verwendet beim Rückweg die unveränderte Projektdefinition.
Die folgenden Aussagen zum späteren `compose up` gelten, solange kein weiterer
Pull oder Retag die Referenz verändert.
Ein späteres `compose up` verwendet nach erfolgreichem Rückweg bei unveränderter Projektdefinition das alte Image, weil die ursprüngliche Referenz auf dessen Image-ID zeigt.
Scheitert nach dem Retag das Erzeugen, zeigt die Referenz trotzdem auf das alte Image; ein späteres `compose up` versucht daher bei unveränderter Projektdefinition dieses alte Image zu erzeugen.
Der dabei entstehende Vorfall nennt diesen Tag-Stand.
Nach einem Pull ohne Austausch bleibt der Tag auf dem neuen Image; ein späteres `compose up` kann es deshalb entsprechend der Projektdefinition verwenden.

War ein Dienst vorher `unhealthy`, `paused` oder `restarting`, verlangt der
Rückweg kein `healthy`, sondern einen wie vorher laufenden Container.
`restarting` zählt dabei wie bei Laufzeitaktionen als laufend; eine
Neustartschleife muss für einen erfolgreichen Rückweg nicht erzeugt werden.
Ein vorher pausierter Dienst wird nach erfolgreichem Update ebenso wie nach
dem Rückweg wieder pausiert; geprüft wird er davor im laufenden Zustand.
Damit setzt der Rückweg einen mangelhaften, aber bekannten Ausgangszustand
nicht mit einem zusätzlichen Rollback-Fehler gleich. Ein erfolgreicher
Rückweg macht das Update nicht erfolgreich: Das Ergebnis unterscheidet
Update-Fehler, erfolgreichen Rollback und fehlgeschlagenen Rollback. So ist
erkennbar, ob wieder der vorherige Zustand besteht oder Betreiberhandeln nötig ist.

Ein Image-Rollback stellt keine Nutzerdaten zurück. Ein neues Image kann Daten
oder ein Datenbankschema bereits verändert haben; auch das vorherige Image kann
dann scheitern. Die Bestätigung erklärt diese Grenze. Ein Dateibackup und ein
geprüfter anwendungsspezifischer Wiederherstellungsweg bleiben getrennte Aufgaben.

## Stack und Eskalation

Ein Stack-Update behandelt die in diesem Lauf aktualisierten Services als eine
Einheit. Services werden nacheinander in Compose-Abhängigkeitsreihenfolge
aktualisiert und geprüft. Beim ersten Fehler endet die Vorwärtsfolge;
noch nicht aktualisierte Services werden nicht ausgetauscht. Alle bereits
ausgetauschten Services, einschließlich des fehlgeschlagenen Service, werden in
umgekehrter Reihenfolge auf ihr jeweiliges vorheriges Image, die vorherige
Definition und den vorherigen Laufzustand zurückgesetzt. Services mit
unverändertem Digest werden nicht unnötig ersetzt. Jeder Service wird direkt
vor seinem eigenen Austausch gesichert, sofern gewählt. Ein Fehler dieser
Sicherung beendet ebenfalls die Vorwärtsfolge und löst den Rückweg für bereits
ausgetauschte Services aus. Der Stack ist erst erfolgreich, wenn alle
aktualisierten Dienste ihre Laufprüfung und alle ausgeführten Abschlussaufträge
Exit-Code 0 innerhalb der Startfrist erreichen; ursprünglich gestoppte Services
bleiben ohne Laufprüfung gestoppt. Der Rückweg bewertet jeden Service anhand
seines festgehaltenen Vorzustands. Damit bleibt ein Fehler nicht als
unbeabsichtigte Mischung alter und neuer Images stehen, und abhängige Services werden geordnet zurückgesetzt.

Scheitert der Rückweg eines Service, prüft und meldet der Agent trotzdem den
Zustand aller betroffenen Services. Der Hub eskaliert den fehlgeschlagenen
Rückweg als Container-Vorfall beziehungsweise als zusammengehörige Meldung der
betroffenen Services über die vorgesehenen
[Meldekanäle](notification-channels.md). Der Vorfall folgt dem Begriff aus
[self-healing.md](self-healing.md): Ziel, Ursache, Versuche mit Ergebnis und eine
empfohlene Handlung. Update- und Rückwegfehler bleiben unterscheidbar; sensible
Diagnosen werden vor Anzeige und Versand bereinigt. Versandwiederholungen sind
keine weiteren Rollback-Versuche. Ein sichtbarer Vorfall bleibt auch ohne
konfigurierten oder erreichbaren Meldekanal erforderlich.

## Sperren, Abbruch und Fortschritt

Der gesamte Update-Lauf einschließlich Sicherung, Prüfung und Rückweg verwendet
dieselbe Projekt- und Containersperre wie Dateischreiben, Compose-Apply
und Restore. Alle vier Wege koordinieren sich über diese gemeinsame Sperre,
einschließlich direkter Agent-Anfragen. Parallele Aktionen
am selben Ziel dürfen währenddessen keine Mutation ausführen. Update, Restore
und Compose-Apply warten wie Laufzeitaktionen höchstens 60 Sekunden in der
Projekt-/Containerwarteschlange und melden danach `action-queue-timeout`.
Dateischreiben wartet nicht und weist bei belegter Sperre sofort mit `busy` ab. Für einen Stack
umfasst die Sperre sein Projekt und dessen Services. Wartende Aktionen müssen
anschließend den erwarteten Zustand erneut prüfen; ein überholter Auftrag darf
nicht einfach auf den Ersatzcontainer angewendet werden. Damit können manuelle
Aktionen und Selbstheilung den Rückweg nicht überholen. Auch Restore hält die
entsprechende Sperre bis zur Wiederherstellung des vorherigen Laufzustands.

Es gibt keine Sperre je Image-Referenz. Parallele Updates derselben Referenz
auf verschiedenen Zielen werden über die Image-ID-Prüfung nach dem Erzeugen
sicher erkannt, wenn ein konkurrierender Pull oder Retag eine andere Image-ID
auflösen lässt; der betroffene Austausch gilt dann als fehlgeschlagen.

Die Erkennung unterbrochener Updates läuft unabhängig vom Agent-Start und
wiederholt Fehler mit Backoff bis zum ersten erfolgreichen Durchlauf.
Bis dahin werden neue Update-Starts mit `update-rollback-unavailable` abgelehnt;
die Selbstheilung lässt Journal-Ziele aus. Solange das Journal unlesbar ist,
lässt sie alle Ziele aus. Wiederholte Recovery-Audits derselben Fehlerklasse
werden auf höchstens einen Eintrag je 15 Minuten begrenzt. Ein beschädigter Erkennungsverlauf (`update-pending.json.seen`) wird mit
Dateiname im Log beiseitegelegt; höchstens drei solcher Dateien und 512
Erkennungsschlüssel bleiben erhalten. Der Journal-Vorfall verwendet
`@update-journal`, das kein gültiger Docker-Containername ist.
Ein unlesbares Journal wird mit
Zeitstempel und Rechten 0600 beiseitegelegt und als Vorfall gemeldet.
Die Erkennung berücksichtigt nur Journal-Einträge oder bekannte Registry-Ziele.
Sie erhält die Ursache eines offenen Vorfalls und ergänzt allenfalls Kontext.
Ein geschlossener Vorfall für ein bewusst stehen gelassenes geparktes Original
bleibt geschlossen, solange dessen beobachteter Zustand unverändert ist;
Journal-ID und Containername bilden den persistenten Erkennungsschlüssel.

Während eines Update- oder Restore-Laufs gelten Stopp, Entfernen und Tod des
Originalcontainers und des Ersatzcontainers, einschließlich des Stopps vor dem
Entpacken beim Restore, für die [Selbstheilung](self-healing.md) als beabsichtigt.
Sie verbrauchen kein Selbstheilungsbudget, merken keine Heilung vor und erzeugen
keinen Selbstheilungsvorfall. Fehler meldet allein der zuständige Update- oder
Restore-Lauf; die Eskalation eines fehlgeschlagenen Rückwegs bleibt seine Aufgabe.
Damit führt derselbe Fehler nicht zu zwei konkurrierenden Reparaturabläufen.

Ein Betreiber kann bis unmittelbar vor dem ersten Austausch im gesamten Stack
ausdrücklich abbrechen. Nach diesem ersten Austausch ist auch zwischen weiteren
Services kein Abbruch mehr möglich (`update-cancel-too-late`).
Ein bereits für die Sicherung gestoppter Container erhält dabei seinen vorherigen
Laufzustand zurück; scheitert das, wird der Fehler sichtbar gemeldet. Sobald der erste
Austausch beginnt, läuft die Prüfung samt gegebenenfalls nötigem Rückweg zu Ende.
Eine getrennte Browserverbindung ist kein Abbruchauftrag. Diese Grenze verhindert
einen absichtlich zurückgelassenen, unbewerteten Ersatzcontainer.

Update und Restore sind Aufträge im Agenten mit abfragbarem beziehungsweise
gestreamtem Fortschritt. Ihr Start antwortet nur mit `jobId`; das Ergebnis steht
im abfragbaren Fortschritt. Beide laufen unabhängig von der HTTP-Verbindung und
können die 760-s-Frist für synchrone Laufzeitaktionen überschreiten; ein
Verbindungsabbruch beendet sie in keiner Phase. Nach erneutem Verbinden kann der
Hub Fortschritt und Ergebnis wieder abfragen.

### Auftragsliste

Eine Auftragsliste liefert ohne
bekannte `jobId` aktive und zuletzt beendete Update-/Restore-Aufträge, für den
Host insgesamt oder gefiltert nach stabilem Ziel und Auftragsart. Liste und
Fortschrittsabfrage zeigen ausschließlich Aufträge, deren sämtliche Ziele in
der aktuellen Agent-Registry noch bekannt sind. Die Prüfung erfolgt bei jeder
Abfrage über die stabilen Zielschlüssel (Compose-Projekt plus Service oder
Einzelcontainername), unabhängig von einer inzwischen ersetzten Container-ID.
Entfernte oder nicht vollständig zuordenbare Ziele liefern weder einen
Listeneintrag noch Fortschrittsdaten. Das gilt auch für beendete Aufträge
innerhalb der Aufbewahrungsfrist; ein Filter oder eine bekannte `jobId` hebt
diese Grenze nicht auf. Beobachtereinträge gelten für diese Leseabfragen als
bekannt. Ergebnisse
bleiben ab `completedAt` 24 Stunden verfügbar (`AGENT_JOB_RESULT_RETENTION_MS`);
aktive Aufträge werden nicht durch diese Aufbewahrungsfrist entfernt. Die Auftragsdauer erhält eigene
Fristen je Phase: Ziehen, Sicherung, Austausch mit Prüfung und Rückweg. Sie werden
in `contract/` gemeinsam geführt und übernehmen nicht die Restart-Fristen aus
`runtime-deadlines.ts`. Die Werte und die Budgetrechnung stehen im folgenden
Abschnitt. Jede Phasenfrist gilt je Service, nicht einmal für den gesamten Stack; Austausch und
Rückweg berücksichtigen die übertragene Startfrist beziehungsweise das
Stabilitätsfenster. Eine abgelaufene Phase wird als Fehler behandelt und durchläuft
den jeweils erforderlichen sicheren Abschluss, statt still weiterzumachen.
So begrenzt der Vertrag einzelne Arbeiten, ohne HTTP-Fristen mit der fachlichen
Prüfung zu verwechseln.

Der Fortschritt nennt Ziel und beim Stack den Service sowie die Phasen
„prüfen“ (Digest und Vorbedingungen), „ziehen“, „sichern“ (falls gewählt), „austauschen“,
„prüfen“ (Ergebnis) und gegebenenfalls „zurücksetzen“. Das Abschlussresultat
nennt den nachgelesenen Zustand und die Fehler von Update und Rückweg getrennt.
So sind ein unveränderter Digest, eine fehlgeschlagene Sicherung und ein
fehlgeschlagenes Update unterscheidbar.

Update, Sicherung im Update und Restore erzwingen agentenseitig bei jedem
Einstieg Allowlist, Nur-Lese-Modus, Selbstverwaltungssperre, Systemcontainer-
und Fremdverwaltungsschutz. Fremdverwaltete Definitionen und Systemcontainer
bleiben gesperrt. Eine Dialogbestätigung kann diese Grenzen nicht aufheben.

Nach dem erfolgreichen Abschluss endet die Update-Prüfung. Ein späteres
`unhealthy` gehört zur Selbstheilungsentscheidung #156 und löst keinen
nachträglichen Update-Rollback aus. Die Selbstheilung beschreibt unerwartete
Ausfälle; Health-Ausfälle sind dort gesondert abgegrenzt. So werden
Update-Abnahme und dauerhafte Betriebsüberwachung nicht vermischt.

## Phasenfristen und Budgetrechnung

`contract/src/agent/update-deadlines.ts` führt eigene Update-Fristen, unabhängig
von den Restart-Fristen. Dies sind begrenzte Produktbudgets, keine gemessenen
Durchsatzgarantien. Die synchrone Vorschau fragt die Registry-Manifeste parallel
ab und hat insgesamt 60 Sekunden (`UPDATE_PREVIEW_TIMEOUT_MS`), unabhängig von
der Zahl der Services. Sie liegt damit deutlich unter der 760-s-Hub-Frist für
Laufzeitaktionen. Die Vorprüfung im gestarteten Agent-Auftrag erhält 60 Sekunden je Service;
Pull erhält 900 Sekunden je Service, um große Images bei langsamer Verbindung
zuzulassen. Eine Datenkopie erhält 3.600 Sekunden je Service. Größere Datenmengen,
die diese Frist überschreiten, benötigen ein gesondertes Sicherungsverfahren.

Für jede Mutation werden 600 Sekunden für Stopp, 90 Sekunden für Erzeugung bzw.
Wiederanlauf und 30 Sekunden für Zustandsnachlesen reserviert: zusammen 720 Sekunden.
Die Stoppfrist begrenzt das Warten, ohne Dockers konfigurierte Grace-Period zu
ändern oder einen nicht bestätigten Stopp als Erfolg zu behandeln. Die
Sicherungsphase hat damit 4.320 Sekunden inklusive Stopp und Wiederanlauf.
Austausch einschließlich Prüfung und Rückweg erhalten jeweils
`720 s + max(Startfrist, 30 s)` je Service. Die getrennte Reserve für den
Rückweg wird bei Ablauf einer Vorwärtsphase nicht verbraucht; auch ein nur für
die Sicherung gestopptes Ziel kann wiederhergestellt werden. Restore erhält
`4.320 s + max(Startfrist, 30 s)` einschließlich Wiederanlauf.

Das konservative Update-Laufbudget addiert je Service 60 Sekunden Vorprüfung,
900 Sekunden Pull, gegebenenfalls 4.320 Sekunden Sicherung, Austauschbudget und
Rückwegbudget, plus 30 Sekunden abschließendes Nachlesen. Die Warteschlange liegt
davor und addiert höchstens 60 Sekunden. Bei Standardstartfrist ohne Sicherung
sind das für einen Service 2.670 Sekunden, für drei Services 7.950 Sekunden;
mit Sicherung 6.990 bzw. 20.910 Sekunden. Bei maximaler Startfrist mit Sicherung
sind es je Service 10.320 Sekunden plus 30 Sekunden je Lauf. Unveränderte Digests
brauchen keinen Pull und verkürzen den tatsächlichen Lauf. Die additive Rechnung
verhindert, dass ein mehrgliedriger Stack dieselbe Frist unter seinen Services
aufteilen muss. Ein Fristablauf ist ein Fehler mit sicherem Abschluss und
getrennter Rückwegreserve, keine Erlaubnis zum stillen Weiterlaufen.

Fortschritt unterscheidet `precheck`, `pull`, `backup`, `exchange`, `verify`,
`rollback` und `resume` sowie `queued` und `completed`. Austausch und Ergebnisprüfung
teilen das Austauschbudget. `firstExchangeStarted` macht die globale
Abbruchgrenze sichtbar. `acceptance` benennt `created`, `service` oder
`completion-job`; der Agent leitet dies selbst aus Vorzustand und Definition ab.
Vorschau und Start sind über `previewId`, erwarteten Containerzustand,
Definitionshash und bestätigten Digest verbunden. Der Agent prüft diese Werte
nach dem Warten erneut; eine abgelaufene oder veränderte Vorschau ist kein Auftrag.

## Optionale Datensicherung

Im Update-Dialog wird eine Datensicherung bewusst gewählt; sie ist optional.
Für jeden zulässigen Bind-Mount und jedes zulässige benannte Volume gibt es einen
eigenen Schalter. Die Auswahl nennt Quelle, Zuordnung zum Container und Umfang.
Die Quellen der Update-Vorschau und jeder ausgewählte Sicherungs-Mount tragen
`estimatedBytes`; `null` bedeutet, dass der Umfang nicht ermittelbar ist. Die
Platzprüfung darf daraus keinen Umfang von null Bytes ableiten und lehnt bei
unbekanntem Umfang mit `backup-size-unavailable` ab.
Die Auswahl gilt beim Stack je betroffenem Service und ist vor Beginn der Kopie
festgelegt. Gesichert wird nach dem Ziehen und der Digest-Prüfung, beim Stack
je Service direkt vor dessen eigenem Austausch. Im Stoppmodus wird dieser
Service für seine Kopie gestoppt; im Live-Modus erfolgt die Kopie ohne diesen
Stopp. Dadurch werden große oder anderweitig gesicherte Daten nicht ungefragt
mitkopiert und ein Service nicht schon während des Pulls stillgelegt.

Sicherung und Restore verwenden dieselbe Quellenklassifikation wie der
[Dateizugriff](file-access.md). Docker-Socket, Host-Systempfade, Agent-
Betriebsverzeichnisse und das Sicherungsverzeichnis selbst sind nie auswählbar.
Das gilt auch für Volumes mit solchen tatsächlichen Quellen, für Pfad-Aliasse
und für geschützte Unterpfade innerhalb einer ausgewählten Quelle.
Geteilte Quellen sind für Sicherung mit sichtbarem Hinweis auf weitere Schreiber
wählbar, für Restore gesperrt. Ist eine mögliche geteilte Nutzung nicht sicher
zuordenbar, bleibt Restore wie der Dateibrowser für Schreibzugriffe gesperrt.
Die Quellenauswahl allein erzwingt diese Grenzen nicht:
Der Agent prüft sie bei jeder Anfrage. Eine Datenkopie darf weder Host- oder
Agent-Geheimnisse erfassen noch eine Wiederherstellung über fremde Daten erlauben.

Standardmodus ist „Container stoppen“: Während der Kopie schreibt der betroffene
Container nicht. „Live“ bleibt ausdrücklich wählbar und trägt eine deutliche
Warnung vor inkonsistenten Dateien. Auch bei gestopptem Container können andere
Nutzer einer geteilten Quelle weiter schreiben. Eine Dateikopie verspricht in
keinem Modus ein konsistentes Datenbankbackup; dafür ist ein Verfahren der
jeweiligen Anwendung nötig. Der gewählte Modus und geteilte Quellen werden vor
der Bestätigung sichtbar, damit die Einschränkung nicht hinter „Sicherung“
verschwindet.

Eine Sicherung ist ein erfolgreich abgeschlossener Lauf mit genau einem
tar-Archiv je gewähltem Mount. Der Nutzer wählt für Restore ausdrücklich eine
der bis zu drei Sicherungen über deren `backupId` und daraus die Mounts.
Unvollständige Läufe werden nicht in dieser Liste angeboten.

Sicherung und Restore lassen Compose-Dateien und `.env` im Projektverzeichnis
aus, auch wenn das Projektverzeichnis selbst ein gewählter Mount ist. Diese
Dateien bleiben ausschließlich dem geschützten Bearbeitungsweg vorbehalten;
der Ausschluss gilt beim Kopieren und Entpacken.

Der Agent legt die Archive in seinem Sicherungsverzeichnis ab.
Standardort ist das Unterverzeichnis `backups` im Agent-Datenpfad. Das
Verzeichnis ist per Umgebungsvariable übersteuerbar; der konkrete technische
Schlüssel ist `DOCKER_AGENT_BACKUP_DIR`, dokumentiert in den generischen
Agent-Deploy-`.env.example`-Dateien. Das gebündelte Setup verwendet ohne
Durchreichen einer Override-Variable das Datenvolume unter `/state`; dessen
Unterverzeichnis `backups` ist bereits persistent. Leer bedeutet `backups` relativ zum Agent-Datenpfad;
eine gesetzte Angabe bezeichnet das alternative Sicherungsverzeichnis.
Archive sind nur für den Agenten lesbar (Rechte `0600`), das Verzeichnis hat
Rechte `0700`. Das Sicherungsverzeichnis ist über den Dateibrowser nicht
erreichbar. Damit wird eine Sicherung nicht zur ungeprüften zweiten Quelle
sensibler Dateiinhalte.

Der stabile Sicherungsschlüssel ist bei Compose Projekt plus Service,
bei Einzelcontainern der Containername, analog zur
[Stopp-Absicht](self-healing.md). Er bestimmt die Aufbewahrung der letzten
drei erfolgreich abgeschlossenen Sicherungen und die Zuordnung beim Restore.
Eine neue Container-ID nach einem Austausch beginnt keine neue Sicherungsreihe.
Damit bleiben Sicherungen über Updates hinweg beim selben fachlichen Ziel.
Ältere Sicherungen werden erst nach erfolgreichem Abschluss einer neuen entfernt.
Unvollständige Archive gelten nicht als Sicherung und verdrängen
keine brauchbare ältere Sicherung. Die begrenzte Aufbewahrung hält den
Platzbedarf verständlich und bewahrt mehrere Rückgriffsmöglichkeiten.

Vor der Kopie prüft der Agent den verfügbaren Platz am Sicherungsziel gegen den
ermittelten Sicherungsumfang und hält zusätzlich eine feste Reserve frei,
damit der Agent-Zustand schreibbar bleibt. Die feste Reserve
`BACKUP_FREE_RESERVE_BYTES` beträgt 1 GiB (1.073.741.824 Bytes).
Sie hält Platz für Agent-Zustand und atomare Schreibvorgänge frei; sie ist keine
Schätzung der Archivgröße. Der ermittelte Kopierumfang wird zusätzlich benötigt.
Reicht der Platz nicht für Sicherung plus Reserve oder ist
die Reserve bereits unterschritten, wird keine Sicherung angelegt und das
Update nicht gestartet. Das gilt vor jedem Sicherungsschritt im Stack; bereits
ausgetauschte Services gehen bei einem solchen Fehler in den Rückweg.
Scheitert die Sicherung, startet das Update nicht stillschweigend ohne sie;
der Lauf meldet den Fehler und beendet sich. Ein für die Sicherung gestoppter
Container erhält dabei seinen vorherigen Laufzustand zurück, soweit dies
möglich ist; ein Wiederanlauffehler wird zusätzlich gemeldet. Auch ein späterer
Platzfehler während der Kopie darf keinen Austausch auslösen. So bleibt die
gewählte Sicherung eine Vorbedingung des Auftrags.

Der Agent protokolliert den Vorzustand vor einem Daten-Stopp in einem privaten
Journal. Nach einem Agent-Neustart stellt er diesen Laufzustand wieder her und
meldet den unterbrochenen Lauf; ein begonnenes Restore wird nicht automatisch
erneut entpackt. Bis zur Recovery bleiben Starts und Selbstheilung für betroffene
Ziele gesperrt. Das Datenjournal enthält keine Definition und keine Dateiinhalte.

Die Sicherung erhält reguläre Dateien, Verzeichnisse und relative Symlinks,
deren Ziele lexikalisch innerhalb der Mount-Wurzel bleiben. Symlinks werden nie
verfolgt. Absolute und ausbrechende Linkziele, Hardlinks ohne reguläres Ziel im
Archiv sowie Geräte, FIFOs und Sockets werden ausgelassen; `metadata.json`
vermerkt unter `skipped` jeweils Quelle, Pfad und Grund. Lange Linkziele werden
mit GNU-Linkmetadaten erhalten; Dateipfade müssen im ustar-Namensbereich liegen.

Beim sichtbaren Restore werden interne Symlinks erst nach allen regulären
Dateien angelegt. Hardlinks werden als reguläre Kopien ihres gepinnten Ziels
wiederhergestellt. Kein Archiv darf einen Link als Elternverzeichnis verwenden;
ausbrechende Links und Spezialdateien werden bei der Vorprüfung abgelehnt.
Die Deskriptorprüfung folgt auch bestehenden Links niemals. Beim Docker-PUT
werden Links ausgelassen, weil dieser Weg keine gepinnten Zieldeskriptoren
bietet. Eine private Datei `restore-skipped-<Quellenschlüssel>.json` hält die
Auslassungen des letzten erfolgreichen Restore je Quelle fest. Vertrag 13 hat
kein geeignetes Feld für Auslassungszahlen; diese bleiben in den privaten
Metadaten und werden nicht als Fehler oder Archivgröße umgedeutet.

Die Image-Vorschau liest keine Mount-Archive ohne ausdrücklich gewählte
Sicherung. Erst nach den Manifestprüfungen bekommen gewählte Mounts ein eigenes
Umfangsbudget von höchstens fünf Sekunden pro Service. Ein unbekannter Umfang
bleibt `estimatedBytes: null`; nur die Sicherungsauswahl des Mounts ist damit
nicht bestätigbar. Das Update ohne Sicherung bleibt möglich. Vor der tatsächlichen
Kopie wird der Umfang der gewählten Mounts erneut gestreamt ermittelt und die
Platzreserve vor und während der Kopie geprüft.

Offene Journaleinträge sperren ihr Ziel laufend, auch nach der Start-Recovery.
Ein neuer Datenlauf darf den gespeicherten Vorzustand nicht ersetzen. Nach einem
Wiederanlauffehler wird Recovery erneut gestartet; sie wartet auf das Ende
aktiver Aufträge und prüft den Eintrag nach Erwerb seiner Sperre erneut. Erst
nach erfolgreichem Wiederanlauf und Abschluss des Eintrags wird das Ziel frei.
Eine Vorfallsquittierung ersetzt keinen Journalabschluss.

## Gesonderter Restore

Restore ist eine eigene, gesondert bestätigte Aktion als Agent-Auftrag. Seine
Phasen sind `queued`, `stop`, `extract`, `resume` und `completed`. Abbruch ist nur
vor `extract` möglich; ein bereits gestopptes Ziel wird dabei in seinen Vorzustand
zurückgeführt. Nach Entpackbeginn werden Entpacken und Wiederanlauf abgeschlossen.
Das Fortschrittsresultat enthält Restore- und Wiederanlauffehler getrennt.
Die Vorschau enthält die gewählte Sicherung mit `completedAt`, Modus und der
Archivliste je Mount einschließlich Bytes sowie die ausgewählten betroffenen
Zielquellen. Die Sicherungsliste je stabilem Ziel trägt dieselben Sicherungsangaben.
Die Vorschau nennt
Ziel anhand des stabilen Schlüssels, zugehörige Sicherung und die ausgewählten
zulässigen Mount-Ziele sowie die betroffenen vorhandenen Daten. Die Zuordnung
verwendet Compose-Projekt plus Service beziehungsweise den Einzelcontainernamen,
keine überholte Container-ID. Der Agent stoppt den Container selbst; erst nach
bestätigtem Stopp wird entpackt. Nach Ende des Restore-Laufs stellt er den
vorherigen Laufzustand wieder her: Ein vorher laufender Container wird
gestartet, ein vorher gestoppter bleibt gestoppt.
Ein Stopp- oder Wiederanlauffehler wird sichtbar gemeldet. Diese Bestätigung
ist nötig, weil Wiederherstellen Nutzerdaten überschreibt und unabhängig vom
Erfolg eines Image-Rollbacks ist.

Die Quellenklassifikation aus [file-access.md](file-access.md) und dieselben
Verwaltungsgrenzen wie beim Update gelten bei jedem Restore-Einstieg.
Geteilte Quellen, Docker-Socket, Host-Systempfade, Agent-Betriebsverzeichnisse
und das Sicherungsverzeichnis sind als Restore-Ziele gesperrt. Auch bei unklarer
Zuordnung einer möglichen geteilten Quelle ist Restore-Schreiben gesperrt.
Beim sichtbaren Restore werden Modus und numerische UID/GID regulärer Dateien,
Hardlink-Kopien sowie neuer und bestehender Verzeichnisse geprüft hergestellt.
Die Mount-Wurzel bleibt derselbe Verzeichnis-Inode; nur ihre Metadaten ändern
sich. Verzeichnisrechte werden nach ihren Kindern gesetzt, die Mount-Wurzel
zuletzt. Eigentümer werden vor dem Modus gesetzt, da `chown` Set-ID-Bits löschen
kann. Verzeichnisdeskriptoren werden nicht für den gesamten Lauf offen gehalten.

Fehlende lokale Rechte führen nach Prüfung des Eltern-Deskriptors zu einem
benannten Archiv-PUT mit Header-Eigentümer. Auch danach werden die tatsächlichen
Metadaten geprüft; eine Abweichung führt zu `restore-extract-failed`, mit Quelle
und betroffenem Pfad in der privaten Datei `restore-failure.json`. Moby
[führt bestehende Verzeichnisse zusammen und setzt danach Eigentümer und Modus](https://github.com/moby/moby/blob/v27.5.1/pkg/archive/archive.go#L691).
Ein Eintrag namens `.` wird dagegen
[übersprungen](https://github.com/moby/moby/blob/v27.5.1/pkg/archive/archive.go#L1150);
deshalb adressiert der PUT die Mount-Wurzel mit ihrem Namen vom Elternpfad aus.
Die anschließende Prüfung verhindert ein stilles Erfolgsergebnis bei einer
abweichenden Engine-Implementierung oder fehlenden Daemon-Rechten. Symlinks
haben unter Linux den festen Modus 0777; ein davon abweichender Archivmodus
führt beim sichtbaren Restore zum Fehler. Sie werden niemals durchschrieben.

Agentenseitige Pfad-, Symlink- und Rechteprüfungen gelten auch beim Entpacken; ein Archiv darf
keine Daten außerhalb seiner bestätigten Ziele verändern. Der gestoppte
Container allein ist keine Berechtigung zum Schreiben.

Das Restore-Ergebnis nennt Erfolg oder Fehler und den tatsächlichen
Containerzustand. Ein fehlgeschlagener Restore ist keine erfolgreiche
Wiederherstellung und löst keinen stillen Image-Wechsel aus. Fehler bei der
Wiederherstellung und beim Wiederanlauf bleiben getrennt erkennbar.
Dateikopien versprechen auch beim Restore keine Datenbankkonsistenz.

## Umsetzungskriterien

- Ziele sind Hub-verwaltete Compose-Services und Einzelcontainer mit aus Inspect
  übernommener Erzeugungskonfiguration. Fremdverwaltete Ziele und Container mit
  `com.docker.compose.oneoff=True` sind keine Update-Ziele.
- Jedes Update verlangt vorab Vorschau und Bestätigung von Ziel, Services,
  betroffenen Digests, Rückweg und gewählter Sicherung. Es zieht dieselbe
  Image-Referenz; gleicher Digest führt zu keinem Pull oder Austausch. Ein abweichender
  Zieldigest bricht vor jeder Daten- oder Containeränderung ab und verlangt eine
  neue Vorschau. Sie ermittelt das Angebot per Registry-Manifest-Abfrage ohne Pull
  und warnt bei vorher `unhealthy`, `restarting` und `paused`. Lokal gebaute
  Images ohne Registry-Digest werden mit erklärtem Sperrgrund abgelehnt.
  Versionswechsel sind Definitionsänderungen;
  #70 behandelt Anzeige und Erklärung von Pins und Versionen.
- Nach Digest-Prüfung und Bestätigung werden zuerst alle benötigten Images
  gezogen und mit den bestätigten Digests verglichen. Erst danach wird gesichert
  und im Stoppmodus gestoppt, dann ausgetauscht; bei gleichem Digest entfallen
  Sicherung, Stopp und Austausch.
- Vor dem Austausch sind vorheriges Image als Image-ID oder Digest, vorherige
  Definition und Laufzustand einschließlich Health, Pause und Neustartzustand
  als verwendbare Rückweggrundlage vor der ersten Containeränderung festgehalten.
- Ein ursprünglich gestopptes Ziel wird mit dem neuen Image und der übernommenen
  Definition erzeugt und bleibt gestoppt; es erhält keine Laufprüfung.
- Für laufende Dienste mit wirksamem Healthcheck gelten 120 Sekunden als Standard,
  erlaubt 10–1.800 Sekunden als Hub-Einstellung je Container, mit dem Auftrag
  übertragen. Der Agent prüft den Healthcheck am neuen Inspect; `disable`/`NONE`
  zählt als ohne Healthcheck. Dockers `start_period` verlängert die Frist nicht.
- Ein laufender Dienst mit Healthcheck muss innerhalb der Startfrist `healthy`
  werden und laufen. Ohne Healthcheck muss er 30 Sekunden ohne Neustart und Exit
  laufen. Ein Neustart im Stabilitätsfenster beendet die Prüfung als Fehlschlag;
  auch Exit-Code 0 scheitert bei Diensten.
- Ein Update-Abschlussauftrag gilt nur bei Beginn in `running` oder `restarting`
  und wird aus der aufgelösten Compose-Definition
  erkannt: keine Restart-Policy oder `restart: "no"`, und mindestens ein anderer
  Service desselben Projekts hängt von ihm mit
  `condition: service_completed_successfully` ab. Er besteht nur mit Exit 0
  innerhalb derselben je Container konfigurierten und übertragenen Startfrist
  ab seinem Start; anderer Exit-Code und Zeitüberschreitung scheitern. Alle übrigen Services
  und Einzelcontainer sind Dienste. Laufzeitaktionen verwenden stattdessen
  ausschließlich das oneoff-Label; das macht keinen Container zum Update-Ziel.
- Ein Fehler löst den Rückweg aus; erfolgreich ist er nur mit derselben
  Image-ID, Definition und demselben Laufzustand wie vor dem Update. Gestoppte
  Ziele bleiben gestoppt, erledigte Abschlussaufträge werden nicht zur Prüfung
  gestartet. Bei zuvor `unhealthy`, `paused` oder `restarting` ist kein `healthy`
  nötig, sondern laufend wie vorher; `paused` wird wieder pausiert. Update-Fehler
  und Rollback-Ergebnis werden getrennt gemeldet.
- Stack-Services werden nacheinander in Compose-Abhängigkeitsreihenfolge geprüft:
  Dienste mit Laufprüfung, Abschlussaufträge mit Exit 0 innerhalb der Startfrist,
  ursprünglich gestoppte Services ohne Laufprüfung. Jeder Service wird bei gewählter
  Sicherung direkt vor seinem eigenen Austausch gesichert. Beim ersten Fehler,
  auch einem Sicherungsfehler, endet die Vorwärtsfolge; alle ausgetauschten Services
  werden in umgekehrter Reihenfolge auf ihren jeweiligen Vorzustand zurückgesetzt.
  Rückwegfehler verhindern die Prüfung
  der übrigen nicht und erzeugen einen sichtbaren Vorfall samt Meldeversuch über
  konfigurierte Kanäle, ohne Geheimnisse weiterzureichen.
- Dateischreiben, Compose-Apply, Update und Restore teilen dieselbe Projekt-
  und Containersperre, auch bei direkten Agent-Anfragen. Kein konkurrierender
  Weg mutiert dasselbe Ziel während eines Laufs; nach dem Warten wird sein
  erwarteter Zustand geprüft.
- Stopp, Entfernen und Tod von Original und Ersatz während Update oder Restore,
  einschließlich des Restore-Stopps, sind
  für die Selbstheilung beabsichtigt: kein Budgetverbrauch, keine vorgemerkte
  Heilung, kein Selbstheilungsvorfall. Fehler meldet allein der zuständige Lauf.
- Ausdrücklicher Abbruch vor dem ersten Austausch im Stack verhindert ihn; danach
  werden Prüfung und nötiger Rückweg abgeschlossen. Ein nur für die Sicherung
  gestopptes Ziel erhält seinen vorherigen Laufzustand zurück oder einen sichtbaren
  Wiederanlauffehler.
- Der Update-Auftrag läuft im Agenten mit abfragbarem/gestreamtem Fortschritt;
  Verbindungsabbruch beendet ihn nicht. Eigene Fristen für Ziehen, Sicherung,
  Austausch mit Prüfung und Rückweg stehen gemeinsam in `contract/`, mit Werten
  aus dem Vertragsschritt und unabhängig von Restart-Fristen. Fortschritt enthält
  die festgelegten Phasen und beim Stack den Service.
- Auftragsliste und Fortschrittsabfrage prüfen bei jeder Anfrage die aktuelle
  Registry anhand sämtlicher stabiler Auftragsziele. Unbekannte, entfernte oder
  nicht vollständig zuordenbare Ziele werden weder in aktiven noch in zuletzt
  beendeten Aufträgen oder deren Fortschritt offengelegt. Ein Container-ID-Wechsel
  bei weiterhin bekanntem stabilem Ziel erhält die Lesbarkeit; Filter und
  Aufbewahrungsfrist umgehen die Registry-Grenze nicht.
- Update, Sicherung und Restore erzwingen an allen Einstiegen Allowlist,
  Nur-Lese-Modus, Selbstverwaltungssperre, Systemcontainer- und Fremdverwaltungsschutz.
- Ein nach erfolgreichem Abschluss auftretendes `unhealthy` startet keinen
  Update-Rollback und bleibt Gegenstand von #156.
- Die Mount-Auswahl für Sicherung und Restore folgt der Quellenklassifikation
  des Dateibrowsers. Docker-Socket, Host-Systempfade, Agent-Betriebsverzeichnisse
  und Sicherungsverzeichnis sind nie auswählbar, auch nicht über Aliasse,
  Volumes oder geschützte Unterpfade. Geteilte Quellen sind nur für Sicherung
  mit Hinweis wählbar. Unklare Zuordnung geteilter Quellen sperrt Restore-Schreiben.
- Der Dialog bietet optionale Sicherung, je zulässigem Mount einen Schalter,
  Stopp als Standardmodus und Live mit Inkonsistenzwarnung. Eine konsistente
  Datenbanksicherung durch Dateikopie wird ausdrücklich nicht zugesagt.
- Sicherungen sind tar-Archive mit Rechten `0600` im per Umgebungsvariable
  übersteuerbaren Unterverzeichnis `backups` des Agent-Datenpfads mit Rechten
  `0700`. Dieses ist im Dateibrowser unerreichbar. Die letzten drei vollständigen
  Sicherungen und die Restore-Zuordnung verwenden den stabilen Schlüssel
  Compose-Projekt plus Service oder Einzelcontainername, auch nach Containerwechsel.
  Ältere Sicherungen werden erst nach erfolgreichem Abschluss einer neuen entfernt.
- Die Platzprüfung vor jeder Sicherung berücksichtigt Sicherungsumfang plus
  feste Reserve für den Agent-Zustand. Die feste Reserve beträgt 1 GiB und steht
  in `contract/`. Bei unterschrittener Reserve wird keine Sicherung angelegt und
  kein Update gestartet. Zu wenig Platz oder ein Sicherungsfehler verhindert den
  jeweiligen Austausch und löst beim Stack den Rückweg für bereits ausgetauschte
  Services aus; der Fehler wird sichtbar gemeldet. Ein Wiederanlauffehler nach
  Sicherungsabbruch bleibt zusätzlich sichtbar.
- Restore verlangt eine eigene Bestätigung und stoppt den Container selbst.
  Entpackt wird erst nach bestätigtem Stopp; danach wird der vorherige Laufzustand
  wiederhergestellt. Das Archiv bleibt innerhalb bestätigter zulässiger Mount-Ziele;
  geteilte Quellen sind gesperrt. Stopp-,
  Wiederherstellungs- und Wiederanlauffehler werden sichtbar gemeldet.
  Image-Rollback stellt keine Nutzerdaten zurück.
