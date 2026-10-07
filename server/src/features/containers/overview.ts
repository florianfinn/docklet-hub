import type { HostOverview, LifecycleSnapshot } from "contract";

import { toHostView, type AgentHealth, type HostRecord } from "../../domain/hosts/index.js";
import {
  groupIntoStacks,
  withoutHistory,
  type ContainerOverviewEntry,
  type HostStacks,
  type OverviewContainer,
  type StackView
} from "../../domain/containers/index.js";
import { AgentError } from "../../platform/agent-transport/protocol.js";
import type { HostDecoration } from "./decoration.js";

// Die Übersicht über alle Arme in EINER Antwort — die Fläche, die nach der
// Anmeldung erscheint (docs/design/hub-color-and-structure.md §5: „Übersicht
// führt Stacks, gruppiert nach Host, dazu die Container ohne Stack“).
//
// ⚠️ Warum eine eigene Route und nicht N Aufrufe von
// `GET /hosts/:id/containers` aus der Oberfläche: die Zusammenfassung eines
// Stacks ist laut §5 Logik und gehört in den Server. Läge die Schleife im
// Browser, läge die Regel dort mit — und die zweite Fläche, die dieselbe
// Zusammenfassung braucht (die Stack-Seite aus Phase 5), bekäme ihre eigene.
//
// ⚠️ Diese Datei RUFT NICHTS SELBST AUF. Sonde und Container-Abruf kommen als
// Argumente herein. Das ist keine Zierde: nur so lässt sich die Fläche gegen
// einen Arm prüfen, der antwortet, einen, der schweigt, und einen, der Unsinn
// liefert — ohne Netz, ohne Docker und ohne einen Agenten.

// The shape lives in the contract (`contract/src/api/containers.ts`, #248),
// including why `agent: null` means "not asked" and not "unreachable".
export type { HostOverview };

export type OverviewDeps = {
  lifecycleFor?: (record: HostRecord) => Promise<{ lifecycle: LifecycleSnapshot; hubOwnedProjects: Set<string> }>;
  probeHost: (record: HostRecord) => Promise<AgentHealth>;
  fetchContainersFor: (record: HostRecord) => Promise<ContainerOverviewEntry[]>;
  // Was der Betreiber diesem Arm an eigenen Marken und an Einrückung vergeben
  // hat (D7b, #62).
  //
  // ⚠️ Sie steht HIER und nicht in `stacks.ts`. Diese Datei kennt den Arm,
  // jene sieht immer nur die Container EINES Hosts und kennt seine Kennung
  // nicht (stacks.ts, Kopf) — die Zuordnung hängt aber genau daran.
  decorationFor: (record: HostRecord) => Promise<HostDecoration>;
};

const NOTHING = { stacks: [] as StackView[], loose: [] as OverviewContainer[] };

/**
 * Legt über die gruppierten Container, was der Betreiber vergeben hat.
 *
 * Eine reine Funktion und exportiert: sie ist die Regel, an der man sich irren
 * kann (welche Marke an welchem Ziel, in welcher Reihenfolge), und sie muss
 * ohne Datenbank prüfbar sein.
 *
 * ⚠️ EIN CONTAINER IN EINEM STACK TRÄGT SEINE EIGENEN MARKEN und nicht die
 * seines Stacks. §3 sagt „an einen Stack ODER an einen einzelnen Container";
 * ein Container, der die Marken seines Stacks erbte, machte die Zuordnung am
 * Stack unsichtbar — man sähe dieselbe Marke an acht Zeilen und wüsste nicht
 * mehr, wo sie vergeben wurde.
 *
 * ⚠️ Der Schlüssel eines Containers ist sein NAME und nicht sein Dienstname.
 * Der Dienstname („web", „db") ist die Rolle IM Stack und auf einem Arm nicht
 * eindeutig — zwei Stacks haben beide ein „db". Der Name ist es (Docker lässt
 * ihn nur einmal je Host zu).
 *
 * ⚠️ Ein Ziel ohne Eintrag behält, was `groupIntoStacks` gesetzt hat: die
 * leere Liste und den `fallback`. Kein `undefined` und kein fehlendes Feld.
 */
