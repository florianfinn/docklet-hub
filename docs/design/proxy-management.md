# Proxyverwaltung HTTP/S

Traefik und Caddy gehören zur ersten Produktversion. Maßgeblich ist die echte Proxy-Konfiguration. Der Hub erhält keine unabhängig gepflegte zweite Routendefinition. Zugriffsdaten und Betriebsmetadaten sind von Routenkonfiguration getrennt.

Vor Umsetzung werden Lesen, Schreibquelle, Vorschau, Rückweg, Zertifikate und Ziele auf anderen Hosts entschieden. Bestehende und Hub-erzeugte Proxys werden berücksichtigt. Unraid-eigene Templates dürfen nicht indirekt verändert werden. TCP/UDP ist eine spätere Erweiterung.
