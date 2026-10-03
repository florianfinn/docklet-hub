import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentAuditLog, MAX_FIELD_CHARS, type Handoff } from "./audit.js";

function tempFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-audit-")), "audit.jsonl");
}

// A prepared handoff; fails the test on "already running" or no log.
async function handoffOf(audit: AgentAuditLog): Promise<Handoff> {
  const handoff = await audit.prepareHandoff();
  assert.ok(handoff !== null && typeof handoff === "object", `no handoff: ${String(handoff)}`);
  return handoff;
}

test("entries are appended as JSONL, not overwritten", () => {
  const file = tempFile();
  const audit = new AgentAuditLog(file);
  audit.write({
    action: "start",
    containerId: "abc",
    containerName: "minecraft",
    actor: "marwin",
    networkTier: "internal",
    outcome: "allowed"
  });
  audit.write({
    action: "stop",
    containerId: "abc",
    containerName: "minecraft",
    actor: "marwin",
    networkTier: "external",
    outcome: "denied",
    reason: "scope-requires-internal"
  });

  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const second = JSON.parse(lines[1]);
  assert.equal(second.action, "stop");
  assert.equal(second.outcome, "denied");
  assert.equal(second.reason, "scope-requires-internal");
  assert.ok(second.at, "timestamp missing");
});

test("assertWritable writes a start entry", () => {
  const file = tempFile();
  new AgentAuditLog(file).assertWritable();
  const first = JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n")[0]);
  assert.equal(first.action, "agent-start");
});

test("a non-writable path throws instead of failing silently", () => {
  // The original bug: the failure was logged and the agent kept running
  // without a log. Now it has to propagate.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-audit-ro-"));
  // A directory (instead of a file) at the target location is not writable
  // on any platform — unlike chmod, which has no effect on Windows.
  const file = path.join(directory, "audit.jsonl");
  fs.mkdirSync(file);
  const audit = new AgentAuditLog(file);
  assert.throws(() => audit.assertWritable());
  assert.throws(() =>
    audit.write({
      action: "start",
      containerId: "abc",
      containerName: null,
      actor: null,
      networkTier: null,
      outcome: "allowed"
    })
  );
});

test("long fields are visibly truncated instead of bloating the log", () => {
  // The path of a rejected request and the actor header come raw from the
  // request. Without a cap every connection attempt writes up to Node's
  // header limit into a log that is never deleted — and without a writable
  // audit log the agent executes nothing at all any more.
  const file = tempFile();
  const audit = new AgentAuditLog(file);
  audit.write({
    action: `unauth:GET /${"a".repeat(20_000)}`,
    containerId: null,
    containerName: null,
    actor: "b".repeat(20_000),
    networkTier: null,
    outcome: "denied",
    reason: "c".repeat(20_000)
  });

  const entry = JSON.parse(fs.readFileSync(file, "utf8").trim());
  assert.equal(entry.action.length, MAX_FIELD_CHARS + 1);
  assert.ok(entry.action.endsWith("…"), "truncation must be visible");
  assert.equal(entry.actor.length, MAX_FIELD_CHARS + 1);
  assert.equal(entry.reason.length, MAX_FIELD_CHARS + 1);
});

test("control characters in a field do not corrupt the line", () => {
  const file = tempFile();
  const audit = new AgentAuditLog(file);
  audit.write({
    action: "GET /a\nb",
    containerId: null,
    containerName: null,
    actor: "mar\u0000win",
    networkTier: null,
    outcome: "denied",
    reason: "grund"
  });
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).action, "GET /a b");
  assert.equal(JSON.parse(lines[0]).actor, "mar win");
});

test("sizeBytes reports the growth of the log", () => {
  const file = tempFile();
  const audit = new AgentAuditLog(file);
  assert.equal(audit.sizeBytes(), null);
  audit.assertWritable();
  assert.ok((audit.sizeBytes() ?? 0) > 0);
});

// --- Archiving: fetch and discard (#30) ------------------------------------

function write(audit: AgentAuditLog, action: string): void {
  audit.write({
    action,
    containerId: null,
    containerName: null,
    actor: "marwin",
    networkTier: "internal",
    outcome: "allowed"
  });
}

