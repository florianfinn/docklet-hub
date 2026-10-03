import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";

import { changeLanguage } from "./service.js";

// The language change without Express and without Postgres (#269): a pool that
// records what was written. The HTTP side runs against the whole router in
// `api/` (`PUT /session/language`).

function recordingPool() {
  const writes: unknown[][] = [];
  const pool = {
    query: async (_sql: string, params: unknown[]) => {
      writes.push(params);
      return { rows: [] };
    }
  } as unknown as Pool;
  return { pool, writes };
}

test("changeLanguage schreibt eine bekannte Sprache an der Kennung der Sitzung", async () => {
  const { pool, writes } = recordingPool();
  assert.deepEqual(await changeLanguage(pool, "u1", { language: "en" }), { kind: "ok" });
  assert.deepEqual(writes, [["u1", "en"]]);
});

test("changeLanguage lehnt „fr“ ab, statt es zu „de“ zu machen, und schreibt nichts", async () => {
  const { pool, writes } = recordingPool();
  assert.deepEqual(await changeLanguage(pool, "u1", { language: "fr" }), { kind: "invalid-language" });
  assert.deepEqual(writes, []);
});

test("changeLanguage lehnt einen Rumpf ab, der kein Objekt ist", async () => {
  const { pool, writes } = recordingPool();
  for (const body of [null, "en", ["en"], 3, undefined]) {
    assert.deepEqual(await changeLanguage(pool, "u1", body), { kind: "invalid-body" });
  }
  assert.deepEqual(writes, []);
});

test("changeLanguage liest die Kennung nie aus dem Rumpf", async () => {
  const { pool, writes } = recordingPool();
  await changeLanguage(pool, "u1", { language: "de", userId: "someone-else" });
  assert.deepEqual(writes, [["u1", "de"]]);
});
