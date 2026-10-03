import test from "node:test";
import assert from "node:assert/strict";

import type { AgentHealth } from "./health.js";
import type { DiscoveredStack, HostInventoryContainer, RegistryEntryInput } from "../containers/index.js";
import type { HostRecord } from "./index.js";
import { DEFAULT_HOST_THEME } from "contract";
import { registryFingerprint, runHostCycle, type HostCycleDeps, type HostObservation } from "./host-cycle.js";

// Der Hintergrundlauf, geprüft mit eingespeisten Attrappen — ohne Netz, ohne
// Agenten und ohne Uhr (AGENTS.md verlangt Tests ohne echte Dienste).
//
// ⚠️ KEIN `setTimeout` in dieser Datei. Die Zeit kommt aus `now()`, und der
// Zeitgeber selbst wird in `host-cycle-timer.test.ts` geprüft. Ein Test, der
// auf eine echte Uhr wartet, macht den Lauf langsam und wackelig.

function host(id: string, overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    id,
    name: `arm-${id}`,
    agentUrl: `http://${id}.example:8099`,
    kind: "internal",
    state: "registered",
    tunnelAddress: "10.254.0.2",
    wireguardPublicKey: null,
    endpointOverride: null,
    failedAttempts: 0,
    display: DEFAULT_HOST_THEME,
    dockerGid: null,
    bindBasePath: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    registeredAt: new Date("2026-09-01T00:00:00Z"),
    lastSeenAt: null,
    ...overrides
  };
}

const ONLINE: AgentHealth = { reachable: true, version: "0.32.0", contractVersion: 7, readOnly: false, entries: null };

function container(id: string, image = "ghcr.io/example/app:1"): HostInventoryContainer {
  return { id, name: `c-${id}`, image, externalManagement: null };
}

// Ein Aufzeichner: er ist der Halter aus Baustein 2 in seiner kleinsten Form
// und zugleich das Protokoll dessen, was der Lauf getan hat.
type Harness = {
  deps: HostCycleDeps;
  observations: Map<string, HostObservation>;
  probed: string[];
  sent: { hostId: string; entries: readonly RegistryEntryInput[] }[];
  inventory: Map<string, HostInventoryContainer[]>;
};

function harness(
  records: HostRecord[],
  overrides: Partial<HostCycleDeps> = {},
  inventoryByHost: Record<string, HostInventoryContainer[]> = {}
): Harness {
  const observations = new Map<string, HostObservation>();
  const probed: string[] = [];
  const sent: { hostId: string; entries: readonly RegistryEntryInput[] }[] = [];
  const inventory = new Map(Object.entries(inventoryByHost));
  let tick = 1_000;

  const deps: HostCycleDeps = {
    listHosts: () => Promise.resolve(records),
    readObservation: (hostId) => observations.get(hostId),
    writeObservation: (observation) => {
      observations.set(observation.hostId, observation);
    },
    probeHost: (record) => {
      probed.push(record.id);
      return Promise.resolve(ONLINE);
    },
    fetchInventory: (record) => Promise.resolve(inventory.get(record.id) ?? [container("a")]),
    fetchStacks: () => Promise.resolve([] as DiscoveredStack[]),
    readShares: () => Promise.resolve([]),
    fetchHostInfo: () => Promise.resolve({ cpuCores: 4, memTotalBytes: 8_000 }),
    sendRegistry: (record, entries) => {
      sent.push({ hostId: record.id, entries });
      return Promise.resolve();
    },
    // Eine Uhr, die bei jedem Blick um eine Millisekunde weiterspringt: so
    // trägt jeder Zeitstempel einen anderen Wert, und ein Test kann zeigen,
    // dass er aus DIESER Uhr kommt und nicht aus `Date.now()`.
    now: () => tick++,
    ...overrides
  };

  return { deps, observations, probed, sent, inventory };
}

