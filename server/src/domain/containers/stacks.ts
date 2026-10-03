import type { ContainerOverviewEntry } from "./containers.js";
import { DEFAULT_STACK_DISPLAY, type ContainerState, type OverviewContainer, type StackView } from "contract";
import { isSystemImage, isSystemProject } from "./system-containers.js";

// Die Zusammenfassung eines Stacks — die Regel aus
// docs/design/hub-color-and-structure.md §5, wörtlich:
//
//   „In der Übersicht bestimmt der schlechteste Container die Farbe seines
//    Stacks: ein ausgefallener färbt ihn rot, ein kranker bernstein, sonst
//    bleibt er grün. Daneben steht die Zahl der laufenden Container.“
//
// ⚠️ SIE STEHT IM SERVER UND NICHT IN DER OBERFLÄCHE, und zwar auf Ansage
// derselben Stelle: „Diese Regel ist Logik und kein Design.“ Der Grund ist
// nicht Ordnungsliebe. Dieselbe Zusammenfassung wird ab Phase 5 an mehr als
// einer Stelle gebraucht — Übersicht, Stack-Seite, später die Signale aus
// docs/design/outage-signals.md. Läge sie in der Übersicht, entstünde beim
// zweiten Aufrufer eine zweite Fassung, und zwei Fassungen einer Regel sind
// eine Regel weniger.
//
// ⚠️ Ein Stack ist hier das COMPOSE-PROJEKT EINES HOSTS und nicht der
// Projektname allein. Zwei Arme können beide ein Projekt „monitoring“ führen,
// und das sind zwei Stacks (D0 §6). Diese Datei sieht immer nur die Container
// EINES Hosts; die Kennung entsteht beim Aufrufer aus Host und Projekt.
//
// ⚠️ DAS GILT AUCH FÜR DIE EIGENEN MARKEN UND DIE EINRÜCKUNG (D7b, #62). Beide
// hängen am Paar aus Host-Kennung und Namen — und diese Datei kennt die
// Host-Kennung nicht. Die FELDER stehen deshalb hier (sie gehören zur Form,
// die nach draußen geht), die WERTE kommen von außen: `groupIntoStacks` setzt
// die leere Liste und den `fallback` der Stellschraube, `decorate` in
// `overview.ts` legt darüber, was der Betreiber vergeben hat. Wer die
// Zuordnung in diese Datei holte, müsste ihr die Host-Kennung mitgeben — und
// hätte damit den Kommentar oben zu einer Lüge gemacht.

// State, container and stack as the overview hands them out live in the
// contract (`contract/src/api/containers.ts`, #248), with the reasons for
// `marks`, `system` and `total` next to their fields.
export type { ContainerState, OverviewContainer, StackView };

export type HostStacks = {
  stacks: StackView[];
  // Container ohne Compose-Angabe. Sie sind kein Stack mit einem Mitglied,
  // sondern stehen daneben — im Artboard („teamspeak“, „musikbot“ unter den
  // Stacks von local-host, container-module.html Z. 194) und in §5 („dazu die
  // Container ohne Stack“).
  loose: OverviewContainer[];
};

// Der Rang der drei Stufen. Nur hier steht, welche schlechter ist als welche.
const SEVERITY: Record<ContainerState, number> = { ok: 0, warn: 1, down: 2 };

/**
 * Der Zustand eines einzelnen Containers.
 *
 * ⚠️ `running === false` schlägt jede Gesundheitsangabe: ein Container, der
 * nicht läuft, ist ausgefallen, auch wenn seine letzte Prüfung „healthy“
 * lautete. Die Angabe stammt dann aus der Zeit, als er noch lief.
 *
 * ⚠️ Nur „unhealthy“ ist krank. Docker kennt daneben „starting“ — ein
 * Container in der Anlaufphase ist nicht krank, sondern noch nicht fertig, und
 * ein Stack, der bei jedem Neustart eines Mitglieds bernstein blinkt, bringt
 * dem Betreiber genau nichts bei. Der Vergleich läuft ohne Rücksicht auf
 * Groß- und Kleinschreibung, weil das Feld beim Agenten aus der Docker-API
 * durchgereicht wird und dort schon in beiden Schreibweisen gesehen wurde.
 */
