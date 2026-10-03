import { useDeepDiveSlots } from "../containers/container-slots";
import { ContainersView } from "../../features/containers";
import type { Role } from "../../platform/session/session-user";

// Die Fläche „Container" — der Deepdive der Übersicht (D6b, #62).
//
// „Container ist der Deepdive: jeder Container einzeln, nach Host geordnet,
// die Container eines Stacks eingerückt unter ihm"
// (docs/design/hub-color-and-structure.md §5). Die Übersicht beantwortet
// „läuft mein Haus"; diese Fläche beantwortet „was läuft in meinem Haus".
//
// ⚠️ SEIT D7b/C2 IST DIES DER ORT, AN DEM DIE MARKEN EINES EINZELNEN
// CONTAINERS VERGEBEN WERDEN. Der Deepdive ist die Fläche, die jeden Container
// einzeln führt (§5) — die Übersicht führt Stacks und klappt Container nur
// auf, und die Seite eines Stacks führt ihn ebenfalls nicht einzeln, sondern
// zeigt seinen Stack. Ein zweiter Weg zum selben Ziel wären zwei Stellen, die
// auseinanderlaufen.
//
// ⚠️ DIE MARKEN EINES STACKS VERGIBT SEINE SEITE UND NICHT DIESE FLÄCHE. Die
// Stack-Kopfzeile hier ist ein `Link` über die ganze Zeile
// (`features/containers/StackSection.tsx`), und ein Bedienelement darin wäre
// verschachtelte Bedienung und ungültiges HTML.
//
// ⚠️ KEIN NEUER ENDPUNKT. Die Daten sind dieselben wie die der Übersicht
// (`GET /api/overview`, je Host `stacks[]` und `loose[]`); anders ist nur, was
// die Fläche daraus zeigt. Ein zweiter Endpunkt für dieselbe Frage wäre eine
// zweite Antwort, die beim ersten Sonderfall abweicht.
//
// ⚠️ DER CHIP „UPDATE 3" UND DIE MARKE „NEU" AUS DEM ARTBOARD STEHEN HIER
// NICHT (hub-palette.html Z. 574, Z. 632). Weder der Agent noch der Hub melden
// bisher, ob für ein Image eine neuere Fassung bereitliegt. Ein Chip, der
// immer „Update 0" zeigt, ist kein Platzhalter, sondern eine falsche Aussage:
// er sagt „nichts zu tun", wo niemand nachgesehen hat.
//
// ⚠️ CPU UND SPEICHER BLEIBEN EBENFALLS DRAUSSEN. Sie gehören ans
// Container-Detail (Phase 5, #5); in einer Liste von dreißig Zeilen wären es
// sechzig Zahlen, die niemand vergleicht. Auch die Sparklines der Panelköpfe
// im Artboard (Z. 578–584) fehlen aus demselben Grund: der Hub führt keine
// Zeitreihe, aus der sie sich zeichnen ließe.

// ⚠️ Der Rumpf der Fläche liegt seit #282 im Feature `containers`
// (`ContainersView`, `ContainerBrowser`): derselbe Baustein zeichnet im Reiter
// „Hub & Agenten" die Container des Leitstands selbst. Diese Fläche zeigt sie
// nur, wenn die Einstellung es sagt (`GET /api/settings` →
// `containers.showSystem`).

export function ContainersScreen({ role }: { role: Role }) {
  // ⚠️ DIE MARKEN UND IHR GRIFF STECKEN HIER IN DIE FLÄCHE: sie gehören zum
  // Feature `marks`, und ein Feature importiert kein anderes (#282).
  const slots = useDeepDiveSlots(role);
  return <ContainersView slots={slots} />;
}
