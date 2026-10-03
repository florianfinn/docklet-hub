import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

import type { SessionUser } from "./session.js";
import type { Auth } from "./auth.js";
import { requireAdmin } from "./require-admin.js";

// Geprüft wird ohne better-auth und ohne Datenbank: die Auflösung der Sitzung
// wird eingespeist. Ein Test, der dafür ein Postgres bräuchte, liefe auf einer
// frischen Arbeitskopie nicht (AGENTS.md, „Tests") — und genau die Zusage, um
// die es hier geht, stünde dann ungeprüft da.

type Recorded = {
  status: number | null;
  body: unknown;
  passed: boolean;
  forwarded: unknown;
};

function run(resolve: () => Promise<SessionUser | null>): Promise<Recorded> {
  const recorded: Recorded = { status: null, body: null, passed: false, forwarded: null };

  return new Promise((done) => {
    const response = {
      status(code: number) {
        recorded.status = code;
        return this;
      },
      json(body: unknown) {
        recorded.body = body;
        // Eine Antwort beendet den Durchlauf. Käme danach noch ein `next()`,
        // wäre das der Fehler, den dieser Test sucht — und er fiele als
        // „passed" auf, weil `recorded` weiterläuft.
        setImmediate(() => done(recorded));
        return this;
      }
    } as unknown as Response;

    const next = (error?: unknown) => {
      if (error === undefined) recorded.passed = true;
      else recorded.forwarded = error;
      setImmediate(() => done(recorded));
    };

    requireAdmin({} as Auth, { resolve })({ headers: {} } as Request, response, next);
  });
}

// Die Sprache steht hier nur, weil `SessionUser` sie trägt (#70). Für diese
// Zwischenschicht ist sie ohne Bedeutung: sie entscheidet über die Rolle.
const admin: SessionUser = { id: "1", name: "A", email: "a@example.invalid", role: "admin", language: "de" };
const user: SessionUser = { id: "2", name: "B", email: "b@example.invalid", role: "user", language: "de" };

test("ein Admin kommt durch", async () => {
  const result = await run(async () => admin);
  assert.equal(result.passed, true);
  assert.equal(result.status, null);
});

test("die Rolle user bekommt 403 und läuft nicht weiter", async () => {
  const result = await run(async () => user);
  assert.equal(result.passed, false);
  assert.equal(result.status, 403);
  assert.deepEqual(result.body, { error: "admin-required" });
});

test("ohne Sitzung: 401, und die Anfrage läuft nicht weiter", async () => {
  const result = await run(async () => null);
  assert.equal(result.passed, false);
  assert.equal(result.status, 401);
  assert.deepEqual(result.body, { error: "unauthenticated" });
});

test("eine Sitzung, die sich nicht auflösen lässt, ist keine", async () => {
  // ⚠️ Der Fall, der still öffnet: ein `catch`, das weiterlaufen lässt, macht
  // aus einer nicht erreichbaren Datenbank einen offenen Schreibzugriff.
  const failure = new Error("Datenbank weg");
  const result = await run(async () => {
    throw failure;
  });
  assert.equal(result.passed, false);
  assert.equal(result.forwarded, failure);
  // Der Aufrufer bekommt nichts selbst gebautes: der Fehlerbehandler von
  // Express antwortet, und der schreibt keinen Stacktrace nach draußen.
  assert.equal(result.status, null);
});

test("eine unbekannte Rolle ist keine Admin-Rolle", async () => {
  // Fail closed über die ganze Kette: `toRole` (auth/roles.ts) macht aus
  // allem Unbekannten `user`, und hier fällt das auf 403.
  const strange = { ...user, role: "superadmin" } as unknown as SessionUser;
  const result = await run(async () => strange);
  assert.equal(result.passed, false);
  assert.equal(result.status, 403);
});
