# Begrenzte Selbstheilung

Unerwartete Crashes und Stops werden mit begrenzten erlaubten Aktionen behandelt. Manuelle Stops, Wartung und erfolgreich beendete Einmalaufträge werden unterschieden. Budget und Wartezeiten werden vor Umsetzung festgelegt.

Nach ausgeschöpftem Budget wird ein Vorfall gemeldet und auf Nutzereingabe gewartet. Automatisches Recreate ist ausdrücklich optional, gilt nur für Hub-eigene Projekte und erhält Daten. Docker-Neustartregeln dürfen keinen konkurrierenden endlosen Reparaturablauf erzeugen.

## Manuelle Stopp-Absicht

Der Agent erkennt einen manuellen Stopp an den Docker-Ereignissen: Geht dem `die` eines Containers ein `kill` voraus, war der Stopp gewollt, gleich ob er über den Hub, die Docker-CLI oder die Unraid-Oberfläche kam. Auch `docker stop` und `compose stop` senden zuerst ein `kill` mit dem Stoppsignal; das Ereignis `stop` folgt erst nach `die`. Ein `die` ohne vorheriges `kill` ist ein unerwarteter Ausfall. Fährt der Docker-Daemon selbst herunter, etwa beim Neustart des Hosts, stoppt er die Container auf demselben Weg; diese Stopps sind keine Absicht, und der Agent verwirft sie beim nächsten Start des Daemons. Der Agent speichert die Absicht dauerhaft unter Projekt und Service, bei Einzelcontainern unter dem Namen, weil ein Recreate die Container-ID ersetzt. Bei einem Stopp über den Hub hält er den Akteur fest. Der nächste Start des Containers löscht die Absicht. So übersteht sie Neustarts von Hub und Agent und gilt auch, solange der Tunnel getrennt ist. Würde allein der Hub die Absicht führen, gälten Stopps über andere Wege als Ausfall, und die Selbstheilung hinge an der Verbindung zum Hub.
