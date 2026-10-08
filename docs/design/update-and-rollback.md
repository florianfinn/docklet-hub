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
gesperrt. Damit erhält jedes Ziel eine verlässliche Grundlage für Austausch
und Rückweg, ohne fremde Definitionen zu übernehmen.

Ein Update wird ausdrücklich angefordert und immer vorab mit Vorschau bestätigt.
Die Vorschau nennt Ziel, betroffene Services, bisherige und angebotene Digests,
den Rückweg und die gewählte Sicherung. Das Update zieht dieselbe Image-Referenz
aus der geltenden Definition neu und ersetzt einen Container nur, wenn der
Digest vom bisherigen Image abweicht. Bei gleichem Digest endet der Auftrag ohne
Austausch. Das vor dem Austausch gezogene Image muss dem bestätigten Ziel
entsprechen; eine Abweichung verlangt eine neue Vorschau und Bestätigung.
Ein Tag- oder Versionswechsel erfolgt ausschließlich über eine Änderung der
Definition. Eine Versionsauswahl gehört nicht zum Update; sie ist Gegenstand von
#70. So bleibt die Definition die Quelle der Wahrheit, und ein Update wechselt
nicht unbemerkt auf eine andere Versionslinie.

Vor dem Austausch hält der Agent die vorherige Definition, den vorherigen
Laufzustand und das tatsächlich verwendete Image als unveränderliche Image-ID
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

Einmalaufträge im Sinne von [container-lifecycle.md](container-lifecycle.md)
bestehen dagegen mit Exit-Code 0 als erledigt; für sie ist ein solcher Exit
kein Update-Fehler. Ein anderer Exit-Code scheitert. Die Unterscheidung zwischen
Dienst und Einmalauftrag gilt auch bei der Stack-Prüfung und beim Rückweg.

Scheitert der Austausch oder die Ergebnisprüfung, setzt der Agent automatisch
auf das festgehaltene vorherige Image und die vorherige Definition zurück und
stellt den vorherigen Laufzustand wieder her. Der Rückweg wird ebenfalls anhand
des tatsächlichen Images und der jeweiligen Erfolgskriterien geprüft: gestoppte
Ziele ohne Laufprüfung, laufende Dienste mit Health- beziehungsweise
Stabilitätsprüfung, Einmalaufträge mit Exit-Code 0 als erledigt. Ein erfolgreicher
Rückweg macht das Update nicht erfolgreich: Das Ergebnis unterscheidet
Update-Fehler, erfolgreichen Rollback und fehlgeschlagenen Rollback. So ist
erkennbar, ob wieder der vorherige Zustand läuft oder Betreiberhandeln nötig ist.

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
unverändertem Digest werden nicht unnötig ersetzt. Der Stack ist erst
erfolgreich, wenn alle aktualisierten Services ihre jeweiligen Erfolgskriterien
bestehen. Damit bleibt ein Fehler nicht als unbeabsichtigte Mischung alter und
neuer Images stehen, und abhängige Services werden geordnet zurückgesetzt.

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
Aktionen und Selbstheilung den Rückweg nicht überholen. Auch Restore hält die
entsprechende Sperre bis zur Wiederherstellung des vorherigen Laufzustands.

Während eines Update- oder Restore-Laufs gelten Stopp, Entfernen und Tod des
Ersatzcontainers für die [Selbstheilung](self-healing.md) als beabsichtigt.
Sie verbrauchen kein Selbstheilungsbudget, merken keine Heilung vor und erzeugen
keinen Selbstheilungsvorfall. Fehler meldet allein der zuständige Update- oder
Restore-Lauf; die Eskalation eines fehlgeschlagenen Rückwegs bleibt seine Aufgabe.
Damit führt derselbe Fehler nicht zu zwei konkurrierenden Reparaturabläufen.

