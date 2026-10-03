-- Die Adresse, unter der dieser Hub VON AUSSEN erreichbar ist — Phase 4b,
-- nachgezogen vor dem ersten externen Arm (#4, B2 in #46).
--
-- WARUM ES DIESE ZEILE GEBEN MUSS
--
-- Ein Arm wählt den Hub an, nie umgekehrt: sein `wg0.conf` trägt
-- `Endpoint = <Hub>:<Port>`, die Peer-Einträge auf der Hub-Seite tragen keinen
-- (`bootstrap/wireguard-config.ts`). Was von außen erreichbar sein muss, ist
-- also der HUB, und zwar unter einer Adresse, die der Arm von seinem Netz aus
-- auflösen kann.
--
-- Bisher gab es dafür genau einen Wert: `HUB_WIREGUARD_ENDPOINT` aus der
-- Umgebung. Der ist für interne Arme richtig — er ist die Adresse des Hubs im
-- eigenen Netz — und für externe in aller Regel falsch, weil er dann eine
-- private Adresse ist. Gemessen am 2026-09-07 auf dem laufenden Hub:
-- `HUB_WIREGUARD_ENDPOINT=192.0.2.31`. Ein Arm auf einem VPS bekäme damit
-- `Endpoint = 192.0.2.31:51821` und käme nie an.
--
-- ⚠️ ES IST EINE EIGENSCHAFT DES HUBS UND NICHT DES ARMS. Der Weg über den
-- bestehenden `endpoint_override` je Arm funktioniert, verlangt aber, dieselbe
-- Adresse bei jedem externen Arm neu abzutippen — und ein Tippfehler darin
-- fällt erst auf dem fremden Rechner auf, wie alles auf diesem Weg. Der
-- Override bleibt, was er ist: die Ausnahme für EINEN Arm.
--
-- ⚠️ NULLABLE, und das ist der Unterschied zu einer Vorgabe. „Noch nicht
-- eingetragen" ist ein echter Zustand: ein Hub ohne externen Arm braucht den
-- Wert nicht, und eine Vorgabe hier wäre eine erfundene Adresse, die beim
-- ersten externen Arm stillschweigend in dessen Paket geriete. Wer sie
-- braucht, wird beim Anlegen danach gefragt.

-- ── Das Netz des Hubs ───────────────────────────────────────────────────────
--
-- Eine Zeile für den ganzen Hub, nach dem Muster von `hub_theme` (006): der
-- Riegel `singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton)`
-- schließt eine zweite Zeile aus, und `CHECK (singleton)` schließt dabei
-- `false` aus — ein Primärschlüssel über `boolean` ließe sonst genau zwei zu.
--
-- Eine EIGENE Tabelle und keine Spalte in `hub_theme`: dort steht, wie der Hub
-- aussieht. Was hier steht, entscheidet, ob ein Arm den Tunnel aufbauen kann.
-- Zwei Zusagen verschiedener Art gehören nicht in dieselbe Zeile.
CREATE TABLE hub_network (
  singleton         boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
  -- Host oder Host:Port, ohne Schema. Ohne Port gilt HUB_WIREGUARD_PORT —
  -- dieselbe Regel wie beim Wert aus der Umgebung (`resolveWireguardEndpoint`).
  --
  -- ⚠️ Der CHECK ist der Schutz vor einer wg0.conf, die auf dem fremden Host
  -- zerfällt: der Wert wird dort UNMASKIERT in die Zeile `Endpoint = …`
  -- gesetzt. Ein Leerzeichen darin ergibt eine zweite Angabe, ein `/` einen
  -- Pfad, den WireGuard nicht kennt — und beides fällt erst auf dem Zielhost
  -- auf, mit einer Meldung über die Konfigurationsdatei statt über dieses Feld.
  external_endpoint text        CHECK (external_endpoint IS NULL OR external_endpoint ~ '^[^[:space:]/]+$'),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Die Zeile entsteht hier und nicht beim ersten Schreiben — wie in 006. Ein
-- Leser findet damit immer etwas vor, und `GET /api/settings` braucht keinen
-- Sonderweg für „noch nie eingestellt".
INSERT INTO hub_network (singleton) VALUES (true);
