import type { useTranslations } from "use-intl";

import { ApiError } from "../../platform/http/transport";

// Was der Betreiber liest, wenn eine der drei Schreibrouten der Marken
// ablehnt (D7b, #62).
//
// Eigene Datei und keine Funktion in `MarksPanel.tsx`: dieselbe Bauart wie
// `web/src/features/hosts/host-errors.ts` und aus demselben Grund — die Tafel
// ist eine Komponente, diese Übersetzung ist keine, und `t` kommt deshalb als
// erstes Argument von der Aufrufstelle herein.
type Translate = ReturnType<typeof useTranslations>;

/**
 * Der Statuscode, mit dem der Server einen VERGEBENEN NAMEN ablehnt.
 *
 * ⚠️ GEMESSEN und nicht angenommen: `handleMarkError` in
 * `server/src/features/marks/mark-errors.ts` bildet den Grund `name-taken` auf
 * 409 ab und die beiden übrigen (`mark-unknown`, `host-unknown`) auf 404. Der
 * Rumpf trägt `{ error, message }` (`failWith`, Z. 86–88).
 *
 * Er steht als benannte Konstante, weil die Zahl sonst zweimal im Baum stünde
 * — einmal hier und einmal in der Begründung daneben.
 */
const NAME_TAKEN = 409;

/**
 * Ein Name, den es schon gibt — der Fall, den der Betreiber tatsächlich
 * auslöst.
 *
 * ⚠️ Der Grund wird am STATUSCODE erkannt und nicht am Rumpf. Beides wäre
 * möglich (`{ "error": "name-taken" }` steht darin), aber der Code ist die
 * Angabe, die auch dann noch stimmt, wenn ein Zwischenglied den Rumpf
 * verschluckt — und `request<T>` in `client.ts` legt den Rumpf ohnehin als
 * JSON-Zeichenkette in `ApiError.message`, also müsste er hier ein zweites Mal
 * geparst werden, um dasselbe zu erfahren.
 */
export function isNameTaken(error: unknown): boolean {
  return error instanceof ApiError && error.status === NAME_TAKEN;
}

export function describeCreateMarkError(t: Translate, error: unknown): string {
  return isNameTaken(error) ? t("settingsMarkNameTaken") : t("settingsMarkCreateFailed");
}

export function describeSaveMarkError(t: Translate, error: unknown): string {
  return isNameTaken(error) ? t("settingsMarkNameTaken") : t("settingsMarkSaveFailed");
}

/**
 * Ein Fehlschlag beim Entfernen.
 *
 * ⚠️ OHNE das Fehlerobjekt, und das ist Absicht. `DELETE /api/marks/:markId`
 * kennt genau zwei Ausgänge: 204 und 404 („es gibt sie nicht mehr" oder „es
 * gab sie nie", server/src/features/marks/routes.ts). Für den Betreiber, der gerade auf
 * eine Zeile geklickt hat, sind beide dasselbe — ein Parameter, der die
 * Antwort nicht ändert, wäre eine Unterscheidung, die es nicht gibt.
 */
export function describeDeleteMarkError(t: Translate): string {
  return t("settingsMarkDeleteFailed");
}
