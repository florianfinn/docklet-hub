# Schreibzugriff: Herkunft, Compose, Dateien, Logs und Shell

## 1. Herkunftsprüfung

Alle zustandsändernden Browseranfragen prüfen die zulässige Herkunft und den aktiven Anmeldemodus. Zustandsänderungen dürfen nicht über ein scheinbar lesendes GET ausgelöst werden. Agentengeheimnisse sind unabhängig von Browsersitzungen. Ablehnungen geben keine Geheimnisse oder private Headerwerte in öffentliche Logs aus.

## 2. Fähigkeiten und Verwaltung

Das Zielbild steht in container-lifecycle.md. Der Agent erzwingt die Fähigkeiten: Hub-eigene Projekte haben einen Ordner und eine Compose-Definition; Unraid behält Templates, Updates, Recreate und Entfernen. Laufzeitaktionen, Logs, Shell und Games-Befehle folgen der erlaubten Abgrenzung. Rohes Compose darf sie nicht umgehen.

## 3. Vorschau und Anwenden

Änderungen zeigen ihren tatsächlichen Umfang und prüfen die gelesene Dateifassung. Konflikte werden angezeigt statt still überschrieben. Definitionen, Pfade und Nutzerdaten haben getrennte Verantwortlichkeiten. Entfernen eines Projekts bewahrt Daten standardmäßig. Update, Ergebnisprüfung und Rückweg sind in update-and-rollback.md begründet.

## 4. Containerzugriff und Ströme

Logs und Shell gehören zum ausgewählten Host und Container. Fehlercodes sind Teil des gemeinsamen Vertrages. Ein getrennter Browser räumt Sitzungen und Stream-Slots auf. Zeitgrenzen, Stream-Limits und Abbrüche brauchen Tests; praktische Gleichzeitigkeit wird am Release-Kandidaten geprüft. Games-Konsolen teilen Ausgabe und Befehle, behalten aber ihre fachlichen Eingabewege.

## 5. Redaktion und Sicherheitsgrenzen

Texteditoren erhalten ungespeicherte Entwürfe beziehungsweise fragen vor Verlust nach. Sensible Konfigurationswerte werden geschützt angezeigt. Harte Einstellungen werden verständlich erklärt und vor einer riskanten Änderung bewusst bestätigt. Welche Regel ein Container verletzt, entscheidet allein die Härtungsprüfung des Agenten; Regelnamen und Schweregrade stehen in contract/, und die Oberfläche ordnet jedem Befund nur die Erklärung seiner Regel zu. Unbekannte Regeln erscheinen wörtlich und ohne eigene Bewertung. Neue Befunde eines Entwurfs werden einzeln mit Service und Pfad bestätigt; der Agent prüft die Bestätigung weiterhin auf genaue Mengengleichheit. Proxy-Konfiguration wird am tatsächlichen Proxy gelesen und geschrieben, ohne zweite Route-Wahrheit im Hub.

## 6. Dateien und Shell

Dateizugriff umfasst Projektverzeichnis, externe Bind-Mounts und benannte Volumes. Pfadgrenzen, Symlinks und Schreibrechte bleiben agentenseitig abgesichert. Zeitangaben wie changedAt sind einheitliche ISO-Texte. Konflikte, Entfernen und Überschreiben werden getrennt behandelt. Shell-Aufbau und Websocket-Unterbrechung sind unabhängig vom Container-Lifecycle; ein Konsolen-Detach beendet keinen Serverprozess.