test("ein wartender Arm wird übersprungen und gar nicht erst befragt", async () => {
  // ⚠️ Der Kern dieses Falls ist `probed`, nicht das Ergebnis: ein wartender
  // Arm hat keinen Agenten, und eine Sonde dorthin liefe in ihre Frist. Bei
  // zwanzig wartenden Armen dauerte der Durchlauf eine Minute für nichts.
  const kit = harness([host("h1", { state: "pending" })]);
  const result = await runHostCycle(kit.deps);

  assert.deepEqual(kit.probed, []);
  assert.deepEqual(kit.sent, []);
  assert.equal(result.hosts.length, 1);
  assert.equal(result.hosts[0].status, "pending");

  // `agent: null` heißt NICHT GEFRAGT — ein Leser muss das von „still"
  // unterscheiden können.
  const observation = kit.observations.get("h1");
  assert.ok(observation !== undefined, "der wartende Arm wird trotzdem abgelegt");
  assert.equal(observation.agent, null);
  assert.equal(observation.error, null);
});

test("ein unerreichbarer Arm wird abgelegt, aber nicht abgeglichen", async () => {
  const kit = harness([host("h1")], {
    probeHost: () => Promise.resolve({ reachable: false, error: "Agent antwortete nicht innerhalb von 3000 ms" })
  });
  const result = await runHostCycle(kit.deps);

  assert.deepEqual(kit.sent, [], "einem stillen Arm wird nichts geschickt");
  assert.equal(result.hosts[0].status, "unreachable");
  assert.equal(result.hosts[0].error, "Agent antwortete nicht innerhalb von 3000 ms");

  const observation = kit.observations.get("h1");
  assert.ok(observation !== undefined, "der stille Arm steht im Halter");
  assert.deepEqual(observation.agent, { reachable: false, error: "Agent antwortete nicht innerhalb von 3000 ms" });
  // Nicht erreichbar ist kein Fehler DES DURCHLAUFS: `error` bleibt frei für
  // das, was nach der Sonde schiefging.
  assert.equal(observation.error, null);
});

test("ein Arm, der wirft, nimmt den anderen seinen Durchlauf nicht", async () => {
  // ⚠️ Ohne diese Eigenschaft nähme der erste kaputte Arm allen übrigen ihren
  // Abgleich — und zwar still, denn ein Zeitgeber sähe nur eine abgelehnte
  // Zusage.
  const kit = harness([host("h1"), host("h2")], {
    fetchInventory: (record) => {
      if (record.id === "h1") return Promise.reject(new Error('host-containers: das Feld „id" fehlt oder ist leer.'));
      return Promise.resolve([container("a")]);
    }
  });
  const result = await runHostCycle(kit.deps);

  assert.deepEqual(
    result.hosts.map((entry) => [entry.hostId, entry.status]),
    [
      ["h1", "failed"],
      ["h2", "synced"]
    ]
  );
  assert.deepEqual(
    kit.sent.map((entry) => entry.hostId),
    ["h2"]
  );
  assert.equal(kit.observations.get("h1")?.error, 'host-containers: das Feld „id" fehlt oder ist leer.');
});

test("derselbe Bestand zweimal ergibt genau EINEN PUT", async () => {
  // ⚠️ Der teuerste Fehler dieses Bausteins, und einer, den kein Typ fängt:
  // ohne den Vergleich schickt der Hub im Minutentakt dieselbe Liste, und
  // jeder Schub steht im Audit-Log des Agenten. Der eine Schub, der wirklich
  // etwas geändert hat, wäre darin nicht mehr zu finden.
  const kit = harness([host("h1")], {}, { h1: [container("a"), container("b")] });

  await runHostCycle(kit.deps);
  assert.equal(kit.sent.length, 1, "der erste Durchlauf schickt");
  assert.equal(kit.sent[0].entries.length, 2);

  const first = await runHostCycle(kit.deps);
  assert.equal(kit.sent.length, 1, "der zweite Durchlauf schickt NICHT noch einmal");
  assert.equal(first.hosts[0].status, "unchanged");
  // Gerechnet wurde trotzdem — die Zahl steht im Ergebnis, obwohl nichts
  // losging.
  assert.equal(first.hosts[0].entryCount, 2);

  const third = await runHostCycle(kit.deps);
  assert.equal(kit.sent.length, 1, "und auch beim dritten nicht");
  assert.equal(third.hosts[0].status, "unchanged");
});