export function decorate(grouped: HostStacks, decoration: HostDecoration): HostStacks {
  const marksOf = (name: string): OverviewContainer["marks"] => decoration.marksByContainer.get(name) ?? [];
  const withMarks = (entry: OverviewContainer): OverviewContainer => ({ ...entry, marks: marksOf(entry.name) });

  return {
    stacks: grouped.stacks.map((stack) => ({
      ...stack,
      marks: decoration.marksByStack.get(stack.project) ?? stack.marks,
      indent: decoration.indentByStack.get(stack.project) ?? stack.indent,
      hidden: decoration.hiddenStacks.has(stack.project) || stack.hidden,
      containers: stack.containers.map(withMarks)
    })),
    loose: grouped.loose.map(withMarks)
  };
}

async function overviewFor(record: HostRecord, deps: OverviewDeps): Promise<HostOverview> {
  if (record.state === "pending") {
    return { host: toHostView(record, null), agent: null, ...NOTHING, error: null };
  }

  const agent = await deps.probeHost(record);
  if (!agent.reachable) {
    // Kein Fehlerstatus: die Frage ist beantwortet worden, und zwar mit
    // „schlecht“ (dieselbe Entscheidung wie in `GET /hosts/:id/containers`).
    return { host: toHostView(record, agent), agent, ...NOTHING, error: agent.error };
  }

  try {
    // ⚠️ Nebeneinander und nicht nacheinander: die Marken stehen in der
    // eigenen Datenbank und hängen nicht davon ab, was der Agent antwortet.
    // In Reihe wartete die Fläche erst auf den Agenten und dann noch auf eine
    // Abfrage, die längst hätte laufen können.
    //
    // ⚠️ Die Marken werden NUR hier geholt — nicht für einen wartenden und
    // nicht für einen stillen Arm. Beide liefern keine Container, und Marken
    // ohne Ziel sind eine Abfrage ohne Empfänger.
    const [containers, decoration, lifecycle] = await Promise.all([
      deps.fetchContainersFor(record),
      deps.decorationFor(record),
      deps.lifecycleFor?.(record)
    ]);
    const grouped = decorate(groupIntoStacks(containers.map(withoutHistory)), decoration);
    if (lifecycle) grouped.stacks = grouped.stacks.map((stack) => ({ ...stack,
      hubOwned: lifecycle.hubOwnedProjects.has(stack.project) && !stack.containers.some((entry) => entry.externalManagement !== null) }));
    return {
      ...(lifecycle ? { lifecycle: lifecycle.lifecycle } : {}),
      host: toHostView(record, agent),
      agent,
      // ⚠️ OHNE VERLAUF (#213). Die Übersicht zeigt den letzten Wert; 60
      // Messpunkte je Container machten jede Zeile rund sechzehnmal so groß
      // (Messung in `container-load.ts`). Das Detail holt den Verlauf über
      // seine eigene Route.
      ...grouped,
      error: null
    };
  } catch (error) {
    // ⚠️ NUR `AgentError` wird zur Meldung. Alles andere fliegt weiter: ein
    // Programmierfehler im Hub, der hier als Textfeld eines Hosts landete,
    // sähe in der Oberfläche aus wie ein Problem dieses Arms — und stünde in
    // keinem Log.
    if (error instanceof AgentError) {
      return { host: toHostView(record, agent), agent, ...NOTHING, error: error.message };
    }
    throw error;
  }
}

/**
 * Baut die Übersicht über alle Arme.
 *
 * Nebeneinander und nicht nacheinander: die Arme wissen nichts voneinander,
 * und in Reihe wäre die Wartezeit die Summe aller Fristen — bei drei stillen
 * Armen also neun Sekunden für eine Fläche, die nach der Anmeldung erscheint.
 *
 * Die Reihenfolge der Antwort ist die der Eingabe (lokaler Arm zuerst, dann
 * nach Namen — `listHostRecords`), denn `Promise.all` behält sie.
 */
export function buildOverview(records: HostRecord[], deps: OverviewDeps): Promise<HostOverview[]> {
  return Promise.all(records.map((record) => overviewFor(record, deps)));
}
