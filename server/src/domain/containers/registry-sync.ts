import { HUB_REGISTRY_ORIGIN, type RegistryOrigin } from "contract";
import { agentPut, AgentError, type Actor, type AgentTarget, type RequestOptions } from "../../platform/agent-transport/protocol.js";

// Der Registry-Abgleich: was der Hub beim Agenten einträgt.
//
// Der Agent entscheidet JEDE Aktion an einem Container gegen seine eigene
// Allowlist-Kopie. Gemessen am 2026-09-07 an `florianfinn/dashboard-docker-agent`
// @6ffc3c8 (v0.19.1), `src/index.ts:1481`: `gate()` prüft
// `registry.isAllowed(containerId)` an dritter Stelle — BEVOR es zwischen
// mutierend und lesend unterscheidet. Steht ein Container nicht in dieser
// Liste, ist er für den Agenten nicht vorhanden: keine Logs, kein Compose,
// kein Dateizugriff, nicht einmal ein Blick. Ein frisch aufgesetzter Arm hat
// eine leere Liste und meldet deshalb null Container, obwohl zwei Dutzend
// laufen. Diese Liste zu füllen ist der Zweck dieser Datei.
//
// Es gibt dazu KEINEN Betreiberschritt (#20, Entscheidung vom 2026-09-06):
// keine Oberfläche, die Container „aufnimmt" oder „freischaltet". Der Hub
// trägt ein, was der Arm meldet. Eine Freischaltung von Hand wäre eine zweite
// Liste neben der des Agenten, und zwei Listen desselben Bestands laufen beim
// ersten neuen Container auseinander.
//
// ⚠️ Die RECHNUNG geht nicht ans Netz. `buildRegistryEntries` und
// `toRegistryRequestBody` sind reine Funktionen: sie sind die Stelle, an der
// man sich irren kann, und müssen allein prüfbar sein. Nur `syncRegistry` am
// Ende der Datei schickt tatsächlich etwas los.
//
// Wer den Abgleich AUSLÖST, ist nicht diese Datei — sie kennt weder eine Uhr
// noch die Liste der Arme. Ausgelöst wird er seit dem Hintergrundlauf
// (`server/src/domain/hosts/host-cycle*.ts`, Etappe B4a-C2, #5). Gezählt am 2026-09-07
// (`grep -rln 'containers/registry-sync.js' server/src --include=*.ts |
// grep -v '\.test\.'`): ZWEI Dateien außerhalb der Tests rufen von hier ab —
// `domain/hosts/host-cycle.ts` rechnet je Arm mit `buildRegistryEntries` und
// `toRegistryRequestBody` die Liste, `domain/hosts/host-cycle-service.ts`
// schickt sie über `syncRegistry` mit `REGISTRY_SYNC_ACTOR` los. WANN das
// geschieht, bestimmt `domain/hosts/host-cycle-timer.ts`.
//
// ⚠️ Die vorige Fassung dieses Absatzes las „es gibt in dieser Etappe keinen
// Hintergrundlauf, keinen Zeitgeber und keine Route. Aufgerufen wird sie heute
// von ihren Tests und sonst von niemandem". Das stimmte, als sie geschrieben
// wurde, und wurde beim Bau des Hintergrundlaufs nicht nachgezogen. Ein
// Kommentar über den Bestand veraltet, ohne dass etwas rot wird; er trägt
// deshalb hier seinen Messweg, damit die nächste Abweichung nachzurechnen
// ist.

// ---------------------------------------------------------------------------
// Was hereinkommt
// ---------------------------------------------------------------------------

// ⚠️ Die Eingaben stehen hier als EIGENE, schmale Formen und nicht als die
// vollen Antworttypen der beiden Leseclients. Das ist Absicht: sie nennen
// genau die Felder, die diese Rechnung liest. Wer die Rechnung prüft, sieht
// damit ohne Umweg, worauf sie sich stützt — und die Tests kommen ohne
// Datensätze aus, die zwanzig unbeteiligte Felder mitschleppen. Die Typen der
// Clients (`domain/containers/host-containers.ts`, `domain/containers/stack-discovery.ts`) sind
// strukturell mit diesen verträglich und werden ohne Umwandlung übergeben.

