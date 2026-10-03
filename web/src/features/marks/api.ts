// The calls of the feature `marks` to the hub (#268): the own marks, their
// assignment to a stack or a container, and the display per stack (indent and
// hide). Moved here from `web/src/api/client.ts` unchanged; the reasons stand at
// each call.
//
// ⚠️ THE MIRROR GUARD READS THIS FILE: `web/tests/client-files.mjs` collects
// every `api.ts` under `web/src/` next to `platform/http/`, so a
// call here is held against the routes of the server like any other.

import type { IndentName, MarkThemePreset, MarkView } from "contract";

import { postJson, putJson, request, requestNoContent } from "../../platform/http/transport";

// Die eigenen Marken des Hubs (D7b, #62).
//
// ⚠️ ALLE VIER FUNKTIONEN PACKEN IHREN UMSCHLAG AUS und versprechen den Typ,
// den sie wirklich liefern. Das ist die Lehre aus dem Fehler, der bis D7a auf
// dem Standardbranch stand (siehe `createHost` unten): `request<T>` castet die
// Antwort BLIND (`(await response.json()) as T`), TypeScript sieht eine falsche
// Zusage also nicht. Eine Funktion, die hier `MarkView` verspräche und
// `{ mark: … }` zurückgäbe, ergäbe eine Marke mit `id: undefined` — und die
// Zeile im Editor stünde kaputt da, bis jemand neu lädt. Die Fehlerklasse ist
// weiterhin UNBEWACHT: kein Test dieses Repos hält die deklarierten
// Rückgabetypen dieser Datei gegen die obersten Schlüssel der
// `response.json(…)`-Aufrufe des Routers.
//
// ⚠️ `GET /api/marks` steht hinter `withSession` und NICHT hinter
// `requireAdmin` (server/src/features/marks/routes.ts, Begründung dort): die Marken hängen
// an Stacks und Container-Zeilen, die jeder angemeldete Benutzer sieht. Die
// drei schreibenden Routen sind Admin — die Tafel zeigt einem Benutzer ohne
// Rolle deshalb die Liste und keine Bedienelemente.
export async function fetchMarks(): Promise<MarkView[]> {
  const { marks } = await request<{ marks: MarkView[] }>("/api/marks");
  return marks;
}

// Eine Marke anlegen. Der Server antwortet mit 201 und der ANGELEGTEN Marke —
// die Kennung entsteht dort, und ohne sie könnte die Oberfläche sie nie wieder
// ansprechen.
//
// ⚠️ Ein Name, den es schon gibt, ist ein **409** mit
// `{ error: "name-taken", message }` (`handleMarkError`, router.ts:122). Das
// ist der Fall, den der Betreiber tatsächlich auslöst, und er wird an der
// Aufrufstelle als eigene Meldung gezeigt (`mark-errors.ts`).
export async function createMark(input: MarkThemePreset & { name: string }): Promise<MarkView> {
  const { mark } = await postJson<{ mark: MarkView }>("/api/marks", { mark: input });
  return mark;
}

// Eine Marke ändern. Der VOLLE Satz reist, wie überall in diesem Bereich: ein
// Rumpf, der nur das geänderte Feld trüge, hinterließe eine Mischung aus altem
// und neuem Stand, die niemand mehr benennen kann.
export async function updateMark(
  markId: string,
  input: MarkThemePreset & { name: string }
): Promise<MarkView> {
  const { mark } = await putJson<{ mark: MarkView }>(`/api/marks/${encodeURIComponent(markId)}`, {
    mark: input
  });
  return mark;
}

// Eine Marke entfernen. 204 ohne Rumpf — deshalb `requestNoContent`.
//
// ⚠️ MIT IHR VERSCHWINDEN IHRE ZUORDNUNGEN. `mark_assignment.mark_id` trägt
// `ON DELETE CASCADE` (server/src/platform/db/migrations/007-marks.sql:134, nachgesehen):
// die Marke geht von jedem Stack und jedem Container ab, dem sie zugeordnet
// war, und das in einem Schritt, den nichts zurücknimmt. Die Aufrufstelle fragt
// deshalb vorher und sagt im Text, was geschieht.
export function deleteMark(markId: string): Promise<void> {
  return requestNoContent(`/api/marks/${encodeURIComponent(markId)}`, { method: "DELETE" });
}

