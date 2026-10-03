# Projektpfade und Container-Lebenszyklus

Ein Hub-eigenes Compose-Projekt besitzt ein Verzeichnis mit eigener Compose-Datei unter dem eingerichteten Basispfad. Services teilen dieses Projekt. Bind-Mounts liegen primär im Projekt; externe Mounts und Volumes bleiben möglich. Entfernen erhält Daten standardmäßig.

Unraid verwaltet Templates und Definitionen. Erlaubte Laufzeitaktionen ändern keine Definition. Update, Recreate und Entfernen gehören dort Unraid. Diese Grenze gilt auch für rohe Compose-Schreibwege und Selbstheilung.
