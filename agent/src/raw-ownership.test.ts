import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRegistry } from "./registry.js";
import { DEFINITION_ACTIONS } from "./route-policy.js";
import { externallyManagedServices } from "./raw-ownership.js";

// The ownership lock of the raw editor and the stack actions (#56).
//
// The handlers need engine, registry file and a socket, so the decision is
// checked as a pure function against a real registry, and its use in the
// handlers as source text.

function registryWith(entries: Array<{ id: string; externallyManaged?: boolean }>): AgentRegistry {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-registry-")), "registry.json");
  new AgentRegistry(file).replaceAll(
    entries.map(({ id, externallyManaged }) => ({
      containerId: id,
      containerName: id,
      imageRef: `${id}@sha256:feed`,
      allowed: true,
      secured: false,
      ...(externallyManaged ? { externallyManaged: true } : {})
    }))
  );
  return new AgentRegistry(file);
}

const STACK = new Map([
  ["db", "db-id"],
  ["web", "web-id"]
]);

test("a stack without an externally managed container is not locked", () => {
  const registry = registryWith([{ id: "db-id" }, { id: "web-id" }]);
  assert.equal(externallyManagedServices("web-id", STACK, (id) => registry.isExternallyManaged(id)), null);
});

test("one externally managed service locks the whole file, whichever container is the anchor", () => {
  const registry = registryWith([{ id: "db-id", externallyManaged: true }, { id: "web-id" }]);
  const check = (id: string) => registry.isExternallyManaged(id);
  assert.deepEqual(externallyManagedServices("web-id", STACK, check), ["db"]);
  assert.deepEqual(externallyManagedServices("db-id", STACK, check), ["db"]);
});

test("an externally managed anchor locks even when compose ps does not list it", () => {
  const registry = registryWith([{ id: "anchor-id", externallyManaged: true }, { id: "db-id" }, { id: "web-id" }]);
  assert.deepEqual(externallyManagedServices("anchor-id", STACK, (id) => registry.isExternallyManaged(id)), []);
});

test("a new stack without anchor and containers is not locked", () => {
  assert.equal(externallyManagedServices(null, new Map(), () => true), null);
});

test("stack apply and stack down are definition actions for gate()", () => {
  const registry = registryWith([{ id: "db-id", externallyManaged: true }]);
  for (const action of ["stack-apply", "stack-down"]) {
    assert.ok(DEFINITION_ACTIONS.has(action), action);
    assert.equal(registry.checkAccess("db-id", true, DEFINITION_ACTIONS.has(action)), "externally-managed", action);
  }
  // Runtime actions on the same stack stay allowed.
  for (const action of ["start", "stop", "restart"]) {
    assert.equal(DEFINITION_ACTIONS.has(action), false, action);
    assert.equal(registry.checkAccess("db-id", true, DEFINITION_ACTIONS.has(action)), "allowed", action);
  }
});

const routes = fs.readFileSync(new URL("./routes/compose-raw-routes.ts", import.meta.url), "utf8");
const rawOps = fs.readFileSync(new URL("./runtime/raw-ops.ts", import.meta.url), "utf8");

test("the raw route refuses preview and apply before either branch runs, but not the read", () => {
  const check = routes.indexOf("const managed = writing || previewing");
  assert.ok(check >= 0, "the ownership check in handleComposeRaw is gone");
  assert.ok(check < routes.indexOf("if (previewing) {"), "the preview branch runs before the ownership check");
  assert.ok(check < routes.indexOf("if (!writing) {"), "the read branch runs before the ownership check");
  assert.match(routes.slice(check, check + 600), /send\(response, 403, \{ error: rawReason\("externally-managed"\)/);
});

test("apply and preview check ownership again under the project lock", () => {
  for (const name of ["executeRaw", "previewRaw"]) {
    const start = rawOps.indexOf(`export async function ${name}(`);
    assert.ok(start >= 0, name);
    const body = rawOps.slice(start, rawOps.indexOf("\n}\n", start));
    const lock = body.indexOf("stackLocks.runExclusive(");
    const managed = body.indexOf("managedDenial(");
    assert.ok(lock >= 0 && managed > lock, `${name} does not check ownership under the lock`);
  }
});
