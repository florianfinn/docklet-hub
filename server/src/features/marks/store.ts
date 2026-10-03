import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import type { MarkView } from "contract";

import { MarkError } from "./types.js";
import type { MarkInput } from "./input.js";

// Der Weg zur Tabelle `hub_mark` — und sonst nichts.
//
// Getrennt von `input.ts`, wo die Prüfung steht: hier kommt ein bereits
// geprüfter Wert an. Dieselbe Aufteilung wie zwischen `input.ts` und
// `features/appearance/store.ts`, und dieselbe wie zwischen `setup-gate.ts` und
// `setup-store.ts`.
//
// Die Zuordnung einer Marke steht NICHT hier, sondern in
// `assignment-store.ts`. Sie ist eine andere Tabelle mit einer anderen Frage:
// hier geht es um den BESTAND der Marken, dort darum, wer welche trägt.
//
// ⚠️ Die Spaltenliste steht hier ausgeschrieben und wird nicht aus
// `MARK_KNOBS` gebaut — anders als in `features/appearance/store.ts`. Der Grund ist der
// Name: `hub_mark` trägt eine Spalte, die KEINE Stellschraube ist, und eine
// Liste, die aus `MARK_KNOBS` entstünde, müsste ihn danebenstellen. Die
// Deckung zwischen den zwei Stellschrauben und der Migration hält
// `theme-schema.test.ts`.

const COLUMNS = "id, name, hue, style";

type MarkRow = { id: string; name: string; hue: string; style: string };

function toView(row: MarkRow): MarkView {
  return { id: row.id, name: row.name, hue: row.hue as MarkView["hue"], style: row.style as MarkView["style"] };
}

/**
 * Ob ein Fehler eine verletzte Eindeutigkeit ist, und welche.
 *
 * Wörtlich derselbe Leser wie in `domain/hosts/host-store.ts`. Er steht hier ein zweites
 * Mal und nicht als Import: `domain/hosts/host-store.ts` exportiert ihn nicht, und ihn dort
 * herauszuziehen hieße, eine Datei anzufassen, die dieses Paket sonst nicht
 * berührt. Gemeldet als Befund, nicht behoben.
 */
function conflictConstraint(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { code?: unknown; constraint?: unknown };
  if (candidate.code !== "23505") return null;
  return typeof candidate.constraint === "string" ? candidate.constraint : "";
}

function nameTaken(name: string): MarkError {
  return new MarkError("name-taken", `Eine Marke mit dem Namen „${name}" gibt es bereits.`);
}

/**
 * Alle Marken, nach Namen geordnet.
 *
 * ⚠️ Die Reihenfolge steht HIER und nicht im Browser. Sie ist auf jeder Fläche
 * dieselbe — Liste in den Einstellungen, Auswahl an einem Stack, Auswahl an
 * einer Container-Zeile —, und eine Liste, die je Fläche anders sortiert ist,
 * liest sich wie eine andere Liste.
 *
 * ⚠️ `ORDER BY name` und kein `localeCompare` im Programm: `name` ist
 * `citext`, und die Datenbank ordnet ihn nach ihrer Kollation. Ein zweites
 * Sortieren im Hub wäre eine zweite Ordnung derselben Liste — und die von
 * `localeCompare` hängt an der ICU-Fassung des laufenden Node
 * (domain/containers/stacks.ts sagt dasselbe über die Container).
 */
export async function listMarks(pool: Pool): Promise<MarkView[]> {
  const { rows } = await pool.query<MarkRow>(`SELECT ${COLUMNS} FROM hub_mark ORDER BY name`);
  return rows.map(toView);
}

/**
 * Legt eine Marke an und meldet sie zurück.
 *
 * Die Kennung entsteht mit `randomUUID()` wie bei `docker_host`
 * (domain/hosts/host-store.ts) und nicht in der Datenbank: das brauchte eine Erweiterung,
 * und die Kennung eines Datensatzes entsteht in diesem Repo dort, wo der
 * Datensatz entsteht.
 *
 * ⚠️ Der doppelte Name ist ein FEHLER MIT NAMEN und kein Datenbankfehler nach
 * draußen. Der eindeutige Index über `citext` ist die Schranke; ohne diese
 * Übersetzung sähe der Betreiber eine Meldung über einen Index statt der
 * Auskunft, dass es die Marke schon gibt.
 */
export async function createMark(pool: Pool, input: MarkInput): Promise<MarkView> {
  try {
    const { rows } = await pool.query<MarkRow>(
      `INSERT INTO hub_mark (id, name, hue, style)
       VALUES ($1, $2, $3, $4)
       RETURNING ${COLUMNS}`,
      [randomUUID(), input.name, input.hue, input.style]
    );
    return toView(rows[0]);
  } catch (error) {
    if (conflictConstraint(error) === "hub_mark_name_key") throw nameTaken(input.name);
    throw error;
  }
}

/**
 * Schreibt den VOLLEN Satz einer Marke und meldet ihn zurück.
 *
 * `null` heißt: es gibt keine Marke mit dieser Kennung. Der Aufrufer macht
 * daraus einen 404 — dieselbe Bauart wie `setHostDisplay`.
 *
 * ⚠️ Der ganze Satz und keine Teilmenge, wie überall in diesem Bereich. Ein
 * unvollständiger Rumpf ist schon in `input.ts` ein 400 und erreicht
 * diese Funktion nie.
 */
export async function updateMark(pool: Pool, id: string, input: MarkInput): Promise<MarkView | null> {
  try {
    const { rows } = await pool.query<MarkRow>(
      `UPDATE hub_mark
          SET name  = $2,
              hue   = $3,
              style = $4
        WHERE id = $1
        RETURNING ${COLUMNS}`,
      [id, input.name, input.hue, input.style]
    );
    return rows[0] ? toView(rows[0]) : null;
  } catch (error) {
    if (conflictConstraint(error) === "hub_mark_name_key") throw nameTaken(input.name);
    throw error;
  }
}

/**
 * Entfernt eine Marke. Idempotent: ein zweiter Aufruf meldet `false`, nicht
 * einen Fehler — dieselbe Entscheidung wie bei `removeHost`.
 *
 * ⚠️ Ihre Zuordnungen gehen mit, und zwar in der Datenbank
 * (`ON DELETE CASCADE`, 007-marks.sql) und nicht hier. Ein Aufräumen im
 * Programm wäre eine zweite Anweisung ohne Transaktion: zwischen den beiden
 * stünde ein Fenster, in dem eine Zuordnung auf eine Marke zeigt, die es nicht
 * mehr gibt.
 */
export async function deleteMark(pool: Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM hub_mark WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}
