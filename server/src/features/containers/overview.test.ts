import assert from "node:assert/strict";
import test from "node:test";

import { groupIntoStacks, type ContainerOverviewEntry } from "../../domain/containers/index.js";
import { AgentError } from "../../platform/agent-transport/protocol.js";
import { MIN_AGENT_VERSION, type HostRecord } from "../../domain/hosts/index.js";
import { buildOverview, decorate, type OverviewDeps } from "./overview.js";
import { DEFAULT_HOST_THEME, DEFAULT_STACK_DISPLAY, type MarkView } from "contract";
import { EMPTY_DECORATION, type HostDecoration } from "./decoration.js";

// Was hier geprüft wird, ist die Fallunterscheidung — nicht die Gruppierung
// (die steht in stacks.test.ts). Die vier Wege durch einen Arm sehen in der
// Antwort ähnlich aus und bedeuten Verschiedenes:
//
//   1. wartend        → gar nicht gefragt (`agent: null`)
//   2. still          → gefragt, keine Antwort (`agent.reachable === false`)
//   3. antwortet, aber nicht mit Containern → `error` trägt den Text
//   4. antwortet      → Stacks und Einzelgänger
//
// Der Fehler, den das fängt: „wartend“ und „still“ als denselben Zustand zu
// führen. Ein frisch angelegter Arm meldete sich dann in der Übersicht als
// Störung, obwohl noch niemand ihn angeschlossen hat.

function record(overrides: Partial<HostRecord> & { name: string }): HostRecord {
  return {
    id: `id-${overrides.name}`,
    agentUrl: `http://${overrides.name}:8099`,
    kind: "internal",
    state: "registered",
    tunnelAddress: null,
    wireguardPublicKey: null,
    endpointOverride: null,
    failedAttempts: 0,
    dockerGid: null,
    bindBasePath: null,
    display: DEFAULT_HOST_THEME,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    registeredAt: null,
    lastSeenAt: null,
    ...overrides
  };
}

function container(name: string, compose: { project: string; service: string } | null): ContainerOverviewEntry {
  return {
    id: `id-${name}`,
    name,
    image: "example:1",
    status: "Up 2 hours",
    running: true,
    startedAt: null,
    health: null,
    compose,
    stats: null,
    externalManagement: null
  };
}

function deps(overrides: Partial<OverviewDeps> = {}): OverviewDeps {
  return {
    probeHost: () => Promise.resolve({ reachable: true, version: MIN_AGENT_VERSION, contractVersion: 6, readOnly: true, entries: null }),
    fetchContainersFor: () => Promise.resolve([]),
    // Ein Arm, dem der Betreiber nichts vergeben hat — der Normalfall.
    decorationFor: () => Promise.resolve(EMPTY_DECORATION),
    ...overrides
  };
}

test("ein wartender Arm wird gar nicht erst gefragt", async () => {
  let asked = 0;
  const [entry] = await buildOverview(
    [record({ name: "neu", state: "pending" })],
    deps({
      probeHost: () => {
        asked += 1;
        return Promise.resolve({ reachable: false, error: "nie" });
      }
    })
  );

  assert.equal(asked, 0);
  // ⚠️ `null` und nicht `{ reachable: false }`: der Unterschied zwischen
  // „noch nicht angeschlossen“ und „gestört“ ist der Inhalt dieses Feldes.
  assert.equal(entry.agent, null);
  assert.equal(entry.host.status, "pending");
  assert.equal(entry.error, null);
  assert.deepEqual(entry.stacks, []);
});

test("ein stiller Arm steht mit seiner Meldung in der Liste und wirft die Fläche nicht um", async () => {
  const [entry] = await buildOverview(
    [record({ name: "unraid" })],
    deps({ probeHost: () => Promise.resolve({ reachable: false, error: "Zeitüberlauf nach 3000 ms" }) })
  );

  assert.equal(entry.agent?.reachable, false);
  assert.equal(entry.host.status, "offline");
  assert.equal(entry.error, "Zeitüberlauf nach 3000 ms");
  assert.deepEqual(entry.stacks, []);
});

test("ein Arm, dessen Container-Antwort nicht lesbar ist, trägt den Text des Agenten", async () => {
  const [entry] = await buildOverview(
    [record({ name: "vps" })],
    deps({
      fetchContainersFor: () => Promise.reject(new AgentError("Die Antwort auf GET /containers ist kein Objekt."))
    })
  );

  assert.equal(entry.host.status, "online");
  assert.equal(entry.error, "Die Antwort auf GET /containers ist kein Objekt.");
  assert.deepEqual(entry.stacks, []);
});

