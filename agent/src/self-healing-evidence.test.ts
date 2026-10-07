import assert from "node:assert/strict";
import test from "node:test";
import type { RawInspect } from "./engine-model.js";
import type { RegistryEntry } from "./registry.js";
import { healingEvidence } from "./self-healing-evidence.js";

const secret = "synthetic-password";
const container: RawInspect = { Id: "a".repeat(64), Name: "/demo-web", Config: { Tty: false, Env: [`PASSWORD=${secret}`], Labels: {
  "com.docker.compose.project": "demo", "com.docker.compose.service": "web",
  "com.docker.compose.project.working_dir": "/srv/apps/demo",
  "com.docker.compose.project.config_files": "/srv/apps/demo/compose.yaml"
} } };
const entry: RegistryEntry = { containerId: container.Id, containerName: "demo-web", imageRef: "example/app:1.0", allowed: true, secured: false,
  compose: { projectDir: "/srv/apps/demo", projectName: "demo", serviceName: "web", composeFileName: "compose.yaml", origin: "adopted" } };
const cause = { exitCode: 1, engineError: `error ${secret}` };

test("incident uses the existing environment redaction and returns only the last 50 lines", async () => {
  let called = false;
  const result = await healingEvidence(container, cause, entry, "/srv/apps", async (id, tail, tty) => {
    assert.equal(id, container.Id); assert.equal(tail, 50); assert.equal(tty, false); called = true;
    return Buffer.from(Array.from({ length: 70 }, (_, i) => `line ${i} ${secret} synthetic-env-secret`).join("\n") + "\n");
  }, (directory) => { assert.equal(directory, "/srv/apps/demo"); return ["synthetic-env-secret"]; });
  assert.equal(called, true); assert.equal(result.logs.available, true);
  if (!result.logs.available) throw new Error("expected excerpt");
  assert.equal(result.logs.lines.length, 50); assert.match(result.logs.lines[0], /^line 20/);
  assert.equal(JSON.stringify(result).includes(secret), false); assert.equal(JSON.stringify(result).includes("synthetic-env-secret"), false);
  assert.equal(result.cause.engineError, "error ••••");
});

test("unavailable redaction produces no excerpt or unsanitized engine message", async () => {
  let called = false;
  const result = await healingEvidence(container, cause, entry, "/srv/apps", async () => { called = true; return Buffer.from(secret); },
    () => { throw new Error("synthetic file failure"); });
  assert.equal(called, false); assert.deepEqual(result.logs, { available: false, reason: "redaction-unavailable" });
  assert.equal(result.cause.engineError, null); assert.equal(JSON.stringify(result).includes(secret), false);
});

test("log read failure records a stable reason and never forwards the diagnosis", async () => {
  const result = await healingEvidence(container, cause, entry, "/srv/apps", async () => { throw new Error("private diagnostic"); }, () => []);
  assert.deepEqual(result.logs, { available: false, reason: "logs-unavailable" });
  assert.equal(JSON.stringify(result).includes("private diagnostic"), false);
});

test("unconfirmed compose anchors use container secrets and never read a foreign environment", async () => {
  const result = await healingEvidence(container, cause, null, "/srv/apps", async () => Buffer.from(secret),
    () => { throw new Error("foreign environment read"); });
  assert.deepEqual(result.logs, { available: true, lines: ["••••"] });
});

for (const character of ["x", "界", "😀"]) test(`incident bounds long UTF-8 log lines and total excerpt: ${character}`, async () => {
  const result = await healingEvidence(container, cause, entry, "/srv/apps",
    async () => Buffer.from(Array.from({ length: 70 }, () => character.repeat(10_000) + secret).join("\n")), () => []);
  assert.equal(result.logs.available, true);
  if (!result.logs.available) throw new Error("expected excerpt");
  assert.equal(result.logs.lines.length <= 50, true);
  assert.equal(result.logs.lines.every((line) => Array.from(line).length <= 500), true);
  assert.equal(Buffer.byteLength(result.logs.lines.join("\n"), "utf8") <= 16 * 1024, true);
  assert.equal(result.logs.lines.every((line) => !line.includes("�")), true);
  assert.equal(JSON.stringify(result).includes(secret), false);
});