/**
 * Ein Container aus dem vollen Bestand des Hosts (`GET /host-containers`).
 *
 * ⚠️ Die Quelle ist NICHT `GET /containers`. Diese Route zeigt ausschließlich
 * Container, die schon in der Allowlist stehen (`registry.allowedIds()`,
 * v0.19.1) — auf einem frischen Arm also nichts. Ein Abgleich, der sich daraus
 * speiste, bliebe für immer wirkungslos: leere Liste rein, leere Liste raus.
 */
export type HostInventoryContainer = {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  // `null` heißt „von niemandem sonst verwaltet" UND „der Agent hat nichts
  // dazu gesagt" — dieselbe Lesart wie in `domain/containers/containers.ts`.
  readonly externalManagement: { readonly manager: string } | null;
};

/**
 * Die gewählte Freigabe eines Containers, wie `domain/containers/shares.ts` sie hält
 * — hier nur der Ausschnitt, den diese Rechnung braucht.
 *
 * ⚠️ `containerName` und NICHT `containerId`: dieselbe Entscheidung des
 * Leitstands wie bei `RegistryEntryInput.sharePath` oben. Der Bestand
 * (`hostContainers`) führt die aktuelle Id; die Ablage kennt nur den Namen,
 * weil der beim `recreate` eines Containers erhalten bleibt und die Id nicht.
 */
export type ContainerShareInput = {
  readonly containerName: string;
  readonly path: string;
};

/** Ein Dienst innerhalb eines erhobenen Stacks. */
export type DiscoveredStackService = {
  readonly serviceName: string;
  readonly containerId: string;
};

/**
 * Ein Stack aus der Erhebung des Agenten (`GET /stacks`).
 *
 * ⚠️ VON HIER KOMMT DER COMPOSE-ANKER und nicht aus dem Bestand. Was
 * `GET /host-containers` je Container an Compose meldet, sind nur Projekt- und
 * Servicename (gemessen an `src/index.ts:2463` und `src/redact.ts:138`) — kein
 * `projectDir`, kein `composeFileName`. Wer daraus einen Anker baut, baut
 * einen halben, und ein halber Anker wird vom Agenten ganz verworfen (siehe
 * `findComposeAnchor`).
 */
export type DiscoveredStack = {
  readonly projectDir: string;
  readonly projectName: string;
  readonly composeFileName: string;
  readonly services: readonly DiscoveredStackService[];
};

// ---------------------------------------------------------------------------
// Was hinausgeht — der Vertrag der Gegenseite
// ---------------------------------------------------------------------------

/**
 * Der Compose-Anker eines Eintrags, gemessen an `src/registry.ts` (v0.24.0).
 *
 * ⚠️ `origin` trägt den Wert `"adopted"`. `isRegistryCompose` (ebenda, Zeile
 * 364) lässt nur `"dashboard"` und `"adopted"` zu, und ein unbekannter Wert
 * macht den GANZEN Anker ungültig, nicht nur das Feld — der Eintrag fiele
 * still ohne Compose-Anker durch. `"dashboard"` heißt beim Agenten „darf aus
 * einer Spec neu geschrieben werden"; das gilt für keine Datei, die der
 * Betreiber selbst angelegt hat. Alles, was dieser Hub vorfindet, ist deshalb
 * `"adopted"` — seit Etappe V1 (#98) nicht mehr als Literal an zwei Stellen
 * dieser Datei, sondern als `HUB_REGISTRY_ORIGIN` aus
 * `contract/src/agent/`.
 *
 * ⚠️ DER WERT HIESS BIS v0.23.0 `"adoptiert"` und ist mit v0.24.0 (#130)
 * gewechselt. Ein Arm auf v0.23.0 oder älter kennt den neuen
 * nicht und verwirft jeden Eintrag mit Anker; die Zahl in seiner Quittung
 * bleibt dann unter der gesendeten, und `syncRegistry` wirft — laut, an
 * genau der Stelle, für die diese Prüfung gebaut ist.
 */
