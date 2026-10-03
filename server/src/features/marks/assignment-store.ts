import type { Pool } from "pg";

import { DEFAULT_STACK_DISPLAY, type IndentName, type MarkView, type StackDisplayPreset } from "contract";

import { MarkError, type HostDecoration, type MarkTarget } from "./types.js";

// Der Weg zu den zwei Tabellen, die am PAAR hängen: `mark_assignment` (wer
// welche Marke trägt) und `stack_display` (Einrückung und Ausblenden je
// Stack).
//
// Getrennt von `store.ts`, wo der BESTAND der Marken steht: das sind zwei
// Fragen. Eine Marke gibt es oder nicht; wer sie trägt, ist eine Angabe je Arm
// und Name. Zusammen wäre es eine Datei, die mit jeder weiteren Zuordnung
// wächst.
//
// ⚠️ Der Schlüssel ist der NAME und keine Kennung — die Begründung steht im
// Kopf von `007-marks.sql` und wird hier nicht wiederholt.

type AssignmentRow = {
  target: string;
  target_key: string;
  id: string;
  name: string;
  hue: string;
  style: string;
};

type IndentRow = { project: string; indent: string };

type DisplayRow = IndentRow & { hidden: boolean };

function toView(row: AssignmentRow): MarkView {
  return { id: row.id, name: row.name, hue: row.hue as MarkView["hue"], style: row.style as MarkView["style"] };
}

/** Hängt einen Wert an die Liste seines Schlüssels. */
function push(into: Map<string, MarkView[]>, key: string, view: MarkView): void {
  const found = into.get(key);
  if (found) found.push(view);
  else into.set(key, [view]);
}

/**
 * Alles, was ein Arm an eigenen Angaben mitbringt — in ZWEI Abfragen.
 *
 * ⚠️ Zwei Abfragen und nicht eine je Stack. Die Übersicht baut alle Arme
 * nebeneinander (`buildOverview`); eine Abfrage je Stack wäre eine Frage je
 * Zeile der Fläche, die nach der Anmeldung erscheint.
 *
 * ⚠️ Auch nicht ein `JOIN` über beides. Marken und Einrückung stehen an
 * verschiedenen Schlüsseln (die Marken auch an Containern, die Einrückung nur
 * an Stacks); zusammengezogen käme jede Marke so oft heraus, wie es Zeilen der
 * anderen Tabelle gibt, und der Hub müsste das im Programm wieder auseinander
 * nehmen.
 *
 * ⚠️ `ORDER BY position` ist die Reihenfolge des Betreibers und keine Zierde.
 * Ohne sie gäbe Postgres gar keine Zusage über die Reihenfolge der Zeilen —
 * die Marken eines Stacks stünden dann bei jedem Laden anders da.
 *
 * ⚠️ Der `JOIN` auf `hub_mark` ist ein innerer und darf einer sein: der
 * Fremdschlüssel mit `ON DELETE CASCADE` lässt keine Zuordnung ohne Marke
 * übrig. Eine Zuordnung, deren STACK verschwunden ist, bleibt dagegen liegen
 * und kommt hier mit heraus — sie hat einfach keinen Empfänger, bis der Stack
 * wieder auftaucht (007-marks.sql, Kopf).
 */
export async function readHostDecoration(pool: Pool, hostId: string): Promise<HostDecoration> {
  const marksByStack = new Map<string, MarkView[]>();
  const marksByContainer = new Map<string, MarkView[]>();
  const indentByStack = new Map<string, IndentName>();
  const hiddenStacks = new Set<string>();

  const assignments = await pool.query<AssignmentRow>(
    `SELECT a.target, a.target_key, m.id, m.name, m.hue, m.style
       FROM mark_assignment a
       JOIN hub_mark m ON m.id = a.mark_id
      WHERE a.host_id = $1
      ORDER BY a.target, a.target_key, a.position`,
    [hostId]
  );
  for (const row of assignments.rows) {
    const into = row.target === "container" ? marksByContainer : marksByStack;
    push(into, row.target_key, toView(row));
  }

  const displays = await pool.query<DisplayRow>(
    `SELECT project, indent, hidden FROM stack_display WHERE host_id = $1`,
    [hostId]
  );
  for (const row of displays.rows) {
    indentByStack.set(row.project, row.indent as IndentName);
    // ⚠️ `=== true` und nicht nur der Wert: eine Antwort ohne die Spalte
    // (ein Stand vor 015, ein Testpool) heißt „sichtbar" und nicht „fehlt".
    if (row.hidden === true) hiddenStacks.add(row.project);
  }

  return { marksByStack, marksByContainer, indentByStack, hiddenStacks };
}

