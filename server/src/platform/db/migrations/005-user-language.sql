-- Die Sprache der Oberfläche, je Benutzer im Konto — Issue #70.
--
-- Sie liegt am Konto und nicht im Browser: eine Einstellung des Kontos, kein
-- Zustand eines Geräts. Wer sich an einem zweiten Rechner anmeldet, bekommt
-- dieselbe Sprache, ohne sie noch einmal zu wählen. Das ist die Entscheidung
-- des Betreibers und nicht die bequemere Umsetzung — ein Wert im
-- Browserspeicher wäre weniger Code und eine andere Zusage.
--
-- ⚠️ Der Spaltenname steht in Anführungszeichen und ist klein geschrieben,
-- weil er aus einem Wort besteht. Die Anführungszeichen sind trotzdem kein
-- Beiwerk: better-auth spricht diese Tabelle über Kysely an und zitiert seine
-- Bezeichner (siehe den Kopf von 002-auth.sql). Ohne sie stünde hier ein
-- anders gefalteter Name als in jeder Abfrage von better-auth.
--
-- ⚠️ Der CHECK ist die Schranke, genau wie bei "role" in 002-auth.sql: eine
-- dritte Sprache entsteht nicht durch einen Tippfehler in einer Zuweisung,
-- sondern nur durch eine Migration. Die Aufzählung im Code (auth/language.ts)
-- sagt dasselbe noch einmal; beide zusammen sind die Zusage.
--
-- NOT NULL mit Vorgabe und nicht NULLABLE: die bestehenden Zeilen bekommen
-- damit „de" und bleiben gültig, ohne dass diese Migration sie kennt. Eine
-- Spalte ohne Vorgabe hätte den Start eines bestehenden Hubs angehalten.

ALTER TABLE "user"
  ADD COLUMN "language" text NOT NULL DEFAULT 'de'
  CHECK ("language" IN ('de', 'en'));
