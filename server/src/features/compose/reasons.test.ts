import assert from "node:assert/strict";
import test from "node:test";

import { COMPOSE_RAW_FAILURE_REASONS } from "contract";

import { AgentError } from "../../platform/agent-transport/protocol.js";
import { COMPOSE_REASONS, composeQuestionOf, describeComposeRejection, isRouteUnknown } from "./reasons.js";

// The table of the agent's keys for the compose surface (#264) — without a
// server, without an arm. `app/compose-routes.test.ts` stands near the
// 1.000-line mark of `AGENTS.md`, and a table needs no arm to be right.

/** An error as `agentRequest` builds it from the body of the arm. */
function rejection(status: number, detail: unknown, message = "abgelehnt"): AgentError {
  return new AgentError(message, status, { detail });
}

// ── Jeder bekannte Schlüssel hat einen Text ─────────────────────────────────

test("jeder bekannte Schlüssel des Agenten hat einen Satz, und die Tabelle führt keinen anderen", () => {
  // ⚠️ THE COMPILER HOLDS THE SAME (`Record<ComposeRawFailureReason, …>`); this
  // is the runtime side of it, and it counts what is there instead of what is
  // typed: an entry cast in from outside would not break the build.
  assert.deepEqual(Object.keys(COMPOSE_REASONS).sort(), [...COMPOSE_RAW_FAILURE_REASONS].sort());
  for (const key of COMPOSE_RAW_FAILURE_REASONS) {
    const entry = COMPOSE_REASONS[key];
    assert.ok(entry.message.trim().length > 0, `„${key}" hat keinen Satz`);
    assert.ok(!entry.message.includes(key), `„${key}" nennt sich selbst statt zu erklären`);
  }
});

test("jeder bekannte Schlüssel kommt mit seinem Satz und als reason an", () => {
  for (const key of COMPOSE_RAW_FAILURE_REASONS) {
    // 409 stands for "the arm answered and named it": it is no `agent-unreachable`
    // for any key. The hub-fault key is the one that is read as the hub's own.
    const answer = describeComposeRejection(rejection(409, { error: key }, "Text des Transports"));
    if (key === "compose-file-missing" || key.startsWith("compose-anchor-")) {
      // The three anchor reasons take the way of a missing file (#185).
      assert.equal(answer.body.error, "compose-file-missing");
      assert.equal(answer.body.message, COMPOSE_REASONS[key].message, key);
    } else if (key === "tier-missing") {
      assert.equal(answer.body.error, "agent-unreachable");
      assert.notEqual(answer.body.message, COMPOSE_REASONS[key].message);
    } else {
      assert.equal(answer.body.message, COMPOSE_REASONS[key].message, key);
    }
    assert.equal(answer.body.reason, key);
  }
});

test("die Schlüssel aus #113 und #234 haben ihren eigenen Satz", () => {
  for (const key of [
    "stack-anchor-stale",
    "image-ref-unreadable",
    "compose-anchor-labels-missing",
    "compose-anchor-outside-base-path",
    "compose-anchor-file-ambiguous"
  ] as const) {
    const answer = describeComposeRejection(rejection(409, { error: key }, "Text des Transports"));
    assert.equal(answer.status, 409);
    // Since #185 the anchor reasons leave as `compose-file-missing`, so that
    // the surface asks the next container of the stack.
    assert.equal(answer.body.error, key.startsWith("compose-anchor-") ? "compose-file-missing" : "agent-conflict");
    assert.equal(answer.body.message, COMPOSE_REASONS[key].message);
    assert.notEqual(answer.body.message, "Text des Transports");
    assert.equal(answer.body.reason, key);
  }
});

// ── Ein unbekannter Schlüssel reist wörtlich ────────────────────────────────

