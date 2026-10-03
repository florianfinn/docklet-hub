import type { Router } from "express";
import type { Pool } from "pg";

import type { Auth } from "../../platform/auth/auth.js";
import { requireAdmin } from "../../platform/auth/require-admin.js";
import { failWith, guarded } from "../../platform/http/route-responses.js";
import { withSession } from "../../platform/auth/session.js";
import { setTargetMarks, writeStackDisplay, writeStackHidden } from "./assignment-store.js";
import { parseMarkIds, parseMarkInput, parseStackDisplay } from "./input.js";
import { handleMarkError } from "./mark-errors.js";
import { createMark, deleteMark, listMarks, updateMark } from "./store.js";

// The routes of the feature `marks` (#268): the stock of the own marks of the
// hub (list, create, change, remove; D7b, #62), the ASSIGNMENT of marks to a
// stack or a container, and the display per stack (indent, hide). They took the
// place of `appearance-routes.ts` (the stock) and `mark-assignment-routes.ts`
// (the assignment), which were two files only to stay under a limit of about
// 250 lines; the cut between them follows the subject, and it stays visible
// below: the first four routes write ONE mark, the last four write WHICH marks
// hang on a target.
//
// The global theme and the colour of an arm are the feature `appearance`; the
// check of a set of knobs both use stands in `platform/theme/knob-input.ts`.
//
// `GET /marks` stands behind `withSession` and the writing routes behind
// `requireAdmin`, as reasoned at each route: since #17 an administrator writes,
// everybody reads. An assignment is a setting of the hub and not of the
// account.
//
// ⚠️ TWO OF THE THREE PATH PARAMETERS OF AN ASSIGNMENT CARRY A FOREIGN NAME.
// Ein Compose-Projekt und ein Containername kommen aus der Antwort des Agenten
// und nicht aus diesem Hub — anders als `:markId`, das der Server selbst
// vergibt. Nachgeschlagen am 2026-09-06, damit die Form der Route nicht auf
// einer Annahme steht:
//
//   - Containername: `moby/moby`, `daemon/names/names.go` —
//     `RestrictedNamePattern = "^[a-zA-Z0-9][a-zA-Z0-9_.-]+$"`.
//   - Compose-Projekt: `compose-spec/compose-go`, `loader/loader.go` —
//     `NormalizeProjectName` behält `[a-z0-9_-]`, und `InvalidProjectNameErr`
//     sagt „must consist only of lowercase alphanumeric characters, hyphens,
//     and underscores".
//
// Beide Alphabete kennen KEINEN Schrägstrich. Der Pfad mit zwei Segmenten
// hält damit für alles, was Docker und Compose selbst vergeben.
//
// ⚠️ Was der Beleg NICHT deckt und was deshalb dasteht: der Hub liest das
// Projekt aus dem LABEL `com.docker.compose.project`, und ein Label kann von
// Hand gesetzt werden — an dieser Stelle hat es keine Prüfung mehr passiert.
// Die Route ist deshalb so gebaut, dass sie auch mit einem Schrägstrich im
// Namen hält: die Oberfläche kodiert ihn mit `encodeURIComponent` (das tut
// `web/src/platform/routes/stack-path.ts` heute schon), Express zerlegt den
// Pfad VOR dem Dekodieren, und ein `%2F` bleibt damit in einem Segment.
// `server/src/app/mark-routes.test.ts` prüft genau diesen Fall gegen den
// echten Router, statt ihn zu behaupten.

