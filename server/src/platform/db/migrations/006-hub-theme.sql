-- Die Ablage der Darstellung — Paket D7a (#62), Vertrag aus #64.
--
-- Zwei Dinge in EINER Migration, weil sie eine Zusage sind: die Darstellung
-- des Hubs ist ab hier gespeichert und nicht mehr gerechnet. Getrennt wäre die
-- eine Hälfte eine Tabelle ohne Leser und die andere eine Spalte ohne Editor.
--
-- WARUM EINE ZEILE MIT SPALTEN UND KEINE SCHLÜSSEL-WERT-TABELLE
--
-- Beide Formen tragen dieselben sieben Werte. Der Unterschied liegt darin, was
-- die Datenbank davon selbst weiß:
--
--   - Schlüssel-Wert (`key text PRIMARY KEY, value text`): die kleinere
--     Migration. Die Datenbank kennt aber weder die Namen der Stellschrauben
--     noch die Stufen — ein `CHECK` über alle Werte gleichzeitig wäre eine
--     einzige lange Bedingung, die nicht sagt, welcher Schlüssel welche Stufen
--     hat. Ein Tippfehler im SCHLÜSSEL („shceme“) legt eine neue Zeile an,
--     statt aufzufallen, und der Leser bekommt für „scheme“ nichts.
--   - Eine Zeile mit sieben Spalten: die schärfere Zusicherung. Je Spalte ein
--     eigener `CHECK` mit genau den Stufen dieser Stellschraube, je Spalte ein
--     `DEFAULT`, der dem `fallback` aus `THEME_KNOBS` entspricht, und
--     NOT NULL. Ein unbekannter Schlüssel ist hier kein neuer Datensatz,
--     sondern ein Fehler beim Übersetzen der Abfrage.
--
-- Gewählt ist die zweite Form. Der Preis ist eine Migration je neuer
-- Stellschraube; das ist genau der Punkt — eine Stellschraube entsteht in
-- diesem Repo ohnehin nicht durch eine Zuweisung, sondern durch eine
-- Entscheidung mit einem Dokument dahinter.
--
-- ⚠️ Die Stufen stehen damit ZWEIMAL: hier und in `server/src/theme/presets.ts`
-- (`THEME_KNOBS`). Das ist im Haus gelöst und nicht verboten — der Wächter
-- `server/src/theme/theme-schema.test.ts` hält beide Orte gegeneinander und
-- liest dazu DIESE Datei. Er entfernt vorher die SQL-Kommentare: `--` bis zum
-- Zeilenende, `/* … */`, und ein Anführungszeichen maskiert SQL durch
-- Verdopplung und nicht mit einem Backslash. Ein `CHECK (hue IN ( … ))` in
-- diesem Prosakopf sähe sonst aus wie die Schranke und stünde vor ihr (#70).

-- ── Die Einstellung des Hubs ────────────────────────────────────────────────
--
-- Eine Zeile für den ganzen Hub. Nach #17 schreibt ein Administrator, lesen
-- alle — die Zeile hängt deshalb an keinem Konto.
--
-- ⚠️ `singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton)` ist der
-- Riegel gegen eine zweite Zeile. Ohne ihn wäre „die Einstellung des Hubs“ ein
-- Bestand, aus dem ein Leser eine Zeile auswählen müsste — und zwei Hubs
-- läsen dieselbe Tabelle verschieden. Der `CHECK` schließt dabei `false` aus:
-- ein Primärschlüssel über `boolean` ließe sonst genau zwei Zeilen zu.
CREATE TABLE hub_theme (
  singleton  boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
  -- Die sieben Stellschrauben mit `scope: "global"` aus THEME_KNOBS. Der
  -- Spaltenname ist wörtlich der Name der Stellschraube; der `DEFAULT` ist
  -- wörtlich ihr `fallback`.
  scheme     text        NOT NULL DEFAULT 'dark'   CHECK (scheme IN ('dark', 'light')),
  chroma     text        NOT NULL DEFAULT 'normal' CHECK (chroma IN ('subtle', 'normal', 'bold')),
  radius     text        NOT NULL DEFAULT 'soft'   CHECK (radius IN ('sharp', 'soft', 'round')),
  density    text        NOT NULL DEFAULT 'normal' CHECK (density IN ('normal', 'compact')),
  font       text        NOT NULL DEFAULT 'plex'   CHECK (font IN ('plex', 'system')),
  charts     text        NOT NULL DEFAULT 'rotate' CHECK (charts IN ('rotate', 'mono')),
  focus      text        NOT NULL DEFAULT 'hue'    CHECK (focus IN ('hue', 'neutral')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Die Zeile entsteht hier und nicht beim ersten Schreiben. Ein Leser findet
-- damit immer etwas vor, und `GET /api/settings` braucht keinen Sonderweg für
-- „noch nie eingestellt“.
INSERT INTO hub_theme (singleton) VALUES (true);

-- ── Der Ton je Arm ──────────────────────────────────────────────────────────
--
-- D0 §6: „ein Farbton und eine Stufe des Farbeinsatzes je Datensatz in
-- `docker_host`. Zwei Spalten.“
--
-- ⚠️ DER VORGABEWERT DES TONS IST `neutral`, UND ES WIRD NICHT RÜCKWIRKEND
-- GEFÄRBT. D0 §2 sagt „der Betreiber vergibt“ — ein automatisch zugeteilter
-- Ton wäre genau die Zufallsfarbe, die `hostHue` aus #75 als Platzhalter
-- kennzeichnet („zwei Hosts können denselben Ton bekommen; das endet mit D7“).
-- Bestehende Arme stehen nach dieser Migration also neutral, bis ihnen jemand
-- im Editor eine Farbe gibt. Eine Migration, die hier über die Kennung streut,
-- machte die Übergabe an den Betreiber unsichtbar: er sähe Farben und hielte
-- sie für seine.
--
-- NOT NULL mit Vorgabe und nicht NULLABLE — dieselbe Entscheidung wie in
-- 005-user-language.sql: die bestehenden Zeilen bekommen damit einen gültigen
-- Wert, ohne dass diese Migration sie kennt.
--
-- Die Spaltennamen sind snake_case und ohne Anführungszeichen wie der Rest von
-- `docker_host` (siehe den Kopf von 003-hosts.sql); zugleich sind sie wörtlich
-- die Namen der zwei Stellschrauben mit `scope: "host"`.
ALTER TABLE docker_host
  ADD COLUMN hue text NOT NULL DEFAULT 'neutral'
    CHECK (hue IN ('amber', 'green', 'teal', 'blue', 'violet', 'rose', 'neutral')),
  ADD COLUMN ink text NOT NULL DEFAULT 'head'
    CHECK (ink IN ('none', 'edge', 'head', 'card'));
