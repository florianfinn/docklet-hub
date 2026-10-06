import assert from "node:assert/strict";
import test from "node:test";
import { monitorEventOf } from "./engine-model.js";

test("monitor events retain lifecycle actions without exposing Docker attributes", () => {
  for (const action of ["start", "stop", "restart", "create", "destroy", "die"]) {
    const event = monitorEventOf({ Type: "container", Action: action, Actor: { ID: "a".repeat(64), Attributes: { secret: "synthetic" } } });
    assert.deepEqual(event, { action, containerId: "a".repeat(64) });
  }
});
