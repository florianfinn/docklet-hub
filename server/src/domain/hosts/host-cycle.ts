import type { AgentHealth } from "./health.js";
import type { HostInfo } from "./host-info.js";
import { supportsExternallyManaged } from "./version.js";
import {
  buildRegistryEntries,
  toRegistryRequestBody,
  type ContainerShareInput,
  type DiscoveredStack,
  type HostInventoryContainer,
  type RegistryEntryInput
} from "../containers/index.js";
import type { HostRecord } from "./host-record.js";

// Der Hintergrundlauf: EIN Durchgang über alle Arme.
//
// Was er je Arm tut: die Sonde stellen, das Ergebnis mit einem Zeitstempel
// ablegen, und — nur bei einem erreichbaren Arm — Bestand, Erhebung UND die
// gewählten Freigaben (Etappe E2, #5, B5) lesen, daraus die Allowlist rechnen
// und sie schicken, WENN sie sich geändert hat.
//
// ⚠️ DIESE DATEI RUFT NICHTS SELBST AUF, und sie kennt keine Uhr. Alles, was
// nach draußen geht, kommt als Argument herein: die Liste der Arme, die
// Sonde, die drei Leseabrufe, der Schreibaufruf, der Halter und die Zeit.
// Dieselbe Bauart wie `containers/overview.ts` und aus demselben Grund — nur
// so lässt sich ein Durchlauf gegen einen wartenden Arm, einen stillen Arm,
// einen unveränderten Arm und einen werfenden Arm prüfen, ohne Netz, ohne
// Docker und ohne einen Agenten.
//
// Der Zeitgeber steht in `host-cycle-timer.ts` und ruft `runHostCycle` auf.
// Er ist der Teil, den man am schlechtesten prüfen kann; deshalb steht hier
// alles, was eine Entscheidung trifft, und dort nur der Riegel und das
// Intervall.
//
// ⚠️ Der Aufrufer gegenüber dem Agenten ist `REGISTRY_SYNC_ACTOR`
// (`{ kind: "system", name: "hub" }`, siehe `domain/containers/registry-sync.ts`).
// Diese Datei setzt ihn nicht selbst — `sendRegistry` kommt fertig herein —,
// aber sie ist der Grund dafür: hier sieht niemand zu, und ein `user:<id>` im
// Audit-Log des Agenten behauptete, ein Mensch habe den Abgleich ausgelöst.

/**
 * Was der Hub zuletzt über einen Arm wusste.
 *
 * ⚠️ `agent: null` heißt NICHT GEFRAGT und ist nicht dasselbe wie „nicht
 * erreichbar" — dieselbe Unterscheidung wie in `containers/overview.ts`. Ein
 * Arm im Zustand `pending` hat noch keinen Agenten; sein Tunnel steht nicht,
 * und eine Frage dorthin liefe in die Frist.
 */
export type HostObservation = {
  hostId: string;
  agent: AgentHealth | null;
  // Wann die Sonde gestellt wurde, in Millisekunden seit der Epoche. Er
  // entscheidet später, ob ein Leser diesen Stand noch benutzen darf
  // (`host-observation-store.ts`, `createObservedProbe`).
  checkedAt: number;
  // Was in diesem Durchlauf NACH der Sonde schiefging — ein Formfehler des
  // Bestands, eine abgelehnte Quittung, ein fehlendes Secret. Getrennt von
  // `agent`, weil ein Arm antworten und der Abgleich trotzdem scheitern kann.
  error: string | null;
  // Die Abbildung der zuletzt ERFOLGREICH gesendeten Liste. `null` heißt
  // „diesem Arm wurde von diesem Hub-Prozess noch nie etwas geschickt".
  syncedFingerprint: string | null;
  syncedEntryCount: number | null;
  syncedAt: number | null;
  // Kerne und Arbeitsspeicher des Arms aus `GET /host-info` (#214) — der
  // Nenner der Last durch Container. `null`: noch nie gelesen. Ein
  // gescheitertes Lesen behält den vorigen Stand; die Ausstattung ändert sich
  // nur mit der Hardware.
  hostInfo: HostInfo | null;
};

