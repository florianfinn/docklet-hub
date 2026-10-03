# Games-Konsole

Minecraft Java mit itzg/minecraft-server verwendet direkte Docker-Attach-Eingabe und Ausgabe. Unterstützte RCON-Varianten verwenden dieselbe Bedienfläche, etwa für Garry’s Mod. Weitere Spieladapter werden getrennt bewertet.

Die Attach-Konsole benötigt passende stdin-/TTY-Einstellungen. Trennen einer Sitzung darf den Server nicht beenden. Absichtliche Stop-Befehle werden mit Selbstheilung koordiniert. Sitzungen, Reconnect, Befehlsberechtigung und sensible Verbindungswerte werden geprüft.
