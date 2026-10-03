# Deploybarer Stack und neue Datenbanken

## 1. Migrationsfolge

Nummerierte SQL-Migrationen sind die Schemaquelle. Der Server wendet sie beim Start vorwärts an. migration-plan.ts prüft Folge und Prüfsummen; migrate.ts führt sie unter PostgreSQL-Advisory-Lock aus. Der Lock verhindert konkurrierende Schemaänderungen. Ein leeres Migrationsverzeichnis ist ein Auslieferungsfehler.

Die öffentliche Grundlinie unterstützt nur neue Installationen. Alte Datenbanken und Registrierungen werden nicht importiert. Ab dieser Grundlinie bleiben ausgelieferte Migrationen unverändert; Korrekturen erfolgen durch zusätzliche Migrationen. Die Schema- und Planprüfungen brauchen keinen laufenden Datenbankdienst. Das echte Startverhalten gehört zur praktischen Release-Abnahme.

## 2. Setup und Geheimnisse

scripts/bootstrap.sh erzeugt lokale Geheimnisse, liest die Docker-Socket-GID und ergänzt vorhandene Werte, ohne sie zu ersetzen. Compose benötigt die GID vor dem Containerstart. Laufzeitwerte bleiben in .env; Beispiele liefern Platzhalter. WireGuard-Schlüssel entstehen für spätere Hostanbindungen. Das Setup soll keine Kenntnis einer bestimmten privaten Infrastruktur verlangen.

## 3. Dienste und Images

Hub, PostgreSQL, Agent und Tunnelkomponente haben eigene Aufgaben. Nur der Agent sieht den Docker-Socket. Datenbank und Agent benötigen keinen öffentlich zugänglichen Port. Der Hub bindet standardmäßig lokal; externe Erreichbarkeit wird bewusst eingerichtet.

Images sind gepinnt und über Umgebungsvariablen austauschbar. Hub und Agent werden aus demselben Quellbaum gebaut. Der lokale Bau ergänzt veröffentlichte Images. Ein frischer Quellstart zieht PostgreSQL, baut die eigenen Images und startet anschließend die Compose-Dienste. Registry-Auslieferung und praktischer Pakettest sind eigene Release-Kriterien.
