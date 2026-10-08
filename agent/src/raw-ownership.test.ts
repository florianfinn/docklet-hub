import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRegistry } from "./registry.js";
import { DEFINITION_ACTIONS } from "./route-policy.js";
import { createScopeContainerIds, externallyManagedServices } from "./raw-ownership.js";
import { handlerSource } from "./handler-source-test-support.js";

// The ownership lock of the raw editor, the stack actions (#56), the `.env`
// write (#121) and the stack `up` of apply and start fallback (#122).
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

function rawOpsBody(name: string): string {
  const start = rawOps.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, name);
  return rawOps.slice(start, rawOps.indexOf("\n}\n", start));
}

test("apply and preview check ownership again under the project lock", () => {
  const preview = rawOpsBody("previewRaw");
  const previewLock = preview.indexOf("stackLocks.runExclusive(");
  assert.ok(
    previewLock >= 0 && preview.indexOf("managedDenial(") > previewLock,
    "previewRaw does not check ownership under the lock"
  );

  // The apply locks in executeRaw and checks in executeRawLocked.
  const apply = rawOpsBody("executeRaw");
  const applyLock = apply.indexOf("stackLocks.runExclusive(");
  assert.ok(applyLock >= 0 && apply.indexOf("executeRawLocked(") > applyLock, "executeRaw does not delegate under the lock");
  assert.ok(rawOpsBody("executeRawLocked").includes("managedDenial("), "executeRawLocked does not check ownership");

  // Every other caller of the locked body holds the lock itself.
  const create = fs.readFileSync(new URL("./runtime/project-create.ts", import.meta.url), "utf8");
  const createLock = create.indexOf("stackLocks.runExclusive(");
  assert.ok(
    createLock >= 0 && create.indexOf("executeRawLocked(") > createLock,
    "createProject calls the apply outside the lock"
  );
  // Definition, executeRaw and createProject, across every handler source.
  assert.equal(handlerSource().match(/executeRawLocked\(/g)?.length, 3);
  assert.equal(rawOps.match(/executeRawLocked\(/g)?.length, 2);
  assert.equal(create.match(/executeRawLocked\(/g)?.length, 1);
});

const composeRoutes = fs.readFileSync(new URL("./routes/compose-routes.ts", import.meta.url), "utf8");

test("the .env write refuses an externally managed stack right before writing, but not the read", () => {
  assert.match(composeRoutes, /stackLocks.runExclusive\(key, \(\) => handleEnvUnlocked\(ctx\)\)/);
  const start = composeRoutes.indexOf("async function handleEnvUnlocked(");
  assert.ok(start >= 0, "handleEnv is gone");
  const body = composeRoutes.slice(start, composeRoutes.indexOf("\n}\n", start));
  const read = body.indexOf("if (!writing) {");
  const check = body.indexOf("externallyManagedServices(containerId, before.serviceIds,");
  const write = body.indexOf("writeEnvFile(");
  assert.ok(check >= 0, "the ownership check in handleEnv is gone");
  assert.ok(read >= 0 && read < check, "the read branch no longer returns before the ownership check");
  assert.ok(check < write, "the .env is written before the ownership check");
  // No await between check and write: the registry cannot change in between.
  assert.doesNotMatch(body.slice(check, write), /\bawait\b/);
  assert.match(body.slice(check, write), /send\(response, 403, \{ error: "externally-managed", services: managed \}\)/);
});

test("the create scope of a stack up covers a missing service through its last registry entry", () => {
  const registry = registryWith([{ id: "anchor-id" }, { id: "db-old-id", externallyManaged: true }, { id: "web-id" }]);
  const check = (id: string) => registry.isExternallyManaged(id);
  const registryIds = new Map([["db", "db-old-id"]]);
  const scope = createScopeContainerIds(
    [
      { serviceName: "db", containerId: null },
      { serviceName: "web", containerId: "web-id" },
      { serviceName: "cache", containerId: null }
    ],
    (serviceName) => registryIds.get(serviceName)
  );
  assert.deepEqual([...scope.entries()], [
    ["db", "db-old-id"],
    ["web", "web-id"]
  ]);
  assert.deepEqual(externallyManagedServices("anchor-id", scope, check), ["db"]);
});

test("the create scope of a stack up locks for an existing externally managed container", () => {
  const registry = registryWith([{ id: "anchor-id" }, { id: "web-id", externallyManaged: true }]);
  const scope = createScopeContainerIds(
    [
      { serviceName: "db", containerId: null },
      { serviceName: "web", containerId: "web-id" }
    ],
    () => undefined
  );
  assert.deepEqual(externallyManagedServices("anchor-id", scope, (id) => registry.isExternallyManaged(id)), ["web"]);
});

const stackRoutes = fs.readFileSync(new URL("./routes/stack-routes.ts", import.meta.url), "utf8");
const stackRuntime = fs.readFileSync(new URL("./runtime/stack.ts", import.meta.url), "utf8");

test("stack apply checks external ownership under its project lock", () => {
  const start = stackRoutes.indexOf("export async function handleStackAction(");
  const body = stackRoutes.slice(start, stackRoutes.indexOf("\n}\n", start));
  const lock = body.indexOf("stackLocks.runExclusive(");
  const scope = body.indexOf('if (action === "apply") {');
  const check = body.indexOf("ensureCreateScopeNotExternallyManaged(prepared);");
  const up = body.indexOf("await composeUp(project,");
  assert.ok(lock >= 0 && scope > lock);
  assert.ok(check > scope && check < up);
  assert.doesNotMatch(body.slice(check, up), /\bawait\b/);
});

test("runtime creation uses the same external ownership check under the project lock", () => {
  const source = fs.readFileSync(new URL("./runtime/stack-action.ts", import.meta.url), "utf8");
  const lock = source.indexOf("stackLocks.runExclusive(");
  const call = source.indexOf("executeStackRuntimeAction(");
  const check = source.indexOf("ensureCreateScopeNotExternallyManaged(prepared);");
  assert.ok(lock >= 0 && call > lock && check > call);
  assert.match(source, /checkCreateScope:.*?ensureCreateScopeAllowlisted\(prepared\);.*?ensureCreateScopeNotExternallyManaged\(prepared\);/s);
});

test("the create scope check answers 403 externally-managed with the services", () => {
  const start = stackRuntime.indexOf("export function ensureCreateScopeNotExternallyManaged(");
  assert.ok(start >= 0, "ensureCreateScopeNotExternallyManaged is gone");
  const body = stackRuntime.slice(start, stackRuntime.indexOf("\n}\n", start));
  assert.match(body, /createScopeContainerIds\(\s*prepared\.context\.services,/);
  assert.match(body, /externallyManagedServices\(prepared\.project\.anchorEntry\.containerId,/);
  assert.match(body, /new StackEndpointError\(403, "externally-managed", \{ services: managed \}\)/);
});