/**
 * Wie ein Arm aus einem Durchlauf hervorging.
 *
 *   * `pending`     — übersprungen, noch kein Agent.
 *   * `unreachable` — Sonde gestellt, keine Antwort. Kein Abgleich.
 *   * `unchanged`   — erreichbar, gerechnet, nichts geschickt (gleiche Liste).
 *   * `synced`      — erreichbar, geändert, geschickt und quittiert.
 *   * `failed`      — irgendwo dazwischen geworfen. Der Durchlauf ging weiter.
 */
export type HostCycleStatus = "pending" | "unreachable" | "unchanged" | "synced" | "failed";

export type HostCycleOutcome = {
  hostId: string;
  hostName: string;
  status: HostCycleStatus;
  // Wie viele Einträge die Rechnung ergeben hat; `null`, wo nicht gerechnet
  // wurde. NICHT „wie viele geschickt wurden" — bei `unchanged` ist die Zahl
  // gerechnet und nichts ging los.
  entryCount: number | null;
  error: string | null;
};

export type HostCycleResult = {
  startedAt: number;
  finishedAt: number;
  hosts: HostCycleOutcome[];
};

export type HostCycleDeps = {
  listHosts: () => Promise<readonly HostRecord[]>;
  // The service shares this coordinator with explicit and live reconciliations.
  syncHost?: (record: HostRecord) => Promise<HostCycleOutcome>;
  // Der Halter, als zwei Funktionen und nicht als Objekt: der Lauf braucht
  // genau diese zwei Zugriffe, und ein Test speist sie in drei Zeilen ein.
  readObservation: (hostId: string) => HostObservation | undefined;
  writeObservation: (observation: HostObservation) => void;
  probeHost: (record: HostRecord) => Promise<AgentHealth>;
  fetchInventory: (record: HostRecord) => Promise<readonly HostInventoryContainer[]>;
  fetchStacks: (record: HostRecord) => Promise<readonly DiscoveredStack[]>;
  // Die gewählten Freigaben DIESES Arms — `domain/containers/shares.ts`, Baustein 2
  // von Etappe E2. Anders als `fetchInventory`/`fetchStacks` kein Abruf beim
  // Agenten, sondern ein Lesen der eigenen Ablage; sie heißt trotzdem wie ihre
  // Nachbarn, weil `cycleHost` sie genauso behandelt.
  readShares: (record: HostRecord) => Promise<readonly ContainerShareInput[]>;
  // Schickt die Liste an DIESEN Arm. Dahinter steht `syncRegistry` mitsamt
  // seiner Prüfung der Quittung; siehe `domain/containers/registry-sync.ts`.
  sendRegistry: (record: HostRecord, entries: readonly RegistryEntryInput[]) => Promise<void>;
  // Liest die Ausstattung des Arms — einmal je Durchlauf (#214).
  fetchHostInfo: (record: HostRecord) => Promise<HostInfo>;
  now: () => number;
};

/** Dependencies of one host cycle, excluding listing and service coordination. */
export type SingleHostCycleDeps = Omit<HostCycleDeps, "listHosts" | "syncHost">;

/**
 * Die stabile Abbildung einer gerechneten Allowlist.
 *
 * ⚠️ SIE IST DER GRUND, WARUM DER HUB NICHT IM MINUTENTAKT DIESELBE LISTE
 * SCHICKT. Jeder `PUT /registry` steht im Audit-Log des Agenten; ein Lauf ohne
 * diesen Vergleich füllte es mit einem Eintrag je Minute und Arm, und der eine
 * Schub, der wirklich etwas geändert hat, wäre darin nicht mehr zu finden.
 *
 * ⚠️ SORTIERT nach `containerId`, bevor sie zu Text wird. Die Reihenfolge der
 * Einträge folgt der Reihenfolge, in der der Agent seinen Bestand aufzählt —
 * und die ist nicht zugesagt. Ohne die Sortierung wäre eine umgestellte
 * Antwort desselben Bestands eine „Änderung", und der Vergleich verlöre genau
 * dort seine Wirkung, wo er gebraucht wird.
 *
 * ⚠️ Gerechnet wird auf der LEITUNGSFORM (`toRegistryRequestBody`) und nicht
 * auf den Eingaben. So zählt genau das mit, was den Arm auch tatsächlich
 * erreicht: ein Feld, das später zur Leitungsform dazukommt, ist ohne weiteres
 * Zutun Teil des Vergleichs. Der Preis ist bekannt und klein: die
 * Schlüsselreihenfolge kommt aus jener Funktion, eine Umstellung dort ergäbe
 * nach dem Neustart genau einen zusätzlichen Schub je Arm.
 */
