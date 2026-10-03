// Der Pfad INNERHALB der Freigabe — und wo er steht.
//
// ⚠️ ER STEHT IN DER ADRESSE UND NICHT IN EINEM `useState`, aus demselben
// Grund wie der Reiter (Entscheidung des Betreibers vom 2026-09-07, festgehalten
// in `container/container-path.ts`): ein Zustand überstünde kein Neuladen und
// wäre nicht verlinkbar. Wer bei einer Fehlersuche drei Ebenen tief steht und
// neu lädt, will nicht wieder in der Wurzel anfangen — und wer jemandem sagt,
// wo er hinschauen soll, will eine Adresse schicken können.
//
// ⚠️ ALS ABFRAGETEIL (`?path=…`) UND NICHT ALS PFADSEGMENT, und das ist eine
// Entscheidung mit drei Gründen:
//
//   1. Ein Pfad in der Freigabe enthält SELBST Schrägstriche. Als Segment
//      bräuchte die Route einen Splat (`/files/*`), und react-router zerlegte
//      ihn an den Schrägstrichen — ein Verzeichnisname, der einen kodierten
//      Schrägstrich enthält, wäre danach nicht mehr von einer Ebenengrenze zu
//      unterscheiden. Im Abfrageteil ist der ganze Pfad EIN Wert.
//   2. Die Reiterleiste verweist auf `containerPath(…, "files")`. Trüge der
//      Pfad ein Segment, wäre die Adresse des Reiters ein PRÄFIX der Adresse
//      des Unterverzeichnisses, und `aria-current="page"` müsste anders
//      bestimmt werden als bei den anderen Reitern — eine zweite Regel für
//      dieselbe Frage.
//   3. Der Reiter ist ein ORT, der Pfad eine ANSICHT dieses Ortes. Genau diese
//      Trennung ist die Aufgabe des Abfrageteils.
//
// ⚠️ KEIN `decodeURIComponent` BEIM LESEN. `useSearchParams` liefert den Wert
// bereits dekodiert (dieselbe Messung wie bei den Adressparametern von
// react-router 8.3.1, siehe `container/container-path.ts`); ein zweites
// Dekodieren machte aus „a%2Fb" still ein „a/b" — also aus einem Namen einen
// anderen, und zwar einen, den es womöglich gibt.

/**
 * Der Name des Abfrageparameters.
 *
 * ⚠️ `path` und nicht `pfad`: der Agent hat diesen Schlüssel umbenannt, und
 * seine Anfrage-Schemas in `contract/src/agent/` kennen nur noch den neuen
 * Namen. Derselbe Name wie
 * an der Route ist zudem kein Zufall, sondern spart die Übersetzung: was in
 * der Adresse der Fläche steht, geht unverändert an den Server.
 */
export const FILES_PATH_PARAM = "path";

/**
 * Der Name des Abfrageparameters für die Datei, die im Editor offen ist.
 *
 * ⚠️ EIN ZWEITER PARAMETER UND NICHT DERSELBE. `path` sagt, welches
 * VERZEICHNIS gezeigt wird; `edit` sagt, welche Datei darin gerade bearbeitet
 * wird. Beides in einen Wert zu legen ginge nicht: die Fläche zeigt die Liste
 * des Verzeichnisses UND den Editor, und aus einem Pfad allein ließe sich
 * nicht ablesen, welches von beiden er meint.
 *
 * ⚠️ ER STEHT IN DER ADRESSE UND NICHT IN EINEM `useState`, aus denselben
 * Gründen wie `path`: ein offener Editor übersteht damit ein Neuladen, und wer
 * jemandem sagt, wo er hinschauen soll, kann die Adresse schicken. Ein
 * `useState` wäre in einem Test, der KLICKT, nicht davon zu unterscheiden —
 * rot würde er erst beim frischen Einhängen unter der Adresse.
 *
 * ⚠️ `edit` UND NICHT `bearbeiten`: Bezeichner dieses Repos, und damit auch
 * seine Adressparameter, sind englisch (AGENTS.md, Abschnitt Sprache).
 */
export const FILES_EDIT_PARAM = "edit";

/**
 * Der Pfad eine Ebene weiter oben. Die Wurzel der Freigabe ist der leere Text,
 * und über ihr liegt nichts — `parentPath("")` bleibt `""`.
 */
export function parentPath(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/**
 * Der Pfad eines Eintrags in diesem Verzeichnis.
 *
 * ⚠️ In der Wurzel OHNE führenden Schrägstrich. Der Agent liest einen Pfad
 * relativ zur Freigabe; ein „/x" sähe aus wie ein absoluter Pfad und wäre für
 * die Traversal-Prüfung der Gegenseite eine andere Frage als „x".
 */
export function childPath(path: string, name: string): string {
  return path === "" ? name : `${path}/${name}`;
}
