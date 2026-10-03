# Projektpfade und Container-Lebenszyklus

Ein Hub-eigenes Compose-Projekt besitzt ein Verzeichnis mit eigener Compose-Datei unter dem eingerichteten Basispfad. Services teilen dieses Projekt. Bind-Mounts liegen primär im Projekt; externe Mounts und Volumes bleiben möglich. Entfernen erhält Daten standardmäßig.

Unraid verwaltet Templates und Definitionen. Erlaubte Laufzeitaktionen ändern keine Definition. Update, Recreate und Entfernen gehören dort Unraid. Diese Grenze gilt auch für rohe Compose-Schreibwege und Selbstheilung.

Der Agent ordnet den Verwalter über das Label `net.unraid.docker.managed` und dessen Umfeld zu. `dockerman` ohne Compose-Labels bedeutet native Unraid-Verwaltung, `composeman` mit Compose-Projekt das Compose-Manager-Plugin. Das Label allein ist kein Beweis, weil Docker Image- und Container-Labels zusammenführt. Trägt schon das Image denselben Wert, ist das Image nicht lesbar oder passen Wert und Compose-Labels nicht zusammen, meldet der Agent `unknown`. Jede gemeldete Fremdverwaltung, auch `unknown`, setzt in der Allowlist `externallyManaged` und sperrt damit Pull, Recreate, Apply-Spec, Entfernen und die Compose-Definitionswege; Start, Stopp, Neustart, Logs, Shell, Dateien und Metriken bleiben erlaubt. Die Zuordnung kann nur einschränken: Ein fehlendes Label ist nicht erkennbar und lässt den Container beim Hub.