export type RegistryComposeAnchor = {
  projectDir: string;
  // Optional im Vertrag — aber ohne ihn lehnt der Agent STACK-Aktionen ab.
  // Der Abgleich setzt ihn deshalb, wo die Erhebung ihn kennt.
  projectName?: string;
  serviceName: string;
  composeFileName: string;
  origin: RegistryOrigin;
};

/**
 * Ein Eintrag, wie der Abgleich ihn bildet.
 *
 * ⚠️ `sharePath` TRÄGT JETZT ETWAS (Etappe E2, #5, B5) — hier stand bis zu
 * dieser Etappe: „Abweichung von docs/design/phase-5-write-access.md §6:
 * dort trägt `RegistryEntryInput` zusätzlich `sharePath: string | null`. Hier
 * fehlt das Feld. Grund: Web-FTP ist B5, und heute setzt niemand einen
 * Freigabepfad." Diese Begründung erklärte eine Abwesenheit, die es nicht
 * mehr gibt, und stand deshalb nicht als Verweis hier weiter — ein Kommentar
 * über einen vergangenen Zustand ist eine zweite Wahrheit, wenn niemand ihn
 * nachzieht.
 *
 * Die Freigabe kommt aus `domain/containers/shares.ts` — je (Arm, Containername) EIN
 * gewählter Pfad, keine Liste (Entscheidung des Leitstands,
 * 011-container-shares.sql). `buildRegistryEntries` ordnet ihn dem Container
 * über den NAMEN zu, nicht über die Id: eine Id wechselt bei jedem
 * `recreate`, der Name überlebt ihn.
 *
 * `null` heißt „keine gewählte Freigabe" und wird beim Verpacken zu einem
 * FEHLENDEN `shares`-Feld, NIE zu `[]` oder zu einer Liste mit einem leeren
 * Eintrag — dieselbe Falle wie bei `compose`: die Vertragsdatei des Agenten
 * (`src/registry.ts:318-330`, v0.19.1) verlangt für ein vorhandenes `shares`
 * eine Liste NICHT LEERER Texte und lehnt sonst den GANZEN Eintrag ab, nicht
 * nur das Feld. Ein Container ohne Anker in der Allowlist verlöre so seinen
 * ganzen Platz, statt nur seinen Web-FTP-Zugriff.
 *
 * `secured` fehlt weiterhin — dafür gilt die alte Begründung unverändert:
 * ein Feld, das heute immer denselben Wert trüge, wäre eine Zusage ohne
 * Deckung.
 */
export type RegistryEntryInput = {
  containerId: string;
  containerName: string;
  imageRef: string;
  allowed: boolean;
  // `null` heißt „dieser Container hat keinen vollständigen Anker" und wird
  // beim Verpacken zu einem FEHLENDEN Feld, nicht zu einem leeren Objekt.
  compose: RegistryComposeAnchor | null;
  // `null` heißt „keine gewählte Freigabe" — dieselbe Lesart wie bei `compose`
  // oben, aus demselben Grund.
  sharePath: string | null;
  // Ein anderer verwaltet die Definition dieses Containers (#124). Fehlt das
  // Feld oder ist es `false`, geht es gar nicht über die Leitung.
  externallyManaged?: boolean;
};

/** Ein Eintrag in der Form, die tatsächlich über die Leitung geht. */
export type RegistryWireEntry = {
  containerId: string;
  containerName: string;
  imageRef: string;
  allowed: boolean;
  compose?: RegistryComposeAnchor;
  // Immer eine Liste mit GENAU EINEM Eintrag, wenn vorhanden — die Ablage
  // hält nur einen gewählten Pfad je Container (s.o.), auch wenn die
  // Vertragsdatei des Agenten hier grundsätzlich mehrere zuließe.
  shares?: string[];
  // Nur `true` reist mit. Der Agent sperrt damit pull, recreate, apply-spec
  // und remove mit `403 externally-managed` (v0.31.0,
  // `dashboard-docker-agent#78`).
  externallyManaged?: true;
};