// Die ZUORDNUNG der Marken (D7b/C2, #62): welche Marken ein Stack und welche
// ein einzelner Container trägt, dazu die Einrückung eines Stacks.
//
// ⚠️ DER GANZE SATZ REIST, NICHT EIN ZUSATZ. `PUT …/marks` ERSETZT die
// Zuordnung des Ziels: die Liste im Rumpf ist danach genau die Liste am Ziel,
// und ihre Reihenfolge ist die Reihenfolge (`parseMarkIds` in
// `server/src/features/marks/input.ts`, nachgelesen — sie sortiert nicht und
// normalisiert nicht). Wer eine Marke ANHÄNGT, schickt also die alten plus die
// neue; wer eine abzieht, schickt den Rest. Eine Funktion, die nur die neue
// Kennung schickte, löschte alle übrigen — lautlos und mit einer 200 als
// Antwort.
//
// ⚠️ DIE LEERE LISTE IST GÜLTIG und heißt „dieses Ziel trägt keine Marke
// mehr". Sie ist der einzige Weg, die letzte Marke wieder abzuziehen.
//
// ⚠️ WAS DER SERVER ABLEHNT, gemessen an `parseMarkIds` und `handleMarkError`
// (`server/src/features/marks/routes.ts`): mehr als `MARK_IDS_MAX` Einträge
// und eine Dublette sind 400 „invalid-input"; eine Kennung, die es nicht mehr
// gibt, ist 404 „mark-unknown", ein unbekannter Arm 404 „host-unknown". Der
// Fall `name-taken` (409) gehört zu `createMark`/`updateMark` und kann hier
// nicht auftreten — diese drei Routen tragen keinen Namen.
//
// ⚠️ ALLE DREI PACKEN IHREN UMSCHLAG AUS, aus demselben Grund wie die vier
// Funktionen darüber: `request<T>` castet blind, TypeScript sieht eine falsche
// Zusage nicht. Die Rümpfe sind `{ marks }` und `{ display }` — abgelesen an
// `response.json({ marks })` bzw. `response.json({ display })` im Router
// (Z. 636, 661, 687).

/**
 * Die Marken EINES STACKS setzen (Admin).
 *
 * Zurück kommen die Marken mit Namen und Ton, nicht nur ihre Kennungen: die
 * Oberfläche ersetzt damit ihre Zeile, statt sie aus einer zweiten Liste
 * zusammenzusuchen — und trägt danach genau den Stand des Servers.
 */
export async function setStackMarks(
  hostId: string,
  project: string,
  markIds: readonly string[]
): Promise<MarkView[]> {
  const { marks } = await putJson<{ marks: MarkView[] }>(
    `/api/hosts/${encodeURIComponent(hostId)}/stacks/${encodeURIComponent(project)}/marks`,
    { markIds }
  );
  return marks;
}

/**
 * Die Marken EINES CONTAINERS setzen (Admin).
 *
 * ⚠️ Das Ziel ist der VOLLSTÄNDIGE Container-Name („monitoring-grafana-1") und
 * nicht der Dienstname und nicht die Kennung von Docker. Gemessen: der Router
 * reicht `request.params.name` als `targetKey` an `setTargetMarks` durch, und
 * die Anreicherung der Übersicht liest denselben Schlüssel
 * (`server/src/containers/overview.ts:72`, `marksByContainer.get(name)`). Ein
 * Aufruf mit der Docker-Kennung schriebe eine Zuordnung, die an keiner Zeile
 * je wieder auftaucht.
 */
export async function setContainerMarks(
  hostId: string,
  containerName: string,
  markIds: readonly string[]
): Promise<MarkView[]> {
  const { marks } = await putJson<{ marks: MarkView[] }>(
    `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerName)}/marks`,
    { markIds }
  );
  return marks;
}

/**
 * Die Einrückung EINES STACKS setzen (Admin) — je Stack und nicht global
 * (docs/design/hub-color-and-structure.md §4).
 *
 * ⚠️ Sie verspricht `IndentName` und nicht `{ display }`: der Rumpf trägt
 * heute genau ein Feld, und die Aufrufstelle braucht genau dieses. Käme eine
 * zweite Stellschraube für den Stack dazu, wäre das hier eine Änderung des
 * Rückgabetyps und damit ein Typfehler an jeder Aufrufstelle — und nicht ein
 * Feld, das niemand liest.
 */
export async function setStackIndent(
  hostId: string,
  project: string,
  indent: IndentName
): Promise<IndentName> {
  const { display } = await putJson<{ display: { indent: IndentName } }>(
    `/api/hosts/${encodeURIComponent(hostId)}/stacks/${encodeURIComponent(project)}/display`,
    { display: { indent } }
  );
  return display.indent;
}

/**
 * Einen Stack auf der Übersicht aus- oder wieder einblenden (Admin). Meldet
 * den gespeicherten Stand zurück.
 */
export async function setStackHidden(hostId: string, project: string, hidden: boolean): Promise<boolean> {
  const answer = await putJson<{ hidden: boolean }>(
    `/api/hosts/${encodeURIComponent(hostId)}/stacks/${encodeURIComponent(project)}/hidden`,
    { hidden }
  );
  return answer.hidden;
}