export function registerMarkRoutes(router: Router, { auth, pool }: { auth: Auth; pool: Pool }): void {
  // Der Bestand der eigenen Marken (D7b, #62).
  //
  // ⚠️ Hinter `withSession` und nicht hinter `requireAdmin`, aus demselben
  // Grund wie `GET /settings`: nach #17 schreibt ein Administrator, lesen alle.
  //
  // ⚠️ HIER STAND BIS ZUR ETAPPE D VON D7b EINE FALSCHE BEGRÜNDUNG: „ohne diese
  // Liste sähe er farbige Etiketten ohne Namen". Das stimmt nicht, und es ist
  // nachgemessen: `readHostDecoration` liest `m.name` mit
  // (`features/marks/assignment-store.ts`, das `SELECT a.target, a.target_key,
  // m.id, m.name, m.hue, m.style`), und `GET /api/overview` liefert damit
  // vollständige `MarkView`. Ein Benutzer ohne diese Route sähe seine Marken
  // also mit Namen — die Route ist nicht die Quelle der Namen, sondern die
  // Quelle des VORRATS: sie beantwortet „welche Marken gibt es im Hub", nicht
  // „wie heißt die hier". Ein Kommentar wird geglaubt, und ein geglaubter
  // falscher Grund ist die Vorlage für die nächste falsche Entscheidung.
  //
  // Die Zuordnung braucht den Vorrat, und der Vorrat trägt nichts Schützenswertes
  // über den Stand hinaus, den `GET /api/overview` ohnehin ausliefert: dieselben
  // Marken, dieselben Namen, dieselben Töne. `requireAdmin` verteidigte damit
  // nichts und träfe zugleich die Fläche der Einstellungen, die die Liste ohne
  // eine Zuordnung anzeigt. Gebrauch macht davon heute allein der Administrator
  // — `web/tests/marks-assign.test.tsx` prüft nach, dass ein Benutzer ohne
  // Rolle diese Route gar nicht erst abruft.
  //
  // Eine eigene Route und kein Feld in `GET /settings`: die Liste ändert sich
  // unabhängig von der Darstellung des Hubs, und die Fläche, die Marken
  // zuordnet (Etappe C), braucht sie, ohne das Theme mitzuladen.
  router.get(
    "/marks",
    withSession(auth, async (_request, response) => {
      response.json({ marks: await listMarks(pool) });
    })
  );

  // Eine Marke anlegen. 201 und die angelegte Marke — die Kennung entsteht im
  // Server, und ohne sie könnte die Oberfläche sie nicht wieder ansprechen.
  router.post(
    "/marks",
    requireAdmin(auth),
    guarded(async (request, response) => {
      const parsed = parseMarkInput(request.body);
      if (!parsed.ok) {
        failWith(response, 400, "invalid-input", parsed.message);
        return;
      }
      try {
        response.status(201).json({ mark: await createMark(pool, parsed.value) });
      } catch (error) {
        if (!handleMarkError(error, response)) throw error;
      }
    })
  );

  // Eine Marke ändern — der VOLLE Satz, wie überall in diesem Bereich.
  router.put(
    "/marks/:markId",
    requireAdmin(auth),
    guarded(async (request, response) => {
      const parsed = parseMarkInput(request.body);
      if (!parsed.ok) {
        failWith(response, 400, "invalid-input", parsed.message);
        return;
      }
      try {
        const mark = await updateMark(pool, String(request.params.markId), parsed.value);
        if (!mark) {
          response.status(404).json({ error: "mark-unknown" });
          return;
        }
        response.json({ mark });
      } catch (error) {
        if (!handleMarkError(error, response)) throw error;
      }
    })
  );

  // Eine Marke entfernen. 204 und kein Rumpf: die Antwort trüge nichts, was
  // der Aufrufer nicht schon wüsste.
  //
  // ⚠️ Ein zweiter Aufruf ist ein 404 und kein 204. „Es gibt sie nicht mehr"
  // und „es gab sie nie" sind für den Editor derselbe Zustand — aber ein
  // Editor, der auf eine getippte Kennung ein 204 bekommt, hält sie für
  // richtig.
  router.delete(
    "/marks/:markId",
    requireAdmin(auth),
    guarded(async (request, response) => {
      if (!(await deleteMark(pool, String(request.params.markId)))) {
        response.status(404).json({ error: "mark-unknown" });
        return;
      }
      response.status(204).end();
    })
  );

  // Die Marken eines Stacks setzen. Der ganze Satz, in der geschickten
  // Reihenfolge; zurück kommen die Marken mit Namen und Farbe, damit die
  // Oberfläche ihre Zeile ersetzen kann, statt sie aus Kennungen
  // zusammenzusuchen.
  router.put(
    "/hosts/:hostId/stacks/:project/marks",
    requireAdmin(auth),
    guarded(async (request, response) => {
      const parsed = parseMarkIds(request.body);
      if (!parsed.ok) {
        failWith(response, 400, "invalid-input", parsed.message);
        return;
      }
      try {
        const marks = await setTargetMarks(
          pool,
          String(request.params.hostId),
          "stack",
          String(request.params.project),
          parsed.value
        );
        response.json({ marks });
      } catch (error) {
        if (!handleMarkError(error, response)) throw error;
      }
    })
  );

  // Die Einrückung eines Stacks setzen — je Stack und nicht global
  // (Entscheidung des Betreibers vom 2026-09-06).
  router.put(
    "/hosts/:hostId/stacks/:project/display",
    requireAdmin(auth),
    guarded(async (request, response) => {
      const parsed = parseStackDisplay(request.body);
      if (!parsed.ok) {
        failWith(response, 400, "invalid-input", parsed.message);
        return;
      }
      try {
        const display = await writeStackDisplay(
          pool,
          String(request.params.hostId),
          String(request.params.project),
          parsed.value
        );
        response.json({ display });
      } catch (error) {
        if (!handleMarkError(error, response)) throw error;
      }
    })
  );

  // Einen Stack auf der Übersicht aus- oder wieder einblenden (015). Admin wie
  // die Einrückung: es ist eine Angabe für ALLE, die den Hub öffnen, und
  // keine Vorliebe des einzelnen Browsers.
  //
  // ⚠️ Der Rumpf ist `{ hidden: true | false }` und nichts anderes — ein
  // „ja", eine 1 oder ein fehlendes Feld ist kein Wahrheitswert, und ein
  // stilles `Boolean(…)` machte aus `"false"` ein Ausblenden.
  router.put(
    "/hosts/:hostId/stacks/:project/hidden",
    requireAdmin(auth),
    guarded(async (request, response) => {
      const hidden = (request.body as { hidden?: unknown } | undefined)?.hidden;
      if (typeof hidden !== "boolean") {
        failWith(response, 400, "invalid-input", "„hidden“ muss true oder false sein.");
        return;
      }
      try {
        const stored = await writeStackHidden(
          pool,
          String(request.params.hostId),
          String(request.params.project),
          hidden
        );
        response.json({ hidden: stored });
      } catch (error) {
        if (!handleMarkError(error, response)) throw error;
      }
    })
  );

  // Die Marken eines einzelnen Containers setzen. Derselbe Rumpf und dieselbe
  // Antwort wie beim Stack — es ist dieselbe Zuordnung mit einem anderen Ziel.
  router.put(
    "/hosts/:hostId/containers/:name/marks",
    requireAdmin(auth),
    guarded(async (request, response) => {
      const parsed = parseMarkIds(request.body);
      if (!parsed.ok) {
        failWith(response, 400, "invalid-input", parsed.message);
        return;
      }
      try {
        const marks = await setTargetMarks(
          pool,
          String(request.params.hostId),
          "container",
          String(request.params.name),
          parsed.value
        );
        response.json({ marks });
      } catch (error) {
        if (!handleMarkError(error, response)) throw error;
      }
    })
  );
}
