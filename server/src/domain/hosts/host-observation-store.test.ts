import test from "node:test";
import assert from "node:assert/strict";

import type { AgentHealth } from "./health.js";
import type { HostRecord } from "./index.js";
import { DEFAULT_HOST_THEME } from "contract";
import type { HostObservation } from "./host-cycle.js";
import { createHostObservationStore, createObservedProbe, staleAfterMs } from "./host-observation-store.js";

// Der Halter und seine Leseseite — ohne Uhr, ohne Netz.

const ONLINE: AgentHealth = { reachable: true, version: "0.32.0", contractVersion: 13, readOnly: false, entries: null };
const PROBED: AgentHealth = { reachable: true, version: "0.32.1", contractVersion: 13, readOnly: false, entries: null };

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

function observation(overrides: Partial<HostObservation> = {}): HostObservation {
  return {
    hostId: "h1",
    agent: ONLINE,
    checkedAt: 1_000,
    error: null,
    syncedFingerprint: "[]",
    syncedEntryCount: 0,
    syncedAt: 1_000,
    hostInfo: null,
    ...overrides
  };
}

test("der Halter gibt zurück, was hineingelegt wurde, und sonst nichts", () => {
  const store = createHostObservationStore();
  assert.equal(store.read("h1"), undefined, "ein unbekannter Arm ist nicht abgelegt");

  const first = observation();
  store.write(first);
  assert.deepEqual(store.read("h1"), first);

  store.write(observation({ checkedAt: 2_000 }));
  assert.equal(store.read("h1")?.checkedAt, 2_000, "der zweite Stand ersetzt den ersten");
  assert.equal(store.read("h2"), undefined);
});

test("ein zweiter Halter weiß nichts vom ersten", () => {
  // Er lebt im Arbeitsspeicher dieses einen Prozesses — nach einem Neustart
  // weiß der Hub nichts und fragt neu. Das ist die Zusage, und sie ist hier
  // festgehalten, damit ein späterer Umbau auf eine Tabelle nicht unbemerkt
  // eine Wahrheit von gestern behauptet.
  const first = createHostObservationStore();
  first.write(observation());
  assert.equal(createHostObservationStore().read("h1"), undefined);
});

test("die Verfallsfrist sind zwei Intervalle, mindestens aber eine Minute", () => {
  // ⚠️ Zwei Intervalle, weil der Riegel gegen überlappende Läufe einen Takt
  // auslassen darf. Alles darüber heißt: mindestens ein ganzer Takt hat nichts
  // geschrieben.
  assert.equal(staleAfterMs(60_000), 120_000, "die Vorgabe von 60 s ergibt 120 s");
  assert.equal(staleAfterMs(300_000), 600_000);
  // Die Untergrenze greift erst bei sehr kurzen Takten — sonst verfiele ein
  // eben geschriebener Stand, während der laufende Durchlauf noch unterwegs
  // ist.
  assert.equal(staleAfterMs(5_000), 60_000);
  assert.equal(staleAfterMs(29_000), 60_000);
  assert.equal(staleAfterMs(31_000), 62_000);
});

test("ein abgeschalteter Lauf macht JEDEN abgelegten Stand unbrauchbar", () => {
  // ⚠️ Kein Sonderfall in den Routen: bei Intervall 0 ist die Frist 0, und
  // damit ist nichts je frisch. Wer den Lauf abschaltet, bekommt die alte
  // Übersicht zurück und nicht eine, die einen eingefrorenen Stand anzeigt.
  assert.equal(staleAfterMs(0), 0);
  assert.equal(staleAfterMs(-1), 0);

  const store = createHostObservationStore();
  store.write(observation({ checkedAt: 999 }));
  let probes = 0;
  const probe = createObservedProbe({
    store,
    staleAfterMs: staleAfterMs(0),
    now: () => 1_000,
    probe: () => {
      probes += 1;
      return Promise.resolve(PROBED);
    }
  });

  return probe(host("h1")).then((health) => {
    assert.deepEqual(health, PROBED);
    assert.equal(probes, 1);
  });
});