/**
 * Ersetzt die Marken EINES Ziels durch die übergebene Liste und meldet sie in
 * ihrer neuen Reihenfolge zurück.
 *
 * ⚠️ EINE Anweisung, und das ist der Punkt. „Löschen, dann einfügen" wären
 * zwei, und zwischen ihnen stünde ein Fenster, in dem das Ziel gar keine Marke
 * trägt — ein zweiter Leser sähe es leer. Eine Transaktion ginge auch, brauchte
 * aber eine Verbindung aus dem Pool und ein `BEGIN`/`COMMIT` mit allem, was
 * daran schiefgehen kann; eine Anweisung ist in Postgres ohnehin atomar.
 *
 * ⚠️ WARUM NICHT „ALLES LÖSCHEN UND NEU EINFÜGEN" IN DERSELBEN ANWEISUNG: die
 * ändernden Ausdrücke einer `WITH`-Anweisung sehen ALLE denselben Stand. Ein
 * `DELETE` und ein `INSERT` nebeneinander wüssten nichts voneinander, und eine
 * Marke, die vorher schon dastand und wieder geschickt wird, liefe in den
 * Primärschlüssel — die Anweisung bräche mit einem Datenbankfehler, obwohl
 * nichts falsch war. Deshalb löscht `removed` nur, was NICHT in der neuen
 * Liste steht, und `upserted` schreibt die Position der übrigen fort.
 *
 * ⚠️ `NOT IN (SELECT …)` über eine LEERE Liste trifft jede Zeile — genau
 * richtig: eine leere `markIds` zieht alle Marken dieses Ziels ab. Die
 * NULL-Falle von `NOT IN` greift hier nicht, weil `mark_id` `NOT NULL` ist.
 *
 * ⚠️ `WITH ORDINALITY` zählt ab 1, `position` ab 0. Die Verschiebung steht in
 * der Anweisung und nicht im Programm: die Reihenfolge des Feldes IST die
 * Reihenfolge, und sie soll nicht zweimal irgendwo umgerechnet werden.
 */
export async function setTargetMarks(
  pool: Pool,
  hostId: string,
  target: MarkTarget,
  targetKey: string,
  markIds: readonly string[]
): Promise<MarkView[]> {
  try {
    const { rows } = await pool.query<AssignmentRow>(
      `WITH wanted AS (
         SELECT entry.mark_id, entry.ordinality - 1 AS position
           FROM unnest($4::text[]) WITH ORDINALITY AS entry(mark_id, ordinality)
       ),
       removed AS (
         DELETE FROM mark_assignment
          WHERE host_id = $1 AND target = $2 AND target_key = $3
            AND mark_id NOT IN (SELECT mark_id FROM wanted)
       ),
       upserted AS (
         INSERT INTO mark_assignment (host_id, target, target_key, mark_id, position)
         SELECT $1, $2, $3, wanted.mark_id, wanted.position FROM wanted
         ON CONFLICT (host_id, target, target_key, mark_id)
         DO UPDATE SET position = EXCLUDED.position
         RETURNING mark_id, position
       )
       SELECT $2::text AS target, $3::text AS target_key, m.id, m.name, m.hue, m.style
         FROM upserted
         JOIN hub_mark m ON m.id = upserted.mark_id
        ORDER BY upserted.position`,
      [hostId, target, targetKey, [...markIds]]
    );
    return rows.map(toView);
  } catch (error) {
    throw translateForeignKey(error, hostId);
  }
}

/**
 * Ein verletzter Fremdschlüssel als Fehler MIT NAMEN.
 *
 * Beide Fälle sind Anfragen, die ein Aufrufer stellen kann, und keine
 * Programmierfehler: eine Kennung, die es nicht (mehr) gibt. Ohne diese
 * Übersetzung wäre beides eine 500 mit dem Text der Datenbank darin.
 *
 * ⚠️ Unterschieden wird über den NAMEN der Schranke und nicht über den Code
 * allein: `23503` sagt nur „ein Fremdschlüssel", und die Antwort „der Arm ist
 * unbekannt" auf eine unbekannte Marke wäre eine falsche Auskunft. Die Namen
 * sind die, die Postgres aus `007-marks.sql` selbst vergibt
 * (`<tabelle>_<spalte>_fkey`).
 */
