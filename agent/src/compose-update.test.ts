import assert from "node:assert/strict";
import test from "node:test";
import type { RawInspect } from "./engine.js";
import {
  updateComposeServiceWithRollback,
  type ComposeUpdateOps
} from "./compose-update.js";
import type { UpOptions } from "./compose-cli.js";

const ALT = `sha256:${"a".repeat(64)}`;
const New = `sha256:${"b".repeat(64)}`;
const PROJECT = {
  projectDir: "/home/docker/app",
  composeFileName: "compose.yaml",
  projectName: "app"
};

function inspected(id: string, image: string, health: string | undefined = "healthy"): RawInspect {
  return {
    Id: id,
    Name: "/app-web-1",
    Image: image,
    State: { Running: true, Restarting: false, Status: "running", Health: health ? { Status: health } : undefined }
  };
}

function fakeOps(): {
  ops: ComposeUpdateOps;
  upOptions: UpOptions[];
  events: string[];
  state: { id: string; inspect: RawInspect };
} {
  const upOptions: UpOptions[] = [];
  const events: string[] = [];
  const state = { id: "neu-id", inspect: inspected("neu-id", New) };
  const ops: ComposeUpdateOps = {
    async up(_project, options) {
      upOptions.push(options);
      events.push(options.rollbackOverride ? "rollback-up" : "update-up");
      if (options.rollbackOverride) {
        state.id = "rollback-id";
        state.inspect = inspected("rollback-id", ALT);
      }
      return "";
    },
    async resolveContainerId() {
      events.push("resolve");
      return state.id;
    },
    async inspect() {
      events.push("inspect");
      return state.inspect;
    },
    writeRollbackOverride(serviceName, imageId) {
      events.push(`write:${serviceName}:${imageId}`);
    },
    removeRollbackOverride() {
      events.push("remove-override");
    }
  };
  return { ops, upOptions, events, state };
}

function input() {
  return {
    project: PROJECT,
    serviceName: "web",
    originalContainerId: "alt-id",
    previousImageId: ALT,
    targetImageId: New
  };
}

test("gesundes Compose-Update bleibt auf dem neuen Digest und schreibt kein Override", async () => {
  const fake = fakeOps();
  const result = await updateComposeServiceWithRollback(fake.ops, input());

  assert.equal(result.ok, true);
  assert.equal(result.finalContainerId, "neu-id");
  assert.equal(result.finalImageId, New);
  assert.equal(result.rolledBack, false);
  assert.equal(fake.events.some((event) => event.startsWith("write:")), false);
  assert.deepEqual(fake.upOptions[0], {
    removeOrphans: false,
    serviceName: "web",
    pullNever: true,
    noDeps: true,
    forceRecreate: true,
    rollbackOverride: false
  });
});

test("unhealthy nach up wird auf den vorherigen Digest zurueckgerollt", async () => {
  const fake = fakeOps();
  fake.state.inspect = inspected("neu-id", New, "unhealthy");

  const result = await updateComposeServiceWithRollback(fake.ops, input());

  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.updateReason, "container-unhealthy");
  assert.equal(result.finalContainerId, "rollback-id");
  assert.equal(result.finalImageId, ALT);
  assert.deepEqual(fake.events, [
    "update-up",
    "resolve",
    "inspect",
    `write:web:${ALT}`,
    "rollback-up",
    "resolve",
    "inspect",
    "remove-override"
  ]);
  assert.equal(fake.upOptions[1]?.rollbackOverride, true);
  assert.equal(fake.upOptions[1]?.forceRecreate, true);
  assert.equal(fake.upOptions[1]?.pullNever, true);
});

test("auch ein Compose-Fehler startet den Rollback und entfernt das Override", async () => {
  const fake = fakeOps();
  const originalUp = fake.ops.up;
  let first = true;
  fake.ops.up = async (project, options) => {
    if (first) {
      first = false;
      fake.events.push("update-up-fehler");
      throw new Error("health wait failed");
    }
    return originalUp(project, options);
  };

  const result = await updateComposeServiceWithRollback(fake.ops, input());

  assert.equal(result.rolledBack, true);
  assert.equal(result.updateReason, "compose-update-failed");
  assert.equal(fake.events.at(-1), "remove-override");
});

test("override cleanup runs even when the rollback up fails as well", async () => {
  const fake = fakeOps();
  fake.ops.up = async (_project, options) => {
    fake.events.push(options.rollbackOverride ? "rollback-up-fehler" : "update-up-fehler");
    throw new Error("compose kaputt");
  };
  // Der best-effort Ist-Zustand ist weiterhin der neue, ungesunde Digest.
  fake.state.inspect = inspected("neu-id", New, "unhealthy");

  const result = await updateComposeServiceWithRollback(fake.ops, input());

  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, false);
  assert.equal(result.reason, "update-rollback-failed");
  assert.equal(result.rollbackReason, "compose-rollback-failed");
  assert.ok(fake.events.includes("remove-override"));
  assert.equal(result.finalContainerId, "neu-id");
});

test("ein nicht entfernbares Override wird als eigener Fehler sichtbar", async () => {
  const fake = fakeOps();
  fake.state.inspect = inspected("neu-id", New, "unhealthy");
  fake.ops.removeRollbackOverride = () => {
    fake.events.push("remove-override-fehler");
    throw new Error("read-only");
  };

  const result = await updateComposeServiceWithRollback(fake.ops, input());

  assert.equal(result.rolledBack, true);
  assert.equal(result.cleanupFailed, true);
  assert.equal(result.reason, "rollback-override-cleanup-failed");
});

test("auch ein Ein-Service-Projekt bleibt auf den autorisierten Service begrenzt", async () => {
  const fake = fakeOps();
  await updateComposeServiceWithRollback(fake.ops, input());
  assert.equal(fake.upOptions[0]?.serviceName, "web");
  assert.equal(fake.upOptions[0]?.noDeps, true);
  assert.equal(fake.upOptions[0]?.forceRecreate, true);
});
