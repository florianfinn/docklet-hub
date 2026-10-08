import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DataJournal } from "./data-journal.js";
import { recoverDataOperations } from "./data-recovery.js";
import { KeyedMutex } from "./concurrency.js";
for (const kind of ["backup", "restore"] as const) for (const running of [false, true]) test(`K21/K22: recovery restores ${kind} prior running=${running} without extraction or exchange`, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "data-recovery-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "pending.json"); const target = { kind: "container", containerName: "demo" } as const;
  const journal = new DataJournal(file);
  journal.begin(target, { Id: "original", Name: "/demo", State: { Running: running, Paused: running } }, kind);
  if (kind === "restore") journal.extracting(target);
  const trace: string[] = [];
  await recoverDataOperations({ journal: new DataJournal(file), locks: new KeyedMutex(), known: () => ["original"],
    inspect: async () => ({ Id: "original", Name: "/demo", State: { Running: false } }),
    resume: async (raw) => { assert.equal(raw.State!.Running, running); assert.equal(raw.State!.Paused, running); trace.push("resume"); return raw; },
    intentional: () => { trace.push("intent"); return () => trace.push("intent-end"); },
    interrupted: (_target, _id, message) => trace.push(message) });
  assert.deepEqual(trace, ["intent", "resume", kind === "restore" ? "restore-interrupted-after-extract" : "backup-interrupted-before-exchange", "intent-end"]);
  assert.deepEqual(journal.read(), []);
});
for (const failure of ["identity", "registry", "resume"] as const) test(`K21/K22: recovery ${failure} failure retains the durable journal and blocks further work`, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "data-recovery-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const journal = new DataJournal(path.join(root, "pending.json")); const target = { kind: "container", containerName: "demo" } as const;
  journal.begin(target, { Id: "original", Name: "/demo", State: { Running: true } }, "restore");
  let resumed = false; let ended = false;
  await assert.rejects(recoverDataOperations({ journal, locks: new KeyedMutex(), known: () => failure === "registry" ? ["other"] : ["original"],
    inspect: async () => ({ Id: "original", Name: failure === "identity" ? "/other" : "/demo" }),
    resume: async () => { resumed = true; throw new Error("synthetic resume failure"); },
    intentional: () => () => { ended = true; }, interrupted: () => { throw new Error("failed recovery must not complete"); } }));
  assert.equal(resumed, failure === "resume"); assert.equal(ended, failure === "resume"); assert.equal(journal.read().length, 1);
});
