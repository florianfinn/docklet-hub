# Gestaltung und Bedienung

Die neue Oberfläche nutzt Angular/ZardUI und orientiert sich eng an Arcane.
Die [Produktentscheidungen](decisions.md) bestimmen den Funktionsumfang.
Arcanes Farben, Typografie, Icons, Dialoge und Zustandsanzeigen liefern die
visuelle Referenz. Docklets kompakte Bedienung und gemeinsame Hostansicht
prägen die gezielten Anpassungen. Freie Neuinterpretationen sind keine Grundlage.

## Navigation und Hostkontext

Der Hostfilter sitzt in der Navigation. „Alle Hosts“ ist der Standard. Eine
Auswahl wirkt auf hostbezogene Übersichten, Listen und deren Kennzahlen,
beispielsweise Dashboard, Anwendungen, Container und Ressourcen. Sie ist kein
verpflichtender Wechsel einer globalen Umgebung. Hub-Einstellungen bleiben
unabhängig vom Filter. Die genaue Auswahlbedienung ist im Design zu prüfen.

Das Benutzericon unten links öffnet Profil und Hub-Einstellungen. Die Platzierung
weiterer Ressourcen, Proxy-/Games-Module und des Aktionszentrums ist gestalterisch
zu evaluieren; damit ist noch keine vollständige Navigationsstruktur festgelegt.

## Dashboard

Das Dashboard ist eine eigene Startseite für Kennzahlen, Probleme, Updates und
Hoststatus. Dynamische Ressourcenanzeigen pro Host folgen Arcane. Ein
Standard-Dashboard bietet auswählbare Widgets mit veränderbarer Reihenfolge und
einheitlichen Kartengrößen. Unterstützte Anwendungswidgets orientieren sich am
[Homepage-Vorbild](https://gethomepage.dev/widgets/). Freie Kartenskalierung ist
kein erster Umfang.

## Anwendungsübersicht und Stackseite

Die Anwendungsübersicht enthält ausschließlich Stacks. Die tabellarische
Arcane-Grundstruktur bleibt erhalten, die Zeilen sollen Stacks klar voneinander
absetzen und ihre Namen leichter lesbar machen. Ein Klick öffnet eine eigene
Stackseite nach Arcane-Vorbild; Stackzeilen werden nicht ausgeklappt.
Einzelcontainer werden separat verwaltet.

Dienstanzahl, Host, Status und Updates sind wesentliche Informationen. Updates
bieten verständliche Hover-Details, auch per Tastaturfokus erreichbar. Vorhandene
Stack-Tags/Labels erscheinen als dynamische Chips. Erstellungsdatum und
Arbeitsverzeichnis entfallen in der normalen Übersicht. Die kompakte Standard-
und eine ausführlichere Ansicht werden verglichen. Mehrfachauswahl ist
zuschaltbar; genaue Anordnung und Zusatzfelder bleiben Gegenstand des Designs.

Die eigene Stackseite bündelt Informationen, Aktionen, den gemeinsamen Logstream
und den Editor. Logs der zugehörigen Services werden zusammengeführt; die
Service-Herkunft bleibt erkennbar. Dateizugriff auf gemountete Volumes und
Bind-Mounts wird aus dem Stack-/Container-Arbeitsbereich erreichbar. Die
Detailaufteilung in Tabs ist zu evaluieren.

## Editor im Stack-Arbeitsbereich

Arcanes Editor-Arbeitsbereich mit Dateibaum und Editorfläche ist die Referenz.
Easy und Advanced bearbeiten denselben synchronisierten Compose-Entwurf direkt
auf der Stackseite. Advanced zeigt den Raw-Editor; Easy ergänzt einen
verschachtelten Wizard für Stack-Grundlagen und einzelne Services.

Es gibt keine anfänglichen drei Erstellungsmodi. Docker-run-Konvertierung und
einmaliger GitHub-/DockerHub-Import sind Aktionen im Easy Mode. Verfügbare Werte
werden übernommen; fehlende Werte bleiben leer oder erhalten einen
Pflichtfeldhinweis. Unbekannte Compose-Felder bleiben erhalten. Ungültiges YAML
darf weder den Rohentwurf verwerfen noch einen verlustbehafteten Wechsel ins
Formular auslösen. Git Sync und Vorlagenkatalog entfallen.

## Deployment, Popups und Verlauf

Stack-/Container-Deployments zeigen einzelne Ablauf-Schritte nach Docklet-Vorbild,
mit aktueller Phase, Fortschritt, Ergebnis und bei Stacks betroffenen Services.
Prüfung, Image-Pull/Build, Erstellung/Austausch, Start und Zustandsprüfung sind
Beispiele; die wirkliche Schrittfolge muss zur jeweiligen Aktion passen.

Aktionen und Benachrichtigungen erscheinen rechts oben als kompakte Popups mit
Ablauf-/Fortschrittsanzeige. Sie öffnen nicht automatisch die ganze Seitenleiste.
Das Aktionszentrum bleibt bewusst für Details, Ausgaben und Fehler aufrufbar.
Aktions- und Ereignisverlauf sollen nach einem Seitenwechsel nachvollziehbar
bleiben; eine gemeinsame Darstellung mit Filtern wird evaluiert.

## Sicherheit und Topologie

Arcanes Sicherheitslayout, Farben und verständliche Diagramme sind die direkte
Referenz. Schwachstellenscans bleiben optional. Scanbefunde werden von verfügbaren
Image-Updates getrennt dargestellt.

Die Topologie zeigt Status, Auslastung und Verbindungen. Durchsatzzahlen entfallen.
Animationen dienen ausschließlich der Gestaltung und signalisieren keinen
gemessenen Traffic. Docker-Netzwerkzuordnung und tatsächliche Kommunikation
müssen fachlich unterscheidbar bleiben. Zoom, Filter und Details unterstützen
die Übersicht; die technische Datenquelle ist gesondert zu evaluieren.

## Vergleich im Arcane-Livesystem

| Ansicht | Prüfpunkte |
| --- | --- |
| Dashboard (`/dashboard`) | Host-Ressourcen und Statusdarstellung |
| Projects (`/projects`) | Tabellenbasis, Dienstanzahl, Update-Hovers und Tags |
| Geöffnetes Projekt | Eigene Projektseite, Dateibaum und Editor-Arbeitsbereich |
| Security (`/security`) | Farben, Risikoanzeige, Verlauf und Befunddarstellung |
| Networks (`/networks`) | Topologie und Detailauswahl |

Der gemeinsame Hostfilter, die vereinfachte Stackübersicht, der Easy-Wizard und
die genannten Betriebsabläufe sind Docklet-Vorgaben. Die Referenzpfade bedeuten
keine Zusage, dass Arcane diese Ergänzungen bereits bietet.

Die Gestaltung wird mit nativen klickbaren Oberflächen, Hover-/Fokuszuständen,
dezenten Übergängen und reduzierbaren Animationen geprüft. Dummys verwenden
synthetische Daten und simulierte Aktionen. Originaltreue wird anhand tatsächlicher
Referenzansichten beurteilt; eine Quellannäherung allein belegt keine Pixelgleichheit.
