import type { AgentHealth } from "./health.js";
import type { HostRecord } from "./host-record.js";
import type { HostObservation } from "./host-cycle.js";

// Der Halter: was der Hub zuletzt über jeden Arm wusste.
//
// ⚠️ IM ARBEITSSPEICHER, keine Tabelle, keine Migration. Das ist eine
// Entscheidung und keine Abkürzung: nach einem Neustart weiß der Hub nichts
// und fragt neu. Ein gespeicherter Zustand behauptete nach dem Hochfahren eine
// Wahrheit von gestern — „Arm erreichbar", weil er es vor dem Stromausfall
// war —, und niemand sähe ihm an, dass er alt ist. Der Preis ist ein
// Durchlauf: bis der erste Lauf durch ist, weiß der Halter nichts, und die
// Leser fragen wie bisher selbst (siehe `createObservedProbe` weiter unten).
//
// ⚠️ Er wächst um einen Eintrag je Arm, den dieser Prozess einmal gesehen hat.
// Ein entfernter Arm bleibt bis zum nächsten Neustart darin stehen. Gemessen
// an der Form von `HostObservation` sind das je Arm eine Handvoll Felder und
// eine Zeichenkette in der Größe der Allowlist dieses Arms; bei den Zahlen
// dieses Systems (docs/design/concept-and-plan.md §1: ein Hub, eine Handvoll
// Arme) ist eine Aufräumroutine dafür mehr Code als Nutzen. Wer hier einmal
// hunderte Arme führt, hat vorher andere Fragen.

export type HostObservationStore = {
  read: (hostId: string) => HostObservation | undefined;
  write: (observation: HostObservation) => void;
};

export function createHostObservationStore(): HostObservationStore {
  const byHost = new Map<string, HostObservation>();
  return {
    read: (hostId) => byHost.get(hostId),
    write: (observation) => {
      byHost.set(observation.hostId, observation);
    }
  };
}

// ---------------------------------------------------------------------------
// Die Leseseite: was eine Route aus dem Halter noch benutzen darf
// ---------------------------------------------------------------------------

// Die Untergrenze der Verfallsfrist, in Millisekunden.
//
// ⚠️ Sie greift nur bei einem SEHR kurzen Intervall. Ohne sie verfiele bei
// einem Takt von etwa fünf Sekunden ein Stand, der eben erst geschrieben
// wurde, noch während der laufende Durchlauf unterwegs ist — die Route fiele
// dann bei fast jeder Anfrage auf ihre eigene Sonde zurück, also genau in das
// Verhalten, das dieser Lauf ablösen soll. Bei der Vorgabe von 60 s ist die
// Frist 120 s, und diese Grenze bindet nicht.
const MIN_STALE_AFTER_MS = 60_000;

/**
 * Ab welchem Alter ein abgelegter Stand nicht mehr benutzt wird.
 *
 * ⚠️ ZWEI INTERVALLE, und die Zahl ist an der Intervalllänge begründet:
 *
 *   * Im Normalbetrieb schreibt jeder Durchlauf jeden Arm einmal — ein Stand
 *     ist also höchstens ein Intervall plus die Dauer eines Durchlaufs alt.
 *   * Der Riegel gegen überlappende Läufe (`host-cycle-timer.ts`) darf einen
 *     Takt auslassen, wenn ein Durchlauf länger dauert als das Intervall. Ein
 *     Alter von knapp zwei Intervallen ist damit noch der Normalfall.
 *   * Alles darüber heißt, dass mindestens ein ganzer Takt nichts geschrieben
 *     hat: der Lauf hängt, ist abgestürzt oder wurde abgeschaltet. Ein
 *     Zustand von vor einer Stunde, der als aktuell ausgegeben wird, ist
 *     schlechter als eine Sonde, die drei Sekunden kostet.
 *
 * ⚠️ Bei Intervall `0` — der Lauf ist abgeschaltet — ist die Frist `0`, und
 * damit ist KEIN Stand je frisch. Das ist kein Sonderfall in den Routen,
 * sondern fällt hier heraus: sie fragen dann wieder selbst, so wie vor dieser
 * Etappe. Wer den Lauf abschaltet, bekommt die alte Übersicht zurück und nicht
 * eine, die einen eingefrorenen Stand anzeigt.
 */
export function staleAfterMs(intervalMs: number): number {
  if (intervalMs <= 0) return 0;
  return Math.max(intervalMs * 2, MIN_STALE_AFTER_MS);
}

export type ObservedProbeOptions = {
  store: HostObservationStore;
  staleAfterMs: number;
  now: () => number;
  // Die eigene Sonde der Route — der Rückfall, wenn der Halter nichts
  // Brauchbares hat.
  probe: (record: HostRecord) => Promise<AgentHealth>;
};

/**
 * Eine Sonde, die zuerst in den Halter schaut.
 *
 * Sie hat genau die Form von `probeAgent` aus Sicht der Routen — ein Arm
 * hinein, sein Zustand heraus. Deshalb ändert sich an keiner Antwortform
 * etwas; die Route weiß nicht, ob die Auskunft eine Sekunde oder eine
 * Millisekunde gekostet hat.
 *
 * ⚠️ ZWEI FÄLLE FALLEN AUF DIE EIGENE SONDE ZURÜCK, und beide mit Absicht:
 *
 *   1. DER HALTER WEISS NICHTS über diesen Arm — er wurde gerade angelegt,
 *      oder der erste Durchlauf ist noch nicht durch. Ohne den Rückfall sähe
 *      ein frisch angelegter Arm bis zum nächsten Lauf tot aus, und der
 *      Betreiber suchte den Fehler beim Arm statt beim Takt.
 *   2. DER STAND IST ZU ALT (siehe `staleAfterMs`). Ein hängender oder
 *      abgeschalteter Lauf darf keine Erreichbarkeit von gestern als
 *      Gegenwart ausgeben.
 *
 * ⚠️ Ein abgelegtes `agent: null` (NICHT GEFRAGT, also ein wartender Arm)
 * zählt ebenfalls als „nichts Brauchbares". Das ist kein Verlust: `GET
 * /overview` fängt wartende Arme vor der Sonde ab (`containers/overview.ts`),
 * und `GET /hosts/:hostId/containers` fragt sie heute schon selbst. Der
 * Rückfall hält damit genau das bestehende Verhalten.
 *
 * ⚠️ Die CONTAINER holt die Route weiterhin SELBST, mit dem Aufrufer ihrer
 * Sitzung. Nur die Erreichbarkeit kommt von hier. Das Audit-Log des Agenten
 * ist die einzige Spur, die von diesem Hub auf einen Menschen zeigt — ein
 * `system:hub` an jener Stelle löschte sie.
 */
export function createObservedProbe(
  options: ObservedProbeOptions
): (record: HostRecord) => Promise<AgentHealth> {
  return (record) => {
    const observation = options.store.read(record.id);
    if (
      observation !== undefined &&
      observation.agent !== null &&
      options.now() - observation.checkedAt < options.staleAfterMs
    ) {
      return Promise.resolve(observation.agent);
    }
    return options.probe(record);
  };
}
