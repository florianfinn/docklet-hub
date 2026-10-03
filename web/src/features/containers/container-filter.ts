import type {
  ContainerEntry,
  ContainerState,
  HostOverview,
  OverviewContainer,
  StackView
} from "contract";

// Suche und Filter der Übersicht — die Leiste über der Liste
// (docs/design/mockup/container-module.html Z. 172–181: ein Suchfeld, darunter
// „alle 34“, „läuft 31“, „aus 1“).
//
// ⚠️ DER VIERTE CHIP DES ARTBOARDS FEHLT HIER, und zwar mit Absicht: „Update
// 3“. Weder der Agent (v0.18.1) noch der Hub melden bisher, ob für ein Image
// eine neuere Fassung bereitliegt — `grep -rn "digest\|update" server/src`
// findet dazu nichts (gemessen 2026-09-05). Ein Chip, der immer „Update 0“
// zeigt, ist kein Platzhalter, sondern eine falsche Aussage über den Bestand:
// er sagt „nichts zu tun“, wo in Wahrheit niemand nachgesehen hat. Dasselbe
// gilt für die Marke „neu“ an der Zeile. Beide kommen mit dem Signal, das sie
// speist, und nicht vorher.

// ⚠️ Diese Liste ist die EINE Quelle der Filter. Der Wächter
// web/tests/overview-filters.test.mjs hält sie gegen die Sprachdateien: jeder
// Eintrag braucht `overviewFilter<Name>` in de.ts und en.ts, und kein solcher
// Schlüssel darf ohne Eintrag hier stehen. Ein Filter ohne Beschriftung
// erschiene sonst als leerer Knopf.
//
// ⚠️ „unhealthy" (der Chip „krank") kam mit D6b dazu — das Artboard führt vier
// Chips, D6 baute drei. Er steht hier und nicht nur auf der neuen Fläche:
// zwei Filterlisten wären zwei Wahrheiten, und die Übersicht zeigte dann eine
// Kategorie nicht, die der Deepdive kennt.
export const CONTAINER_FILTERS = ["all", "running", "unhealthy", "stopped"] as const;

export type ContainerFilter = (typeof CONTAINER_FILTERS)[number];

export type FilterCounts = Record<ContainerFilter, number>;

// Die drei Zustände des Servers, auf die drei Chips abgebildet — und umgekehrt.
//
// ⚠️ Gefiltert wird über `state` und NICHT mehr über `running`. Der Grund ist
// eine Zahl: mit `running` fiele ein kranker Container zugleich unter „läuft"
// und unter „krank", und die Zähler summierten sich auf mehr als „alle". Das
// Artboard rechnet ausdrücklich anders (Z. 570-573: 31 + 1 + 2 = 34), und der
// Server liefert die Trennung schon fertig (`server/src/domain/containers/stacks.ts`:
// nicht laufend ist `down`, laufend und `unhealthy` ist `warn`, sonst `ok`).
const FILTER_OF_STATE: Record<ContainerState, Exclude<ContainerFilter, "all">> = {
  ok: "running",
  warn: "unhealthy",
  down: "stopped"
};

function matchesFilter(container: OverviewContainer, filter: ContainerFilter): boolean {
  if (filter === "all") return true;
  return FILTER_OF_STATE[container.state] === filter;
}

// Gesucht wird über Name, Dienst im Stack und Image. Nicht über den
// Statustext: der lautet „Up 2 hours“ und träfe bei der Eingabe „up“ jeden
// laufenden Container — ein Treffer, der wie ein Fund aussieht und keiner ist.
function matchesQuery(container: ContainerEntry, needle: string): boolean {
  if (needle === "") return true;
  const haystack = [container.name, container.image, container.compose?.service ?? ""];
  return haystack.some((value) => value.toLowerCase().includes(needle));
}

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * Die Zahlen an den Chips — über ALLE Hosts, nicht über die gefilterte Liste.
 *
 * ⚠️ Sonst zeigte „aus 1“ nach einem Klick auf „läuft“ plötzlich „aus 0“. Die
 * Zahl an einem Filter sagt, was er finden WÜRDE; sie ist der Grund, ihn
 * anzuklicken, und darf sich durch das Anklicken eines anderen nicht ändern.
 *
 * ⚠️ Die Suche zählt dagegen SEHR WOHL mit: sie schränkt die Menge ein, über
 * die überhaupt gesprochen wird. Wer „arr“ sucht, will wissen, wie viele der
 * gefundenen laufen — nicht, wie viele im ganzen Haus laufen.
 */
export function countContainers(hosts: HostOverview[], query: string): FilterCounts {
  const needle = normalizeQuery(query);
  const counts: FilterCounts = { all: 0, running: 0, unhealthy: 0, stopped: 0 };
  for (const container of allContainers(hosts)) {
    if (!matchesQuery(container, needle)) continue;
    counts.all += 1;
    counts[FILTER_OF_STATE[container.state]] += 1;
  }
  return counts;
}