test("fremdverwaltete gehen erst an einen Agenten ab v0.31.0 (#124)", async () => {
  const unraid: HostInventoryContainer = { ...container("u"), externalManagement: { manager: "unraid" } };
  let version = "0.30.0";
  const kit = harness(
    [host("h1")],
    { probeHost: () => Promise.resolve({ ...ONLINE, version }) },
    { h1: [container("a"), unraid] }
  );

  await runHostCycle(kit.deps);
  assert.deepEqual(kit.sent[0].entries.map((entry) => entry.containerId), ["a"], "ein älterer Agent bekommt ihn nicht");

  // Nach dem Update des Arms ändert sich die Liste und geht im selben Takt neu los.
  version = "0.31.0";
  await runHostCycle(kit.deps);
  assert.equal(kit.sent.length, 2);
  const sent = kit.sent[1].entries.find((entry) => entry.containerId === "u");
  assert.equal(sent?.externallyManaged, true);
  assert.equal(sent?.allowed, true);
});

test("ein geänderter Bestand ergibt einen zweiten PUT", async () => {
  const kit = harness([host("h1")], {}, { h1: [container("a")] });

  await runHostCycle(kit.deps);
  assert.equal(kit.sent.length, 1);

  kit.inventory.set("h1", [container("a"), container("b")]);
  const result = await runHostCycle(kit.deps);

  assert.equal(kit.sent.length, 2, "eine geänderte Liste geht los");
  assert.equal(result.hosts[0].status, "synced");
  assert.equal(kit.sent[1].entries.length, 2);
});

test("ein Arm, der seine Allowlist verloren hat, bekommt sie im nächsten Takt wieder (#123)", async () => {
  // Der Arm hat sein `/state`-Volume verloren und ist still auf die leere
  // Liste gefallen. Bestand und Fingerabdruck im Hub sind unverändert — nur
  // `entries` aus `/health` zeigt den Unterschied.
  let armEntries: number | null = 2;
  const kit = harness([host("h1")], {
    probeHost: () => Promise.resolve({ ...ONLINE, entries: armEntries })
  }, { h1: [container("a"), container("b")] });

  await runHostCycle(kit.deps);
  assert.equal(kit.sent.length, 1);

  const steady = await runHostCycle(kit.deps);
  assert.equal(steady.hosts[0].status, "unchanged", "gleiche Zahl am Arm: kein Schub");

  armEntries = 0;
  const recovered = await runHostCycle(kit.deps);
  assert.equal(recovered.hosts[0].status, "synced", "abweichende Zahl am Arm: neu senden");
  assert.equal(kit.sent.length, 2);
  assert.equal(kit.sent[1].entries.length, 2);

  // Ein Agent, der keine Zahl nennt, löst keinen Schub aus.
  armEntries = null;
  const silent = await runHostCycle(kit.deps);
  assert.equal(silent.hosts[0].status, "unchanged");
  assert.equal(kit.sent.length, 2);
});

test("ein anderes Image bei gleicher Containerliste gilt als Änderung", async () => {
  // `imageRef` bestimmt beim Agenten, worauf ein `pull` ziehen darf. Eine
  // Abbildung, die nur die Kennungen sähe, hielte einen neu gestarteten
  // Container für unverändert.
  const kit = harness([host("h1")], {}, { h1: [container("a", "ghcr.io/example/app:1")] });
  await runHostCycle(kit.deps);

  kit.inventory.set("h1", [container("a", "ghcr.io/example/app:2")]);
  await runHostCycle(kit.deps);

  assert.equal(kit.sent.length, 2);
});

test("ein gescheiterter Schub legt die Abbildung NICHT ab", async () => {
  // ⚠️ Stünde die Abbildung vor der Quittung im Halter, hielte der Hub sich
  // für erledigt: die Liste ginge bis zur nächsten echten Änderung nie wieder
  // los, und der Arm bliebe beim Agenten für jede Aktion gesperrt.
  let failNext = true;
  const kit = harness([host("h1")], {
    sendRegistry: () => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("Der Agent hat 0 von 2 Einträgen übernommen."));
      }
      return Promise.resolve();
    }
  });

  const first = await runHostCycle(kit.deps);
  assert.equal(first.hosts[0].status, "failed");
  assert.equal(kit.observations.get("h1")?.syncedFingerprint, null);

  const second = await runHostCycle(kit.deps);
  assert.equal(second.hosts[0].status, "synced", "der nächste Durchlauf versucht es erneut");
  assert.ok(kit.observations.get("h1")?.syncedFingerprint !== null);
});