export function registryFingerprint(entries: readonly RegistryEntryInput[]): string {
  const wire = [...toRegistryRequestBody(entries).entries];
  wire.sort((left, right) => (left.containerId < right.containerId ? -1 : left.containerId > right.containerId ? 1 : 0));
  return JSON.stringify(wire);
}

/** Der Text eines Fehlers, wie er in den Halter und in das Ergebnis geht. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Ein Arm, ein Durchlauf.
 *
 * ⚠️ SIE WIRFT NICHT. Ein Arm, der scheitert, darf den Durchlauf nicht
 * abbrechen — sonst nähme der erste unerreichbare Arm allen übrigen ihren
 * Abgleich, und zwar still: der Zeitgeber sähe nur eine abgelehnte Zusage.
 *
 * ⚠️ SIE IST SEIT #35 AUCH VON AUSSEN AUFRUFBAR, und zwar aus genau einem
 * Grund: nach einem angewandten Compose-Entwurf sind die Container-Ids andere.
 * `POST /containers/:id/compose-raw` verankert die Allowlist des Agenten —
 * anders als `apply-spec` — NICHT neu; bis zum nächsten Takt gilt dort also
 * die alte Liste, und der eben bearbeitete Stack antwortet auf jede weitere
 * Aktion mit einer Ablehnung. Das ist kein Komfortproblem: die Fläche, die
 * gerade etwas geändert hat, ist danach bis zu einem Takt lang kaputt.
 *
 * Dass sie dieselbe Funktion ist wie im Hintergrundlauf, ist der Punkt. Ein
 * zweiter Weg, der die Allowlist rechnet, wäre eine zweite Wahrheit über die
 * Frage, was auf diesem Arm erlaubt ist — mitsamt eigenem Fingerabdruck und
 * eigenen Fehlern.
 */
