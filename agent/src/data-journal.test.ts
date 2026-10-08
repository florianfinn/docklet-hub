import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DataJournal } from "./data-journal.js";
for (const kind of ["backup", "restore"] as const) test(`K21/K22: ${kind} restart preserves prior state and monotonic extract marker`, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "data-journal-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "pending.json"); const target = { kind: "container", containerName: "demo" } as const;
  const journal = new DataJournal(file);
  journal.begin(target, { Id: "original", Name: "/demo", State: { Running: true, Paused: true } }, kind);
  const reopened = new DataJournal(file);
  assert.equal(reopened.read()[0].paused, true); assert.equal(reopened.read()[0].running, true);
  assert.equal(reopened.read()[0].extractStarted, false);
  reopened.extracting(target); assert.equal(new DataJournal(file).read()[0].extractStarted, true);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  reopened.complete(target); assert.deepEqual(reopened.read(), []);
  await fs.writeFile(file, "{}"); assert.throws(() => reopened.read(), /data-journal-invalid/);
});
test("R2: begin refuses overlapping backup and restore operations without changing the original state", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "data-journal-overlap-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const journal = new DataJournal(path.join(root, "pending.json")); const target = { kind: "container", containerName: "demo" } as const;
  journal.begin(target, { Id: "original", Name: "/demo", State: { Running: true, Paused: true } }, "restore");
  journal.extracting(target); const initial = journal.read();
  for (const kind of ["backup", "restore"] as const) assert.throws(() => journal.begin(target, { Id: "stopped", Name: "/demo", State: { Running: false } }, kind), /data-operation-pending/);
  assert.deepEqual(journal.read(), initial);
  journal.complete(target); journal.begin(target, { Id: "original", Name: "/demo", State: { Running: true } }, "backup");
  assert.equal(journal.read()[0].running, true);
});