export function containerState(entry: ContainerOverviewEntry): ContainerState {
  if (!entry.running) return "down";
  return entry.health?.toLowerCase() === "unhealthy" ? "warn" : "ok";
}

/**
 * Der schlechteste Zustand einer Menge.
 *
 * Ohne Mitglieder „ok“: diese Antwort erreicht niemanden, weil ein Stack ohne
 * Container nicht entsteht (er entsteht AUS seinen Containern). Sie steht
 * trotzdem hier, damit die Funktion für sich genommen vollständig ist.
 */
export function worstState(states: ContainerState[]): ContainerState {
  return states.reduce<ContainerState>((worst, state) => (SEVERITY[state] > SEVERITY[worst] ? state : worst), "ok");
}

// Vergleich über die Zeichenkette und nicht über `localeCompare`: die
// Reihenfolge soll auf jedem Host dieselbe sein, und `localeCompare` hängt an
// der ICU-Fassung des laufenden Node. Namen von Compose-Projekten und
// Containern sind nach Docker ohnehin auf `[a-zA-Z0-9._-]` beschränkt — ein
// Umlaut, an dem die beiden Verfahren auseinanderliefen, kann darin nicht
// vorkommen.
function byText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function withState(entry: ContainerOverviewEntry, system: boolean): OverviewContainer {
  // `marks: []` und nicht „kein Feld": der Unterschied ist die ganze
  // Zusicherung am Typ oben.
  return { ...entry, state: containerState(entry), marks: [], system };
}

function containerSortKey(entry: ContainerOverviewEntry): string {
  // Innerhalb eines Stacks ordnet der Dienstname: er ist die Rolle im Stack
  // („web“, „db“) und bleibt gleich, während der Container-Name je nach
  // Compose-Fassung eine angehängte Nummer trägt.
  return entry.compose ? entry.compose.service : entry.name;
}

/**
 * Teilt die Container eines Hosts in Stacks und Einzelgänger.
 *
 * Die Reihenfolge ist festgelegt und nicht die des Agenten: der liefert nach
 * Docker-Reihenfolge, und die ändert sich mit jedem Neustart eines Containers.
 * Eine Liste, die bei jedem Laden anders sortiert ist, liest sich wie eine
 * Liste, in der sich etwas geändert hat.
 */
export function groupIntoStacks(containers: ContainerOverviewEntry[]): HostStacks {
  const projects = new Map<string, ContainerOverviewEntry[]>();
  const loose: ContainerOverviewEntry[] = [];

  for (const entry of containers) {
    if (entry.compose === null) {
      loose.push(entry);
      continue;
    }
    const members = projects.get(entry.compose.project);
    if (members) members.push(entry);
    else projects.set(entry.compose.project, [entry]);
  }

  const stacks = [...projects.entries()]
    .map(([project, members]) => {
      const system = isSystemProject(project) || members.some((member) => isSystemImage(member.image));
      const sorted = [...members]
        .sort((left, right) => byText(containerSortKey(left), containerSortKey(right)))
        .map((member) => withState(member, system));
      return {
        project,
        state: worstState(sorted.map((entry) => entry.state)),
        running: sorted.filter((entry) => entry.running).length,
        total: sorted.length,
        marks: [],
        // Der `fallback` der Stellschraube und keine zweite Vorgabe: ein Stack
        // ohne Zeile in `stack_display` steht auf „nested" (007-marks.sql).
        indent: DEFAULT_STACK_DISPLAY.indent,
        system,
        hidden: false,
        containers: sorted
      };
    })
    .sort((left, right) => byText(left.project, right.project));

  return {
    stacks,
    loose: [...loose]
      .sort((left, right) => byText(left.name, right.name))
      .map((entry) => withState(entry, isSystemImage(entry.image)))
  };
}
