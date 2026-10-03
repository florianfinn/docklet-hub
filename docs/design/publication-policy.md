# Öffentliche Daten und Prüfungen

Alle Dateien, Git-Metadaten, Issues, PR-Texte und Artefakte enthalten nur veröffentlichbare Daten. Reale private Adressen, Hostnamen, Netzpläne und Zugangsdaten werden entfernt; Beispiele sind synthetisch. Keine alte Git-Historie wird übernommen.

Netzwerkparser benötigen absichtlich synthetische private Testbereiche. Die Produkt-Vorgaben 10.253.0.0/24 für Agent-Beispiele und 10.254.0.0/24 für das Hub-Tunnelnetz sind konfigurierbar und keine Beschreibung einer Betreiberinstallation. Tests mit anderen privaten Bereichen dienen der Validierung von Adressklassen; reale Infrastruktur-Freitexte bleiben verboten. Automatische Prüfung vor Push und unabhängiger Review ergänzen sich.

GitHub erzeugt Automationscommits mit dem öffentlichen Absender noreply@github.com und Dependabot-Signoff mit support@github.com. Genau diese zwei öffentlichen Plattformadressen sind für Textprüfungen zugelassen; als Git-Identität gilt zusätzlich nur noreply@github.com. Persönliche Betreiberadressen und beliebige andere Adressen derselben Domain bleiben gesperrt.

KI-Werkzeuge erscheinen nicht als eigene Mitwirkende. GitHub verknüpft Autor-, Committer- und Co-Author-Adressen mit Konten; deshalb bleiben Git-Identitäten menschliche Noreply-Absender, und Co-authored-by-Trailer werden abgelehnt, wenn Name oder Adresse ein KI-Werkzeug bezeichnen, auch mit Noreply-Adresse. Menschen mit gleichem Vornamen, etwa Claude Martin, bleiben zulässig. Mitarbeit wird höchstens als Texthinweis ohne Adresse vermerkt, etwa Assisted-by: Claude Code. Die Git-Identität setzt die jeweilige Umgebung, weil eine versionierte Identität alle Mitwirkenden unter einem Namen committen ließe.

Unter .claude/ ist genau .claude/settings.json versioniert: Sie legt diesen Hinweis fest und setzt beim Sitzungsstart core.hooksPath, damit die Prüfungen auch in Cloud-Sitzungen lokal greifen. Lokale Einstellungen, Notizen und Profile darunter bleiben gesperrt.
