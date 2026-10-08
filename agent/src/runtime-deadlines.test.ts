import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";
import {
  ACTION_QUEUE_WAIT_MS, HUB_RUNTIME_TIMEOUT_MS, LIFECYCLE_TIMEOUT_MS,
  MAX_STOP_GRACE_MS, MAX_AGENT_ACTION_MS, RUNTIME_READBACK_RESERVE_MS,
  RUNTIME_TRANSPORT_RESERVE_MS, LIFECYCLE_DELIVERY_RESERVE_MS
} from "contract";
import { containerActionTimeoutMs, stackActionTimeoutMs, gracePeriodSeconds } from "./runtime-actions.js";
import { DockerEngine } from "./engine.js";

const gracePeriods = [MAX_STOP_GRACE_MS / 1000, -1, 2000, Number.MAX_VALUE,
  gracePeriodSeconds("2h")];

function assertCovered(timeoutMs: number, path: string) {
  assert.ok(Number.isFinite(timeoutMs), path);
  assert.ok(timeoutMs <= MAX_AGENT_ACTION_MS, `${path}: maximum agent action`);
  assert.ok(HUB_RUNTIME_TIMEOUT_MS >= ACTION_QUEUE_WAIT_MS + timeoutMs
    + RUNTIME_READBACK_RESERVE_MS + RUNTIME_TRANSPORT_RESERVE_MS, `${path}: hub coverage`);
  assert.ok(LIFECYCLE_TIMEOUT_MS > HUB_RUNTIME_TIMEOUT_MS, `${path}: browser coverage`);
  assert.ok(LIFECYCLE_TIMEOUT_MS >= HUB_RUNTIME_TIMEOUT_MS + LIFECYCLE_DELIVERY_RESERVE_MS,
    `${path}: browser delivery reserve`);
}

test("deadline matrix covers all six actions at maximum, unlimited and oversized grace periods", () => {
  for (const action of ["start", "stop", "restart"] as const) {
    for (const grace of gracePeriods) {
      assertCovered(containerActionTimeoutMs(action, grace), `container ${action} grace ${grace}`);
      assertCovered(stackActionTimeoutMs(action, [10, grace]), `stack ${action} grace ${grace}`);
    }
  }
});

test("actual container HTTP deadlines stay within the shared hub and browser budgets", async (t) => {
  let actualDeadline = 0;
  t.mock.method(http, "request", (options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    actualDeadline = Number(options.timeout);
    const request = new EventEmitter() as http.ClientRequest;
    request.end = (() => {
      const response = Object.assign(new EventEmitter(), { statusCode: 204 }) as http.IncomingMessage;
      callback(response);
      response.emit("end");
      return request;
    }) as typeof request.end;
    return request;
  });
  const engine = new DockerEngine({ socketPath: "/unused.sock", timeoutMs: 1 });
  for (const action of ["start", "stop", "restart"] as const) {
    for (const grace of gracePeriods) {
      if (action === "start") await engine.start("demo");
      else await engine[action]("demo", grace);
      assert.equal(actualDeadline, containerActionTimeoutMs(action, grace));
      assertCovered(actualDeadline, `engine ${action} grace ${grace}`);
    }
  }
});
