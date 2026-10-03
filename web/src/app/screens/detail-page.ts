// Der Rahmen der beiden Detailseiten, Container und Stack.
//
// ⚠️ VOLLE BREITE UND KEIN `max-w-4xl` WIE AUF DEN ÜBRIGEN SEITEN. Ein Log und
// eine Shell sind Zeilen fester Breite; in 56rem brach eine Zeile von
// AdGuard Home dreimal um, während daneben die halbe Fensterbreite leer stand
// (Befund des Betreibers am 2026-09-29). Die Breite hängt an der SEITE und
// nicht am Reiter: hinge sie am Reiter, spränge beim Wechsel die Überschrift
// samt Reiterleiste nach links. Die Übersichten, die aus Fließtext und kurzen
// Werten bestehen, begrenzen sich selbst.
//
// ⚠️ UND IM PROTOKOLL GENAU DIE HÖHE DES FENSTERS. Die Seite ist dann so hoch
// wie das, was unter der Kopfzeile Platz hat (`--shell-header-height`, gesetzt
// in `shell/AppShell.tsx`); das Log füllt den Rest und scrollt in sich, statt
// die Seite zu verlängern. Vorher hing die Höhe am Inhalt: in einem schmalen
// Fenster wurde die Seite mit jeder umgebrochenen Zeile länger, in einem
// breiten blieb das Feld kurz. Die Untergrenze greift erst in einem Fenster,
// in dem Kopf, Reiter und Filter allein fast alles belegen — dann scrollt
// ausnahmsweise die Seite, und das Log bleibt lesbar.

const DETAIL_PAGE = "flex w-full min-w-0 flex-col gap-5 px-8 py-7";
const WINDOW_HIGH = "h-[calc(100svh-var(--shell-header-height))] min-h-[32rem]";

/** Die Klassen des Seitenrahmens; `fillsWindow` für einen Reiter, der in sich scrollt. */
export function detailPageClass(fillsWindow: boolean): string {
  return fillsWindow ? `${DETAIL_PAGE} ${WINDOW_HIGH}` : DETAIL_PAGE;
}
