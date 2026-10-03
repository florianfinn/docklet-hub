# Arbeitshilfen der Verwaltung

Metriken, Live-Stand, Dateien, Editor, Speicher, Aufräumen, Volumes, Netze
und Abhängigkeiten gehören zum Alltag des Administrators. Daten werden aus
Agent und Engine abgeleitet; Host-Ausfälle werden von Container-Ausfällen
unterschieden. Messwerte tragen Zeitpunkt und Herkunft.

Dateizugriffe umfassen Projektverzeichnis und Mounts eines Containers.
Externe Bind-Mounts und benannte Volumes brauchen dieselben Pfad-, Symlink-
und Besitzprüfungen wie lokale Projektdateien. Geheimniswerte werden nicht
ungefragt angezeigt oder in Logs geschrieben.

Riskante Docker-Einstellungen werden verständlich erklärt und beim Anwenden
ausdrücklich bestätigt. Die Bestätigung ersetzt weder Authentifizierung
noch Unraid-Besitzgrenzen. Aufräumen unterscheidet Images, Build-Cache,
Volumes und Netze; Datenlöschung bekommt eine ausdrückliche Vorschau.

Stack-Abhängigkeiten werden lesend dargestellt. Ein Graph ist keine eigene
Stack-Definition und keine implizite Änderung eines Compose-Entwurfs.
