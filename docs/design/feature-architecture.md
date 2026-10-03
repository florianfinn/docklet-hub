# Architektur nach Features

Vier Workspaces trennen shared contract, Server, Web und Agent. Ihre
Abhängigkeiten folgen app → features → domain → platform; jeder darf
das gemeinsame contract importieren. contract importiert keinen Workspace.
Die Importgrenzen werden mit dependency-cruiser geprüft.

app setzt Router, Schale und featureübergreifende Bildschirme zusammen.
features/<name> trägt fachbezogene API-Aufrufe, Dienste, Agent-Clients,
Ansichten und Sprachdateien. domain trägt gemeinsam benötigte Fachlogik
für Hosts und Container. platform trägt HTTP, Auth, Datenbank, Transport,
Stream-Verwaltung und UI-Grundbausteine ohne fachliche Abhängigkeit.

Server und Web importieren ihre HTTP-/Agent-Formen aus contract/src/. Beide
Seiten validieren dasselbe Schema; kein nebenher gepflegter Spiegel.
Agent-Werte sind englisch. CONTRACT_VERSION benennt einen Vertragsbruch;
MIN_AGENT_VERSION benennt die Mindestimplementierung für einen Hub-Release.
Beide Grenzen erfüllen unterschiedliche Aufgaben.

Das Web lädt über TanStack Query. Fachliche Hub-Aufrufe gehören nicht in
useEffect; Query-Invalidierung und gemeinsam abgebrochene Requests halten
Ladezustände und Navigation zusammen. Stream-Sitzungen brauchen gesonderte
Lebenszyklusverwaltung, insbesondere bidirektionale Shell-Verbindungen.

Migrationen werden beim Serverstart vorwärts ausgeführt. Eine ausgelieferte
Datei wird nicht verändert; Dateiname, Reihenfolge und Prüfsumme werden
geprüft. Die öffentliche Grundlage gilt ausschließlich für Neuinstallationen.

Der Hub betreibt keinen Docker-Socket. Der Agent ist ein eigener Prozess
mit eigenständigen Sicherheitsprüfungen. Ein Watcher hat keinen HTTP-Port
und führt explizit angeforderte Agenten-Updates aus. Seine feste
Signaturidentität wird aus vertrauenswürdiger Konfiguration gewählt, nicht
aus den Metadaten eines zu prüfenden Images.
