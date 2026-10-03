-- Wann ein Arm zuletzt geantwortet hat (#205).
--
-- Die Karte eines Arms zeigt „Zuletzt erreichbar“. Der Zustand selbst bleibt
-- eine Messung und wird weiter NICHT gespeichert (`background/
-- host-observation-store.ts`, Kopf): ein gespeichertes „erreichbar“ behauptete
-- nach einem Neustart eine Wahrheit von gestern. Ein ZEITPUNKT behauptet das
-- nicht — er trägt sein Alter selbst, und die Oberfläche zeigt es mit an.
--
-- Geschrieben wird er vom Hintergrundlauf und von `GET /hosts`, jeweils nur
-- nach einer Sonde, auf die der Agent geantwortet hat.
--
-- NULLABLE und ohne Vorgabe: ein Arm, der seit dieser Migration noch nie
-- geantwortet hat, hat keinen Zeitpunkt, und `now()` als Vorgabe behauptete
-- für jeden bestehenden Arm eine Antwort, die es nicht gab.

ALTER TABLE docker_host
  ADD COLUMN last_seen_at timestamptz;