export function allContainers(hosts: HostOverview[]): OverviewContainer[] {
  return hosts.flatMap((host) => [...host.stacks.flatMap((stack) => stack.containers), ...host.loose]);
}

export type FilteredHost = {
  stacks: StackView[];
  loose: OverviewContainer[];
  // Wie viele Container nach Suche und Filter übrig sind. Getrennt geführt,
  // weil die Fläche daraus zwei verschiedene Sätze macht: „keine Treffer“ bei
  // einer Suche und „keine Container in der Allowlist“ ohne eine.
  count: number;
};

/**
 * Wendet Suche und Filter auf einen Host an.
 *
 * ⚠️ Ein Stack, von dem nichts übrig bleibt, VERSCHWINDET; seine Zahlen
 * bleiben aber die ungefilterten. Deshalb wird hier NUR `containers` ersetzt:
 * `running` und `total` kommen unverändert aus der Antwort des Servers. Der
 * Stack ist die Einheit, und „6 von 8 laufen“ ist die Aussage über ihn — eine
 * Zahl, die sich mit dem Filter mitbewegte, sagte am Ende nur noch, was der
 * Filter tut. (Gemessen am 2026-09-06: der erste Entwurf las den Nenner aus
 * der gefilterten Liste und schrieb mit dem Filter „aus“ ein „2/1“.)
 *
 * ⚠️ Ein Treffer im NAMEN DES STACKS zeigt den ganzen Stack. Wer „arr“ sucht,
 * meint das Projekt und nicht die drei Container, die zufällig „arr“ im Namen
 * tragen.
 */
export function filterHost(host: HostOverview, filter: ContainerFilter, query: string): FilteredHost {
  const needle = normalizeQuery(query);

  const stacks = host.stacks.flatMap((stack) => {
    const wholeStack = needle !== "" && stack.project.toLowerCase().includes(needle);
    const containers = stack.containers.filter(
      (container) => matchesFilter(container, filter) && (wholeStack || matchesQuery(container, needle))
    );
    return containers.length === 0 ? [] : [{ ...stack, containers }];
  });

  const loose = host.loose.filter(
    (container) => matchesFilter(container, filter) && matchesQuery(container, needle)
  );

  return {
    stacks,
    loose,
    count: stacks.reduce((sum, stack) => sum + stack.containers.length, 0) + loose.length
  };
}

/**
 * Welche Container eine Fläche überhaupt führt — VOR Suche und Filter.
 *
 * `workload` ohne die Container des Leitstands selbst (die Vorgabe von
 * Übersicht und Container-Fläche), `system` nur sie (der Reiter „Hub &
 * Agenten" der Einstellungen), `all` beide.
 *
 * ⚠️ Ein Stack fällt nur GANZ heraus oder bleibt ganz: `system` kommt vom
 * Server je Stack und gilt für jedes Mitglied. Seine Zahlen (`running`,
 * `total`) bleiben damit wahr.
 *
 * ⚠️ Die Zähler der Chips rechnen danach — `countContainers` bekommt die
 * eingeschränkte Liste. Ein „alle 34“ über einer Liste, die 28 zeigt, wäre
 * eine Zahl über Container, die hier niemand sehen kann.
 */
export type ContainerScope = "workload" | "system" | "all";

// Ein Host nach der Einschränkung. `hidden` zählt, was sie weggenommen hat:
// ein Arm, auf dem NUR Agent und Watcher laufen, soll nicht „Kein Container
// freigegeben“ melden, wo in Wahrheit nur ausgeblendet ist.
//
// ⚠️ Ein eigener Typ im Web und kein Feld an `HostOverview`: jene Form ist
// die Abschrift der Serverantwort (`web/tests/api-mirror.test.mjs`), und
// `hidden` schickt der Server nicht.
export type ScopedHost = HostOverview & { hidden: number };

function containerCount(host: HostOverview): number {
  return host.stacks.reduce((sum, stack) => sum + stack.containers.length, 0) + host.loose.length;
}

export function scopeHosts(hosts: HostOverview[], scope: ContainerScope): ScopedHost[] {
  if (scope === "all") return hosts.map((host) => ({ ...host, hidden: 0 }));
  const wanted = scope === "system";
  // ⚠️ `=== true` und kein blankes `stack.system`: ein Hub, der das Feld
  // noch nicht sendet (ältere Fassung während eines Deploys), liefert
  // `undefined` — und das heißt „nicht bekannt als Leitstand", nicht „weg".
  const isSystem = (entry: { system?: boolean }) => entry.system === true;
  return hosts.map((host) => {
    const scoped = {
      ...host,
      stacks: host.stacks.filter((stack) => isSystem(stack) === wanted),
      loose: host.loose.filter((container) => isSystem(container) === wanted)
    };
    return { ...scoped, hidden: containerCount(host) - containerCount(scoped) };
  });
}
