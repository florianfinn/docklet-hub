// Der Schlüssel zu einem Wert, der über die Leitung kam.
//
// ⚠️ WARUM ES DIESE DATEI GIBT — EIN GEMESSENER FEHLER, KEINE VORSORGE.
// Gemessen am 2026-09-07 an der gebauten Fassung mit abgefangener API: sobald
// irgendeine Container-Zeile gezeichnet wurde, stand in der Konsole
//
//     MISSING_MESSAGE: Cannot read properties of undefined (reading 'split')
//
// — auf der Übersicht, auf `/containers` und auf allen drei Reitern der
// Detailseite. Ursache ist eine Zeile, die harmlos aussieht:
//
//     const STATE_KEYS: Record<ContainerState, keyof Messages> = { ok: …, warn: …, down: … };
//     t(STATE_KEYS[state])
//
// `ContainerState` ist ein geschlossener Vereinigungstyp, und `tsc` erlaubt den
// Zugriff deshalb ohne `| undefined` (`noUncheckedIndexedAccess` steht in
// diesem Repo nicht an). Trägt der Wert der GEGENSEITE aber etwas anderes —
// ein Feld, das die Antwort gar nicht enthält, ein Zustand aus einer neueren
// Fassung des Servers —, dann ist das Ergebnis zur Laufzeit `undefined`,
// `use-intl` ruft darauf `key.split(".")` und wirft. Die Fläche RENDERT
// TROTZDEM: die Bibliothek fängt den Fehler ab und zeichnet einen Rückfall.
// Man sieht nichts, der Text für den Screenreader verschwindet still, und die
// Zeile sieht aus wie immer.
//
// ⚠️ WARUM DAS KEIN WÄCHTER DIESES REPOS GESEHEN HAT: `languages.test.mjs`
// hält Schlüssel gegen Schlüssel — jeder Schlüssel der Sprachdateien wird
// benutzt, und beide Sprachen tragen dieselben. Ein AUFRUF mit `undefined` ist
// kein Schlüssel; er kommt in keiner der beiden Listen vor. Und `tsc` sieht
// eine Tabelle, die über ihrem Typ vollständig ist. Der Fehler liegt genau in
// der Lücke zwischen beiden.
//
// ⚠️ DIE REGEL, DIE HIERAUS FOLGT: eine Nachschlagetabelle `Record<X, keyof
// Messages>` darf mit einem Wert der Gegenseite NICHT unmittelbar indiziert
// werden. `knownKey` gibt stattdessen `null` zurück, und die Aufrufstelle sagt
// selbst, was dann dasteht. Zwei Stellen dieses Repos machten es schon vorher
// richtig und sind das Vorbild: `ExternalManagementNote` in
// `screens/overview/external-management.tsx` und `fileErrorKey` in
// `features/files/file-errors.ts`.
//
// ⚠️ WAS `knownKey` NICHT IST: eine Absicherung für Tabellen, deren Index aus
// dem Haus kommt. `navigationGroupLabelKeys[groupId]` in der Seitenleiste,
// `LANGUAGE_LABEL_KEYS[code]` über `LANGUAGES`, die Tonleitern der
// Einstellungen — dort erzeugt die Fläche den Index selbst aus einer Liste,
// die neben der Tabelle steht. Wer sie hier durchschleift, verlangt einen
// Rückfall für einen Fall, den es nicht gibt, und verdeckt damit einen echten
// Programmfehler.

import type { Messages } from "use-intl";

/**
 * Der Schlüssel zu `value` — oder `null`, wenn die Tabelle den Wert nicht
 * führt.
 *
 * ⚠️ `Object.hasOwn` und nicht `table[value] !== undefined`: der zweite Weg
 * ginge über die Prototypenkette und hielte `"toString"` oder `"constructor"`
 * für bekannte Werte. Was von der Leitung kommt, ist eine Zeichenkette wie
 * jede andere, und diese beiden sind gültige Zeichenketten.
 */
export function knownKey<Known extends string>(
  table: Record<Known, keyof Messages>,
  value: string
): keyof Messages | null {
  return Object.hasOwn(table, value) ? table[value as Known] : null;
}

/**
 * Dasselbe für eine Tabelle, die keine Schlüssel führt, sondern Klassen —
 * die Farbe eines Punktes, der Ton einer Marke.
 *
 * ⚠️ Sie gehört hierher und nicht in die Nähe von Tailwind: es ist derselbe
 * Fehler mit derselben Ursache, nur ohne Fehlermeldung. Ein `undefined` aus
 * einer Klassentabelle landet in `cn(…)` und fällt dort lautlos heraus — der
 * Punkt wird dann nicht falsch gefärbt, sondern GAR nicht, und ein
 * durchsichtiger Punkt sieht auf keiner Fläche nach einem Fehler aus.
 */
export function knownClass<Known extends string>(
  table: Record<Known, string>,
  value: string,
  fallback: string
): string {
  return Object.hasOwn(table, value) ? table[value as Known] : fallback;
}