test("ein frischer Stand kommt aus dem Halter, ohne dass jemand gefragt wird", async () => {
  const store = createHostObservationStore();
  store.write(observation({ checkedAt: 1_000 }));
  let probes = 0;
  const probe = createObservedProbe({
    store,
    staleAfterMs: 120_000,
    now: () => 100_000,
    probe: () => {
      probes += 1;
      return Promise.resolve(PROBED);
    }
  });

  assert.deepEqual(await probe(host("h1")), ONLINE);
  assert.equal(probes, 0, "die Route stellt keine eigene Sonde — das ist der ganze Zweck");
});

test("ein Arm, über den der Halter nichts weiß, wird von der Route selbst gefragt", async () => {
  // ⚠️ Ohne diesen Rückfall sähe ein frisch angelegter Arm bis zum nächsten
  // Durchlauf tot aus, und der Betreiber suchte den Fehler beim Arm statt beim
  // Takt.
  const store = createHostObservationStore();
  let probed: string[] = [];
  const probe = createObservedProbe({
    store,
    staleAfterMs: 120_000,
    now: () => 1_000,
    probe: (record) => {
      probed.push(record.id);
      return Promise.resolve(PROBED);
    }
  });

  assert.deepEqual(await probe(host("neu")), PROBED);
  assert.deepEqual(probed, ["neu"]);

  // Und ein anderer Arm zieht den Stand des ersten nicht an sich.
  store.write(observation({ hostId: "h1", checkedAt: 1_000 }));
  probed = [];
  assert.deepEqual(await probe(host("h2")), PROBED);
  assert.deepEqual(probed, ["h2"]);
});

test("ein zu alter Stand wird nicht benutzt", async () => {
  // Ein Zustand von vor einer Stunde, der als aktuell ausgegeben wird, ist
  // schlechter als eine Sonde, die drei Sekunden kostet.
  const store = createHostObservationStore();
  store.write(observation({ checkedAt: 1_000 }));
  const probe = (nowValue: number): Promise<AgentHealth> =>
    createObservedProbe({
      store,
      staleAfterMs: 120_000,
      now: () => nowValue,
      probe: () => Promise.resolve(PROBED)
    })(host("h1"));

  assert.deepEqual(await probe(120_999), ONLINE, "knapp unter der Frist gilt der Stand noch");
  assert.deepEqual(await probe(121_000), PROBED, "genau auf der Frist gilt er nicht mehr");
  assert.deepEqual(await probe(3_601_000), PROBED, "eine Stunde später erst recht nicht");
});

test("ein wartender Arm im Halter zählt nicht als Auskunft", async () => {
  // `agent: null` heißt NICHT GEFRAGT. Es ist keine Erreichbarkeit und darf
  // auch nicht als eine ausgegeben werden; die Routen behalten für wartende
  // Arme genau ihr bisheriges Verhalten.
  const store = createHostObservationStore();
  store.write(observation({ agent: null, checkedAt: 1_000 }));
  let probes = 0;
  const probe = createObservedProbe({
    store,
    staleAfterMs: 120_000,
    now: () => 1_100,
    probe: () => {
      probes += 1;
      return Promise.resolve(PROBED);
    }
  });

  assert.deepEqual(await probe(host("h1", { state: "pending" })), PROBED);
  assert.equal(probes, 1);
});

test("ein stiller Arm aus dem Halter wird als still ausgegeben und nicht neu befragt", async () => {
  // Der Halter trägt beide Antworten. Ein `reachable: false` ist eine Auskunft
  // und kein fehlender Wert — sonst kostete ausgerechnet der stille Arm bei
  // jeder Anfrage seine volle Frist.
  const store = createHostObservationStore();
  const offline: AgentHealth = { reachable: false, error: "Agent antwortete nicht innerhalb von 3000 ms" };
  store.write(observation({ agent: offline, checkedAt: 1_000 }));
  let probes = 0;
  const probe = createObservedProbe({
    store,
    staleAfterMs: 120_000,
    now: () => 2_000,
    probe: () => {
      probes += 1;
      return Promise.resolve(PROBED);
    }
  });

  assert.deepEqual(await probe(host("h1")), offline);
  assert.equal(probes, 0);
});
