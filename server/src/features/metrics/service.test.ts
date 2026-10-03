import test from "node:test";
import assert from "node:assert/strict";

import { createMetricsService } from "./service.js";

// The host decision of the service, without Express and without an agent. The
// case with a real agent answer stays in `app/container-routes.test.ts`.

test("ein unbekannter Arm wird abgewiesen, bevor der Agent gefragt wird", async () => {
  let connected = 0;
  const service = createMetricsService({
    hosts: {
      find: async () => null,
      connect: async () => {
        connected += 1;
        throw new Error("must not be reached");
      }
    }
  });
  const result = await service.containerStats({ hostId: "nope", containerId: "c1", actorId: "u1" });
  assert.deepEqual(result, { ok: false, error: "host-unknown" });
  assert.equal(connected, 0);
});
