-- Die vier Stellschrauben des Terminals — Phase 5b, Paket B6, Etappe E4 (#5).
--
-- WARUM EINE NEUE MIGRATION UND KEINE ZEILE IN 006
--
-- Eine angewandte Migration ist unveränderlich: `planMigrations` vergleicht
-- den Hash jeder bereits gelaufenen Datei und hält den Start an, sobald einer
-- abweicht (`server/src/db/migration-plan.ts`, Fall
-- „eine nachträglich geänderte Migration hält den Start an" in
-- `migration-plan.test.ts`). Ein bestehender Hub käme nach einem Nachtrag in
-- 006 gar nicht mehr hoch. Die vier Spalten kommen deshalb als `ALTER TABLE`
-- an `hub_theme`, in derselben Form, die 006 für `hue` und `ink` an
-- `docker_host` benutzt.
--
-- NOT NULL MIT VORGABE: dieselbe Entscheidung wie in 005 und 006. Die schon
-- bestehende Zeile in `hub_theme` bekommt damit einen gültigen Wert, ohne dass
-- diese Migration sie kennt — ein `ADD COLUMN … NOT NULL` OHNE `DEFAULT` hielte
-- den Start eines bestehenden Hubs an und fiele auf einer frischen Datenbank
-- nicht auf. `server/src/db/migration-sequence.test.ts` prüft genau das über
-- alle Migrationen.
--
-- ⚠️ DIE SPALTENNAMEN SIND KLEINGESCHRIEBEN UND OHNE ANFÜHRUNGSZEICHEN, die
-- Stellschrauben in `THEME_KNOBS` heißen dagegen `terminalScheme`,
-- `terminalSurface`, `terminalSize` und `terminalScrollback`. Das ist kein
-- Auseinanderlaufen, sondern die Folge zweier Regeln, die beide gelten:
--
--   1. `server/src/theme/theme-store.ts` baut `SELECT`, `INSERT` und
--      `ON CONFLICT DO UPDATE` WÖRTLICH aus den Namen der Stellschrauben
--      (`COLUMNS = GLOBAL_KNOBS.join(", ")`) — die Anweisung lautet also
--      `SELECT … terminalScheme … FROM hub_theme`, ohne Anführungszeichen.
--   2. Postgres faltet jeden Bezeichner ohne Anführungszeichen auf
--      Kleinschreibung. `terminalScheme` in der Anweisung trifft damit die
--      Spalte `terminalscheme` — und NUR die. Ein snake_case-Name
--      (`terminal_scheme`) wäre die Spalte, die diese Anweisung nicht findet,
--      ein gequoteter Name `"terminalScheme"` ebenso.
--
-- Der Kopf von 006 nennt snake_case als Hausform. Sie ist hier nicht zu haben,
-- ohne dass entweder die Schlüssel des Vertrags (`PUT /api/appearance` trägt
-- `terminalScheme`) oder die abgeleitete Spaltenliste im Store fielen. Der
-- Wächter `server/src/theme/theme-schema.test.ts` bildet den Schlüssel deshalb
-- über `toLowerCase()` auf die Spalte ab und hält beide Seiten gegeneinander.
--
-- ⚠️ BEFUND FÜR EINE SPÄTERE ETAPPE, hier nur gemeldet: `theme-store.ts` liest
-- die Antwortzeile mit `row[knob]`, also mit dem camelCase-Schlüssel. Postgres
-- meldet die Spalte aber als `terminalscheme` zurück; für die vier neuen
-- Stellschrauben käme aus `readGlobalTheme`/`writeGlobalTheme` damit
-- `undefined` an. Der Ort der Behebung ist eine Zeile im Store
-- (`SELECT terminalScheme AS "terminalScheme"`, aus `GLOBAL_KNOBS` gebaut) und
-- nicht diese Migration; der Store gehört nicht zu dieser Etappe.
--
-- DIE STUFEN SELBST stehen zweimal — hier und in `THEME_KNOBS`. Das ist die
-- Bauart aus 006 (siehe deren Kopf) und im Haus gelöst: `theme-schema.test.ts`
-- hält beide Orte gegeneinander, seit dieser Etappe über ALLE Migrationen des
-- Verzeichnisses statt über eine hingeschriebene Liste von Dateinamen.
--
-- WOHER DIE VORGABEN KOMMEN: `.remember/orchestration-b6/terminal-farben.md`,
-- vom Leitstand entschieden und gemessen. „dark" als Vorgabe des Schemas ist
-- die einzige, die nicht dem Hub folgt — ein Terminal ist die eine Fläche, für
-- die Dunkel auch in einer hellen Oberfläche der erwartete Anblick ist.

ALTER TABLE hub_theme
  ADD COLUMN terminalscheme text NOT NULL DEFAULT 'dark'
    CHECK (terminalscheme IN ('follow', 'dark')),
  ADD COLUMN terminalsurface text NOT NULL DEFAULT 'sunken'
    CHECK (terminalsurface IN ('card', 'sunken', 'ink')),
  ADD COLUMN terminalsize text NOT NULL DEFAULT 'normal'
    CHECK (terminalsize IN ('small', 'normal', 'large')),
  ADD COLUMN terminalscrollback text NOT NULL DEFAULT 'normal'
    CHECK (terminalscrollback IN ('short', 'normal', 'long'));
