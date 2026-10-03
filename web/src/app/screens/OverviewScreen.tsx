import { OVERVIEW_SLOTS } from "../containers/container-slots";
import { OverviewView } from "../../features/containers";
import { setStackHidden } from "../../features/marks";
import type { Role } from "../../platform/session/session-user";

// Die Übersicht — die Fläche, die nach der Anmeldung erscheint. Die Ansicht
// selbst liegt seit #282 im Feature `containers`
// (`features/containers/OverviewView.tsx`, dort stehen auch die
// Begründungen); dieser Bildschirm ist der Rahmen, der sie in die Navigation
// stellt.
//
// ⚠️ MARKEN, AUSLASTUNG UND „STACK AUSBLENDEN“ STECKEN HIER IN DIE ANSICHT.
// Sie gehören zu den Features `marks` und `metrics` (#283), und ein Feature
// importiert kein anderes. Der Bildschirm ist der Ort, der beide kennen darf.
export function OverviewScreen({ role }: { role: Role }) {
  return <OverviewView role={role} slots={OVERVIEW_SLOTS} setStackHidden={setStackHidden} />;
}
