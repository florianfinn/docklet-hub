// Die zwei Sprachen der Oberfläche — und sonst nichts.
//
// Zwillingsdatei zu roles.ts, und aus demselben Grund so gebaut: die Sprache
// steht als Aufzählung da und nicht als offene Zeichenkette. Eine offene
// Zeichenkette lädt dazu ein, ihr einen weiteren Wert zu geben — und der
// erste, der das tut, merkt es erst, wenn die Oberfläche für ein Konto leer
// bleibt, weil zu „fr" kein Wörterbuch existiert.
//
// Die Sprache liegt JE BENUTZER im Konto und nicht im Browser: sie ist eine
// Einstellung des Kontos, kein Zustand eines Geräts. Wer sich an einem zweiten
// Rechner anmeldet, bekommt dieselbe Sprache, ohne sie noch einmal zu wählen.

export const LANGUAGES = ["de", "en"] as const;

export type Language = (typeof LANGUAGES)[number];

// Die Sprache eines frisch angelegten Kontos. Sie steht auch als Vorgabe in
// der Spalte (005-user-language.sql) — hier noch einmal, weil der Wert im Code
// gebraucht wird, bevor die Zeile existiert.
export const DEFAULT_LANGUAGE: Language = "de";

/**
 * Liest eine Sprache aus einem Wert, der aus der Datenbank, aus einer Sitzung
 * oder aus dem Rumpf einer Anfrage kommt.
 *
 * Fail closed: was nicht als Sprache erkennbar ist, ist die Vorgabe und nicht
 * etwa der zuletzt gesetzte Wert. Ein `null` in der Spalte — etwa aus einer
 * Zeile, die vor der Migration entstand — zeigt damit eine deutsche
 * Oberfläche und keine leere.
 *
 * ⚠️ Ohne Normalisierung der Schreibweise: „DE" ist kein Sprachcode dieses
 * Systems, sondern ein Tippfehler. Wer ihn stillschweigend annähme, verschöbe
 * die Grenze dessen, was die eine schreibende Route (features/account/routes.ts) durchlässt
 * — und die Spalte trägt den CHECK, der ihn ohnehin abwiese.
 *
 * ⚠️ Die Menge kommt aus `LANGUAGES` und NICHT aus zwei Literalen, obwohl
 * `value === "de" || value === "en"` kürzer wäre. Zwei Literale wären eine
 * zweite Wahrheit über dieselbe Menge, und zwar eine unsichtbare: wer später
 * eine dritte Sprache einträgt, ergänzt die Aufzählung, die Spalte und die
 * Oberfläche, jeder Wächter darüber wird grün — und diese Funktion wiese den
 * neuen Code trotzdem still ab. Die Route antwortete dann mit 400 auf eine
 * Sprache, die überall sonst als gültig dasteht.
 *
 * Gesucht wird deshalb IN der Aufzählung, statt gegen sie zu vergleichen:
 * `find` liefert das Element der Aufzählung selbst zurück, also bereits ein
 * `Language` — `includes` hätte nur ein `boolean` geliefert und danach eine
 * Behauptung über `value` gebraucht (`readonly ["de", "en"]` kennt ohnehin
 * kein `includes` für ein `unknown`). So kommt die Funktion ohne `any`, ohne
 * Zusicherung und ohne Ausnahmezeile durch `tsc --noEmit`.
 */
export function toLanguage(value: unknown): Language {
  return LANGUAGES.find((language) => language === value) ?? DEFAULT_LANGUAGE;
}
