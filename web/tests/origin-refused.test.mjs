import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, isOriginRefused } from "../src/platform/http/transport.js";
import { logErrorKey } from "../src/features/logs/log-errors.js";
import { fileErrorKey } from "../src/features/files/file-errors.js";
import { composeErrorKey } from "../src/features/compose/compose-errors.js";
import { execErrorKey, shellErrorMessageKey } from "../src/features/shell/shell-errors.js";

// Eine `403`, zwei Absender (#188).
//
// ⚠️ WOGEGEN ER STEHT, GEMESSEN AM 2026-09-29. Über reines HTTP wies die
// Herkunftsprüfung des Hubs (`server/src/platform/http/request-origin-guard.ts`) den
// Log-Strom und die Dateiliste mit `403 forbidden-origin` ab (#186). Die
// Oberfläche las nur den Status und zeigte auf jedem Arm „Der Arm hat den
// Zugriff auf dieses Log abgelehnt" — während der Arm die Anfrage nie gesehen
// hatte. Der Satz schickte die Suche in die Allowlist statt in den Browser.
//
// Je Fläche zwei Fälle: `forbidden-origin` bekommt den Satz über den Hub,
// `agent-forbidden` behält den über den Arm. Der zweite ist die Gegenprobe —
// ohne ihn bestünde eine Fassung, die JEDE `403` dem Hub zuschreibt.

// Der Rumpf, wie `readErrorDetail` ihn ablegt: `JSON.stringify` der Antwort.
const fromOriginGuard = () => new ApiError(403, JSON.stringify({ error: "forbidden-origin" }));
const fromAgent = () =>
  new ApiError(403, JSON.stringify({ error: "agent-forbidden", message: "Diesen Container führt der Arm nicht." }));

test("isOriginRefused trifft genau die Abweisung der Herkunftsprüfung", () => {
  assert.equal(isOriginRefused(fromOriginGuard()), true);
  assert.equal(isOriginRefused(fromAgent()), false);
  // Derselbe Wortlaut unter einem anderen Status ist nicht diese Schranke.
  assert.equal(isOriginRefused(new ApiError(400, JSON.stringify({ error: "forbidden-origin" }))), false);
  // Ein Rumpf, der kein JSON ist, ist keine Kennung.
  assert.equal(isOriginRefused(new ApiError(403, "Forbidden")), false);
  assert.equal(isOriginRefused(new Error("forbidden-origin")), false);
});

test("Protokoll: die Schranke des Hubs und die Allowlist des Arms tragen verschiedene Sätze", () => {
  assert.equal(logErrorKey(fromOriginGuard()), "errorOriginRefused");
  assert.equal(logErrorKey(fromAgent()), "logErrorForbidden");
});

test("Dateien: die Schranke des Hubs und die Allowlist des Arms tragen verschiedene Sätze", () => {
  assert.equal(fileErrorKey(fromOriginGuard()), "errorOriginRefused");
  assert.equal(fileErrorKey(fromAgent()), "fileErrorForbidden");
});

test("Compose: die Schranke des Hubs und die Allowlist des Arms tragen verschiedene Sätze", () => {
  assert.equal(composeErrorKey(fromOriginGuard()), "errorOriginRefused");
  assert.equal(composeErrorKey(fromAgent()), "composeErrorNotAllowlisted");
});

test("Shell: die Schranke des Hubs und die Allowlist des Arms tragen verschiedene Sätze", () => {
  const origin = execErrorKey(fromOriginGuard());
  const agent = execErrorKey(fromAgent());
  assert.equal(origin, "forbidden-origin");
  assert.equal(agent, "agent-forbidden");
  assert.equal(shellErrorMessageKey(origin), "errorOriginRefused");
  assert.equal(shellErrorMessageKey(agent), "shellErrorAgentForbidden");
});
