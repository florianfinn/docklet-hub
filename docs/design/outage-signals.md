# Ausfälle und Wiederherstellung

Der Hub unterscheidet Host-Erreichbarkeit, Agent-Erreichbarkeit und Zustand
einzelner Container. Ein nicht erreichbarer Host erzeugt einen gemeinsamen
Vorfall, keine unabhängige Meldungsflut für jeden seiner Container.

Container-Ereignisse zeigen unerwartete Stops, Crashes und Neustarts.
Ein erfolgreich beendeter Einmalauftrag ist kein Crash. Manuelle Stops
und Wartung sind Absichten, die Selbstheilung respektiert.

Ein Container mit gemeinsamem Netzwerk-Namensraum kann einen veralteten
Namensraum behalten, nachdem sein Gateway neu erzeugt wurde. Der Hub
prüft tatsächlichen NetworkMode und Sandbox-Bezug des Agenten statt nur
einer Namensheuristik. Das Signal bleibt von einer erlaubten Reparatur
getrennt: Unraid-Besitzgrenzen gelten auch bei Wiederherstellung.

Wiederholungen brauchen Budget, zunehmende Wartezeit und eindeutigen Stop.
Nach ausgeschöpftem Budget wird benachrichtigt und auf Nutzereingabe
gewartet. Optionale automatische Recreate-Abläufe gelten nur für Hub-eigene
Projekte, verwenden die festgelegte Definition und erhalten Nutzerdaten.
