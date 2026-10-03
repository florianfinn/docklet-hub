import type { Pool } from "pg";

import { DEFAULT_GLOBAL_THEME, type GlobalThemePreset } from "contract";
import { GLOBAL_KNOBS } from "./input.js";

// Der Weg zur Tabelle `hub_theme` — und sonst nichts.
//
// Getrennt von `input.ts`, wo die Prüfung steht: hier kommt ein bereits
// geprüfter Wert an. Der `CHECK` der Spalte (006-hub-theme.sql) ist die zweite
// Hälfte derselben Zusage und nicht ihre einzige — eine verletzte Bedingung
// wäre eine 500 und keine Antwort, die dem Aufrufer sagt, was er falsch
// gemacht hat.
//
// ⚠️ Die Spaltenliste wird aus `GLOBAL_KNOBS` GEBAUT und nicht hingeschrieben.
// Eine eigene Aufzählung hier wäre der dritte Ort, an dem die Stellschrauben
// stünden. Die Werte reisen als Parameter, die Namen stammen aus einer
// Konstanten dieses Programms — es gibt hier nichts, was ein Aufrufer
// einschleusen könnte.
//
// ⚠️ DIE FALTUNGSREGEL, und sie gilt genau hier (B6/E4, #5): Postgres faltet
// jeden Bezeichner OHNE Anführungszeichen auf Kleinschreibung — beim Schreiben
// der Anweisung und beim Benennen der Ergebnisspalte. Bis D7b hießen alle
// Stellschrauben einwortig und klein (`scheme`, `chroma`, …), und der Satz
// „Spaltenname und Name der Stellschraube sind wörtlich dieselben" stimmte.
// Seit `012-terminal-theme.sql` stimmt er nicht mehr: die Stellschraube heißt
// `terminalScheme`, die Spalte `terminalscheme`. Daraus folgen zwei Dinge:
//
//   1. ZUM SCHREIBEN ist nichts zu tun. `INSERT INTO hub_theme (terminalScheme,
//      …)` und `SET terminalScheme = EXCLUDED.terminalScheme` treffen die
//      Spalte, weil beide Seiten gleich gefaltet werden.
//   2. ZUM LESEN braucht es einen Alias. Ohne ihn heißt die Ergebnisspalte
//      `terminalscheme`, `toPreset` liest sie mit `row["terminalScheme"]` und
//      bekommt `undefined` — die Oberfläche setzte dann
//      `data-terminal-scheme="undefined"`, keine CSS-Regel griffe, und das
//      Terminal hätte keine Farben. Bei grüner Prüfkette: kein Test dieser
//      Werkstatt spricht mit Postgres. Deshalb steht die Regel jetzt in der
//      Attrappe von `theme-routes.test.ts` (`postgresRow`), und deshalb wird
//      der Alias hier ABGELEITET und nicht aufgezählt — für die sieben
//      einwortigen ändert er nichts (`scheme AS "scheme"`), für jede künftige
//      Stellschraube mit Großbuchstaben ist er die Rettung.
//
// Die Regel auf der anderen Seite — der Spaltenname IST der kleingeschriebene
// Name der Stellschraube — hält `server/src/platform/theme/theme-schema.test.ts` gegen
// jede Migration des Verzeichnisses.

/** Die Spalten zum Schreiben: ungequotet, Postgres faltet sie selbst. */
const COLUMNS = GLOBAL_KNOBS.join(", ");

/** Dieselben Spalten zum Lesen, jede mit dem Namen ihrer Stellschraube. */
const SELECTED = GLOBAL_KNOBS.map((knob) => `${knob} AS "${knob}"`).join(", ");

type ThemeRow = Record<string, string>;

function toPreset(row: ThemeRow): GlobalThemePreset {
  const preset: Record<string, string> = {};
  for (const knob of GLOBAL_KNOBS) preset[knob] = row[knob];
  return preset as unknown as GlobalThemePreset;
}

/**
 * Die Darstellung des Hubs.
 *
 * `DEFAULT_GLOBAL_THEME`, wenn die Zeile fehlt. Sie wird von 006 gesät, und
 * nichts in diesem Programm löscht sie — der Rückfall ist der Fall „von Hand
 * an der Datenbank gelöscht" und keine Erwartung. Eine Ausnahme wäre hier
 * falsch: die Oberfläche bekäme sonst gar keine Darstellung, statt der, die
 * ohnehin gälte.
 */
export async function readGlobalTheme(pool: Pool): Promise<GlobalThemePreset> {
  const { rows } = await pool.query<ThemeRow>(`SELECT ${SELECTED} FROM hub_theme WHERE singleton`);
  return rows[0] ? toPreset(rows[0]) : DEFAULT_GLOBAL_THEME;
}

/**
 * Schreibt den VOLLEN Satz und meldet ihn zurück.
 *
 * ⚠️ Der ganze Satz und keine Teilmenge — Vertrag aus #64 in der Fassung vom
 * 2026-09-06. Ein Satz, der nur teilweise ankommt, hinterlässt eine Mischung
 * aus altem und neuem Stand, die niemand mehr benennen kann; ein unvollständiger
 * Rumpf ist deshalb schon in `input.ts` ein 400 und erreicht diese
 * Funktion nie.
 *
 * ⚠️ EINE Anweisung, und zwar ein Einfügen mit `ON CONFLICT`. Sie deckt beide
 * Lagen ab: die gesäte Zeile ist da (dann wird sie überschrieben) oder sie ist
 * von Hand gelöscht worden (dann entsteht sie wieder). Ein „lesen, prüfen,
 * schreiben" wäre ein Fenster, in dem zwei Administratoren zwei Zeilen anlegen
 * — die zweite liefe in den Primärschlüssel, und der Hub meldete einen
 * Datenbankfehler auf eine Einstellung.
 *
 * ⚠️ Der zurückgemeldete Stand kommt aus `RETURNING` und nicht aus einem
 * zweiten Lesen. Ein Lesen danach wäre wieder ein Fenster — und die Antwort
 * behauptete einen Stand, der zwischen Schreiben und Lesen schon ein anderer
 * sein kann.
 */
export async function writeGlobalTheme(pool: Pool, theme: GlobalThemePreset): Promise<GlobalThemePreset> {
  const placeholders = GLOBAL_KNOBS.map((_knob, index) => `$${index + 1}`).join(", ");
  const excluded = GLOBAL_KNOBS.map((knob) => `${knob} = EXCLUDED.${knob}`).join(",\n            ");

  const { rows } = await pool.query<ThemeRow>(
    `INSERT INTO hub_theme (${COLUMNS}, singleton)
     VALUES (${placeholders}, true)
     ON CONFLICT (singleton) DO UPDATE
        SET ${excluded},
            updated_at = now()
     RETURNING ${SELECTED}`,
    GLOBAL_KNOBS.map((knob) => theme[knob])
  );
  return toPreset(rows[0]);
}