test("was der Lauf über den Abgleich nicht neu weiß, bleibt im Halter stehen", async () => {
  // Ein Arm, der einmal abgeglichen wurde und danach still wird, verliert
  // seinen zuletzt gesendeten Stand nicht — sonst schickte der Hub nach jeder
  // Störung dieselbe Liste erneut.
  const kit = harness([host("h1")]);
  await runHostCycle(kit.deps);
  const fingerprint = kit.observations.get("h1")?.syncedFingerprint;
  assert.ok(typeof fingerprint === "string");

  kit.deps.probeHost = () => Promise.resolve({ reachable: false, error: "aus" });
  await runHostCycle(kit.deps);

  const observation = kit.observations.get("h1");
  assert.equal(observation?.syncedFingerprint, fingerprint);
  assert.equal(observation?.agent?.reachable, false);
});

test("ein Halter, der beim Schreiben wirft, nimmt die anderen Arme nicht mit", async () => {
  // ⚠️ Der Grund für `Promise.allSettled`: ein unbehandelter Fehler in einem
  // Zeitgeber beendet den Prozess. Ein Hub, der nachts an einem Arm stirbt,
  // ist schlimmer als einer ohne Lauf.
  const kit = harness([host("h1"), host("h2")], {
    writeObservation: (observation) => {
      if (observation.hostId === "h1") throw new Error("Halter kaputt");
    }
  });

  const result = await runHostCycle(kit.deps);
  assert.deepEqual(
    result.hosts.map((entry) => [entry.hostId, entry.status]),
    [
      ["h1", "failed"],
      ["h2", "synced"]
    ]
  );
  assert.equal(result.hosts[0].error, "Halter kaputt");
});

test("die Zeitstempel kommen aus der eingespeisten Uhr", async () => {
  let value = 5_000;
  const kit = harness([host("h1")], { now: () => value++ });
  const result = await runHostCycle(kit.deps);

  assert.equal(result.startedAt, 5_000);
  assert.ok(result.finishedAt > result.startedAt);
  const observation = kit.observations.get("h1");
  assert.ok(observation !== undefined, "der Arm steht im Halter");
  assert.ok(observation.checkedAt >= 5_000 && observation.checkedAt <= result.finishedAt);
  assert.ok(observation.syncedAt !== null);
});

test("die Reihenfolge der Antwort ist die der Eingabe", async () => {
  const kit = harness([host("h3"), host("h1"), host("h2")]);
  const result = await runHostCycle(kit.deps);
  assert.deepEqual(
    result.hosts.map((entry) => entry.hostId),
    ["h3", "h1", "h2"]
  );
});

test("die Abbildung ist unabhängig von der Reihenfolge des Bestands", async () => {
  // ⚠️ Die Reihenfolge, in der ein Agent seinen Bestand aufzählt, ist nicht
  // zugesagt. Ohne die Sortierung wäre eine umgestellte Antwort desselben
  // Bestands eine „Änderung" — und der Vergleich verlöre genau dort seine
  // Wirkung, wo er gebraucht wird.
  const entries: RegistryEntryInput[] = [
    { containerId: "b", containerName: "c-b", imageRef: "img:1", allowed: true, compose: null, sharePath: null },
    { containerId: "a", containerName: "c-a", imageRef: "img:1", allowed: true, compose: null, sharePath: null }
  ];
  assert.equal(registryFingerprint(entries), registryFingerprint([...entries].reverse()));
});

test("die Abbildung unterscheidet zwei verschiedene Bestände", () => {
  // Ein Wächter, der immer dasselbe sagt, ist kein Wächter.
  const one: RegistryEntryInput[] = [
    { containerId: "a", containerName: "c-a", imageRef: "img:1", allowed: true, compose: null, sharePath: null }
  ];
  const two: RegistryEntryInput[] = [
    { containerId: "a", containerName: "c-a", imageRef: "img:2", allowed: true, compose: null, sharePath: null }
  ];
  assert.notEqual(registryFingerprint(one), registryFingerprint(two));
  assert.notEqual(registryFingerprint(one), registryFingerprint([]));
});

