import assert from "node:assert/strict";
import test from "node:test";

import type { ContainerOverviewEntry } from "./containers.js";
import { containerState, groupIntoStacks, worstState } from "./stacks.js";

// Der Test, den docs/design/hub-color-and-structure.md §5 ausdrücklich
// verlangt: „ein Stack mit sieben laufenden und einem ausgefallenen
// Container“. Er steht unten als erster Fall der Zusammenfassung.
//
// Warum genau dieser Fall benannt ist: die naheliegende falsche Regel ist die
// Mehrheit („sieben von acht laufen, also grün“). Sie ist bequem und in einer
// Übersicht tödlich — der eine ausgefallene Container IST der Grund, warum
// jemand auf diese Fläche schaut.

function entry(overrides: Partial<ContainerOverviewEntry> & { name: string }): ContainerOverviewEntry {
  return {
    id: `id-${overrides.name}`,
    image: "example:1",
    status: "Up 2 hours",
    running: true,
    startedAt: null,
    health: null,
    compose: null,
    stats: null,
    externalManagement: null,
    ...overrides
  };
}

function inStack(project: string, service: string, overrides: Partial<ContainerOverviewEntry> = {}) {
  return entry({ name: `${project}-${service}-1`, compose: { project, service }, ...overrides });
}

test("ein Container ohne Lauf ist ausgefallen, auch wenn seine letzte Prüfung gesund lautete", () => {
  assert.equal(containerState(entry({ name: "a", running: false, health: "healthy" })), "down");
});

test("nur „unhealthy“ ist krank — „starting“ ist es nicht", () => {
  assert.equal(containerState(entry({ name: "a", health: "unhealthy" })), "warn");
  assert.equal(containerState(entry({ name: "a", health: "UNHEALTHY" })), "warn");
  assert.equal(containerState(entry({ name: "a", health: "starting" })), "ok");
  assert.equal(containerState(entry({ name: "a", health: null })), "ok");
});

test("der schlechteste Zustand gewinnt, unabhängig von der Reihenfolge", () => {
  assert.equal(worstState(["ok", "ok"]), "ok");
  assert.equal(worstState(["ok", "warn", "ok"]), "warn");
  assert.equal(worstState(["down", "ok", "warn"]), "down");
  assert.equal(worstState(["warn", "down"]), "down");
  assert.equal(worstState([]), "ok");
});

test("sieben laufende und ein ausgefallener Container ergeben einen ausgefallenen Stack (§5)", () => {
  const containers = [
    ...Array.from({ length: 7 }, (_value, index) => inStack("arr", `service-${index}`)),
    inStack("arr", "service-7", { running: false, status: "Exited (1) 3 minutes ago" })
  ];

  const { stacks, loose } = groupIntoStacks(containers);

  assert.equal(stacks.length, 1);
  assert.equal(loose.length, 0);
  assert.equal(stacks[0].state, "down");
  // Die Zahl daneben zählt weiter, was läuft — sie ist die zweite Hälfte der
  // Aussage und wird von der Farbe nicht ersetzt.
  assert.equal(stacks[0].running, 7);
  assert.equal(stacks[0].containers.length, 8);
  // `total` steht als eigene Zahl da, weil die Oberfläche `containers`
  // filtert und der Nenner der Aussage „7 von 8 laufen“ das nicht darf.
  assert.equal(stacks[0].total, 8);
});

test("ein einziger kranker Container färbt den Stack bernstein, kein ausgefallener nötig", () => {
  const { stacks } = groupIntoStacks([
    inStack("monitoring", "grafana"),
    inStack("monitoring", "prometheus", { health: "unhealthy" })
  ]);
  assert.equal(stacks[0].state, "warn");
  assert.equal(stacks[0].running, 2);
});

test("ein ausgefallener Container schlägt einen kranken", () => {
  const { stacks } = groupIntoStacks([
    inStack("games", "minecraft", { health: "unhealthy" }),
    inStack("games", "teamspeak", { running: false })
  ]);
  assert.equal(stacks[0].state, "down");
});

test("Container ohne Compose-Angabe stehen daneben und bilden keinen Stack", () => {
  const { stacks, loose } = groupIntoStacks([
    entry({ name: "musikbot" }),
    inStack("arr", "sonarr"),
    entry({ name: "teamspeak" })
  ]);

  assert.deepEqual(
    stacks.map((stack) => stack.project),
    ["arr"]
  );
  assert.deepEqual(
    loose.map((container) => container.name),
    ["musikbot", "teamspeak"]
  );
});

test("die Reihenfolge ist festgelegt und nicht die des Agenten", () => {
  // Umgedreht hereingegeben — der Agent liefert in Docker-Reihenfolge, und die
  // wechselt mit jedem Neustart eines Containers.
  const { stacks, loose } = groupIntoStacks([
    entry({ name: "zabbix" }),
    entry({ name: "authentik" }),
    inStack("monitoring", "grafana"),
    inStack("arr", "sonarr"),
    inStack("arr", "prowlarr")
  ]);

  assert.deepEqual(
    stacks.map((stack) => stack.project),
    ["arr", "monitoring"]
  );
  assert.deepEqual(
    stacks[0].containers.map((container) => container.compose?.service),
    ["prowlarr", "sonarr"]
  );
  assert.deepEqual(
    loose.map((container) => container.name),
    ["authentik", "zabbix"]
  );
});

test("dasselbe Projekt zweimal ergibt einen Stack mit zwei Mitgliedern und keine zwei Stacks", () => {
  const { stacks } = groupIntoStacks([inStack("arr", "sonarr"), inStack("arr", "radarr")]);
  assert.equal(stacks.length, 1);
  assert.equal(stacks[0].containers.length, 2);
});

test("die Eingabe wird nicht umsortiert", () => {
  // Ein `sort` ohne Kopie ordnete die Liste des Aufrufers mit um. Hier fällt
  // das nicht auf; beim nächsten Aufrufer, der dieselbe Liste noch braucht,
  // schon — und dann sieht es nach einem Fehler an einer ganz anderen Stelle aus.
  const containers = [inStack("arr", "sonarr"), inStack("arr", "radarr")];
  const before = containers.map((container) => container.name);
  groupIntoStacks(containers);
  assert.deepEqual(
    containers.map((container) => container.name),
    before
  );
});

test("jeder Container trägt seinen Zustand mit nach draußen", () => {
  // Damit ihn die Oberfläche nicht ein zweites Mal rechnen muss — und die
  // Regel nicht an zwei Stellen steht, die auseinanderlaufen können.
  const { stacks, loose } = groupIntoStacks([
    inStack("arr", "sonarr"),
    inStack("arr", "radarr", { running: false }),
    entry({ name: "teamspeak", health: "unhealthy" })
  ]);

  assert.deepEqual(
    stacks[0].containers.map((container) => container.state),
    ["down", "ok"]
  );
  assert.deepEqual(
    loose.map((container) => container.state),
    ["warn"]
  );
});
