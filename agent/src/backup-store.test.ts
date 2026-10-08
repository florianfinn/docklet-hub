import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BACKUP_FREE_RESERVE_BYTES, type BackupOptions } from "contract";
import { BackupStore } from "./backup-store.js";
const target = { kind: "container", containerName: "demo" } as const;
const options: BackupOptions = { mode: "stop", mounts: [{ sourceId: "data", estimatedBytes: 1024 }] };
async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "backup-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let free = BigInt(BACKUP_FREE_RESERVE_BYTES) + 1024n * 1024n * 1024n;
  const store = new BackupStore(directory, async () => free);
  const copy = async () => ({ target: "/data", stream: (async function* () { yield Buffer.alloc(1024); })() });
  return { store, directory, copy, free: (value: bigint) => { free = value; } };
}
test("K20: atomic archives, metadata, modes and stable target retention survive reopening", async (t) => {
  const f = await fixture(t); const ids = [];
  for (let index = 0; index < 4; index++) {
    const entry = await f.store.create(target, options, f.copy); ids.push(entry.backupId);
    const archive = await f.store.archive(target, entry.backupId, "data");
    assert.equal((await fs.stat(archive.file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(archive.file))).mode & 0o777, 0o700);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const reopened = new BackupStore(f.directory);
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
  assert.deepEqual((await reopened.list(target)).map((entry) => entry.backupId), ids.slice(1).reverse());
  assert.deepEqual(await reopened.list({ kind: "container", containerName: "other" }), []);
});
test("K21: unknown size, missing reserve and copy failures never evict complete runs", async (t) => {
  const f = await fixture(t); const first = await f.store.create(target, options, f.copy);
  await assert.rejects(f.store.create(target, { ...options, mounts: [{ sourceId: "data", estimatedBytes: null }] }, f.copy), /backup-size-unavailable/);
  f.free(BigInt(BACKUP_FREE_RESERVE_BYTES) + 1023n);
  let copied = false;
  await assert.rejects(f.store.create(target, options, async () => { copied = true; return f.copy(); }), /backup-space-insufficient/);
  assert.equal(copied, false);
  f.free(BigInt(BACKUP_FREE_RESERVE_BYTES) + 2048n);
  await assert.rejects(f.store.create(target, options, async () => ({ target: "/data", stream: (async function* () {
    yield Buffer.alloc(1024); throw new Error("synthetic copy failure");
  })() })), /backup-copy-failed/);
  assert.deepEqual((await f.store.list(target)).map((entry) => entry.backupId), [first.backupId]);
});
test("K21: disk exhaustion and cancellation during a large stream keep prior backups", async (t) => {
  const f = await fixture(t); const first = await f.store.create(target, options, f.copy);
  const controller = new AbortController(); let chunks = 0;
  await assert.rejects(f.store.create(target, options, async () => ({ target: "/data", stream: (async function* () {
    for (let index = 0; index < 1024; index++) { chunks++; if (index === 500) controller.abort(); yield Buffer.alloc(65536); }
  })() }), controller.signal), /backup-deadline-exceeded/);
  assert.equal(chunks, 501);
  assert.equal((await f.store.list(target))[0].backupId, first.backupId);
  await assert.rejects(f.store.create(target, options, async () => ({ target: "/data", stream: (async function* () {
    yield Buffer.alloc(1024); f.free(BigInt(BACKUP_FREE_RESERVE_BYTES)); yield Buffer.alloc(1024);
  })() })), /backup-space-insufficient/);
});
test("K20: a 64 MiB stream is written incrementally with exact byte accounting", async (t) => {
  const f = await fixture(t); let emitted = 0;
  const entry = await f.store.create(target, { ...options, mounts: [{ sourceId: "data", estimatedBytes: 64 * 1024 * 1024 }] }, async () => ({ target: "/data", stream: (async function* () {
    const chunk = Buffer.alloc(65536, 42);
    for (let index = 0; index < 1024; index++) { emitted++; yield chunk; }
  })() }));
  assert.equal(emitted, 1024); assert.equal(entry.archives[0].bytes, 64 * 1024 * 1024);
});