// ---------------------------------------------------------------------------
// Die Rechnung
// ---------------------------------------------------------------------------

/**
 * Sucht den Anker eines Containers in der Erhebung.
 *
 * ⚠️ EIN HALBER ANKER IST UNGÜLTIG UND WIRD GANZ VERWORFEN.
 * `isRegistryCompose` (v0.19.1, `src/registry.ts`) verlangt `projectDir`,
 * `serviceName` und `composeFileName` gemeinsam und je nicht leer; fehlt eines,
 * lehnt der Agent den GESAMTEN Eintrag ab — nicht nur dessen Anker. Ein
 * Container, für den die Erhebung nicht alle drei kennt, bekommt deshalb
 * `null` und damit später gar kein `compose`-Feld. Ein Eintrag mit leeren
 * Zeichenketten wäre der schlimmere Fall: er sähe aus wie ein Anker und kostete
 * den Container seinen ganzen Platz in der Allowlist.
 */
function findComposeAnchor(
  containerId: string,
  stacks: readonly DiscoveredStack[]
): RegistryComposeAnchor | null {
  for (const stack of stacks) {
    // Die erste Fundstelle gewinnt. Derselbe Container in zwei Stacks ist ein
    // Widerspruch in der Erhebung des Agenten und keine Lage, die dieser Hub
    // auflösen könnte — ein Container läuft aus genau einer Compose-Datei.
    const service = stack.services.find((candidate) => candidate.containerId === containerId);
    if (!service) continue;
    if (stack.projectDir === "" || stack.composeFileName === "" || service.serviceName === "") {
      return null;
    }
    const anchor: RegistryComposeAnchor = {
      projectDir: stack.projectDir,
      serviceName: service.serviceName,
      composeFileName: stack.composeFileName,
      origin: HUB_REGISTRY_ORIGIN
    };
    // Der Projektname ist im Vertrag optional; ein leerer wäre eine Angabe
    // ohne Inhalt. Weglassen kostet die Stack-Aktionen, ein leerer Wert
    // brächte sie auch nicht zurück.
    if (stack.projectName !== "") anchor.projectName = stack.projectName;
    return anchor;
  }
  return null;
}

/**
 * Bildet aus dem Bestand des Hosts und der Stack-Erhebung die Einträge der
 * Allowlist.
 *
 * ⚠️ DAS ERGEBNIS IST IMMER DIE VOLLSTÄNDIGE LISTE und nie eine
 * Änderungsmenge. `PUT /registry` ersetzt die Liste des Agenten vollständig
 * (`registry.replaceAll`); eine Teillieferung, die als Ganzes verstanden wird,
 * entzieht dem Agenten Container, die niemand angefasst hat. Der gemessene
 * Fall dazu steht in `domain/containers/containers.ts`: v0.17.0 und v0.18.0 lasen eine
 * Allowlist-Datei nur teilweise — am 2026-09-04 auf einem Live-Host
 * 13 Einträge in der Datei, 6 geladen, kein Wort im Log
 * (`dashboard-docker-agent#52`, behoben in v0.18.1).
 *
 * ⚠️ DER BESTAND FÜHRT, DIE ERHEBUNG ERGÄNZT. Ein Stack, dessen Dienst auf
 * einen Container zeigt, den der Bestand nicht führt, erzeugt keinen Eintrag:
 * die Allowlist beschriebe sonst einen Container, den es auf dem Host nicht
 * gibt.
 *
 * ⚠️ `shares` WIRD ÜBER DEN NAMEN ZUGEORDNET, NICHT ÜBER DIE ID —
 * Entscheidung des Leitstands (011-container-shares.sql): eine Container-Id
 * wechselt bei jedem `recreate`, der Name überlebt ihn. Ein Container, dessen
 * Name in `shares` nicht vorkommt, bekommt `sharePath: null` und damit später
 * gar kein `shares`-Feld — dieselbe Lesart wie bei einem fehlenden
 * Compose-Anker.
 */
