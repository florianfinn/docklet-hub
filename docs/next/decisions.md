# Entscheidungen für die nächste Docklet-Grundlage

Produkt- und Designentscheidungen aus der Abstimmung vom 10.10.2026. Sie bilden
zusammen mit [design-concept.md](design-concept.md) das Zielbild einer neuen
Grundlage. Sie beschreiben keine Eigenschaften der bestehenden Installation und
ändern die bisherigen Betriebsverträge unter `docs/design/` nicht. Arbeitsstand,
Umsetzungspakete und Abnahmen gehören in GitHub Issues und Meilensteine.

## Architektur und Herkunft

Arcane wird einmalig als Go-Betriebskern für Backend und Agent übernommen.
Docklet entwickelt diese Grundlage anschließend unabhängig weiter. Spätere
Arcane-Änderungen, etwa Sicherheitskorrekturen, werden bei Bedarf manuell geprüft
und übertragen. Eine dauerhafte Upstream-Kompatibilität ist kein Ziel.

Die Oberfläche wird auf Angular/ZardUI aufgebaut und orientiert sich eng am
Arcane-Original. Docklets gewünschte Abläufe und die gemeinsame Hostansicht werden
integriert. Ein vollständiger UI-Rewrite ist Teil der gewählten Richtung; ein neuer
Produkt-Repo-Aufbau oder ein Umbau dieses Repos bleibt eine gesonderte Evaluation.

Eine Übernahme erhält Quellpfad, vollständige Quell-SHA, Bezugsdatum, Lizenz und
begründete Abweichungen. Arcane steht im betrachteten Quellstand unter
BSD-3-Clause; die Herkunfts- und Lizenznachweise bleiben bei Codeübernahmen
bestehen. Die konkrete Lizenzierung des abgeleiteten Produkts ist vor Übernahmen
gegen die Apache-2.0-Vorgaben dieses Repos zu prüfen.