export async function cycleHost(record: HostRecord, deps: SingleHostCycleDeps): Promise<HostCycleOutcome> {
  const previous = deps.readObservation(record.id);
  // Was ein Durchlauf über den Abgleich NICHT weiß, bleibt stehen: hat dieser
  // Lauf nichts geschickt, gilt weiter, was der letzte geschickt hat.
  const carried = {
    syncedFingerprint: previous?.syncedFingerprint ?? null,
    syncedEntryCount: previous?.syncedEntryCount ?? null,
    syncedAt: previous?.syncedAt ?? null,
    hostInfo: previous?.hostInfo ?? null
  };

  // ⚠️ Ein wartender Arm wird ÜBERSPRUNGEN und nicht befragt. Er hat noch
  // keinen Agenten; die Sonde liefe in ihre Frist, und bei zwanzig wartenden
  // Armen dauerte der Durchlauf eine Minute für nichts. Abgelegt wird er
  // trotzdem — mit `agent: null`, damit ein Leser den Unterschied zu „still"
  // sieht.
  if (record.state === "pending") {
    deps.writeObservation({
      hostId: record.id,
      agent: null,
      checkedAt: deps.now(),
      error: null,
      ...carried
    });
    return { hostId: record.id, hostName: record.name, status: "pending", entryCount: null, error: null };
  }

  let agent: AgentHealth;
  try {
    agent = await deps.probeHost(record);
  } catch (error) {
    // `probeAgent` fängt selbst und antwortet mit `reachable: false`; hier
    // landet nur, wer eine andere Sonde eingespeist hat. Ein Wurf darf trotzdem
    // nicht den ganzen Durchlauf mitnehmen.
    const message = messageOf(error);
    deps.writeObservation({
      hostId: record.id,
      agent: { reachable: false, error: message },
      checkedAt: deps.now(),
      error: message,
      ...carried
    });
    return { hostId: record.id, hostName: record.name, status: "failed", entryCount: null, error: message };
  }

  if (!agent.reachable) {
    deps.writeObservation({ hostId: record.id, agent, checkedAt: deps.now(), error: null, ...carried });
    return { hostId: record.id, hostName: record.name, status: "unreachable", entryCount: null, error: agent.error };
  }

  // ⚠️ DIE AUSSTATTUNG SCHEITERT UND WARTET FÜR SICH. Ein Arm, der
  // `/host-info` nicht beantwortet, verliert damit die Last durch Container,
  // aber nicht seinen Abgleich — die Allowlist ist die Voraussetzung jeder
  // Aktion, die Last nur eine Anzeige. Bei einem Fehler bleibt der vorige
  // Stand stehen. Die Frage läuft NEBEN dem Abgleich und wird erst beim
  // Ablegen abgewartet: ein Arm, der hier bis in die Frist schweigt, hielte
  // sonst den Schub der Allowlist um bis zu zehn Sekunden auf — auch den
  // sofortigen nach einem angewandten Compose-Entwurf. Die Zusage lehnt nie
  // ab.
  const hostInfoRead = deps.fetchHostInfo(record).then(
    (info): HostInfo | null => info,
    () => carried.hostInfo
  );

  const checkedAt = deps.now();
  try {
    // Nebeneinander: die drei Abrufe wissen nichts voneinander, und in Reihe
    // wäre die Wartezeit je Arm die Summe aller drei Fristen.
    const [inventory, stacks, shares] = await Promise.all([
      deps.fetchInventory(record),
      deps.fetchStacks(record),
      deps.readShares(record)
    ]);
    const entries = buildRegistryEntries(inventory, stacks, shares, {
      externallyManaged: supportsExternallyManaged(agent.version)
    });
    const fingerprint = registryFingerprint(entries);

    // ⚠️ Der Fingerabdruck allein genügt nicht (#123). Er sagt nur, was DIESER
    // Hub-Prozess zuletzt geschickt hat — nicht, was der Arm noch hält. Hat
    // der Arm sein `/state`-Volume verloren, meldet er in `/health` eine
    // andere Zahl als die gesendete, und die Liste geht im selben Takt neu
    // los. Nennt der Agent keine Zahl, entscheidet der Fingerabdruck wie bisher.
    const armDiverged = agent.entries !== null && agent.entries !== carried.syncedEntryCount;
    if (fingerprint === carried.syncedFingerprint && !armDiverged) {
      deps.writeObservation({ hostId: record.id, agent, checkedAt, error: null, ...carried, hostInfo: await hostInfoRead });
      return {
        hostId: record.id,
        hostName: record.name,
        status: "unchanged",
        entryCount: entries.length,
        error: null
      };
    }

    await deps.sendRegistry(record, entries);
    // ⚠️ Die Abbildung wird ERST NACH der Quittung abgelegt. Stünde sie davor,
    // hielte ein fehlgeschlagener Schub den Hub für erledigt, und die Liste
    // ginge bis zur nächsten echten Änderung nie wieder los — der Arm bliebe
    // beim Agenten für jede Aktion gesperrt.
    const syncedAt = deps.now();
    deps.writeObservation({
      hostId: record.id,
      agent,
      checkedAt,
      error: null,
      syncedFingerprint: fingerprint,
      syncedEntryCount: entries.length,
      syncedAt,
      hostInfo: await hostInfoRead
    });
    return { hostId: record.id, hostName: record.name, status: "synced", entryCount: entries.length, error: null };
  } catch (error) {
    const message = messageOf(error);
    deps.writeObservation({ hostId: record.id, agent, checkedAt, error: message, ...carried, hostInfo: await hostInfoRead });
    return { hostId: record.id, hostName: record.name, status: "failed", entryCount: null, error: message };
  }
}

/** A failed host cycle never cancels its siblings; listing failures reach the caller. */
export async function runHostCycle(deps: HostCycleDeps): Promise<HostCycleResult> {
  const startedAt = deps.now();
  const records = await deps.listHosts();
  const settled = await Promise.allSettled(records.map((record) => deps.syncHost ? deps.syncHost(record) : cycleHost(record, deps)));

  const hosts = settled.map((entry, index): HostCycleOutcome => {
    if (entry.status === "fulfilled") return entry.value;
    const record = records[index];
    return {
      hostId: record.id,
      hostName: record.name,
      status: "failed",
      entryCount: null,
      error: messageOf(entry.reason)
    };
  });

  return { startedAt, finishedAt: deps.now(), hosts };
}
