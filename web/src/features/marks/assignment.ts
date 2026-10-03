import type { MarkView } from "contract";

/**
 * Was eine Container-Zeile braucht, um ihre Marken vergeben zu lassen
 * (D7b/C2, #62).
 *
 * ⚠️ EIN OBJEKT UND NICHT DREI EIGENSCHAFTEN. Zwischen `ContainersScreen` und
 * `ContainerRow` liegen drei Bauteile (`HostContainers`, `StackSection`,
 * `ContainerList`), die mit dem Zuordnen nichts zu tun haben und es nur
 * durchreichen. Drei einzelne Eigenschaften wären dreimal drei Zeilen in
 * Dateien, die davon nichts wissen — und die nächste Angabe wäre die vierte.
 *
 * ⚠️ SEIN FEHLEN IST DIE UNTERSCHEIDUNG. Dieselbe `ContainerRow` steht im
 * Deepdive, in der Übersicht unter dem aufgeklappten Stack und auf der Seite
 * eines Stacks. Nur der Deepdive reicht dieses Objekt durch; die anderen
 * beiden reichen nichts, und ohne es zeichnet die Zeile keinen Griff. Ein
 * `variant`- oder `mode`-Schalter wäre die Alternative gewesen und wäre die
 * Sorte Angabe, die beim nächsten Umbau an der falschen Stelle steht — hier
 * KANN eine Fläche den Griff nicht zeigen, die das Objekt nicht hat.
 *
 * ⚠️ DIE KENNUNG DES ARMS STECKT IN `onChange` UND NICHT IN DIESEM TYP. Sie
 * ist an der Stelle bekannt, an der das Objekt entsteht (`ContainersScreen`
 * geht die Arme durch); ein Feld dafür wäre eine Angabe, die jede
 * durchreichende Datei mitschleppt und niemand liest.
 */
export type MarkAssignment = {
  /**
   * Alle Marken des Hubs — die Auswahl. `null` heißt „noch nicht geladen" und
   * ist nicht dasselbe wie „es gibt keine".
   */
  available: readonly MarkView[] | null;
  /**
   * Schreibt den GANZEN Satz für diesen Container und trägt den gespeicherten
   * Stand ins Bild ein.
   *
   * ⚠️ Der Schlüssel ist der VOLLSTÄNDIGE Container-Name und nicht der
   * Dienstname: der Router nimmt ihn als `targetKey`, und die Anreicherung der
   * Übersicht liest denselben (`server/src/containers/overview.ts:72`).
   */
  onChange: (containerName: string, markIds: string[]) => Promise<void>;
};