test("ein unbekannter Schlüssel reist wörtlich als reason, mit Status und Code der allgemeinen Tabelle", () => {
  for (const [status, expected] of [
    [409, "agent-conflict"],
    [403, "agent-forbidden"],
    [400, "agent-rejected"],
    [404, "agent-not-found"]
  ] as const) {
    const answer = describeComposeRejection(rejection(status, { error: "key-of-a-newer-agent" }, "Text des Transports"));
    assert.equal(answer.status, status);
    assert.equal(answer.body.error, expected);
    assert.equal(answer.body.reason, "key-of-a-newer-agent", "der Schlüssel muss wörtlich ankommen");
    assert.ok(String(answer.body.message).length > 0);
  }
  // Without a key there is no `reason`, and nothing is invented.
  const bare = describeComposeRejection(rejection(409, null, "Text des Transports"));
  assert.deepEqual(bare.body, { error: "agent-conflict", message: "Text des Transports" });
});

test("ein geerbter Objektschlüssel ist kein bekannter Schlüssel", () => {
  // `toString` is on every object; a lookup by `in` or by index would find it.
  for (const key of ["toString", "constructor", "__proto__"]) {
    const answer = describeComposeRejection(rejection(409, { error: key }, "Text des Transports"));
    assert.equal(answer.body.message, "Text des Transports", key);
    assert.equal(composeQuestionOf(rejection(409, { error: key })), null, key);
  }
});

test("ein Fehler des Hubs behält den Text des Transports", () => {
  // A wrong secret is no statement of the arm about its keys.
  const wrongSecret = describeComposeRejection(rejection(401, { error: "compose-hash-missing" }, "Text des Transports"));
  assert.equal(wrongSecret.status, 502);
  assert.equal(wrongSecret.body.error, "agent-unreachable");
  assert.equal(wrongSecret.body.message, "Text des Transports");
});

// ── Die Fragen ──────────────────────────────────────────────────────────────

test("genau dreizehn Schlüssel sind eine Frage, jeder mit der Liste des Arms", () => {
  const asked = COMPOSE_RAW_FAILURE_REASONS.filter((key) => COMPOSE_REASONS[key].question !== undefined);
  assert.equal(asked.length, 13);

  const body = {
    new: ["a"],
    removed: ["b"],
    missingImages: ["c:1"],
    externalSources: ["/mnt/user/media"],
    newViolations: ["s:privileged"],
    rolledBack: true,
    actualHash: "h2",
    detail: "Meldung",
    ref: "x::y"
  };
  const kinds = new Map(asked.map((key) => [key, composeQuestionOf(rejection(409, { error: key, ...body }))?.kind]));
  assert.deepEqual(Object.fromEntries(kinds), {
    "invalid-content": "invalid-draft",
    "invalid-compose-file": "invalid-draft",
    "no-services": "invalid-draft",
    "service-without-image": "invalid-draft",
    "stack-anchor-stale": "anchor-stale",
    "image-ref-unreadable": "image-ref-unreadable",
    "service-confirmation-missing": "services",
    "image-not-local": "images",
    "external-source-confirmation-missing": "external-sources",
    "file-changed-externally": "changed-elsewhere",
    "compose-up-failed": "start-failed",
    "container-not-resolvable": "container-missing",
    "hardening-newly-violated": "hardening"
  });
});

test("die Frage trägt die Listen und das Wort rolledBack des Arms", () => {
  assert.deepEqual(composeQuestionOf(rejection(409, { error: "service-confirmation-missing", new: ["a"], removed: ["b"] })), {
    kind: "services",
    added: ["a"],
    removed: ["b"]
  });
  assert.deepEqual(composeQuestionOf(rejection(409, { error: "hardening-newly-violated", newViolations: ["s:r"], rolledBack: true })), {
    kind: "hardening",
    newViolations: ["s:r"],
    rolledBack: true
  });
  assert.deepEqual(composeQuestionOf(rejection(400, { error: "image-ref-unreadable", ref: "x::y" })), {
    kind: "image-ref-unreadable",
    ref: "x::y"
  });
  // The detail of a draft that is no good comes from `detail`, or from `errors`.
  assert.deepEqual(composeQuestionOf(rejection(400, { error: "invalid-content", errors: ["leer", "NUL"] })), {
    kind: "invalid-draft",
    detail: "leer; NUL"
  });
});

