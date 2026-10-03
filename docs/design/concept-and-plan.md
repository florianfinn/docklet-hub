# Zielbild von docklet hub

docklet hub verwaltet Docker-Projekte über lokale, interne und externe
Agenten. Kein bestimmter privater Rechner ist Teil der Produktanforderungen.
Hub und Web sehen keinen Docker-Socket; der Agent vermittelt die Engine.
Das gemeinsame Protokoll liegt in contract/.

Die erste öffentliche Produktversion umfasst Logs, Shell, Compose- und
Dateibearbeitung, Laufzeitaktionen, Updates, Rollback, Metriken, Live-Stand,
Speicherübersicht, Aufräumen, Volume-/Netzlisten und Stack-Abhängigkeiten.
Eine neue Installation entsteht ohne alte Betriebsdaten. Arbeit und Abnahme
werden ausschließlich in GitHub Issues und Meilensteinen dokumentiert.

Hub-eigene Projekte erhalten je ein Verzeichnis und eine Compose-Datei
unter dem Setup-Basispfad. Mehrere Services teilen ein Projekt. Bind-Mounts
liegen primär dort; externe Mounts und benannte Volumes werden unterstützt.
Entfernen erhält Nutzerdaten standardmäßig.

Unraid behält Containerdefinitionen, Templates, Updates, Recreate und
Entfernen. Der Hub darf erlaubte Start-/Stop-/Neustart-Aktionen, Logs,
Shell, Anwendungsdateien, Metriken und Games-Befehle anbieten. Alle
Schreibwege müssen dieselbe Grenze durchsetzen.

Updates werden angefordert, ihr Ergebnis geprüft und beim Fehlschlag Image
und Definition zurückgerollt. Nutzerdatensicherung wird optional angeboten;
Wiederherstellung ist eine eigene ausdrückliche Aktion. Selbstheilung ist
begrenzt, respektiert manuelle Stops und Wartung und wartet nach Eskalation
auf Nutzereingabe. Automatisches Recreate ist optional und auf Hub-eigene
Projekte beschränkt.

Discord, SMTP-E-Mail, Gotify und Webhook sind die ersten Meldekanäle.
Anmeldung unterstützt einen aktiven Modus: ohne Login, lokal oder Proxy.
Ein Admin wird eingerichtet, weitere Admins sind optional; zusätzliche
User-Rollen sind kein Ziel der ersten Produktversion.

Traefik und Caddy gehören für HTTP/S zur ersten Version. Maßgeblich ist
die tatsächliche Proxy-Konfiguration, keine unabhängige Routenkopie im Hub.
Minecraft Java mit itzg/minecraft-server nutzt eine Attach-Konsole;
unterstütztes RCON nutzt dieselbe Oberfläche. Weitere Spieladapter,
TCP/UDP-Proxys, alternative Tunnel und KI-Logauswertung sind spätere Ziele.

Hub und Agent werden primär in derselben Version ausgeliefert. Der Hub
trägt eine Mindest-Agent-Version; erforderliche Agent-Änderungen erhöhen
sie. Der Watcher führt angeforderte Agent-Updates durch. Ein zu alter Agent
behält einen nutzbaren Update-Weg. Ein Produkt-Release braucht eine
praktische Abnahme des konkreten Installationspakets.
