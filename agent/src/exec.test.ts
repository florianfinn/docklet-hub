import assert from "node:assert/strict";
import test from "node:test";
import { terminalSizeSchema } from "contract";
import {
  ExecSessions,
  RedactingStream,
  SHELL_CANDIDATES,
  type ExecSession
} from "./exec.js";

// S16 (K1d, §20.1). The two parts that can be checked without Docker — and the
// more important of the two is the redaction: it is condition 2 from §20.1 and
// the place where a terminal differs from the log stream.

const SECRET = "sup3rgeheimespasswort";

function sessionFake(id: string, actor: string | null): ExecSession {
  return {
    id,
    containerId: "c1",
    containerName: "test",
    actor,
    execId: "e1",
    shell: "sh",
    started: 0,
    sent: 0,
    received: 0,
    write() {},
    async resize() {},
    finish() {}
  };
}

test("shell order is bash before sh", () => {
  assert.deepEqual([...SHELL_CANDIDATES], ["bash", "sh"]);
});

test("redaction replaces a secret in a single chunk", () => {
  const stream = new RedactingStream([SECRET]);
  const from = stream.push(`DB_PASS=${SECRET}\r\n`) + stream.flush();
  assert.equal(from, "DB_PASS=••••\r\n");
});

test("redaction also applies when the secret falls across two chunks", () => {
  const stream = new RedactingStream([SECRET]);
  const partA = SECRET.slice(0, 7);
  const partB = SECRET.slice(7);
  let from = stream.push(`DB_PASS=${partA}`);
  // The beginning must not be out yet — that is exactly the difference from
  // the line-by-line log stream.
  assert.equal(from, "DB_PASS=");
  from += stream.push(`${partB}\r\n`);
  from += stream.flush();
  assert.equal(from, "DB_PASS=••••\r\n");
});

test("redaction survives a split into single characters", () => {
  const stream = new RedactingStream([SECRET]);
  let from = "";
  for (const chars of `x${SECRET}y`) from += stream.push(chars);
  from += stream.flush();
  assert.equal(from, "x••••y");
});

test("text without a secret prefix goes out immediately and completely", () => {
  const stream = new RedactingStream([SECRET]);
  // No character held back: the interactivity of the terminal depends on
  // the normal case costing no delay.
  assert.equal(stream.push("root@host:/# "), "root@host:/# ");
  assert.equal(stream.heldBack, 0);
});

test("a chunk that ends like the start of a secret is held back", () => {
  const stream = new RedactingStream([SECRET]);
  const from = stream.push(`ls ${SECRET.slice(0, 5)}`);
  assert.equal(from, "ls ");
  assert.equal(stream.heldBack, 5);
  // If nothing more follows, the flush still makes it visible.
  assert.equal(stream.flush(), SECRET.slice(0, 5));
});

test("short values are ignored — consistent with redactKnownSecrets", () => {
  const stream = new RedactingStream(["kurz"]);
  assert.equal(stream.push("kurz"), "kurz");
  assert.equal(stream.heldBack, 0);
});

test("the held-back amount stays capped, even with a very long secret", () => {
  const long = "a".repeat(20_000);
  const stream = new RedactingStream([long]);
  stream.push("a".repeat(50_000));
  assert.ok(stream.heldBack <= RedactingStream.MAX_HALT);
});

test("window size is clamped to sensible limits", () => {
  const checkSize = (cols: unknown, rows: unknown) => terminalSizeSchema.parse({ cols, rows });
  assert.deepEqual(checkSize(120, 40), { cols: 120, rows: 40 });
  assert.deepEqual(checkSize(0, 0), { cols: 8, rows: 4 });
  assert.deepEqual(checkSize(99_999, 99_999), { cols: 500, rows: 300 });
  assert.deepEqual(checkSize("80", null), { cols: 80, rows: 24 });
  assert.deepEqual(checkSize(Number.NaN, Number.POSITIVE_INFINITY), { cols: 80, rows: 24 });
  assert.deepEqual(terminalSizeSchema.parse({}), { cols: 80, rows: 24 });
});

test("session ids are long and distinct", () => {
  const a = ExecSessions.newId();
  const b = ExecSessions.newId();
  assert.equal(a.length, 64);
  assert.notEqual(a, b);
});

test("a foreign session is not reachable", () => {
  const sessions = new ExecSessions(2);
  sessions.register(sessionFake("s1", "marwin"));
  assert.equal(sessions.fetch("s1", "marwin")?.id, "s1");
  // The same answer as for an unknown id — no status difference through
  // which valid ids could be confirmed.
  assert.equal(sessions.fetch("s1", "florian"), null);
  assert.equal(sessions.fetch("s2", "marwin"), null);
});

test("the number of concurrent sessions is capped", () => {
  const sessions = new ExecSessions(2);
  assert.equal(sessions.isFull(), false);
  sessions.register(sessionFake("s1", "a"));
  sessions.register(sessionFake("s2", "a"));
  assert.equal(sessions.isFull(), true);
  sessions.remove("s1");
  assert.equal(sessions.isFull(), false);
  assert.equal(sessions.count, 1);
});