Die gestalterische Quellreferenz ist
[getarcaneapp/arcane](https://github.com/getarcaneapp/arcane/tree/095cb778daba1034e2a39961199e712a75d4ba29),
Version 2.15.1, vollständige SHA `095cb778daba1034e2a39961199e712a75d4ba29`,
Bezugsdatum 10.10.2026. Dieser Referenzstand ist keine Festlegung der späteren
Backend-Übernahmeversion.

## Präzisierte visuelle Vorgaben

- Dynamische Ressourcenanzeigen pro Host aus Arcane als Referenz übernehmen;
  mehrere Hosts weiterhin gemeinsam darstellen.
- Sicherheitsansicht: Arcanes Layout, Farben und verständliche Diagramme als
  direkte Referenz verwenden.
- Projekte: Arcanes Tabellenstruktur beibehalten, Stacks jedoch klarer voneinander
  absetzen und leichter lesbar machen, orientiert an Docklets Übersicht.
- Die Anwendungsübersicht zeigt ausschließlich Stacks. Zeilen werden nicht
  ausgeklappt; ein Stack öffnet eine eigene Stackseite nach Arcane-Vorbild.
  Einzelcontainer bleiben über die separate Containerverwaltung erreichbar.
- Der Stack-Editor mit Easy-/Advanced-Modus gehört auf diese Stackseite, zusammen
  mit den weiteren Stackinformationen und dem gemeinsamen Logstream.
- Der Hostfilter sitzt in der Navigation. Standard ist „Alle Hosts“; eine Auswahl
  wirkt gemeinsam auf die hostbezogenen Übersichtsseiten, Listen und Kennzahlen.
  Hub-Einstellungen bleiben unabhängig vom Hostfilter.
- Dienstanzahl und Update-Anzeige einschließlich Hover-Details sind wichtig.
  Vorhandene Stack-Tags/Labels sichtbar als dynamische Chips darstellen;
  bei Stacks ohne Labels keine Platzhalterchips anzeigen. Erstellungsdatum und
  Arbeitsverzeichnis gehören nicht in die normale Übersicht.
- Eine kompakte Easy-Ansicht als Standard und eine ausführlichere Full-/Advanced-
  Ansicht werden im Dummy erprobt; die genaue Aufteilung wird im Design evaluiert.
- Mehrfachauswahl standardmäßig ausblenden; ein Aktivierungsbutton oder eine
  Einbindung in die vollständige Ansicht werden erprobt.
- Das Benutzericon unten links öffnet das Menü für Profil und Hub-Einstellungen.
- Den Arcane-Editor mit seinem Arbeitsbereich möglichst unverändert als visuelle
  und funktionale Referenz verwenden. Den synchronisierten Easy-Wizard ergänzen.
- Topologie dynamischer gestalten und Live-Status, Auslastung
  und Verbindungen anzeigen. Zoom, Filter und Detailauswahl unterstützen die Übersicht;
  die technische Live-Anbindung bleibt später zu evaluieren.
  Netzwerkzuordnung und tatsächlich gemessene Kommunikation unterscheiden;
  verfügbare Container-Metriken bedeuten nicht automatisch Traffic pro Verbindung.
  Durchsatzzahlen gehören nicht in die Topologie. Animationen dienen ausschließlich
  der Gestaltung und signalisieren keinen gemessenen Traffic.

## Präzisierte Betriebsabläufe

Die folgenden Vorgaben ergänzen die visuelle Grundlage um Docklets gewünschte
Betriebsabläufe. Die Dokumentation dieser Entscheidungen beauftragt keine
Änderung eines Design-Dummys.

- Stack-/Container-Deployments erhalten eine Ablaufanzeige mit einzelnen Schritten
  nach Docklets geplantem Vorbild. Sie zeigt aktuelle Phase, Fortschritt und Ergebnis
  sowie bei Stacks die betroffenen Services. Mögliche Schritte sind Prüfung,
  Image-Pull/Build, Erstellung/Austausch, Start und Zustandsprüfung; die konkrete
  Schrittfolge richtet sich nach der Aktion und bleibt technisch zu präzisieren.
- Aktionen und Benachrichtigungen erscheinen rechts oben als kompakte Popups mit
  Ablauf-/Fortschrittsanzeige. Das Aktionszentrum bleibt für Details und Verlauf
  bewusst aufrufbar; eine Aktion öffnet nicht automatisch die ganze Seitenleiste.
- In der Stack-Ansicht wird Docklets gemeinsamer Logstream übernommen: Logs der
  zugehörigen Services zusammenführen und die Herkunft pro Service erkennbar halten.
- Die Netzwerktopologie zeigt keine Durchsatzzahlen. Designanimationen sind keine
  Messanzeigen für tatsächlichen Datenverkehr; Status und Verbindungen bleiben
  fachliche Informationen.

Referenzen im laufenden Arcane: Dashboard, Projects, ein geöffnetes Projekt mit
Editor-Arbeitsbereich, Security sowie Networks mit Topologie. Die kompakte
Projektansicht und der Easy-Wizard sind Docklet-Ergänzungen, keine bestehenden
Arcane-Ansichten. Design-Dummys simulieren dynamische Werte und ersetzen keine Live-Anbindung.

## Übernahmen, Ergänzungen und Streichungen

| Bereich | Übernehmen / ergänzen | Entfernen / Grenze |
| --- | --- | --- |
| Stack-Erstellung | Compose als Grundlage; Easy als verschachtelter Wizard für Stack und Services; Advanced als Raw-Editor; jederzeit wechseln, gleicher synchronisierter Entwurf | Keine anfängliche Auswahl zwischen drei Erstellungsmodi; kein Arcane-Vorlagenkatalog |
| Import | Docker-run-Konvertierung und GitHub-/DockerHub-Import im Easy Mode; vorhandene Werte befüllen; fehlende Werte leer oder mit Pflichtfeldhinweis | Einmaliger Import; keine dauerhafte Git-Verbindung und kein Git Sync |
| Compose-Umfang | Formular möglichst vollständig; weitere Einstellungen bleiben im Raw-Editor erhalten | Unbekannte Felder dürfen beim Umschalten nicht verloren gehen; technische Vollständigkeit später evaluieren |
| Einzelcontainer | Arcanes Verwaltung auch ohne Compose, einschließlich Editor/Recreate mit Hinweis | Unraid-Sonderfall eingeschränkt |
| Unraid / unklare Herkunft | Automatische Erkennung; bei Unklarheit eingeschränkt; manuelle Zuordnung pro Container | Unraid: Status, Logs, Shell, Auslastung, Start/Stop/Neustart; kein Editor/Recreate |
| Benutzer / Anmeldung | Kein Login, lokaler Admin-Login oder Reverse-Proxy-Anbindung; optionale zusätzliche Benutzer mit einfachen Zugriffsrechten auf Ressourcen | Keine feingranularen Rechte pro Feature und kein umfangreicher Rollen-Editor; geringe Priorität |
| Einfache Benutzerrechte | Vollzugriff auf zugewiesene Anwendung einschließlich Updates/Compose-Editor oder eingeschränkter Zugriff wie Start/Stop, Logs/Shell | Vollzugriff ist keine zugesicherte sichere Grenze für fremde Benutzer; Mountbeschränkungen später evaluieren |
| Dashboard | Separate Startseite für Kennzahlen, Probleme, Updates, Hoststatus und optionale Anwendungswidgets nach Homepage-Vorbild | Von der Anwendungsübersicht getrennt |
| Widgets | Standard-Dashboard; Widgets auswählen/ausblenden und Reihenfolge ändern; einheitliche Kartengrößen | Kein frei skalierbares Dashboard als erster Umfang |
| Anwendungsübersicht | Ausschließlich Stacks mit sichtbaren Tag-/Label-Chips; eigene Stackseiten nach Arcane-Vorbild | Keine ausklappbaren Stackzeilen und keine Einzelcontainer in dieser Übersicht |
| Stackseite / Editor | Informationen, gemeinsamer Logstream und Stack-Editor mit Easy/Advanced auf derselben Stackseite | Kein losgelöster Stack-Editor als eigenständiger Hauptbereich |
| Hostfilter | In der Navigation; „Alle Hosts“ als Standard; gemeinsame Wirkung auf hostbezogene Übersichten, Listen und Kennzahlen | Kein verpflichtender Hostwechsel; Hub-Einstellungen werden nicht mitgefiltert |
| Profil / Hub-Einstellungen | Über das Benutzericon unten links erreichbar | Konkrete Menügestaltung später präzisieren |
| Deployment-Ablauf | Stack-/Container-Deployments mit einzelnen Schritten, Fortschritt und Ergebnis nach Docklet-Vorbild | Konkrete Schrittfolge je Aktion später präzisieren |
| Stack-Logs | Gemeinsamen Logstream der Stack-Services aus Docklet übernehmen; Service-Herkunft erkennbar | Kein separater Einzelcontainer-Logstream als einziger Zugriff im Stack |
| Swarm | Normale Docker-/Compose-Mehrhost-Verwaltung bleibt | Swarm vollständig aus UI, API und Backend entfernen |
| Images / Netzwerke / Volumes | Vollständig übernehmen, besonders Netzwerktopologie | Hauptnavigation oder gemeinsame Gruppierung im Mockup prüfen |
| Image-Builds | Compose-build innerhalb eines Stacks | Eigenständige Build-Werkstatt und exklusive Funktionen entfernen |
| Updates | Erkennung und manuelle Installation; optionale automatische Updates je Stack/Container mit Zeitplan; standardmäßig nur prüfen | Keine automatische Installation ohne Aktivierung |
| Wiederherstellung nach Update | Fehler anzeigen; vorheriges Image und vorherige Konfiguration für manuelle Wiederherstellung anbieten | Keine automatische Rückkehr; kein Versprechen, Anwendungsdaten zurückzusetzen |
| Backups | Arcane-Volume-/Systembackups, manuell/geplant, Wiederherstellung und Aufbewahrung; Bind-Mounts ergänzen | S3 entfernen |
| Backupziele | Lokale Verzeichnisse, vorhandene Host-Mounts sowie eigene SMB-/NFS-Share-Anbindung | Genaue Rechte-/Mount-Umsetzung später evaluieren |
| Schwachstellenscans | Optional aktivierbar; manuell und geplant; Befunde und optional Dashboard-Widget | Getrennt von Image-Update-Erkennung |
| Benachrichtigungen | Bestehende Arcane-Kanäle übernehmen; nur eingerichtete Ziele anzeigen; Kanal beim Hinzufügen auswählen | Keine ständig sichtbaren Reiter für jeden ungenutzten Kanal |
| Auto Heal | Optional unhealthy-Container begrenzt neu starten, Limits/Ausnahmen behalten | Unerwartete Stopps über Docker-Neustartregeln; zusätzliche Docklet-Selbstheilung entfällt |
| Dateien | Projektdateien, Volume-Dateibrowser und Bind-Mount-Dateien; gemountete Ressourcen aus Stack-/Containereditor erreichbar | Genaue Aufteilung zwischen eigener Volume-Seite und direktem Aufruf im Mockup prüfen |
| Variablen | Normale Stack-.env und Service-Variablen | Zentralen Variableneditor vollständig entfernen; keine .env.global-Ergänzung als Ziel |
| Host-Verbindung | Direkte Verbindung als Standard, Edge zur Auswahl; Edge verbindet sich zum Hub ohne öffentlichen Agent-Port | Von Docklet verwaltete WireGuard-Pflicht entfällt |
| Host-Onboarding | Verständliche Beschreibungen/Felder, Projektverzeichnis sichtbar; Compose-Befehl, Download und kopierbarer Installercommand | Installationsverzeichnis und Projektverzeichnis nicht verwechseln |
| Host-Dateirechte | Installer prüft Verzeichnisrechte und schlägt UID/GID vor; manuelle Vorgabe unter Erweitert, auch für Compose-Download erreichbar | Docker-Socket-Gruppen-ID ist von PUID/PGID für Dateien zu unterscheiden; Socket-Gruppe automatisch erkennen |
| Proxy-Modul | Traefik/Caddy-Zielbild; vorhandene Installation und gebündelte Migration berücksichtigen; HTTP/HTTPS, Routen, Ziele, Middleware, Zertifikate | TCP/UDP später; Projektbasis und genaue Integration offen |
| Games-Modul | Spielkonsole über Docker Attach/RCON plus Status/Spielerzahl; allgemeine Verwaltung liefert Start/Stop, Updates, Dateien, Backups | Umfang spezieller Spielverwaltung später; externe Projekte als mögliche Basis evaluieren |
| Aktivitäten | Popups rechts oben mit Ablauf/Fortschritt; Aktionszentrum mit Details/Ausgaben/Fehlern plus Ereignisverlauf | Kein automatisches Öffnen der ganzen Seitenleiste bei jeder Aktion; gemeinsame Verlaufdarstellung mit Filtern später prüfen |

Zu den Benachrichtigungskanälen gehören E-Mail, Discord, Telegram, Signal, Slack,
ntfy, Pushover, Gotify, Matrix, Google Chat und ein generischer Kanal.

Nicht benötigte Funktionen sollen einschließlich exklusiver Backend-Funktionen,
API-Endpunkte, Jobs, Einstellungen und Abhängigkeiten entfernt werden. Eine
bloße Ausblendung in der Oberfläche erfüllt das Ziel nicht.

## Herkunft der neuen Oberfläche

Docklet liefert die kompakte Bedienung, gemeinsame Mehrhost-Sicht und das einfache
Onboarding. Arcane liefert die gewählten Docker-Verwaltungsabläufe sowie die
geschätzten Dialoge, Icons und Statusanzeigen als funktionale und visuelle Referenz.
Wizard, Import und Bind-Mount-Dateizugriff werden passend ergänzt. Externe
Proxy-/Games-Projekte werden erst nach Evaluation ausgewählt; Inspiration legt
noch keine konkrete Codeübernahme fest.

## Ausdrücklich offene Evaluationen

- Zuverlässige Erkennung und Abgrenzung von Unraid-Containern.
- Technische Vollständigkeit und verlustfreie Synchronisation des Compose-Wizards.
- DockerHub-/GitHub-Import: verfügbare Metadaten, Compose-Fundstellen und fehlende Werte.
- Benutzerbeschränkungen, insbesondere Mounts, und deren Aufwand; niedrige Priorität.
- SMB/NFS-Anbindung und Backup-Konsistenz für Volumes/Bind-Mounts.
- Navigation für Images/Netzwerke/Volumes und Zugriff auf Dateien aus Detailseiten.
- Proxy-/Games-Projektbasis, Einbindung und Platzierung in Navigation oder Tabs.
- Gemeinsame Darstellung von Aktionszentrum und Ereignissen.
- Endgültige visuelle Auswahl anhand der engeren Arcane-Referenz; Aufteilung der
  Projektansichten, Mehrfachauswahl und Dynamik der Topologie.
- Konkreter Aufbau des neuen Produkt-Repos und die spätere technische Umsetzung.

Design-Dummys dienen ausschließlich der gestalterischen Prüfung und verwenden
synthetische Daten und simulierte Aktionen. Sie sind kein Nachweis implementierter
Backend-Funktionen und dürfen keine laufenden Installationen ändern.
