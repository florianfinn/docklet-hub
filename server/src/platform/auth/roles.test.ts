import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_ROLE, isAdmin, ROLES, toRole } from "./roles.js";

test("es gibt genau zwei Rollen", () => {
  // Kein Scope-Katalog (concept-and-plan.md §2). Wer eine dritte Rolle
  // ergänzt, ändert damit auch den CHECK in 002-auth.sql — dieser Fall soll
  // ihn daran erinnern.
  assert.deepEqual([...ROLES], ["admin", "user"]);
});

test("was nicht als Rolle erkennbar ist, wird zur kleineren Rolle", () => {
  // Fail closed. Ein `null` aus einer Spalte, ein Tippfehler, ein Wert aus
  // einer künftigen Fassung: keiner davon macht einen Admin.
  for (const value of [null, undefined, "", "Admin", "ADMIN", "owner", 1, {}, ["admin"]]) {
    assert.equal(toRole(value), DEFAULT_ROLE, `${JSON.stringify(value)} hätte zur Vorgaberolle werden müssen`);
    assert.equal(isAdmin(value), false);
  }
});

test("die beiden echten Rollen kommen unverändert durch", () => {
  assert.equal(toRole("admin"), "admin");
  assert.equal(toRole("user"), "user");
  assert.equal(isAdmin("admin"), true);
});