test("was keine Frage ist, bleibt ein Fehler", () => {
  assert.equal(composeQuestionOf(rejection(403, { error: "not-allowlisted" })), null);
  assert.equal(composeQuestionOf(rejection(503, { error: "agent-read-only" })), null);
  assert.equal(composeQuestionOf(rejection(409, { error: "key-of-a-newer-agent" })), null);
  assert.equal(composeQuestionOf(rejection(409, null)), null);
  assert.equal(composeQuestionOf(rejection(409, ["service-confirmation-missing"])), null);
});

// ── „Route unbekannt" gegen eine benannte Ablehnung ─────────────────────────

test("eine 404 ohne Grund oder mit einem fremden Grund heißt Route unbekannt", () => {
  assert.equal(isRouteUnknown(rejection(404, null)), true);
  assert.equal(isRouteUnknown(rejection(404, { error: "unbekannte-route" })), true);
  assert.equal(isRouteUnknown(rejection(404, { error: "key-of-a-newer-agent" })), true);
});

test("eine 404 mit not-allowlisted oder container-gone ist eine Antwort und kein Rückfall", () => {
  assert.equal(isRouteUnknown(rejection(404, { error: "not-allowlisted" })), false);
  assert.equal(isRouteUnknown(rejection(404, { error: "container-gone" })), false);
  // They go out as what they are.
  const forbidden = describeComposeRejection(rejection(404, { error: "not-allowlisted" }));
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error, "agent-forbidden");
  const gone = describeComposeRejection(rejection(404, { error: "container-gone" }));
  assert.equal(gone.status, 404);
  assert.equal(gone.body.error, "container-unknown");
});

test("nur eine 404 eines AgentError löst einen Rückfall aus", () => {
  assert.equal(isRouteUnknown(rejection(403, null)), false);
  assert.equal(isRouteUnknown(rejection(503, { error: "agent-read-only" })), false);
  assert.equal(isRouteUnknown(new AgentError("kein Status")), false);
  assert.equal(isRouteUnknown(new Error("kein AgentError")), false);
});

// ── Der Fall „der Arm findet keine Compose-Datei" (#183) ────────────────────

test("das Verzeichnis, in dem der Arm gesucht hat, kommt mit", () => {
  // Wörtlich die Antwort des Arms `unraid` vom 2026-09-29 für `fileflows`.
  const answer = describeComposeRejection(
    rejection(409, { error: "compose-file-missing", projectDir: "/mnt/cache/docker/fileflows" })
  );
  assert.equal(answer.status, 409);
  assert.equal(answer.body.error, "compose-file-missing");
  assert.equal(answer.body.reason, "compose-file-missing");
  assert.equal(answer.body.projectDir, "/mnt/cache/docker/fileflows");
});

test("ohne Verzeichnis im Rumpf bleibt es null und wird nicht erfunden", () => {
  for (const detail of [
    { error: "compose-file-missing" },
    { error: "compose-file-missing", projectDir: 7 },
    { error: "compose-file-missing", projectDir: "" }
  ]) {
    const answer = describeComposeRejection(rejection(409, detail));
    assert.equal(answer.status, 409);
    assert.equal(answer.body.projectDir, null);
  }
});

test("jeder andere Grund ist nicht dieser Fall", () => {
  assert.notEqual(describeComposeRejection(rejection(409, { error: "stack-busy" })).body.error, "compose-file-missing");
  assert.notEqual(describeComposeRejection(rejection(404, { error: "not-allowlisted" })).body.error, "compose-file-missing");
  assert.notEqual(describeComposeRejection(new AgentError("ohne Rumpf", 502)).body.error, "compose-file-missing");
});
