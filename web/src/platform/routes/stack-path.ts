// Die Adresse der Seite eines Stacks.
//
// ⚠️ EIN STACK HAT IM HUB KEINE KENNUNG. Er kommt flüchtig aus der Antwort des
// Agenten (docs/design/hub-color-and-structure.md §6: „Stacks und Container
// besitzen im Hub keine Kennung"). Die Adresse hängt deshalb am Paar aus
// Host-Kennung und Compose-Projekt — dem einzigen, was den Stack zwischen zwei
// Abfragen wiederfindet.
//
// ⚠️ Ein Projektname darf alles enthalten, was Docker erlaubt, und geht
// deshalb KODIERT in die Adresse. Ohne `encodeURIComponent` machte ein „/" aus
// einem Namen zwei Pfadabschnitte und die Route träfe nicht mehr; ein „#"
// schnitte den Rest der Adresse ab.
//
// ⚠️ Dekodiert wird hier NICHT, und das ist gemessen und kein Vertrauen:
// react-router 8.3.1 dekodiert die Parameter selbst
// (`decodePath` in web/node_modules/react-router/dist/development/lib/router/utils.js,
// Z. 532, aufgerufen in Z. 251). Ein zweites `decodeURIComponent` in der
// Fläche machte aus einem Projekt „a%2Fb" ein „a/b" — aus einem Namen mit
// Prozentzeichen also lautlos einen anderen Namen.

/**
 * Die Reiter der Stack-Seite, in der Reihenfolge, in der sie stehen.
 *
 * ⚠️ DREI UND NICHT SECHS. Das Artboard zeigt Protokoll, Compose, Umgebung,
 * Betrieb und Verlauf (hub-palette.html Z. 674–681). Gebaut sind davon
 * Compose (#35) und Protokoll (#183); die anderen drei gibt es nicht, und die
 * Regel des Projekts lautet: was es noch nicht gibt, erscheint nicht. Ein
 * ausgegrauter Reiter ist ein Versprechen, das die Fläche nicht halten kann.
 */
export type StackTab = "overview" | "logs" | "compose";

/**
 * Die Adresse dieses Stacks, wahlweise mit Reiter.
 *
 * ⚠️ DER REITER STEHT IN DER ADRESSE UND NICHT IM ZUSTAND DER FLÄCHE —
 * dieselbe Entscheidung wie bei der Container-Seite (`container-path.ts`), und
 * hier wiegt sie schwerer: der Compose-Reiter trägt einen ungespeicherten
 * Entwurf. Ein Neuladen, das auf den ersten Reiter zurückfiele, sähe für den
 * Betreiber aus, als sei seine Bearbeitung weg.
 *
 * ⚠️ EINE Funktion mit Reiter-Angabe und nicht zwei. Die Reiterleiste zeichnet
 * ihre Einträge aus einer Liste von `StackTab` und braucht einen Bauer, den sie
 * mit dem Reiter als WERT aufrufen kann; zwei Funktionen zwängen sie in eine
 * Verzweigung je Eintrag, und die Kodierung stünde zweimal da.
 */
export function stackPath(hostId: string, project: string, tab: StackTab = "overview"): string {
  const base = `/stack/${encodeURIComponent(hostId)}/${encodeURIComponent(project)}`;
  return tab === "overview" ? base : `${base}/${tab}`;
}