Ein Betreiber kann bis unmittelbar vor dem Austausch ausdrücklich abbrechen.
Ein bereits für die Sicherung gestoppter Container erhält dabei seinen vorherigen
Laufzustand zurück; scheitert das, wird der Fehler sichtbar gemeldet. Sobald der
Austausch beginnt, läuft die Prüfung samt gegebenenfalls nötigem Rückweg zu Ende.
Eine getrennte Browserverbindung ist kein Abbruchauftrag. Diese Grenze verhindert
einen absichtlich zurückgelassenen, unbewerteten Ersatzcontainer.

Der Update-Lauf ist ein Auftrag im Agenten mit abfragbarem beziehungsweise
gestreamtem Fortschritt. Er kann länger als eine HTTP-Anfrage dauern; ein
Verbindungsabbruch beendet ihn in keiner Phase. Nach erneutem Verbinden kann der
Hub Fortschritt und Ergebnis wieder abfragen. Die Auftragsdauer erhält eigene
Fristen je Phase: Ziehen, Sicherung, Austausch mit Prüfung und Rückweg. Sie werden
in `contract/` gemeinsam geführt und übernehmen nicht die Restart-Fristen aus
`runtime-deadlines.ts`. Ihre Werte legt der Vertragsschritt fest; Austausch und
Rückweg müssen die übertragene Startfrist beziehungsweise das Stabilitätsfenster
berücksichtigen. Eine abgelaufene Phase wird als Fehler behandelt und durchläuft
den jeweils erforderlichen sicheren Abschluss, statt still weiterzumachen.
So begrenzt der Vertrag einzelne Arbeiten, ohne HTTP-Fristen mit der fachlichen
Prüfung zu verwechseln.

Der Fortschritt nennt Ziel und beim Stack den Service sowie die Phasen
„prüfen“ (Vorbedingungen), „sichern“ (falls gewählt), „ziehen“, „austauschen“,
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

## Optionale Datensicherung

Im Update-Dialog wird eine Datensicherung bewusst gewählt; sie ist optional.
Für jeden zulässigen Bind-Mount und jedes zulässige benannte Volume gibt es einen
eigenen Schalter. Die Auswahl nennt Quelle, Zuordnung zum Container und Umfang.
Sie gilt beim Stack je betroffenem Container und ist vor Beginn der Kopie
festgelegt. Dadurch werden große oder anderweitig gesicherte Daten nicht
ungefragt mitkopiert.

Sicherung und Restore verwenden dieselbe Quellenklassifikation wie der
[Dateizugriff](file-access.md). Docker-Socket, Host-Systempfade, Agent-
Betriebsverzeichnisse und das Sicherungsverzeichnis selbst sind nie auswählbar.
Das gilt auch für Volumes mit solchen tatsächlichen Quellen, für Pfad-Aliasse
und für geschützte Unterpfade innerhalb einer ausgewählten Quelle.
Geteilte Quellen sind für Sicherung mit sichtbarem Hinweis auf weitere Schreiber
wählbar, für Restore gesperrt. Die Quellenauswahl allein erzwingt diese Grenzen nicht:
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

Der Agent legt die Sicherung als tar in seinem Sicherungsverzeichnis ab. Das
Verzeichnis ist per Umgebungsvariable einstellbar; der konkrete technische
Schlüssel wird bei der Umsetzung in der generischen `.env.example` dokumentiert.
Archive sind nur für den Agenten lesbar (Rechte `0600`), das Verzeichnis hat
Rechte `0700`. Das Sicherungsverzeichnis ist über den Dateibrowser nicht
erreichbar. Damit wird eine Sicherung nicht zur ungeprüften zweiten Quelle
sensibler Dateiinhalte.

