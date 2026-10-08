import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { STARTED_FILE } from "./self-update-state.js";

for (const mode of ["engine", "journal", "base"]) test(`real startup serves Health and reports start despite recovery failure: ${mode}`, { timeout: 20_000 }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "update-startup-"));
  const journal = path.join(base, "update-pending.json");
  fs.writeFileSync(journal, mode === "journal" ? "invalid synthetic journal" : JSON.stringify([{ target: { kind: "container", containerName: "demo" }, containerId: "old", containerName: "demo" }]));
  const child = fork(fileURLToPath(new URL("./update-startup-test-support.ts", import.meta.url)), [], { silent: true, cwd: fileURLToPath(new URL("../", import.meta.url)),
    execArgv: ["--conditions=source", "--import", "tsx"], env: { ...process.env, UPDATE_RECOVERY_TEST_CASE: mode,
      DOCKER_AGENT_PORT: "0", DOCKER_AGENT_HOST: "127.0.0.1", DOCKER_AGENT_SECRET: "s".repeat(64),
      DOCKER_AGENT_REGISTRY_FILE: path.join(base, "registry.json"), DOCKER_AGENT_AUDIT_FILE: path.join(base, "audit.jsonl"),
      DOCKER_AGENT_MONITOR_FILE: path.join(base, "monitor.json"), DOCKER_AGENT_BIND_BASE_PATH: mode === "base" ? path.join(base, "missing") : base,
      DOCKER_AGENT_SELF_UPDATE_DIR: path.join(base, "start"), DOCKER_AGENT_REGISTRATION_URL: "", DOCKER_AGENT_REGISTRATION_TOKEN: "" } });
  let output = ""; child.stdout!.on("data", (chunk) => { output += String(chunk); }); child.stderr!.on("data", (chunk) => { output += String(chunk); });
  t.after(async () => { child.kill("SIGTERM"); if (child.exitCode === null && child.signalCode === null) await once(child, "exit"); fs.rmSync(base, { recursive: true, force: true }); });
  const message = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(`Startup exited: ${output}`); })]);
  const port = (message[0] as { port: number }).port;
  const response = await fetch(`http://127.0.0.1:${port}/health`); assert.equal(response.status, 200); assert.equal((await response.json() as { ok: boolean }).ok, true);
  assert.equal(fs.existsSync(path.join(base, "start", STARTED_FILE)), true);
  const start = await fetch(`http://127.0.0.1:${port}/updates`, { method: "POST", headers: { "Content-Type": "application/json", "X-Docker-Agent-Secret": "s".repeat(64) },
    body: JSON.stringify({ target: { kind: "container", containerName: "demo" }, previewId: "preview", confirmed: true, services: [{
      target: { kind: "container", containerName: "demo" }, expectedContainer: { containerId: "old", status: "running", startedAt: "seen" },
      startDeadlineSeconds: 120, backup: null, definitionHash: "hash", offeredDigest: `sha256:${"a".repeat(64)}` }] }) });
  assert.equal(start.status, 409); assert.deepEqual(await start.json(), { error: "update-rollback-unavailable" });
  const audit = fs.readFileSync(path.join(base, "audit.jsonl"), "utf8"); assert.match(audit, /update-recovery/); assert.match(audit, /retry in/);
  assert.match(output, /update recovery failed/);
  if (mode === "journal") {
    const quarantined = fs.readdirSync(base).filter((file) => file.startsWith("update-pending.json.invalid-"));
    assert.equal(quarantined.length, 1); assert.equal(fs.statSync(path.join(base, quarantined[0])).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(base, quarantined[0]), "utf8"), "invalid synthetic journal");
    assert.match(fs.readFileSync(path.join(base, "self-healing-state.json"), "utf8"), /update-journal-invalid/);
  }
});