async function read(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

test("the handoff names bytes and the SHA-256 of exactly these bytes", async () => {
  const file = tempFile();
  const audit = new AgentAuditLog(file);
  write(audit, "start");
  write(audit, "stop");

  const handoff = await handoffOf(audit);
  const content = fs.readFileSync(file);
  assert.equal(handoff.bytes, content.length);
  assert.equal(handoff.sha256, crypto.createHash("sha256").update(content).digest("hex"));
  assert.match(handoff.sha256, /^[0-9a-f]{64}$/);
});

test("without a log there is nothing to hand off", async () => {
  assert.equal(await new AgentAuditLog(tempFile()).prepareHandoff(), null);
});

test("an empty prefix is permitted and leaves the file alone", async () => {
  // The case "nothing was fetched": permitted, but there is nothing to do.
  // Without this case the file would be copied completely once only to look
  // exactly the same at the end — synchronously, i.e. blocking the whole agent.
  const file = tempFile();
  const audit = new AgentAuditLog(file);
  write(audit, "start");
  const before = fs.readFileSync(file);
  const empty = crypto.createHash("sha256").digest("hex");

  assert.deepEqual(await audit.discardPrefix({ bytes: 0, sha256: empty }), {
    ok: true,
    removed: 0,
    rest: before.length
  });
  assert.deepEqual(fs.readFileSync(file), before);
});

test("whatever is added after the handoff does not belong to it", async () => {
  // The agent keeps writing during the fetch. Everything from byte N+1 on is
  // explicitly not part of the handoff — otherwise the proof against which
  // truncation happens later would already be stale when delivered.
  const file = tempFile();
  const audit = new AgentAuditLog(file);
  write(audit, "start");

  const handoff = await handoffOf(audit);
  write(audit, "waehrenddessen");

  const delivered = await read(audit.readStream(handoff.bytes));
  assert.equal(delivered.length, handoff.bytes);
  assert.equal(crypto.createHash("sha256").update(delivered).digest("hex"), handoff.sha256);
  assert.ok(!delivered.toString("utf8").includes("waehrenddessen"));
});

test("a run truncates by exactly the handed-off bytes and leaves the rest", async () => {
  const file = tempFile();
  const audit = new AgentAuditLog(file);
  write(audit, "alt-1");
  write(audit, "alt-2");

  const handoff = await handoffOf(audit);
  write(audit, "neu-danach");
  const before = fs.readFileSync(file);

  const result = await audit.discardPrefix(handoff);
  assert.deepEqual(result, {
    ok: true,
    removed: handoff.bytes,
    rest: before.length - handoff.bytes
  });

  const after = fs.readFileSync(file);
  // Byte for byte the same rest — not "roughly the right lines".
  assert.deepEqual(after, before.subarray(handoff.bytes));
  assert.ok(!after.toString("utf8").includes("alt-1"));
  assert.ok(after.toString("utf8").includes("neu-danach"));
  // And the log stays writable afterwards: the file was replaced, not the
  // descriptor the agent hangs on.
  write(audit, "nach-der-kuerzung");
  assert.ok(fs.readFileSync(file, "utf8").includes("nach-der-kuerzung"));
});

test("a wrong SHA-256 leaves the file untouched", async () => {
  const file = tempFile();
  const audit = new AgentAuditLog(file);
  write(audit, "start");
  const handoff = await handoffOf(audit);
  const before = fs.readFileSync(file);

  const result = await audit.discardPrefix({ bytes: handoff.bytes, sha256: "0".repeat(64) });
  assert.deepEqual(result, { ok: false, reason: "sha-mismatch" });
  assert.deepEqual(fs.readFileSync(file), before);
});

test("a stale proof from an already truncated log does not truncate again", async () => {
  // The same proof sent twice: the second time the file no longer starts
  // with these bytes. Without this check a repeated call would be a way to
  // discard fresh records of which no copy exists.
  const file = tempFile();
  const audit = new AgentAuditLog(file);
  write(audit, "alt");
  const handoff = await handoffOf(audit);
  write(audit, "neu");

  assert.equal((await audit.discardPrefix(handoff)).ok, true);
  const afterFirst = fs.readFileSync(file);
  assert.deepEqual(await audit.discardPrefix(handoff), { ok: false, reason: "sha-mismatch" });
  assert.deepEqual(fs.readFileSync(file), afterFirst);
});

test("a prefix longer than the file is rejected", async () => {
  const file = tempFile();
  const audit = new AgentAuditLog(file);
  write(audit, "start");
  const handoff = await handoffOf(audit);
  const before = fs.readFileSync(file);

  const result = await audit.discardPrefix({ bytes: handoff.bytes + 1, sha256: handoff.sha256 });
  assert.deepEqual(result, { ok: false, reason: "too-short" });
  assert.deepEqual(fs.readFileSync(file), before);
});

test("without a log there is nothing to discard", async () => {
  const audit = new AgentAuditLog(tempFile());
  const empty = crypto.createHash("sha256").digest("hex");
  assert.deepEqual(await audit.discardPrefix({ bytes: 0, sha256: empty }), { ok: false, reason: "no-log" });
});

test("a large log is truncated without the rest shifting", async () => {
  // Beyond the 1 MiB buffer limit: the copy path runs in loops, and an
  // off-by-one in it would be a log that starts in the middle of a line.
  const file = tempFile();
  const audit = new AgentAuditLog(file);
  const prefix = Buffer.alloc(3 * 1024 * 1024 + 17, 0x61);
  fs.writeFileSync(file, prefix);
  const handoff = await handoffOf(audit);
  const rest = Buffer.alloc(2 * 1024 * 1024 + 5, 0x62);
  fs.appendFileSync(file, rest);

  const result = await audit.discardPrefix(handoff);
  assert.deepEqual(result, { ok: true, removed: prefix.length, rest: rest.length });
  assert.deepEqual(fs.readFileSync(file), rest);
});

test("freeSpaceBytes reports the space of the volume the log lives on", () => {
  const audit = new AgentAuditLog(tempFile());
  const free = audit.freeSpaceBytes();
  assert.ok(typeof free === "number" && free > 0, `unusable value: ${free}`);
  // The number only means something together with sizeBytes() — that is why
  // it sits next to it in /health and not instead of it.
  assert.ok((free ?? 0) > (audit.sizeBytes() ?? 0));
});