function translateForeignKey(error: unknown, hostId: string): unknown {
  if (typeof error !== "object" || error === null) return error;
  const candidate = error as { code?: unknown; constraint?: unknown };
  if (candidate.code !== "23503") return error;
  if (candidate.constraint === "mark_assignment_host_id_fkey") {
    return new MarkError("host-unknown", `Einen Arm mit der Kennung „${hostId}" gibt es nicht.`);
  }
  if (candidate.constraint === "mark_assignment_mark_id_fkey") {
    return new MarkError("mark-unknown", "Mindestens eine der übergebenen Marken gibt es nicht.");
  }
  return error;
}

/**
 * Die Einrückung eines Stacks. `DEFAULT_STACK_DISPLAY`, wenn nichts
 * eingestellt ist.
 *
 * ⚠️ Der Rückfall ist hier der NORMALFALL und nicht der Fall „von Hand
 * gelöscht" wie in `features/appearance/store.ts`: eine Zeile in `stack_display` entsteht
 * erst, wenn der Betreiber etwas einstellt, und der Hub kennt die Stacks eines
 * Arms gar nicht, bevor ein Agent sie meldet. Eine Ausnahme wäre hier deshalb
 * falsch — die Fläche bekäme für jeden unberührten Stack einen Fehler.
 */
export async function readStackDisplay(
  pool: Pool,
  hostId: string,
  project: string
): Promise<StackDisplayPreset> {
  const { rows } = await pool.query<IndentRow>(
    `SELECT project, indent FROM stack_display WHERE host_id = $1 AND project = $2`,
    [hostId, project]
  );
  return rows[0] ? { indent: rows[0].indent as IndentName } : DEFAULT_STACK_DISPLAY;
}

/**
 * Schreibt die Einrückung eines Stacks und meldet sie zurück.
 *
 * ⚠️ Ein Einfügen mit `ON CONFLICT` und kein „lesen, prüfen, schreiben": die
 * Zeile gibt es beim ersten Mal nicht, und zwei Administratoren, die
 * gleichzeitig denselben Stack einstellen, legten sonst beide eine an — die
 * zweite liefe in den Primärschlüssel, und der Hub meldete einen
 * Datenbankfehler auf eine Einstellung. Dieselbe Bauart wie in
 * `features/appearance/store.ts`.
 *
 * ⚠️ Der zurückgemeldete Stand kommt aus `RETURNING` und nicht aus einem
 * zweiten Lesen — sonst behauptete die Antwort einen Stand, der zwischen
 * Schreiben und Lesen schon ein anderer sein kann.
 */
export async function writeStackDisplay(
  pool: Pool,
  hostId: string,
  project: string,
  display: StackDisplayPreset
): Promise<StackDisplayPreset> {
  try {
    const { rows } = await pool.query<IndentRow>(
      `INSERT INTO stack_display (host_id, project, indent)
       VALUES ($1, $2, $3)
       ON CONFLICT (host_id, project) DO UPDATE SET indent = EXCLUDED.indent
       RETURNING project, indent`,
      [hostId, project, display.indent]
    );
    return { indent: rows[0].indent as IndentName };
  } catch (error) {
    throw translateStackForeignKey(error, hostId);
  }
}

/**
 * Blendet einen Stack auf der Übersicht aus oder wieder ein und meldet den
 * gespeicherten Stand zurück.
 *
 * ⚠️ Dieselbe Bauart wie `writeStackDisplay` — `ON CONFLICT` statt „lesen,
 * prüfen, schreiben", der Stand aus `RETURNING`. Das `DO UPDATE` setzt NUR
 * `hidden`: die Einrückung desselben Stacks bleibt, wie sie war.
 */
export async function writeStackHidden(
  pool: Pool,
  hostId: string,
  project: string,
  hidden: boolean
): Promise<boolean> {
  try {
    const { rows } = await pool.query<{ hidden: boolean }>(
      `INSERT INTO stack_display (host_id, project, hidden)
       VALUES ($1, $2, $3)
       ON CONFLICT (host_id, project) DO UPDATE SET hidden = EXCLUDED.hidden
       RETURNING hidden`,
      [hostId, project, hidden]
    );
    return rows[0].hidden;
  } catch (error) {
    throw translateStackForeignKey(error, hostId);
  }
}

/** Wie `translateForeignKey`, für die Schranke von `stack_display`. */
function translateStackForeignKey(error: unknown, hostId: string): unknown {
  if (typeof error !== "object" || error === null) return error;
  const candidate = error as { code?: unknown; constraint?: unknown };
  if (candidate.code !== "23503") return error;
  if (candidate.constraint === "stack_display_host_id_fkey") {
    return new MarkError("host-unknown", `Einen Arm mit der Kennung „${hostId}" gibt es nicht.`);
  }
  return error;
}
