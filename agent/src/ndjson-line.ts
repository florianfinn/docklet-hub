import type http from "node:http";

// Eine Zeile einer NDJSON-Stream-Antwort. Ein Objekt je Zeile, damit der
// Empfänger mitlesen kann, ohne auf das Ende zu warten (im Gegensatz zu einem
// großen JSON-Dokument, das erst vollständig sein muss).
//
// ⚠️ DER DECKEL IST EIN RÜCKSTAU IN BYTES, NICHT DIE HIGH-WATER-MARK VON NODE.
// Bis v0.29.0 zerstörte `sendLine` die Antwort, sobald `response.write`
// einmal `false` meldete — also sobald Nodes Puffer über 16 KiB stand. Das
// passiert nicht erst bei einem Leser, der nicht liest, sondern bei jedem
// Ausschnitt der Vergangenheit: die Engine liefert `tail` Zeilen in einem
// Schwall, und der Agent schreibt sie schneller in den Puffer, als der Socket
// sie abnimmt. Gemessen am 2026-09-29 vom Hub-Container gegen den lokalen
// Agenten (v0.24.0), Log-Strom von AdGuard Home mit `tail=2000`: nach der
// ersten Zeile `ECONNRESET` — mit einem Leser, der jede Zeile sofort nahm,
// genauso wie mit einem, der 5 ms je Zeile wartete. Die Oberfläche des Hubs
// meldete daraufhin „mitten im Log abgerissen".
//
// Gedeckelt bleibt der Rückstau trotzdem: die Erzeuger (Docker-HTTP,
// Datei-Mitleser, Pull-Fortschritt) lassen sich nicht an einer gemeinsamen
// Stelle anhalten, und ein Leser, der gar nicht liest, darf den Speicher des
// Agenten nicht füllen. Erst wenn mehr als `MAX_STREAM_BACKLOG_BYTES` im
// Puffer der Antwort stehen, wird sie zerstört.
//
// ⚠️ WARUM 4 MiB. Der größte Schwall ist der Ausschnitt der Vergangenheit:
// höchstens 2000 Zeilen (`resolveLogTail`). Bei 2 KiB je umschlagener Zeile
// sind das 4 MiB, und eine Logzeile ist in der Regel ein Bruchteil davon.
// Mit `MAX_OPEN_STREAMS` Strömen zugleich bleibt der schlimmste Fall — jeder
// Leser steht still — bei 32 × 4 MiB und damit unter dem, was ein Agent auf
// einem Heimserver ohnehin frei hat.
export const MAX_STREAM_BACKLOG_BYTES = 4 * 1024 * 1024;

/**
 * Schreibt eine Zeile. `false` heißt: die Antwort ist zu (schon vorher oder
 * jetzt, weil der Rückstau den Deckel riss) — der Aufrufer bricht seinen
 * Erzeuger ab.
 */
export function sendLine(
  response: http.ServerResponse,
  value: unknown,
  maxBacklogBytes: number = MAX_STREAM_BACKLOG_BYTES
): boolean {
  // Der Aufrufer (Haupt-API) kann die Verbindung während eines Pulls trennen
  // (Nutzer-Wunsch: manuell abbrechen) — ein `write` danach liefe sonst gegen
  // einen zerstörten Socket.
  if (response.destroyed || response.writableEnded) return false;
  response.write(`${JSON.stringify(value)}\n`);
  if (response.writableLength > maxBacklogBytes) {
    response.destroy();
    return false;
  }
  return true;
}
