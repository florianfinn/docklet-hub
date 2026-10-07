import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test, { after } from "node:test";
import { DEFAULT_SELF_HEALING_CONFIG } from "contract";
import { EngineError } from "./engine.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-healing-route-"));
process.env.DOCKER_AGENT_SECRET = "s".repeat(32);
process.env.DOCKER_AGENT_READ_ONLY = "true";
process.env.DOCKER_AGENT_AUDIT_FILE = path.join(root, "audit.jsonl");
process.env.DOCKER_AGENT_REGISTRY_FILE = path.join(root, "registry.json");
process.env.DOCKER_AGENT_MONITOR_FILE = path.join(root, "monitor.json");
const { handleRequest } = await import("./dispatch.js");
const { selfHealingConfig, config } = await import("./runtime/state.js");
after(() => fs.rmSync(root, { recursive: true, force: true }));

class Response extends EventEmitter {
  headersSent = false;
  status = 0;
  body = "";
  writeHead(status: number) { this.status = status; this.headersSent = true; }
  end(body = "") { this.body = body; }
}

async function call(body: string, actor: string | null = "system:hub") {
  const request = Object.assign(Readable.from([Buffer.from(body)]), {
    method: "PUT", url: "/self-healing/config",
    headers: { "x-docker-agent-secret": process.env.DOCKER_AGENT_SECRET,
      ...(actor === null ? {} : { "x-docker-agent-actor": actor }) }
  });
  const response = new Response();
  const auditLines = () => fs.existsSync(config.auditFile)
    ? fs.readFileSync(config.auditFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const before = auditLines().length;
  await handleRequest(request as unknown as http.IncomingMessage, response as unknown as http.ServerResponse);
  const audits = auditLines().slice(before);
  assert.equal(audits.length, 1);
  return { status: response.status, body: JSON.parse(response.body), audit: audits[0] };
}

test("read-only mode stores and acknowledges unlimited configuration without a container action", async () => {
  assert.equal(config.readOnly, true);
  const value = { ...DEFAULT_SELF_HEALING_CONFIG, maintenanceDurationSeconds: null };
  const result = await call(JSON.stringify(value));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { config: value });
  assert.equal(result.audit.action, "self-healing-config");
  assert.equal(result.audit.actor, "system:hub");
  assert.equal(result.audit.outcome, "allowed");
  assert.deepEqual(selfHealingConfig.read(), value);
});

test("invalid JSON, schema and actor each produce one denial audit", async () => {
  for (const [body, actor, status, error] of [
    ["{broken", "system:hub", 400, "invalid-json"],
    [JSON.stringify({ ...DEFAULT_SELF_HEALING_CONFIG, attempts: 2 }), "system:hub", 400, "invalid-request"],
    [JSON.stringify(DEFAULT_SELF_HEALING_CONFIG), "system:monitor", 403, "actor-not-allowed"],
    [JSON.stringify(DEFAULT_SELF_HEALING_CONFIG), "user:demo", 403, "actor-not-allowed"],
    [JSON.stringify(DEFAULT_SELF_HEALING_CONFIG), null, 403, "actor-not-allowed"]
  ] as const) {
    const result = await call(body, actor);
    assert.equal(result.status, status);
    assert.equal(result.body.error, error);
    assert.equal(result.audit.outcome, "denied");
  }
});

for (const [name, failure, status, error] of [
  ["engine", new EngineError('engine responded 503: {"message":"private diagnostic"}', 503), 503, "engine-action-failed"],
  ["file", Object.assign(new Error("private diagnostic"), { code: "EACCES" }), 500, "internal-error"],
  ["unknown", new Error("private diagnostic"), 500, "internal-error"]
] as const) test(`${name} write failure preserves diagnostics in exactly one error audit`, async (t) => {
  t.mock.method(selfHealingConfig, "write", () => { throw failure; });
  const result = await call(JSON.stringify(DEFAULT_SELF_HEALING_CONFIG));
  assert.equal(result.status, status);
  assert.equal(result.body.error, error);
  assert.equal(result.audit.action, "self-healing-config");
  assert.equal(result.audit.outcome, "error");
  assert.match(result.audit.reason, /private diagnostic/);
  assert.equal(JSON.stringify(result.body).includes("private diagnostic"), false);
});

test("failed atomic file replacement is audited once and retains the stored configuration", async (t) => {
  const previous = selfHealingConfig.read();
  const file = path.join(path.dirname(config.auditFile), "self-healing-config.json");
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file);
  t.after(() => { fs.rmSync(file, { recursive: true, force: true }); selfHealingConfig.write(previous); });
  const result = await call(JSON.stringify({ ...DEFAULT_SELF_HEALING_CONFIG, enabled: false }));
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { error: "internal-error" });
  assert.equal(result.audit.outcome, "error");
  assert.match(result.audit.reason, /EISDIR|ENOTDIR|EEXIST|EPERM/);
  assert.deepEqual(selfHealingConfig.read(), previous);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp")), []);
});
