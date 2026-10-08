# Updates, Rollback und Sicherungen

Dieser Vertrag legt die fachlichen Entscheidungen für ausdrücklich angeforderte
Image-Updates (#13, #14), optionale Datensicherungen (#15) und die gesonderte
Wiederherstellung (#16) fest. Er beschreibt das Zielverhalten. Die
[Verwaltungsgrenzen](container-lifecycle.md) gelten für jeden Einstieg, auch für
rohe Compose-Wege. Updates der Agent-Software sind ein eigener Vorgang.

## Auftrag und Image-Ziel

Ein Update wird ausdrücklich angefordert. Es zieht dieselbe Image-Referenz aus
der geltenden Definition neu und ersetzt einen Container nur, wenn der Digest
vom laufenden Image abweicht. Bei gleichem Digest endet der Auftrag ohne Austausch.
Ein Tag- oder Versionswechsel erfolgt ausschließlich über eine Änderung der
Definition. Eine Versionsauswahl gehört nicht zum Update; sie ist Gegenstand von
#70. So bleibt die Definition die Quelle der Wahrheit, und ein Update wechselt
nicht unbemerkt auf eine andere Versionslinie.

Vor dem Austausch hält der Agent die vorherige Definition und das tatsächlich
laufende Image als unveränderliche Image-ID beziehungsweise Digest fest. Ein
beweglicher Tag genügt für den Rückweg nicht: Nach dem Ziehen kann er schon auf
das neue Image zeigen. Fehlt eine verlässlich verwendbare Rückweggrundlage,
findet kein Austausch statt.

## Erfolg und automatischer Rückweg

Hat der neue Container einen Healthcheck, muss er innerhalb seiner Startfrist
`healthy` werden und laufen. Standard sind 120 Sekunden; die Frist ist je
Container einstellbar und beginnt mit dem Start des Ersatzcontainers. Ein Exit,
ein fehlgeschlagener Start oder das Ausbleiben von `healthy` bis zum Fristende
ist ein Fehlschlag. Ein vorübergehendes `starting` oder `unhealthy` innerhalb der
Frist lässt den Healthcheck weiterlaufen. Damit entscheidet der Healthcheck der
Anwendung über ihre Startbereitschaft, ohne langsame Starts pauschal abzulehnen.

Ohne Healthcheck muss der neue Container nach seinem Start 30 Sekunden ohne
Neustart und ohne Exit laufen. Ein Neustart oder Exit innerhalb dieses
Stabilitätsfensters ist ein Fehlschlag, auch bei Exit-Code 0; das Fenster wird
nicht mit jedem Neustart neu begonnen. Ein einmaliges Nachlesen von `running`
würde eine Startschleife übersehen. Das Fenster ist keine Zusage fachlicher
Erreichbarkeit und ersetzt keinen Healthcheck.

Scheitert der Austausch oder die Ergebnisprüfung, setzt der Agent automatisch
auf das festgehaltene vorherige Image und die vorherige Definition zurück. Der
Rückweg wird ebenfalls anhand des tatsächlichen Images und der jeweiligen
Erfolgskriterien geprüft. Ein erfolgreicher Rückweg macht das Update nicht
erfolgreich: Das Ergebnis unterscheidet Update-Fehler, erfolgreichen Rollback
und fehlgeschlagenen Rollback. So ist erkennbar, ob wieder der vorherige Zustand
läuft oder Betreiberhandeln erforderlich ist.

Ein Image-Rollback stellt keine Nutzerdaten zurück. Ein neues Image kann Daten
oder ein Datenbankschema bereits verändert haben; auch das vorherige Image kann
dann scheitern. Die Bestätigung erklärt diese Grenze. Ein Dateibackup und ein
geprüfter anwendungsspezifischer Wiederherstellungsweg bleiben getrennte Aufgaben.

## Stack und Eskalation

Ein Stack-Update behandelt die in diesem Lauf aktualisierten Services als eine
Einheit. Scheitert ein Service, werden alle bereits ausgetauschten Services,
einschließlich des fehlgeschlagenen Service, auf ihr jeweiliges vorheriges Image
und die vorherige Definition zurückgesetzt. Services mit unverändertem Digest
werden nicht unnötig ersetzt. Für jeden betroffenen Service werden Startfrist
beziehungsweise Stabilitätsfenster geprüft; der Stack ist erst erfolgreich,
wenn alle aktualisierten Services bestehen. Damit bleibt ein Fehler nicht als
unbeabsichtigte Mischung alter und neuer Images stehen.

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
die vorhandene Projekt- beziehungsweise Containersperre. Parallele Aktionen
am selben Ziel dürfen währenddessen keine Mutation ausführen. Für einen Stack
umfasst die Sperre sein Projekt und dessen Services. Wartende Aktionen müssen
anschließend den erwarteten Zustand erneut prüfen; ein überholter Auftrag darf
nicht einfach auf den Ersatzcontainer angewendet werden. Damit können manuelle
Aktionen und Selbstheilung den Rückweg nicht überholen.

Ein Betreiber kann bis unmittelbar vor dem Austausch abbrechen. Ein bereits
für die Sicherung gestoppter Container erhält dabei seinen vorherigen
Laufzustand zurück; scheitert das, wird der Fehler sichtbar gemeldet. Sobald der
Austausch beginnt, läuft die Prüfung samt gegebenenfalls nötigem Rückweg zu
Ende. Eine getrennte Browserverbindung ist keine Freigabe, diese Schritte
abzubrechen. Diese Grenze verhindert einen absichtlich zurückgelassenen,
unbewerteten Ersatzcontainer.

Der Fortschritt nennt Ziel und beim Stack den Service sowie die Phasen
„prüfen“ (Vorbedingungen), „sichern“ (falls gewählt), „ziehen“, „austauschen“,
„prüfen“ (Ergebnis) und gegebenenfalls „zurücksetzen“. Das Abschlussresultat
nennt den nachgelesenen Zustand und die Fehler von Update und Rückweg getrennt.
So sind ein unveränderter Digest, eine fehlgeschlagene Sicherung und ein
fehlgeschlagenes Update unterscheidbar.

Fremdverwaltete Definitionen und Systemcontainer bleiben gesperrt. Allowlist,
Nur-Lese-Modus und Selbstverwaltungssperre gelten agentenseitig bei jedem
Einstieg. Eine Dialogbestätigung kann diese Grenzen nicht aufheben.

Nach dem erfolgreichen Abschluss endet die Update-Prüfung. Ein späteres
`unhealthy` gehört zur Selbstheilungsentscheidung #156 und löst keinen
nachträglichen Update-Rollback aus. Die Selbstheilung beschreibt derzeit
unerwartete Ausfälle; Health-Ausfälle sind dort gesondert abgegrenzt. So werden
Update-Abnahme und dauerhafte Betriebsüberwachung nicht vermischt.

## Optionale Datensicherung

Im Update-Dialog wird eine Datensicherung bewusst gewählt; sie ist optional.
Für jeden Bind-Mount und jedes benannte Volume gibt es einen eigenen Schalter.
Die Auswahl nennt Quelle, Zuordnung zum Container und Umfang. Sie gilt beim
Stack je betroffenem Container und ist vor Beginn der Kopie festgelegt. Dadurch
werden große oder anderweitig gesicherte Daten nicht ungefragt mitkopiert.

Standardmodus ist „Container stoppen“: Während der Kopie schreibt der betroffene
Container nicht. „Live“ bleibt ausdrücklich wählbar und trägt eine deutliche
Warnung vor inkonsistenten Dateien. Auch bei gestopptem Container können andere
Nutzer einer geteilten Quelle weiter schreiben. Eine Dateikopie verspricht in
keinem Modus ein konsistentes Datenbankbackup; dafür ist ein Verfahren der
jeweiligen Anwendung nötig. Der gewählte Modus und geteilte Quellen werden vor
der Bestätigung sichtbar, damit die Einschränkung nicht hinter „Sicherung“
verschwindet.

Der Agent legt die Sicherung als tar in seinem Sicherungsverzeichnis ab. Das
Verzeichnis ist per Umgebungsvariable einstellbar; der konkrete technische
Schlüssel wird bei der Umsetzung in der generischen `.env.example` dokumentiert.
Je Container werden die letzten drei erfolgreich abgeschlossenen Sicherungen
aufbewahrt. Unvollständige Archive gelten nicht als Sicherung und verdrängen
keine brauchbare ältere Sicherung. Die begrenzte Aufbewahrung hält den
Platzbedarf verständlich und bewahrt mehrere Rückgriffsmöglichkeiten.

Vor der Kopie prüft der Agent den verfügbaren Platz am Sicherungsziel gegen den
ermittelten Sicherungsumfang. Bei zu wenig Platz bricht er ohne Update ab.
Scheitert die Sicherung, startet das Update nicht stillschweigend ohne sie;
der Lauf meldet den Fehler und beendet sich. Ein für die Sicherung gestoppter
Container erhält dabei seinen vorherigen Laufzustand zurück, soweit dies
möglich ist; ein Wiederanlauffehler wird zusätzlich gemeldet. Auch ein späterer
Platzfehler während der Kopie darf keinen Austausch auslösen. So bleibt die
gewählte Sicherung eine Vorbedingung des Auftrags.

## Gesonderter Restore

Restore ist eine eigene, gesondert bestätigte Aktion. Die Vorschau nennt
Container, Sicherung und die ausgewählten Mount-Ziele sowie die betroffenen
vorhandenen Daten. Der Container ist während der Wiederherstellung gestoppt.
Agentenseitige Pfad-, Rechte- und Verwaltungsgrenzen gelten auch beim Entpacken;
ein Archiv darf keine Daten außerhalb seiner bestätigten Ziele verändern.
Diese Bestätigung ist nötig, weil Wiederherstellen Nutzerdaten überschreibt
und unabhängig vom Erfolg eines Image-Rollbacks ist.

Das Restore-Ergebnis nennt Erfolg oder Fehler und den tatsächlichen
Containerzustand. Ein fehlgeschlagener Restore ist keine erfolgreiche
Wiederherstellung und löst keinen stillen Image-Wechsel aus. Geteilte Quellen
und Datenbankkonsistenz behalten dieselben Grenzen wie bei der Sicherung.

## Umsetzungskriterien

- Ein ausdrücklich angeforderter Update-Lauf zieht dieselbe Image-Referenz;
  gleicher Digest führt zu keinem Austausch. Tag- und Versionswechsel sind
  ausschließlich Definitionsänderungen, ohne Versionsauswahl im Update.
- Vor jeder Mutation sind vorheriges Image als Image-ID oder Digest und
  vorherige Definition als Rückweggrundlage festgehalten und verwendbar.
- Mit Healthcheck gelten 120 Sekunden als Standard und eine Einstellung je
  Container. Erfolg verlangt `healthy` innerhalb der Startfrist und einen
  laufenden Container; fehlgeschlagener Start und Exit scheitern.
- Ohne Healthcheck ist Erfolg erst nach 30 Sekunden ohne Neustart und Exit
  möglich. Neustarts verlängern das Fenster nicht; auch Exit-Code 0 scheitert.
- Ein Fehler löst den Rückweg auf vorheriges Image und vorherige Definition
  aus. Das Ergebnis weist Update-Fehler und geprüften Rollback getrennt aus.
- Beim Stack-Fehler werden alle in diesem Lauf ausgetauschten Services
  zurückgesetzt. Rückwegfehler einzelner Services verhindern die Prüfung der
  übrigen nicht und erzeugen einen sichtbaren Vorfall samt Meldeversuch über
  konfigurierte Kanäle, ohne Geheimnisse weiterzureichen.
- Ein konkurrierender Auftrag am selben Container oder Projekt mutiert während
  des gesamten Laufs nicht. Nach dem Warten wird sein erwarteter Zustand geprüft.
- Abbruch vor dem Austausch verhindert ihn; nach Austauschbeginn werden Prüfung
  und nötiger Rückweg auch bei Verbindungsabbruch abgeschlossen. Ein vorher nur
  für die Sicherung gestoppter Container erhält seinen Laufzustand zurück oder
  einen sichtbaren Wiederanlauffehler.
- Fortschritt enthält die festgelegten Phasen und beim Stack den Service.
  Alle Einstiege verweigern gesperrte Definitionen und Systemcontainer.
- Ein nach erfolgreichem Abschluss auftretendes `unhealthy` startet keinen
  Update-Rollback und bleibt Gegenstand von #156.
- Der Dialog bietet optionale Sicherung, je Mount einen Schalter, Stopp als
  Standardmodus und Live mit Inkonsistenzwarnung. Eine konsistente
  Datenbanksicherung durch Dateikopie wird ausdrücklich nicht zugesagt.
- Sicherungen sind tar-Archive im per Umgebungsvariable konfigurierbaren
  Agent-Verzeichnis; je Container bleiben die letzten drei vollständigen
  Sicherungen erhalten. Unvollständige Archive verdrängen sie nicht.
- Zu wenig Platz vorab oder ein Sicherungsfehler verhindert den Austausch und
  wird sichtbar gemeldet. Ein Wiederanlauffehler nach Sicherungsabbruch bleibt
  zusätzlich sichtbar.
- Restore erfordert eine eigene Bestätigung und einen gestoppten Container;
  das Archiv bleibt innerhalb bestätigter Mount-Ziele. Image-Rollback stellt
  keine Nutzerdaten zurück.
