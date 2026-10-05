# Begrenzte Selbstheilung

Unerwartete Crashes und Stops werden mit begrenzten erlaubten Aktionen behandelt. Manuelle Stops, Wartung und erfolgreich beendete Einmalaufträge werden unterschieden. Budget und Wartezeiten werden vor Umsetzung festgelegt.

Nach ausgeschöpftem Budget wird ein Vorfall gemeldet und auf Nutzereingabe gewartet. Automatisches Recreate ist ausdrücklich optional, gilt nur für Hub-eigene Projekte und erhält Daten. Docker-Neustartregeln dürfen keinen konkurrierenden endlosen Reparaturablauf erzeugen.

## Manuelle Stopp-Absicht

Der Agent erkennt einen manuellen Stopp an den Docker-Ereignissen: Geht dem `die` eines Containers ein `stop` oder `kill` voraus, war der Stopp gewollt, gleich ob er über den Hub, die Docker-CLI oder die Unraid-Oberfläche kam. Ein `die` ohne diesen Vorlauf ist ein unerwarteter Ausfall. Der Agent speichert die Absicht dauerhaft, bei einem Stopp über den Hub mit dem Akteur, und löscht sie beim nächsten Start des Containers. So übersteht sie Neustarts von Hub und Agent und gilt auch, solange der Tunnel getrennt ist. Würde allein der Hub die Absicht führen, gälten Stopps über andere Wege als Ausfall, und die Selbstheilung hinge an der Verbindung zum Hub.
