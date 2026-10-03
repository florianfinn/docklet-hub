import test from "node:test";
import assert from "node:assert/strict";

import { CONTRACT_VERSION, contractSince, registryEntrySchema, since } from "contract";

// The since boundary of the contract (#272, `contract/src/agent/version.ts`):
// a field added after the first numbered contract names the version it came
// with, and stays optional, because an older agent neither sends nor reads it.

test("die Registry-Felder nach Vertrag 1 tragen ihre Grenze", () => {
  assert.deepEqual(contractSince.get(registryEntrySchema.shape.observeOnly), { since: 2 });
  assert.deepEqual(contractSince.get(registryEntrySchema.shape.externallyManaged), { since: 3 });
  // A field from the first contract carries none.
  assert.equal(contractSince.get(registryEntrySchema.shape.containerId), undefined);
});

test("ein Eintrag ohne die späteren Felder bleibt gültig", () => {
  const entry = { containerId: "c".repeat(64), containerName: "nginx", imageRef: "nginx:1.27", allowed: true };
  assert.equal(registryEntrySchema.safeParse(entry).success, true);
});

test("since nimmt nur eine Nummer, die es gibt", () => {
  // The agent imports no zod of its own (`.dependency-cruiser.mjs`,
  // `agent-only-contract`), so the probes use a field that has its boundary
  // already. A refused number throws before anything is registered.
  const observeOnly = registryEntrySchema.shape.observeOnly;
  assert.throws(() => since(observeOnly, 1));
  assert.throws(() => since(observeOnly, CONTRACT_VERSION + 1));
  assert.throws(() => since(observeOnly, 2.5));
  assert.equal(since(observeOnly, 2), observeOnly);
  assert.deepEqual(contractSince.get(observeOnly), { since: 2 });
});
