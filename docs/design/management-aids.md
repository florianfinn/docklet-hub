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

## Ressourcenübersicht

Je Host zeigt eine eigene Seite die Speicherbelegung nach Art von
`docker system df` sowie Images, Volumes und Netze mit den Containern, die
sie verwenden. Die Seite liest nur. Der Agent beantwortet
`GET /resources` mit fünf festen Lesezugriffen auf die Engine und kann
keinen anderen Pfad nennen. Die Route ist im Hub nur für Admins erreichbar,
weil sie wie die Host-Erhebung auch Container außerhalb der Allowlist nennt.
Labels gehen nur als Compose-Projekt hinaus, Mountpoints und Treiberoptionen
gar nicht.

Jeder Abschnitt steht auf einem eigenen Engine-Aufruf. Scheitert einer, nennt
sein Abschnitt den Grund, und die übrigen bleiben lesbar. Die Verwendung
stammt aus der Containerliste. Ist sie nicht lesbar, gilt die Verwendung als
unbekannt und erscheint nie als „ungenutzt“, damit niemand ein scheinbar
verwaistes Volume für entbehrlich hält. „Ungenutzt“ heißt nur, dass kein
Container es gerade verwendet; die Seite sagt das bei den Volumes ausdrücklich.

Ob eine Ressource zu Hub oder Agent gehört, entscheidet der Hub mit derselben
Regel wie bei den Systemcontainern: Image-Repository, eigenes Compose-Projekt
oder ein Systemcontainer unter den Verwendern. Docker-eigene Netze (`bridge`,
`host`, `none`) markiert der Agent.

`/system/df` summiert die Volumegrößen auf der Platte. Gleichzeitige Anfragen
teilen sich deshalb im Agenten eine Lesung, und das Web liest nur beim Öffnen
und auf Knopfdruck. Die neue Route hebt den Agentenvertrag auf 10; ein älterer
Agent wird vor der Anfrage mit `409 agent-outdated` abgewiesen.
