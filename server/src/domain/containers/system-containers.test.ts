import assert from "node:assert/strict";
import test from "node:test";

import type { ContainerOverviewEntry } from "./containers.js";
import { groupIntoStacks } from "./stacks.js";
import { imageRepository, isSystemImage, isSystemProject } from "./system-containers.js";

// Welche Container zum Leitstand selbst gehören. Die Image-Referenzen sind
// die aus `docker-compose.yml` und dem Archiv eines Arms.

function entry(name: string, image: string, project: string | null): ContainerOverviewEntry {
  return {
    id: `id-${name}`,
    name,
    image,
    status: "Up 2 hours",
    running: true,
    startedAt: null,
    health: null,
    compose: project === null ? null : { project, service: name },
    stats: null,
    externalManagement: null
  };
}

const AGENT = "ghcr.io/florianfinn/docklet-hub-agent:v0.32.0";
const OLD_AGENT = "ghcr.io/florianfinn/dashboard-docker-agent:v0.31.0@sha256:42c4f162f1bba2d0ce2ccf9619dfc856a86d2567bd4a9015d30abff8850511c3";

test("der Repository-Name ignoriert Registry, Tag und Digest", () => {
  assert.equal(imageRepository(AGENT), "docklet-hub-agent");
  assert.equal(imageRepository(OLD_AGENT), "dashboard-docker-agent");
  assert.equal(imageRepository("docklet-hub:local"), "docklet-hub");
  assert.equal(imageRepository("localhost:5000/docklet-hub"), "docklet-hub");
  assert.equal(imageRepository("postgres:18.6-alpine"), "postgres");
});

test("Hub und Agent sind am Image erkennbar, ein ähnlicher Name nicht", () => {
  assert.equal(isSystemImage(AGENT), true);
  assert.equal(isSystemImage(OLD_AGENT), false, "der frühere Image-Name zählt nicht mehr");
  assert.equal(isSystemImage("docklet-hub:local"), true);
  assert.equal(isSystemImage("example/dashboard-docker-agent-fork:1"), false);
  assert.equal(isSystemImage("example/docklet-hub-agent-fork:1"), false);
  assert.equal(isSystemImage("postgres:18.6-alpine"), false);
});

test("die Projekte des Leitstands sind erkennbar, ein fremdes nicht", () => {
  assert.equal(isSystemProject("docklet-hub"), true);
  assert.equal(isSystemProject("docklet-hub-agent-nas"), true);
  assert.equal(isSystemProject("docklet-hub-agent-unraid"), true);
  assert.equal(isSystemProject("dashboard-docker-agent-remote"), false);
  assert.equal(isSystemProject("docklet-hub-agentur"), false);
  assert.equal(isSystemProject("nextcloud"), false);
});

test("ein Postgres im Stack des Hubs gehört zum Hub, auch unter übersteuertem Projektnamen", () => {
  const { stacks } = groupIntoStacks([
    entry("hub", "docklet-hub:local", "my-hub"),
    entry("postgres", "postgres:18.6-alpine", "my-hub"),
    entry("app", "nginx:1", "website")
  ]);
  const hub = stacks.find((stack) => stack.project === "my-hub")!;
  const website = stacks.find((stack) => stack.project === "website")!;
  assert.equal(hub.system, true);
  assert.deepEqual(
    hub.containers.map((container) => container.system),
    [true, true],
    "jedes Mitglied trägt den Wert seines Stacks"
  );
  assert.equal(website.system, false);
  assert.equal(website.containers[0].system, false);
});

test("ein Einzelgänger zählt nach seinem eigenen Image", () => {
  const { loose } = groupIntoStacks([entry("agent", AGENT, null), entry("teamspeak", "teamspeak:3", null)]);
  assert.deepEqual(
    loose.map((container) => [container.name, container.system]),
    [
      ["agent", true],
      ["teamspeak", false]
    ]
  );
});