Je Container werden die letzten drei erfolgreich abgeschlossenen Sicherungen
aufbewahrt. Ältere Sicherungen werden erst nach erfolgreichem Abschluss einer
neuen entfernt. Unvollständige Archive gelten nicht als Sicherung und verdrängen
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
Container, Sicherung und die ausgewählten zulässigen Mount-Ziele sowie die
betroffenen vorhandenen Daten. Der Agent stoppt den Container selbst; erst nach
bestätigtem Stopp wird entpackt. Nach Ende des Restore-Laufs stellt er den
vorherigen Laufzustand wieder her: Ein vorher laufender Container wird
gestartet, ein vorher gestoppter bleibt gestoppt.
Ein Stopp- oder Wiederanlauffehler wird sichtbar gemeldet. Diese Bestätigung
ist nötig, weil Wiederherstellen Nutzerdaten überschreibt und unabhängig vom
Erfolg eines Image-Rollbacks ist.

Die Quellenklassifikation aus [file-access.md](file-access.md) und dieselben
Verwaltungsgrenzen wie beim Update gelten bei jedem Restore-Einstieg.
Geteilte Quellen, Docker-Socket, Host-Systempfade, Agent-Betriebsverzeichnisse
und das Sicherungsverzeichnis sind als Restore-Ziele gesperrt. Agentenseitige
Pfad-, Symlink- und Rechteprüfungen gelten auch beim Entpacken; ein Archiv darf
keine Daten außerhalb seiner bestätigten Ziele verändern. Der gestoppte
Container allein ist keine Berechtigung zum Schreiben.

Das Restore-Ergebnis nennt Erfolg oder Fehler und den tatsächlichen
Containerzustand. Ein fehlgeschlagener Restore ist keine erfolgreiche
Wiederherstellung und löst keinen stillen Image-Wechsel aus. Fehler bei der
Wiederherstellung und beim Wiederanlauf bleiben getrennt erkennbar.
Dateikopien versprechen auch beim Restore keine Datenbankkonsistenz.

## Umsetzungskriterien

- Ziele sind Hub-verwaltete Compose-Services und Einzelcontainer mit aus Inspect
  übernommener Erzeugungskonfiguration. Fremdverwaltete Ziele bleiben gesperrt.
- Jedes Update verlangt vorab Vorschau und Bestätigung von Ziel, Services,
  betroffenen Digests, Rückweg und gewählter Sicherung. Es zieht dieselbe
  Image-Referenz; gleicher Digest führt zu keinem Austausch. Ein abweichender
  Zieldigest verlangt neue Bestätigung. Versionswechsel sind Definitionsänderungen.
- Vor dem Austausch sind vorheriges Image als Image-ID oder Digest, vorherige
  Definition und Laufzustand als verwendbare Rückweggrundlage festgehalten.
- Ein ursprünglich gestopptes Ziel wird mit dem neuen Image und der übernommenen
  Definition erzeugt und bleibt gestoppt; es erhält keine Laufprüfung.
- Für laufende Dienste mit wirksamem Healthcheck gelten 120 Sekunden als Standard,
  erlaubt 10–1.800 Sekunden als Hub-Einstellung je Container, mit dem Auftrag
  übertragen. Der Agent prüft den Healthcheck am neuen Inspect; `disable`/`NONE`
  zählt als ohne Healthcheck. Dockers `start_period` verlängert die Frist nicht.
- Ein laufender Dienst mit Healthcheck muss innerhalb der Startfrist `healthy`
  werden und laufen. Ohne Healthcheck muss er 30 Sekunden ohne Neustart und Exit
  laufen. Ein Neustart im Stabilitätsfenster beendet die Prüfung als Fehlschlag;
  auch Exit-Code 0 scheitert bei Diensten. Einmalaufträge bestehen mit Exit 0.
- Ein Fehler löst den geprüften Rückweg auf vorheriges Image, Definition und
  Laufzustand aus. Gestoppte Ziele und Einmalaufträge behalten ihre besonderen
  Erfolgskriterien; Update-Fehler und Rollback-Ergebnis werden getrennt gemeldet.