export function buildRegistryEntries(
  hostContainers: readonly HostInventoryContainer[],
  stacks: readonly DiscoveredStack[],
  shares: readonly ContainerShareInput[] = [],
  // Ob der Agent `externallyManaged` kennt — `supportsExternallyManaged` in
  // `domain/hosts/version.ts`. Die Vorgabe `false` ist der sichere Stand aus #20.
  options: { readonly externallyManaged?: boolean } = {}
): RegistryEntryInput[] {
  const shareByName = new Map(shares.map((share) => [share.containerName, share.path]));
  const entries: RegistryEntryInput[] = [];
  for (const container of hostContainers) {
    // ⚠️ Fremdverwaltete Container (heute Unraids Templates) bekommen einen
    // Eintrag MIT `externallyManaged` — Entscheidung des Betreibers vom
    // 2026-09-30 (#124, `florianfinn/dashboard-docker-agent#78`). Sie bleiben
    // damit steuerbar und stehen in `GET /containers`; der Agent sperrt nur,
    // was ihre Definition ändert und was der Verwalter beim nächsten
    // „Apply Update" zurückbaute.
    //
    // ⚠️ Kennt der Agent das Feld nicht (`externallyManaged: false` unten,
    // Fassung vor v0.31.0), bleibt es beim Stand aus #20: GAR KEIN Eintrag.
    // Ein älterer Agent legte das Feld still ab und behandelte den Container
    // als gewöhnlich erlaubt — `pull`, `recreate` und `remove` stünden offen.
    const externallyManaged = container.externalManagement !== null;
    if (externallyManaged && !options.externallyManaged) continue;
    entries.push({
      containerId: container.id,
      containerName: container.name,
      // ⚠️ `imageRef` kommt aus dem BESTAND und nicht aus der Erhebung, auch
      // wenn beide etwas sagen. Der Bestand nennt das Image, mit dem der
      // Container GERADE LÄUFT; die Erhebung nennt, was in der Compose-Datei
      // steht. Die beiden fallen auseinander, sobald jemand die Datei ändert,
      // ohne neu zu starten. `imageRef` bestimmt beim Agenten, worauf ein
      // `pull` ziehen darf — und das muss der laufende Stand sein, nicht ein
      // künftig gewollter, sonst zöge ein Update auf etwas, das dieser
      // Container nie war.
      imageRef: container.image,
      allowed: true,
      compose: findComposeAnchor(container.id, stacks),
      sharePath: shareByName.get(container.name) ?? null,
      ...(externallyManaged ? { externallyManaged: true } : {})
    });
  }
  return entries;
}

/**
 * Verpackt die Einträge in den Rumpf von `PUT /registry`.
 *
 * ⚠️ Hier fällt `compose: null` WEG, statt als leeres Objekt mitzureisen.
 * `isRegistryEntry` (v0.19.1) lehnt einen Eintrag mit unbrauchbarem
 * `compose`-Feld ab — und `replaceAll` lässt einen abgelehnten Eintrag
 * stillschweigend weg. Ein Container ohne Anker verlöre so seinen ganzen
 * Platz in der Allowlist, statt nur seinen Compose-Zugriff.
 *
 * ⚠️ DASSELBE FÜR `sharePath: null` — es fällt WEG und wird NIE zu `shares: []`.
 * Ein leeres Array sähe aus wie eine Angabe „keine Freigaben" und wäre
 * trotzdem auf der Leitung gültig — die eigentliche Gefahr liegt woanders:
 * `isRegistryEntry` verlangt für ein VORHANDENES `shares`-Feld eine Liste
 * nicht leerer Texte und lehnt sonst den GANZEN Eintrag ab. Ein Formfehler
 * hier kostete also nicht nur den Web-FTP-Zugriff, sondern den ganzen Platz
 * des Containers in der Allowlist.
 */