test("ein Fehler, der kein AgentError ist, wird NICHT zur Meldung eines Hosts", async () => {
  // Sonst sähe ein Programmierfehler des Hubs in der Oberfläche aus wie ein
  // Problem dieses Arms — und stünde in keinem Log.
  await assert.rejects(
    buildOverview(
      [record({ name: "vps" })],
      deps({ fetchContainersFor: () => Promise.reject(new TypeError("undefined is not a function")) })
    ),
    TypeError
  );
});

test("ein antwortender Arm liefert Stacks und Einzelgänger", async () => {
  const [entry] = await buildOverview(
    [record({ name: "local-host", kind: "local" })],
    deps({
      fetchContainersFor: () =>
        Promise.resolve([
          container("arr-sonarr-1", { project: "arr", service: "sonarr" }),
          container("teamspeak", null)
        ])
    })
  );

  assert.equal(entry.host.status, "online");
  assert.deepEqual(
    entry.stacks.map((stack) => stack.project),
    ["arr"]
  );
  assert.deepEqual(
    entry.loose.map((loose) => loose.name),
    ["teamspeak"]
  );
});

test("die Reihenfolge der Arme ist die der Eingabe, auch wenn der erste am längsten braucht", async () => {
  // `Promise.all` behält sie — eine Schleife, die nach Eintreffen einsammelt,
  // täte es nicht, und die Übersicht ordnete sich dann nach Antwortzeit.
  const slow = record({ name: "langsam" });
  const fast = record({ name: "schnell" });
  const entries = await buildOverview(
    [slow, fast],
    deps({
      probeHost: (host) =>
        host.name === "langsam"
          ? new Promise((resolve) => setTimeout(() => resolve({ reachable: false, error: "still" }), 10))
          : Promise.resolve({ reachable: false, error: "still" })
    })
  );

  assert.deepEqual(
    entries.map((entry) => entry.host.name),
    ["langsam", "schnell"]
  );
});

// ── Die Anreicherung mit eigenen Marken und Einrückung (D7b, #62) ───────────
//
// ⚠️ Geprüft wird `decorate` und nicht die Datenbank. Die Zuordnung kommt als
// Wert herein; ob die Abfrage in `features/marks/assignment-store.ts` richtig ist, zeigt erst
// ein Postgres (dort steht es als Befund).

function mark(id: string, name: string, overrides: Partial<MarkView> = {}): MarkView {
  return { id, name, hue: "neutral", style: "label", ...overrides };
}

function decoration(overrides: Partial<HostDecoration> = {}): HostDecoration {
  return { ...EMPTY_DECORATION, ...overrides };
}

test("ein Stack mit zwei Marken trägt sie in der übergebenen Reihenfolge", () => {
  const production = mark("m-1", "Produktion", { hue: "teal" });
  const backup = mark("m-2", "Backup", { style: "fill" });

  const decorated = decorate(
    groupIntoStacks([container("nextcloud-web-1", { project: "nextcloud", service: "web" })]),
    decoration({
      marksByStack: new Map([["nextcloud", [backup, production]]]),
      indentByStack: new Map([["nextcloud", "flat"]])
    })
  );

  assert.equal(decorated.stacks.length, 1);
  // ⚠️ Die Reihenfolge des Betreibers und nicht die der Namen: „Backup" steht
  // vorn, obwohl es alphabetisch hinter „Produktion" käme.
  assert.deepEqual(decorated.stacks[0].marks, [backup, production]);
  assert.equal(decorated.stacks[0].indent, "flat");
});

test("ein Stack ohne Zuordnung behält die leere Liste und den fallback", () => {
  const decorated = decorate(
    groupIntoStacks([container("web-1", { project: "monitoring", service: "web" })]),
    EMPTY_DECORATION
  );

  assert.deepEqual(decorated.stacks[0].marks, []);
  assert.equal(decorated.stacks[0].indent, DEFAULT_STACK_DISPLAY.indent);
  // ⚠️ Kein `undefined`: ein fehlendes Feld wäre auf der Gegenseite kein
  // Typfehler, und die Zeile stünde still ohne Marken da.
  assert.ok(Array.isArray(decorated.stacks[0].marks));
});

