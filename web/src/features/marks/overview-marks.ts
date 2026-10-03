import type { HostOverview, IndentName, MarkView, OverviewContainer, StackView } from "contract";

// Was nach einem Schreibvorgang mit dem Bild geschieht (D7b/C2, #62).
//
// ⚠️ KEIN NEULADEN UND KEIN ZWEITER ABRUF. Der Server antwortet auf jede der
// drei Schreibrouten mit dem GESPEICHERTEN Stand — `{ marks }` bzw.
// `{ display }` —, und diese vier Funktionen tragen genau ihn in die Antwort
// von `GET /api/overview` ein, die die Fläche schon hält. Ein zweiter Abruf
// wäre eine Anfrage für eine Auskunft, die gerade zurückkam; ein
// `window.location.reload()` wäre der Weg, auf dem ein Filter, eine Suche und
// jeder aufgeklappte Stack verlorengingen.
//
// ⚠️ SIE SIND REIN UND ÄNDERN NICHTS AN IHRER EINGABE. React vergleicht
// Zustände über die Identität: ein an Ort und Stelle geändertes Feld wäre
// dasselbe Objekt wie vorher, und die Fläche zeichnete sich nicht neu — der
// Schreibvorgang wäre erfolgreich und unsichtbar. Deshalb entsteht auf jedem
// Weg nach unten ein neues Objekt, und alles daneben bleibt dasselbe.
//
// ⚠️ WARUM EINE EIGENE DATEI UND NICHT DREI HELFER IN DEN ZWEI FLÄCHEN. Die
// Stack-Seite und der Deepdive halten dieselbe Antwort und müssen sie gleich
// fortschreiben; zweimal geschrieben wichen sie beim ersten Sonderfall
// voneinander ab. Als reine Funktionen sind sie außerdem ohne DOM prüfbar.

/** Der Arm mit dieser Kennung, alle übrigen unverändert. */
function withHost(
  hosts: readonly HostOverview[],
  hostId: string,
  change: (host: HostOverview) => HostOverview
): HostOverview[] {
  return hosts.map((host) => (host.host.id === hostId ? change(host) : host));
}

/** Der Stack mit diesem Projektnamen, alle übrigen unverändert. */
function withStack(
  hosts: readonly HostOverview[],
  hostId: string,
  project: string,
  change: (stack: StackView) => StackView
): HostOverview[] {
  return withHost(hosts, hostId, (host) => ({
    ...host,
    stacks: host.stacks.map((stack) => (stack.project === project ? change(stack) : stack))
  }));
}

/** Die Marken eines Stacks, wie der Server sie zurückgemeldet hat. */
export function withStackMarks(
  hosts: readonly HostOverview[],
  hostId: string,
  project: string,
  marks: MarkView[]
): HostOverview[] {
  return withStack(hosts, hostId, project, (stack) => ({ ...stack, marks }));
}

/** Die Einrückung eines Stacks, wie der Server sie zurückgemeldet hat. */
export function withStackIndent(
  hosts: readonly HostOverview[],
  hostId: string,
  project: string,
  indent: IndentName
): HostOverview[] {
  return withStack(hosts, hostId, project, (stack) => ({ ...stack, indent }));
}

/**
 * Die Marken eines einzelnen Containers.
 *
 * ⚠️ GESUCHT WIRD IN BEIDEN LISTEN — in den Containern jedes Stacks UND unter
 * den Containern ohne Stack. Ein Container ohne Compose-Projekt steht nur in
 * `loose`, und eine Fassung, die allein die Stacks durchginge, schriebe für
 * ihn erfolgreich in die Ablage, ohne dass sich an seiner Zeile etwas ändert.
 *
 * ⚠️ GESUCHT WIRD AM NAMEN und nicht an der Docker-Kennung: der Name ist der
 * Schlüssel der Zuordnung (`request.params.name` im Router,
 * `marksByContainer.get(name)` in `server/src/containers/overview.ts:72`).
 * Er ist je Arm eindeutig — Docker lässt zwei Container mit demselben Namen
 * auf einem Host nicht zu.
 */
export function withContainerMarks(
  hosts: readonly HostOverview[],
  hostId: string,
  containerName: string,
  marks: MarkView[]
): HostOverview[] {
  const apply = (container: OverviewContainer): OverviewContainer =>
    container.name === containerName ? { ...container, marks } : container;

  return withHost(hosts, hostId, (host) => ({
    ...host,
    stacks: host.stacks.map((stack) => ({ ...stack, containers: stack.containers.map(apply) })),
    loose: host.loose.map(apply)
  }));
}