export function toRegistryRequestBody(entries: readonly RegistryEntryInput[]): {
  entries: RegistryWireEntry[];
} {
  return {
    entries: entries.map((entry) => {
      const wire: RegistryWireEntry = {
        containerId: entry.containerId,
        containerName: entry.containerName,
        imageRef: entry.imageRef,
        allowed: entry.allowed
      };
      if (entry.compose !== null) wire.compose = entry.compose;
      if (entry.sharePath !== null) wire.shares = [entry.sharePath];
      if (entry.externallyManaged === true) wire.externallyManaged = true;
      return wire;
    })
  };
}

// ---------------------------------------------------------------------------
// Der Schreibaufruf
// ---------------------------------------------------------------------------

/**
 * Der Aufrufer, unter dem ein Abgleich ohne Menschen davor im Audit-Log des
 * Agenten steht.
 *
 * ⚠️ Nicht ein Benutzerkonto. Der Agent schreibt `x-docker-agent-actor` in
 * sein Log; ein `user:<id>` an dieser Stelle behauptete, ein Mensch habe den
 * Abgleich ausgelöst. Der Abgleich läuft aber von selbst, und wer das Log
 * später liest, sucht sonst nach einer Entscheidung, die niemand getroffen
 * hat.
 */
export const REGISTRY_SYNC_ACTOR: Actor = { kind: "system", name: "hub" };

/** Liest die Zahl aus der Quittung des Agenten. */
function acceptedCount(body: unknown): number {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AgentError("Die Quittung des Agenten auf PUT /registry ist kein Objekt.");
  }
  const value = (body as Record<string, unknown>).entries;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new AgentError(
      `Die Quittung des Agenten auf PUT /registry nennt keine Zahl im Feld „entries" — ` +
        "ohne sie ist nicht feststellbar, wie viele Einträge angekommen sind."
    );
  }
  return value;
}

/**
 * Schickt die vollständige Allowlist an den Agenten.
 *
 * ⚠️ DER AGENT ANTWORTET AUF EINEN FORMFEHLER MIT `200`. `replaceAll`
 * (v0.19.1, `src/registry.ts`) lässt jeden Eintrag, den `isRegistryEntry`
 * ablehnt, stillschweigend weg und quittiert trotzdem mit
 * `{ ok: true, entries: <Zahl> }`. Diese Zahl ist die EINZIGE Rückmeldung
 * darüber, wie viele Einträge tatsächlich angekommen sind — deshalb wird sie
 * hier gegen die gesendete geprüft und eine Abweichung als Fehler gemeldet.
 *
 * Ohne diese Prüfung wäre ein Formfehler auf Hub-Seite unsichtbar: der
 * Abgleich meldete „hat geklappt" und hätte nichts eingetragen. Das ist der
 * schlimmste Fall dieser Etappe — ein Container ohne Eintrag ist beim Agenten
 * für jede Aktion gesperrt, und niemand sähe, warum.
 */
export async function syncRegistry(
  target: AgentTarget,
  entries: readonly RegistryEntryInput[],
  options: RequestOptions
): Promise<void> {
  const body = toRegistryRequestBody(entries);
  const sent = body.entries.length;
  const accepted = acceptedCount(await agentPut(target, "/registry", body, options));
  if (accepted !== sent) {
    throw new AgentError(
      `Der Agent hat ${accepted} von ${sent} Einträgen übernommen. Er lässt Einträge, deren Form er ablehnt, ` +
        "stillschweigend weg und antwortet trotzdem mit 200 — die fehlenden Container sind bei ihm für jede " +
        "Aktion gesperrt. Sein Audit-Log auf dem Zielhost nennt, welche."
    );
  }
}
