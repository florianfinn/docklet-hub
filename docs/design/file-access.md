# Dateizugriff und gemeinsamer Editor

Dieser Vertrag legt Dateizugriff (#6) und Textbearbeitung (#7) fest. Er ergänzt
[management-aids.md](management-aids.md) und die
[Schreibzugriffsgrenzen](phase-5-write-access.md). Die
[Verwaltungsgrenzen](container-lifecycle.md) gelten auch für Dateien: Ein
Dateieditor ist kein Umweg zum Ändern fremdverwalteter Definitionen.

## Gezielte Auswahl der Quelle

Der Dateibrowser wählt gezielt eine Quelle: das freigegebene Projektverzeichnis,
einen internen oder externen Bind-Mount oder ein benanntes Volume des ausgewählten
Containers. Die Auswahl zeigt die Quelle, das Mount-Ziel im Container und die
wirksame Schreibfähigkeit samt Sperrgrund. Interne Bind-Quellen werden relativ
zum Projekt angezeigt; externe Quellen und Volumes erhalten eine eindeutige
Zuordnung. So ist vor einem Schreibvorgang erkennbar, welche Daten er betrifft.
Diese Betriebsangaben gehören in die autorisierte Ansicht, nicht in öffentliche
Fehlerbelege oder ungefragte Diagnoseausgaben.

Die Auswahl folgt der normalisierten Definition und dem tatsächlichen Mount.
Die Einteilung `project`, `external` und `volume` aus
[agent/src/mount-sources.ts](../../agent/src/mount-sources.ts) wird wiederverwendet.
Ein Volume mit einem Host-Pfad in seinen Treiberoptionen wird zusätzlich anhand
seiner tatsächlichen Quelle geprüft; die Bezeichnung „Volume“ macht einen
Systempfad nicht harmlos. Auch weitere Nutzer derselben Quelle werden für die
Schreibentscheidung berücksichtigt. Eine externe Volume-Deklaration ist ein
Hinweis auf geteilte Nutzung, aber kein vollständiger Nachweis aller Nutzer.

Geteilte Mounts sind nur lesend. System-Mounts werden ausgeblendet oder nur
lesend angeboten, soweit schon das Lesen zulässig ist. Dazu gehören der
Docker-Socket, Host-Systempfade wie `/etc`, `/proc`, `/sys`, `/dev` und die eigenen
Betriebsverzeichnisse des Agenten. Socket- und Gerätedateien sind keine
bearbeitbaren Textdateien. Ist die Quelle oder ihr Schutzbedarf nicht sicher
zuordenbar, wird kein Schreibzugriff freigegeben. Damit gefährdet die
Bearbeitung weder andere Container noch den Host oder den Agenten selbst.

Eine im Container schreibbare Quelle ist nicht automatisch im Hub schreibbar:
Mount-Modus, Dateirechte, Allowlist, Nur-Lese-Modus, Selbstverwaltungssperre und
Quellenschutz können weiter einschränken. Der Browser zeigt die daraus abgeleitete
Fähigkeit; der Agent prüft sie bei jeder Anfrage erneut. Eine ausgeblendete
Schaltfläche allein ist keine Zugriffssperre.

## Pfade, Rechte und Dateiaktionen

Die vorhandenen CRUD-Wege für Auflisten, Lesen, Anlegen beziehungsweise Hochladen,
Umbenennen, Entfernen und Schreiben werden für die ausgewählte Quelle
wiederverwendet. Es entsteht kein zweiter Satz von Dateiaktionen für externe
Mounts oder Volumes. Die Agent-Prüfungen aus
[agent/src/routes/file-routes.ts](../../agent/src/routes/file-routes.ts) und
[agent/src/webftp.ts](../../agent/src/webftp.ts) bleiben die gemeinsame Grundlage.
Damit müssen dieselben Sicherheitsregeln nicht für jede Quellart neu gepflegt
werden.

Der Agent erzwingt die Grenze der ausgewählten Quelle: keine absoluten
Benutzerpfade, kein Traversal, keine Flucht über Symlinks und keine Verwendung
einer zwischen Prüfung und Zugriff ausgetauschten Datei außerhalb dieser Grenze.
Symlinks können als solche angezeigt werden, ohne das Ziel ungeprüft zu lesen.
Dateirechte und Besitz werden beim Schreiben beachtet; ein Upload darf sie nicht
zum Vorteil des Agenten oder eines anderen Containers verändern. Konflikte mit
bestehenden Zielen werden sichtbar behandelt, statt Inhalte still zu ersetzen.
Diese Grenzen gelten auch für Downloads, Vorschauen und direkt aufgerufene
Routen, nicht nur für den Editor.

Compose-Definitionen und `.env` erhalten ihre geschützten Bearbeitungswege. Die
Sperre dieser Namen im allgemeinen Web-FTP wird nicht pauschal aufgehoben.
Compose-Schreiben bleibt an Vorschau, Validierung und Verwaltungsgrenzen
gebunden; sensible Konfiguration wird nur über einen Weg mit Maskierung und
gezielter Freigabe zugänglich. So kann eine gewöhnliche Dateiaktion weder die
Definitionsprüfung noch den Geheimnisschutz umgehen.

## Genau ein Editor-Baustein

Compose-Editor und Datei-Editor verwenden genau einen gemeinsamen Editor-Kern
in der Plattformschicht. Er umfasst Textfläche, Zeilenanzeige,
Tastaturbedienung und Einrücken sowie austauschbare Hervorhebung für YAML,
`.env` und Klartext. Die vorhandene Textfläche über einem eingefärbten `pre`
aus [ComposeEditor.tsx](../../web/src/features/compose/ComposeEditor.tsx) und
Einrückungslogik dienen als Grundlage; Laden, Speichern und Hash-Konflikte des
[FileEditor.tsx](../../web/src/features/files/FileEditor.tsx) gehen in die
von beiden Features verwendete gemeinsame Hülle ein.

Diese Hülle verantwortet Laden, Speichern mit Inhaltshash-Konflikt,
Entwurfsschutz bei Navigation und Maskierung sensibler Werte. Die Features
binden ihre jeweiligen Lese- und Schreibverträge an dieselbe Hülle an;
Compose-spezifische Vorschau und Validierung bleiben beim Compose-Feature.
Die vorhandene Compose-Vorschau wird wiederverwendet. Eine gewöhnliche Datei
löst dadurch keine Compose-Anwendung aus. Gemeinsame Bedienung und Schutzregeln
verhindern, dass zwei Editoren bei Konflikten oder Geheimnissen auseinanderlaufen.

Es wird keine neue Editor-Abhängigkeit wie CodeMirror oder Monaco eingeführt,
solange der vorhandene Ansatz innerhalb der Größengrenze bedienbar bleibt.
Die begrenzte Textmenge und vorhandene Einrückungs- und Hervorhebungslogik tragen
den vorgesehenen Konfigurationseditor. Zusätzliche Bibliotheken würden
Ladeumfang und Wartung erhöhen; ein Wechsel bräuchte einen belegten Bedarf.
Die Bedienbarkeit an der Grenze wird mit dem gemeinsamen Kern geprüft.

## Textgrenze und Inhaltshash

Bearbeitbar sind reguläre Textdateien bis einschließlich 1 MiB
(1.048.576 UTF-8-Bytes), die verlustfrei als UTF-8 gelesen und geschrieben werden
können und keine Nullbytes enthalten. Die Grenze gilt beim Laden und Speichern,
nicht nur für die Anzahl sichtbarer Zeichen. Dateiendungen wählen die
Hervorhebung, sind aber kein Beleg für Text. Dies entspricht der Grenze
`MAX_TEXT_BYTES` in [contract/src/agent/limits.ts](../../contract/src/agent/limits.ts)
und der Inhaltsprüfung in `readTextFile`. So werden Binärdaten nicht durch eine
Textkonvertierung zerstört, und große Logs belasten nicht den Editor.

Beim Laden erhält die Hülle den Inhaltshash der tatsächlichen Datei. Speichern
verlangt diesen erwarteten Hash; der Agent vergleicht ihn mit der aktuellen
Fassung im geschützten Schreibablauf. Eine zwischenzeitliche Änderung erzeugt
einen Versionskonflikt und lässt den Entwurf unverändert. Die Hülle bietet
erneutes Laden mit Schutz des Entwurfs oder eine bewusste Konfliktauflösung.
Auch danach wird gegen den Hash der neu gelesenen Fassung gespeichert;
ein weiterer externer Schreibvorgang muss erneut als Konflikt erscheinen.
Ein Speichern ohne erwarteten Hash ist kein Ausweg. Damit wird eine andere
Bearbeitung nicht unbemerkt überschrieben.

## Entwürfe und sensible Werte

Ungespeicherte Entwürfe bleiben bei Navigation erhalten oder werden nur nach
ausdrücklicher Entscheidung verworfen. Sie sind an Host, Container, Quelle
und Datei gebunden und dürfen nicht versehentlich bei einem anderen Ziel
erscheinen. Ein Ladefehler, Konflikt oder automatisches Nachladen ersetzt keinen
bearbeiteten Entwurf. Eine dauerhafte Speicherung sensibler Entwürfe im
Browser ist nicht Voraussetzung dieses Schutzes; ungeschützte Browserablagen
werden dafür nicht verwendet.

Sensible Werte, etwa Werte zu Schlüsseln mit `PASSWORD`, `SECRET`, `TOKEN` oder
`KEY` in `.env`, werden standardmäßig maskiert. Die Erkennung berücksichtigt
Groß- und Kleinschreibung; diese Beispiele sind keine Zusage, alle Geheimnisse
allein am Namen erkennen zu können. Der Betreiber gibt einen Wert gezielt zum
Anzeigen beziehungsweise Bearbeiten frei. Die normale Ansicht, Hervorhebung
und ungefragte Vorschau dürfen den Klartext nicht neben der Maske offenlegen.
Maskierung wird deshalb vor der gewöhnlichen Inhaltsanzeige wirksam; eine bloße
optische Überdeckung von ansonsten sichtbarem Klartext reicht nicht.

Unveränderte maskierte Werte bleiben beim Speichern erhalten. Platzhalter
dürfen weder Geheimnisse ersetzen noch als neue Werte in die Datei gelangen;
der Hash bezieht sich auf die tatsächliche Fassung, nicht auf die maskierte
Ansicht. Das schützt zugleich gegen unbeabsichtigten Datenverlust und gegen
Konflikte, die nur durch die Darstellung verborgen werden.

Dateiinhalte, Geheimnisse und freigegebene Werte gelangen nicht in Logs, Audit,
Fehlerbelege oder Benachrichtigungen. Fehler nennen einen bereinigten Grund,
keinen Inhaltsauszug. Entwürfe und Geheimnisse bleiben auch nach einer gezielten
Freigabe geschützt; diese ist keine Freigabe zum Protokollieren. Die
[Veröffentlichungsregeln](publication-policy.md) gelten für jeden öffentlichen
Beleg einschließlich Screenshots.

## Umsetzungskriterien

- Der Browser bietet die gezielte Auswahl interner und externer Bind-Mounts
  sowie benannter Volumes und zeigt Quelle, Mount-Ziel und wirksame
  Schreibfähigkeit. Projektzugriff bleibt an die Freigabe gebunden.
- Geteilte Quellen sind nur lesend; Systemquellen und Agent-Verzeichnisse sind
  nur lesend oder ausgeblendet. Ein Volume über einen geschützten Host-Pfad
  umgeht diese Grenze nicht. Unklare Zuordnung gibt keinen Schreibzugriff frei.
- Alle Quellarten verwenden dieselben vorhandenen CRUD-Wege. Direkte Anfragen
  erzwingen dieselben Verwaltungs-, Rechte-, Symlink- und Traversalgrenzen;
  ausgetauschte Pfade und Zielkonflikte umgehen sie nicht.
- Allgemeiner Dateizugriff umgeht weder Compose-Prüfung noch den geschützten
  `.env`-Weg. Sensible Inhalte erscheinen nicht ungefragt in Vorschauen,
  Downloads, Diagnoseausgaben oder öffentlichen Fehlerbelegen.
- Compose- und Datei-Feature verwenden denselben Plattformkern und dieselbe
  Hülle für Laden, Hash-Konflikte, Entwurfsschutz und Maskierung. YAML, `.env`
  und Klartext erhalten austauschbare Hervorhebung. Nach der Umsetzung
  existiert kein zweiter Editor-Baustein mehr.
- Compose-Vorschau und Validierung werden wiederverwendet und bleiben beim
  Compose-Feature. Der gemeinsame Editor führt keine neue Editor-Abhängigkeit
  ein, solange der vorhandene Ansatz bis zur Grenze bedienbar bleibt.
- Dateien bis einschließlich 1.048.576 UTF-8-Bytes werden angenommen, größere
  Dateien abgelehnt; ungültiges UTF-8, Nullbytes und nicht reguläre Dateien
  werden nicht als Text bearbeitet. Die Grenzen gelten auch beim Speichern.
- Externe Änderungen erzeugen beim Speichern einen Inhaltshash-Konflikt,
  ohne die Datei oder den Entwurf zu überschreiben. Auch nach einer bewussten
  Auflösung wird eine weitere externe Änderung erkannt.
- Navigation erhält den Entwurf oder verlangt ausdrückliches Verwerfen.
  Zielwechsel, Ladefehler und Nachladen verlieren keinen Entwurf und ordnen
  ihn keiner anderen Datei zu.
- Sensible Werte sind standardmäßig maskiert und gezielt freigebbar, auch in
  der gemeinsamen Hülle des Compose-Editors. Speichern erhält unveränderte
  Geheimnisse ohne Maskenplatzhalter; Logs, Audit und Fehlerbelege bleiben
  auch nach Freigabe frei von Geheimnissen und Dateiinhalt.
