import { clearEditorDrafts } from "../editor/useEditorDocument";
// Der eine Ort, an dem eine abgelaufene Sitzung ankommt (#127).
//
// ⚠️ WARUM ES DIESE DATEI GIBT. Bis hierher stand `status === 401` genau
// einmal im Web, in `web/src/App.tsx` beim Start (gemessen am 2026-09-09 auf
// `00b6c22`: `grep -rn "status === 401" web/src` liefert diese eine Zeile).
// Läuft die Sitzung WÄHREND der Arbeit ab, bekommt jede Fläche denselben 401
// als gewöhnlichen `ApiError` und zeigt ihre allgemeine Fehlermeldung: die
// Container-Liste „konnte nicht geholt werden", der Log-Strom „unbekannter
// Fehler". Kein Satz davon nennt die Anmeldung; erst ein Neuladen führt
// dorthin.
//
// Die Antwort auf einen 401 ist aber keine Frage der Fläche, sondern eine des
// ganzen Fensters — es gibt genau eine, und sie lautet: zurück zur Anmeldung.
// Deshalb steht sie nicht an acht Stellen, sondern an einer.
//
// ⚠️ KEIN REACT-KONTEXT UND KEIN HAKEN, obwohl der Empfänger eine Komponente
// ist. Der Melder sitzt im Transport (`transport.ts`), und der ist ein
// gewöhnliches Modul ohne Baum: ein `useContext` ist dort nicht zu haben, und
// der Weg über einen Anbieter hieße, den Transport durch die Komponenten zu
// reichen — durch jedes `api.ts` unter `web/src/`, bis hinunter zum `XHR` des
// Datei-Uploads. Ein Modulwert mit Anmeldung ist der kurze Weg, und er kostet
// nichts: die Anmeldung geschieht im Effekt, die Abmeldung in seinem
// Aufräumer, und mehr als ein Zuhörer ist ausdrücklich erlaubt.

/** Was ein Zuhörer bekommt: die Nachricht selbst, ohne Nutzlast. */
export type UnauthorizedListener = () => void;

const listeners = new Set<UnauthorizedListener>();

/**
 * Meldet einen 401. Gerufen vom Transport, nicht von einer Fläche.
 *
 * ⚠️ Die Kopie (`[...listeners]`) ist kein Beiwerk: ein Zuhörer, der sich
 * IM Empfangen abmeldet, änderte sonst die Menge, über die gerade gelaufen
 * wird. Genau das tut React beim Aufräumen eines Effekts.
 */
export function reportUnauthorized(): void {
  clearEditorDrafts();
  for (const listener of [...listeners]) listener();
}

/**
 * Hört auf einen 401 und liefert die Abmeldung zurück.
 *
 * Die Rückgabe ist die Form, die ein React-Effekt direkt zurückgeben kann
 * (`useEffect(() => onUnauthorized(…), [])`) — ohne sie bliebe ein Zuhörer
 * nach dem Aushängen stehen und schriebe in einen Zustand, den es nicht mehr
 * gibt.
 */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