test("der Anker gehört zur Abbildung", () => {
  // Ein Container, dessen Compose-Anker verschwindet, ist beim Agenten ein
  // anderer Container — er verliert jede Stack-Aktion. Das muss ein Schub
  // sein.
  const withoutAnchor: RegistryEntryInput[] = [
    { containerId: "a", containerName: "c-a", imageRef: "img:1", allowed: true, compose: null, sharePath: null }
  ];
  const withAnchor: RegistryEntryInput[] = [
    {
      containerId: "a",
      containerName: "c-a",
      imageRef: "img:1",
      allowed: true,
      sharePath: null,
      compose: {
        projectDir: "/srv/stacks/media",
        projectName: "media",
        serviceName: "web",
        composeFileName: "docker-compose.yml",
        origin: "adopted"
      }
    }
  ];
  assert.notEqual(registryFingerprint(withoutAnchor), registryFingerprint(withAnchor));
});

test("ein leerer Bestand von Armen ergibt einen leeren Durchlauf und keinen Fehler", async () => {
  const kit = harness([]);
  const result = await runHostCycle(kit.deps);
  assert.deepEqual(result.hosts, []);
  assert.deepEqual(kit.sent, []);
});

test("die Ausstattung eines Arms wird je Durchlauf gelesen und abgelegt (#214)", async () => {
  const kit = harness([host("h1")]);
  await runHostCycle(kit.deps);
  assert.deepEqual(kit.observations.get("h1")?.hostInfo, { cpuCores: 4, memTotalBytes: 8_000 });
});

test("scheitert die Ausstattung, bleibt der vorige Stand und der Abgleich läuft trotzdem", async () => {
  // Die Allowlist ist die Voraussetzung jeder Aktion, die Last nur eine
  // Anzeige: ein Arm ohne `/host-info` darf seinen Abgleich nicht verlieren.
  let calls = 0;
  const kit = harness([host("h1")], {
    fetchHostInfo: () => {
      calls += 1;
      return calls === 1 ? Promise.resolve({ cpuCores: 2, memTotalBytes: 100 }) : Promise.reject(new Error("404"));
    }
  });
  await runHostCycle(kit.deps);
  kit.inventory.set("h1", [container("b")]);
  const second = await runHostCycle(kit.deps);

  assert.equal(second.hosts[0].status, "synced", "der Abgleich nach der Änderung ging los");
  assert.equal(kit.sent.length, 2);
  assert.deepEqual(kit.observations.get("h1")?.hostInfo, { cpuCores: 2, memTotalBytes: 100 });
});

test("ein unerreichbarer Arm behält seine Ausstattung", async () => {
  let reachable = true;
  const kit = harness([host("h1")], {
    probeHost: () => Promise.resolve(reachable ? ONLINE : { reachable: false, error: "still" })
  });
  await runHostCycle(kit.deps);
  reachable = false;
  await runHostCycle(kit.deps);
  assert.deepEqual(kit.observations.get("h1")?.hostInfo, { cpuCores: 4, memTotalBytes: 8_000 });
});

test("eine schweigende Ausstattung hält den Schub der Allowlist nicht auf", async () => {
  // Der Arm beantwortet `/host-info` erst, wenn der Test es sagt. Der Schub
  // muss vorher draußen sein — sonst wartete jeder Abgleich, auch der nach
  // einem angewandten Compose-Entwurf, bis in die Frist dieser einen Frage.
  let answer: (info: { cpuCores: number; memTotalBytes: number }) => void = () => undefined;
  const kit = harness([host("h1")], {
    fetchHostInfo: () =>
      new Promise((resolve) => {
        answer = resolve;
      })
  });
  const running = runHostCycle(kit.deps);
  for (let round = 0; round < 20 && kit.sent.length === 0; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(kit.sent.length, 1, "der Schub ging los, bevor die Ausstattung antwortete");

  answer({ cpuCores: 6, memTotalBytes: 600 });
  const result = await running;
  assert.equal(result.hosts[0].status, "synced");
  assert.deepEqual(kit.observations.get("h1")?.hostInfo, { cpuCores: 6, memTotalBytes: 600 });
});
