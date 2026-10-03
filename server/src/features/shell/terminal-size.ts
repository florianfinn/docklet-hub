import { EXEC_DEFAULT_COLS, EXEC_DEFAULT_ROWS } from "contract";

// The window size from a request body (#260). It stood in `agent/exec.ts`; two
// routes read it (the stream that opens a session and `size`), so it is a file
// of its own. The comment below is unchanged from there and still German.

/**
 * Die Fenstergröße aus einem Anfragekörper.
 *
 * ⚠️ `Number(body.cols ?? 80)` REICHT NICHT, und das ist der Befund, um den es
 * hier geht — er kommt aus dem Quellsystem (`dashboard-homelab`,
 * `server/src/docker-exec.ts` bei `92fbc0b002fdd9a629ff1543a218f69e92e84034`)
 * und gilt an diesem Agenten unverändert. Bei `{"cols":"x"}` kommt `NaN`
 * heraus, und `JSON.stringify` schreibt `NaN` als `null` in den Körper an den
 * Agenten. Der liest dann eine Größe, die gar keine Zahl mehr ist.
 *
 * ⚠️ DIE TYPPRÜFUNG STEHT VOR `Number(...)` und nicht danach: `Number([])` ist
 * `0`, nicht `NaN`. Ohne sie ginge `{"rows":[]}` als eine Zeile durch, während
 * `{"rows":{}}` sauber auf die Vorgabe fällt — zwei Antworten auf denselben
 * Unsinn.
 *
 * ⚠️ ABWEICHUNG VON DER QUELLE: HIER WIRD NICHT GEKLEMMT. Das Quellsystem
 * klemmte auf `1…1000` — Zahlen, die es bei DIESEM Agenten nicht gibt: er
 * klemmt selbst auf 8…500 Spalten und 4…300 Zeilen (`src/exec.ts`, `:37-50`).
 * Eine eigene Klemme hier wäre die zweite Wahrheit über eine fremde Grenze und
 * würde still falsch, sobald die Gegenseite ihre Zahlen ändert. Was bleibt, ist
 * die Umwandlung in eine ganze Zahl — die einzige Hälfte des Befunds, die den
 * Agenten überhaupt erreicht.
 *
 * Fehlt der Wert oder ist er unbrauchbar, gilt 80 × 24 — dieselbe Vorgabe, die
 * der Agent selbst setzt. Ein zu kleiner oder zu großer Wert wird nicht
 * abgewiesen: die Größe ist Anzeige, keine Rechteentscheidung, und ein `400`
 * mitten im Tippen wäre die schlechtere Antwort.
 */
export function readTerminalSize(body: unknown): { cols: number; rows: number } {
  const values = (body ?? {}) as Record<string, unknown>;
  return {
    cols: wholeNumber(values.cols, EXEC_DEFAULT_COLS),
    rows: wholeNumber(values.rows, EXEC_DEFAULT_ROWS)
  };
}

function wholeNumber(value: unknown, fallback: number): number {
  const usable = typeof value === "number" || (typeof value === "string" && value.trim() !== "");
  if (!usable) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
}
