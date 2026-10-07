import test from "node:test";
import assert from "node:assert/strict";
import { readLifecycleActorNames } from "./actors.js";
import type { Pool } from "pg";
test("actor lookup selects only account identities and names with parameterized ids", async () => {
  let calls = 0;
  const pool = { query: async (sql: string, values: unknown[]) => {
    calls++; assert.equal(sql.includes('"email"'), false);
    assert.equal(sql.includes('"name"'), true); assert.deepEqual(values, [["demo-user"]]);
    return { rows: [{ id: "demo-user", name: "Demo Person" }] };
  } } as unknown as Pool;
  assert.deepEqual(await readLifecycleActorNames(pool, []), new Map());
  assert.equal(calls, 0);
  assert.deepEqual(await readLifecycleActorNames(pool, ["demo-user"]), new Map([["demo-user", "Demo Person"]]));
  assert.equal(calls, 1);
});
