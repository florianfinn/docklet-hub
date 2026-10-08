import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { authOptions } from "./auth.js";

function options(written: boolean[]) {
  return authOptions({ pool: {} as Pool, secret: "x".repeat(32), baseUrl: "https://hub.example.org",
    writeSetupRuntime: async (runtime) => { written.push(runtime.applyComposeDefinition); } });
}

test("Ersteinrichtung speichert die Compose-Wahl im geschützten Anlegeweg und erteilt Adminrechte", async () => {
  const written: boolean[] = [];
  const result = await options(written).databaseHooks.user.create.before({ id: "demo-admin" } as never,
    { body: { applyComposeDefinition: false } } as never);
  assert.deepEqual(written, [false]);
  assert.equal(result.data.role, "admin");
});

test("bestehende Aufrufer der Ersteinrichtung ohne neue Angabe erhalten An", async () => {
  const written: boolean[] = [];
  await options(written).databaseHooks.user.create.before({} as never, { body: {} } as never);
  assert.deepEqual(written, [true]);
});

test("ungültige Compose-Wahl und fehlgeschlagene Speicherung brechen das Anlegen ab", async () => {
  const written: boolean[] = [];
  for (const applyComposeDefinition of ["false", null, 0])
    await assert.rejects(options(written).databaseHooks.user.create.before({} as never,
      { body: { applyComposeDefinition } } as never));
  assert.equal(written.length, 0);
  const failed = authOptions({ pool: {} as Pool, secret: "x".repeat(32), baseUrl: "https://hub.example.org",
    writeSetupRuntime: async () => { throw new Error("storage-failed"); } });
  await assert.rejects(failed.databaseHooks.user.create.before({} as never,
    { body: { applyComposeDefinition: false } } as never), /storage-failed/);
});

test("setup middleware rejects invalid runtime settings before claiming a slot or writing", async () => {
  let queries = 0;
  let writes = 0;
  const config = authOptions({ pool: { query: async () => { queries += 1; throw new Error("Unexpected SQL"); } } as unknown as Pool,
    secret: "x".repeat(32), baseUrl: "https://hub.example.org", writeSetupRuntime: async () => { writes += 1; } });
  for (const applyComposeDefinition of ["false", null, 0, {}, []]) {
    await assert.rejects(config.hooks.before({ path: "/sign-up/email", body: { applyComposeDefinition },
      context: {} } as never), (error: unknown) => {
      const apiError = error as { status?: string; body?: { code?: string } };
      return apiError.status === "BAD_REQUEST" && apiError.body?.code === "INVALID_RUNTIME_SETTINGS";
    });
  }
  assert.equal(queries, 0);
  assert.equal(writes, 0);
});
