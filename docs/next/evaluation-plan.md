# Evaluation vor der Umsetzung

Die [Entscheidungen](decisions.md) und das [Designkonzept](design-concept.md)
definieren den Umfang. Diese Reihenfolge beschreibt fachliche Abhängigkeiten,
keinen Arbeitsstand. Umsetzungspakete, Meilensteine und Abnahmen werden vor der
jeweiligen Feature-Arbeit in GitHub festgelegt.

| Abschnitt | Zweck und Abhängigkeit | Abnahmekriterium |
| --- | --- | --- |
| Herkunft und Betriebskern | Konkreten Arcane-Übernahmestand, Lizenznachweise, Go-Backend und Agent prüfen | Übernahmekarte nennt Quellen, Grenzen, entfernte Bereiche und Verfahren für selektive spätere Sicherheitskorrekturen |
| Funktionszuschnitt | Bestätigte Übernahmen/Ergänzungen/Streichungen auf UI, API, Jobs und Abhängigkeiten abbilden | Entfernte Funktionen besitzen keine exklusiven Endpunkte, Hintergrundjobs oder Einstellungen; Compose-Builds und Mehrhostbetrieb bleiben berücksichtigt |
| Host- und Dateibetrieb | Direkte Verbindung als Standard, optional Edge, Projektverzeichnis und Rechte prüfen | Onboarding-Konzept enthält Compose-Befehl, Download, Installer, Dateirechte und getrennte Socket-Gruppenerkennung |
| Compose und Containerherkunft | Wizard-Synchronisation, Importmetadaten und Unraid-Abgrenzung evaluieren | Unbekannte Compose-Felder bleiben erhalten; ungültige Eingaben verlieren keine Daten; Herkunftsregeln und manuelle Zuordnung sind beschrieben |
| Designabnahme | Arcane-nahe Ansichten mit den bestätigten Docklet-Abläufen vergleichen | Stackübersicht, Stackseite/Editor, Hostfilter, Chips, Benutzermenü, Deployment-Popups, Sicherheit und Topologie lassen sich konkret beurteilen |
| Modulgrenzen | Proxy, Games, Backups und Widget-Anbindung gegen externe Grundlagen prüfen | Integrationskarte trennt allgemeine Containerverwaltung von modulspezifischen Funktionen und nennt Datenquellen, Lizenzen und Betriebsgrenzen |
| Technische Integration | Produkt-Repo-Aufbau und Migrationsgrenzen auf Basis der vorherigen Entscheidungen wählen | Umsetzungsplan nennt Zielbranch, Verträge, Prüfweg und praktische Abnahmekriterien, ohne Upstream-Kompatibilität vorauszusetzen |

## Gesonderte fachliche Fragen

- Wie zuverlässig lassen sich Unraid-Container erkennen, und welche Hinweise
  rechtfertigen eine automatische oder manuelle Zuordnung?
- Welche Compose-Felder lassen sich im Wizard verlustfrei bearbeiten, welche
  bleiben im Raw-Editor, und welche Metadaten liefern einmalige Imports?
- Welche Benutzerbeschränkungen, insbesondere für Mounts, sind für den kleinen
  Einsatzbereich sinnvoll? Vollzugriff ist keine zugesicherte Grenze für fremde
  Benutzer.
- Wie werden SMB/NFS-Ziele, lokale Mounts und konsistente Volume-/Bind-Mount-
  Sicherungen umgesetzt? S3 und automatische Rückkehr nach Updates entfallen.
- Welche Quellen liefern Status, Auslastung und Verbindungen für die Topologie,
  ohne Netzwerkzuordnung mit gemessener Kommunikation zu verwechseln?
- Welche externen Projekte eignen sich für Traefik/Caddy und Games-Konsole,
  wie werden vorhandene Installationen eingebunden und wo liegen die Modulgrenzen?
- Wie werden Images/Netzwerke/Volumes, Dateizugriffe und der gemeinsame
  Aktions-/Ereignisverlauf in der Navigation und auf Detailseiten angeordnet?

Die Prüfung alter Docklet-Pläne übernimmt keine inzwischen gestrichenen
Verhaltensvorgaben: insbesondere keine automatische Rückkehr nach Updates,
keine WireGuard-Pflicht und keine zusätzliche Heilung unerwartet gestoppter
Container. Die Entscheidungen dieser nächsten Grundlage haben dafür Vorrang.
