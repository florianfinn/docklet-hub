# Host-Einrichtung und Agentenregistrierung

## 1. Host-Arten

Der Hub kann lokale, interne und externe Agenten verbinden. Das Produkt setzt keine bestimmten Betreiberhosts voraus. Jeder Host führt seine eigene Identität, Verbindung und Fähigkeiten. Benennungen sind Anzeigenamen, keine Sicherheitsentscheidung.

## 2. Einrichtung

Das generische Installationspaket enthält die benötigte Compose-Definition und vom Setup erzeugte Geheimnisse. Die Socket-GID wird auf dem Zielhost ermittelt. Ein konfigurierbarer Basispfad verankert Hub-eigene Projekte. Unraid behält seine Templates und Containerdefinitionen; ein Agent erzwingt die vereinbarten Fähigkeiten unabhängig von der Oberfläche.

## 3. Status und Version

Registrierung und Laufzeitstatus sind getrennt: ein gespeicherter Host kann vorübergehend nicht erreichbar sein. Vertrag und Mindestversion beschreiben, welche Aktionen zulässig sind. Hub und Agent tragen im Release dieselbe Version; Hub-Updates können die erforderliche Mindestversion anheben. Agenten-Updates verwenden den Watcher und bleiben von fremden Containerdefinitionen getrennt.

Das erzeugte Host-Archiv und angebotene Agentenupdates verwenden die vollständige
Release-Version aus dem Wurzelmanifest des Hubs, einschließlich `-rc.N`.
Der Release-Workflow veröffentlicht beide Images unter diesem Tag. Die
Installationsvorlagen tragen einen veröffentlichten Agenten-Tag als Vorgabe;
für eine andere Hub-Version wird dieser über `DOCKER_AGENT_IMAGE` übersteuert.

## 4. Zugriff

Bedienwege wählen den tatsächlichen Agenten aus der vertrauenswürdigen Hostregistrierung. Frei übermittelte URLs dürfen keinen beliebigen Zugriff auf andere Dienste erlauben. Auch registrierte Verbindungen benötigen begrenzte Wartezeiten und verständliche Fehler.

## 5. Tunnel

WireGuard-Anbindung verwendet generische konfigurierbare Produktnetze. Beispiele beschreiben keine Installation. Abbruch, erneute Einrichtung und veraltete Agenten gehören zur Abnahme. Alternative Tunnel werden in einer späteren Ausbaustufe evaluiert.

## 6. Compose-Netz und Erreichbarkeit

Der lokale Agent und die Datenbank bleiben im Compose-Netz. Der Hub erreicht entfernte Agenten über den eingerichteten privaten Verbindungsweg. Eingehende Registrierung ist bewusst von normalen Browserrouten getrennt. Geheimnisse und echte Routen erscheinen weder im öffentlichen Repo noch in öffentlichen Meldungsbelegen.
