import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { daemonGeneration } from "./daemon-generation.js";

test("daemon generation detects boot changes and socket recreation without a daemon", (t) => {
  let boot = "boot-a";
  let inode = 1n;
  let ctime = 10n;
  t.mock.method(fs, "readFileSync", () => boot);
  t.mock.method(fs, "statSync", () => ({ dev: 1n, ino: inode, ctimeNs: ctime, isSocket: () => true }));
  const first = daemonGeneration("/example/docker.sock");
  assert.equal(daemonGeneration("/example/docker.sock"), first);
  boot = "boot-b";
  assert.notEqual(daemonGeneration("/example/docker.sock"), first);
  boot = "boot-a";
  inode = 2n;
  assert.notEqual(daemonGeneration("/example/docker.sock"), first);
  inode = 1n;
  ctime = 11n;
  assert.notEqual(daemonGeneration("/example/docker.sock"), first);
});

test("unavailable generation fails instead of accepting stale intent", (t) => {
  t.mock.method(fs, "readFileSync", () => "boot-a");
  t.mock.method(fs, "statSync", () => ({ isSocket: () => false }));
  assert.throws(() => daemonGeneration("/example/docker.sock"), /generation unavailable/);
});