- Stack-Services werden nacheinander in Compose-Abhängigkeitsreihenfolge geprüft.
  Beim ersten Fehler endet die Vorwärtsfolge; alle ausgetauschten Services werden
  in umgekehrter Reihenfolge zurückgesetzt. Rückwegfehler verhindern die Prüfung
  der übrigen nicht und erzeugen einen sichtbaren Vorfall samt Meldeversuch über
  konfigurierte Kanäle, ohne Geheimnisse weiterzureichen.
- Ein konkurrierender Auftrag am selben Container oder Projekt mutiert während
  Update oder Restore nicht. Nach dem Warten wird sein erwarteter Zustand geprüft.
- Stopp, Entfernen und Tod des Ersatzcontainers während Update oder Restore sind
  für die Selbstheilung beabsichtigt: kein Budgetverbrauch, keine vorgemerkte
  Heilung, kein Selbstheilungsvorfall. Fehler meldet allein der zuständige Lauf.
- Ausdrücklicher Abbruch vor dem Austausch verhindert ihn; nach Austauschbeginn
  werden Prüfung und nötiger Rückweg abgeschlossen. Ein nur für die Sicherung
  gestopptes Ziel erhält seinen vorherigen Laufzustand zurück oder einen sichtbaren
  Wiederanlauffehler.
- Der Update-Auftrag läuft im Agenten mit abfragbarem/gestreamtem Fortschritt;
  Verbindungsabbruch beendet ihn nicht. Eigene Fristen für Ziehen, Sicherung,
  Austausch mit Prüfung und Rückweg stehen gemeinsam in `contract/`, mit Werten
  aus dem Vertragsschritt und unabhängig von Restart-Fristen. Fortschritt enthält
  die festgelegten Phasen und beim Stack den Service.
- Update, Sicherung und Restore erzwingen an allen Einstiegen Allowlist,
  Nur-Lese-Modus, Selbstverwaltungssperre, Systemcontainer- und Fremdverwaltungsschutz.
- Ein nach erfolgreichem Abschluss auftretendes `unhealthy` startet keinen
  Update-Rollback und bleibt Gegenstand von #156.
- Die Mount-Auswahl für Sicherung und Restore folgt der Quellenklassifikation
  des Dateibrowsers. Docker-Socket, Host-Systempfade, Agent-Betriebsverzeichnisse
  und Sicherungsverzeichnis sind nie auswählbar, auch nicht über Aliasse,
  Volumes oder geschützte Unterpfade. Geteilte Quellen sind nur für Sicherung
  mit Hinweis wählbar.
- Der Dialog bietet optionale Sicherung, je zulässigem Mount einen Schalter,
  Stopp als Standardmodus und Live mit Inkonsistenzwarnung. Eine konsistente
  Datenbanksicherung durch Dateikopie wird ausdrücklich nicht zugesagt.
- Sicherungen sind tar-Archive mit Rechten `0600` im per Umgebungsvariable
  konfigurierbaren Agent-Verzeichnis mit Rechten `0700`. Dieses ist im Dateibrowser
  unerreichbar. Je Container bleiben die letzten drei vollständigen Sicherungen;
  ältere werden erst nach erfolgreichem Abschluss einer neuen entfernt.
- Zu wenig Platz vorab oder ein Sicherungsfehler verhindert den Austausch und
  wird sichtbar gemeldet. Ein Wiederanlauffehler nach Sicherungsabbruch bleibt
  zusätzlich sichtbar.
- Restore verlangt eine eigene Bestätigung und stoppt den Container selbst.
  Entpackt wird erst nach bestätigtem Stopp; danach wird der vorherige Laufzustand
  wiederhergestellt. Das Archiv bleibt innerhalb bestätigter zulässiger Mount-Ziele;
  geteilte Quellen sind gesperrt. Stopp-,
  Wiederherstellungs- und Wiederanlauffehler werden sichtbar gemeldet.
  Image-Rollback stellt keine Nutzerdaten zurück.