test("ein Container trägt seine EIGENEN Marken und nicht die seines Stacks", () => {
  // ⚠️ Der Fall, den sonst nichts fängt: erbte ein Container die Marken seines
  // Stacks, sähe man dieselbe Marke an acht Zeilen und wüsste nicht mehr, wo
  // sie vergeben wurde.
  const stackMark = mark("m-1", "Produktion");
  const containerMark = mark("m-2", "Datenbank");

  const decorated = decorate(
    groupIntoStacks([
      container("nextcloud-db-1", { project: "nextcloud", service: "db" }),
      container("nextcloud-web-1", { project: "nextcloud", service: "web" })
    ]),
    decoration({
      marksByStack: new Map([["nextcloud", [stackMark]]]),
      marksByContainer: new Map([["nextcloud-db-1", [containerMark]]])
    })
  );

  const containers = decorated.stacks[0].containers;
  assert.deepEqual(
    containers.map((entry) => entry.name),
    ["nextcloud-db-1", "nextcloud-web-1"]
  );
  assert.deepEqual(containers[0].marks, [containerMark]);
  assert.deepEqual(containers[1].marks, [], "der zweite Container hat die Marke seines Stacks geerbt");
});

test("ein loser Container trägt seine Marken ebenso", () => {
  const teamspeak = mark("m-1", "Spiele");
  const decorated = decorate(
    groupIntoStacks([container("teamspeak", null)]),
    decoration({ marksByContainer: new Map([["teamspeak", [teamspeak]]]) })
  );

  assert.deepEqual(decorated.stacks, []);
  assert.deepEqual(decorated.loose[0].marks, [teamspeak]);
});

test("ein ausgeblendeter Stack trägt `hidden`, die übrigen nicht", () => {
  const decorated = decorate(
    groupIntoStacks([
      container("nextcloud-web-1", { project: "nextcloud", service: "web" }),
      container("monitoring-web-1", { project: "monitoring", service: "web" })
    ]),
    decoration({ hiddenStacks: new Set(["nextcloud"]) })
  );

  assert.deepEqual(
    decorated.stacks.map((stack) => [stack.project, stack.hidden]),
    [
      ["monitoring", false],
      ["nextcloud", true]
    ]
  );
});

test("eine Zuordnung, deren Stack gerade fehlt, wirft nichts um", () => {
  // Sie bleibt in der Ablage liegen (007-marks.sql, Kopf) und kommt hier ohne
  // Empfänger an. Der Arm meldet trotzdem seine übrigen Stacks.
  const decorated = decorate(
    groupIntoStacks([container("web-1", { project: "monitoring", service: "web" })]),
    decoration({
      marksByStack: new Map([["gibt-es-gerade-nicht", [mark("m-1", "Produktion")]]]),
      indentByStack: new Map([["gibt-es-gerade-nicht", "flat"]])
    })
  );

  assert.deepEqual(
    decorated.stacks.map((stack) => stack.project),
    ["monitoring"]
  );
  assert.deepEqual(decorated.stacks[0].marks, []);
});

test("die Marken werden für einen wartenden und einen stillen Arm gar nicht erst geholt", async () => {
  // Marken ohne Ziel sind eine Abfrage ohne Empfänger — und eine Abfrage je
  // Arm, den es gar nicht zu zeichnen gibt.
  let asked = 0;
  await buildOverview(
    [record({ name: "wartend", state: "pending" }), record({ name: "still" })],
    deps({
      probeHost: () => Promise.resolve({ reachable: false, error: "still" }),
      decorationFor: () => {
        asked += 1;
        return Promise.resolve(EMPTY_DECORATION);
      }
    })
  );

  assert.equal(asked, 0);
});

test("ein antwortender Arm trägt die Marken bis in die Übersicht", async () => {
  // Der Weg als Ganzes: `buildOverview` legt die Zuordnung über die
  // Gruppierung, und die Antwort trägt sie.
  const production = mark("m-1", "Produktion");
  const entries = await buildOverview(
    [record({ name: "local-host" })],
    deps({
      fetchContainersFor: () =>
        Promise.resolve([container("nextcloud-web-1", { project: "nextcloud", service: "web" })]),
      decorationFor: () =>
        Promise.resolve(
          decoration({
            marksByStack: new Map([["nextcloud", [production]]]),
            indentByStack: new Map([["nextcloud", "flat"]])
          })
        )
    })
  );

  assert.deepEqual(entries[0].stacks[0].marks, [production]);
  assert.equal(entries[0].stacks[0].indent, "flat");
});
