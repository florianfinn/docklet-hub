import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { fileSourcesResponseSchema, type MountSource } from "contract";
import { protectionOf, resolveFileSources } from "./file-sources.js";
import { archivePolicy } from "./archive-test-support.js";
import type { RawInspect } from "./engine-model.js";
function fixture() {
  const inspect: RawInspect = { Id: "target", Name: "/web", Config: { Labels: { "com.docker.compose.service": "web" } }, Mounts: [
    { Type: "bind", Source: "/invisible/project", Destination: "/project", RW: true },
    { Type: "bind", Source: "/invisible/external", Destination: "/data", RW: true },
    { Type: "volume", Name: "data", Source: "/var/lib/docker/volumes/data/_data", Destination: "/volume", RW: true }
  ] };
  const definitions: MountSource[] = inspect.Mounts!.map((mount) => ({ service: "web", kind: mount.Type === "volume" ? "volume" : mount.Destination === "/project" ? "project" : "external", source: mount.Name ?? mount.Source!, target: mount.Destination!, readOnly: false, shared: false }));
  return { containerId: "target", inspect, definitions, projectDir: "/invisible/project", shares: ["public"], containers: [inspect], volumes: new Map([["data", { Name: "data", Driver: "local", Mountpoint: inspect.Mounts![2].Source }]]), policy: archivePolicy, readOnly: false };
}
test("all mount classes are resolved without filesystem access or agent permissions", async (t) => {
  for (const method of ["stat", "access", "realpath"] as const) t.mock.method(fs, method, () => { throw new Error("host filesystem must not be consulted"); });
  const entries = await resolveFileSources(fixture());
  assert.deepEqual(entries.map((entry) => entry.source.kind), ["project", "external", "volume"]);
  assert.equal(entries[0].source.target, "/project/public");
  assert.equal(entries[0].source.source, "public");
  assert.equal(entries.every((entry) => entry.source.writable && entry.source.estimatedBytes === null), true);
  assert.equal(fileSourcesResponseSchema.safeParse({ sources: entries.map((entry) => entry.source) }).success, true);
});
test("project access requires an explicit grant and multiple grants remain clipped", async () => {
  const f = fixture();
  const denied = await resolveFileSources({ ...f, shares: [] });
  assert.equal(denied[0].source.readable, false);
  assert.equal(denied[0].source.writable, false);
  const expanded = await resolveFileSources({ ...f, shares: ["one", "two"] });
  assert.deepEqual(expanded.filter((entry) => entry.source.kind === "project").map((entry) => entry.source.target), ["/project/one", "/project/two"]);
});
test("shared, ambiguous, failed survey and readonly sources deny writing and restore", async () => {
  const f = fixture();
  const shared = await resolveFileSources({ ...f, containers: [...f.containers, { Id: "other", Name: "/other", Mounts: [{ Type: "bind", Source: "/invisible/external/child", Destination: "/other" }] }] });
  assert.equal(shared[1].source.writeBlocker, "source-shared");
  assert.equal(shared[1].source.backupEligible, true);
  assert.equal(shared[1].source.restoreEligible, false);
  for (const variation of [{ containers: null }, { definitions: [] }, { readOnly: true }]) assert.equal((await resolveFileSources({ ...f, ...variation })).some((entry) => entry.source.writable || entry.source.restoreEligible), false);
  const mismatch = await resolveFileSources({ ...f, definitions: f.definitions.map((entry) => ({ ...entry, source: "different" })) });
  assert.equal(mismatch.some((entry) => entry.source.writable), false);
});
test("Docker storage, root, boot and all protected ancestors are readonly", async () => {
  for (const root of ["/var", "/var/lib", "/var/lib/docker", "/var/lib/docker/volumes", "/root", "/boot", "/", "/etc", "/run/docker.sock"])
    assert.equal(await protectionOf(root, archivePolicy), "system", root);
  const custom = { ...archivePolicy, dockerRootDir: "/storage/engine", dockerRootAliases: ["/alias/engine"] };
  for (const root of ["/storage", "/storage/engine", "/storage/engine/volumes", "/alias", "/alias/engine/data"]) assert.equal(await protectionOf(root, custom), "system", root);
});
test("volume devices and known backup aliases cannot bypass protection", async () => {
  const f = fixture();
  const policy = { ...archivePolicy, backupAliases: ["/backup-alias"] };
  for (const [device, protection] of [["/backup", "backup"], ["/backup-alias", "backup"], ["/etc", "system"], ["/agent-state", "agent"], ["/var/lib/docker/volumes", "system"]]) {
    const sources = await resolveFileSources({ ...f, policy, volumes: new Map([["data", { Name: "data", Driver: "local", Options: { device } }]]) });
    assert.equal(sources[2].source.protection, protection);
    assert.equal(sources[2].source.writable || sources[2].source.backupEligible || sources[2].source.restoreEligible, false);
    if (protection === "backup") assert.equal(sources[2].source.readable, false);
  }
});
test("missing policy or unknown volume metadata fail closed without global state", async () => {
  const f = fixture();
  assert.equal(await protectionOf("/safe", undefined as never), "unknown");
  assert.equal((await resolveFileSources({ ...f, policy: undefined as never })).some((entry) => entry.source.writable), false);
  assert.equal((await resolveFileSources({ ...f, volumes: new Map() }))[2].source.writable, false);
  assert.equal((await resolveFileSources({ ...f, volumes: new Map([["data", { Driver: "unknown" }]]) }))[2].source.writable, false);
});
test("manually selected definitions and env file mounts keep protected editing routes", async () => {
  const f = fixture();
  for (const source of ["/invisible/manual.yaml", "/invisible/.env", "/invisible/.env.local"]) {
    const inspect = { ...f.inspect, Mounts: [{ Type: "bind", Source: source, Destination: "/config", RW: true }] };
    const definitions: MountSource[] = [{ service: "web", kind: "external", source, target: "/config", readOnly: false, shared: false }];
    const resolved = await resolveFileSources({ ...f, inspect, definitions, policy: { ...f.policy, blockedFiles: ["/invisible/manual.yaml"] } });
    assert.equal(resolved[0].source.readable || resolved[0].source.writable || resolved[0].source.backupEligible, false);
    assert.equal(resolved[0].source.writeBlocker, "path-blocked");
  }
});

test("protected ancestors and custom Docker roots never grant write or backup capabilities", async () => {
  const f = fixture();
  const policy = { ...f.policy, dockerRootDir: "/storage/engine", dockerRootAliases: ["/alias/engine"] };
  for (const source of ["/var", "/var/lib", "/var/lib/docker", "/var/lib/docker/volumes", "/storage", "/storage/engine", "/storage/engine/volumes", "/alias/engine"]) {
    const inspect = { ...f.inspect, Mounts: [{ Type: "bind", Source: source, Destination: "/data", RW: true }] };
    const definitions: MountSource[] = [{ service: "web", kind: "external", source, target: "/data", readOnly: false, shared: false }];
    const effective = source.startsWith("/var") ? f.policy : policy;
    const entry = (await resolveFileSources({ ...f, inspect, definitions, policy: effective }))[0].source;
    assert.equal(entry.protection, "system", source);
    assert.equal(entry.writable || entry.backupEligible || entry.restoreEligible, false, source);
    assert.equal(entry.writeBlocker, "source-protected", source);
  }
});

test("mount and volume metadata supply socket, state, backup and Docker-root aliases without filesystem reads", async () => {
  const { withMountAliases } = await import("./file-sources.js");
  const original = { ...archivePolicy, backupDirectory: "/state/backup", agentPaths: ["/state"] };
  const policy = withMountAliases(original, [
    { Type: "volume", Name: "state", Source: "/volumes/state", Destination: "/state" },
    { Type: "bind", Source: "/custom/socket", Destination: "/run/docker.sock" },
    { Type: "bind", Source: "/var/lib", Destination: "/alias" }
  ], new Map([["state", { Driver: "local", Options: { device: "/actual/state" } }]]));
  for (const alias of ["/volumes/state/backup", "/actual/state/backup"]) assert.equal(await protectionOf(alias, policy), "backup");
  assert.equal(await protectionOf("/actual/state/other", policy), "agent");
  assert.equal(await protectionOf("/custom/socket", policy), "system");
  assert.equal(await protectionOf("/alias/docker/volumes", policy), "system");
  assert.deepEqual(original.agentPaths, ["/state"]);
});

test("a local bind-backed volume uses its driver source without exposing Docker storage", async () => {
  const f = fixture();
  const source = f.inspect.Mounts![2].Source;
  for (const [device, expected] of [["/safe/data", "none"], ["/var/lib/docker/volumes", "system"]] as const) {
    const entries = await resolveFileSources({ ...f, volumes: new Map([["data", { Name: "data", Driver: "local", Mountpoint: source, Options: { device } }]]) });
    assert.equal(entries[2].source.protection, expected);
    assert.equal(entries[2].source.writable, expected === "none");
  }
});

test("R9/K20: source IDs survive container replacement for binds and named volumes", async () => {
  const original = fixture();
  original.inspect.Config!.Labels!["com.docker.compose.project"] = "demo";
  const before = await resolveFileSources(original);
  const inspect = { ...original.inspect, Id: "replacement" };
  const after = await resolveFileSources({ ...original, containerId: inspect.Id, inspect, containers: [inspect] });
  assert.deepEqual(after.map((item) => item.source.sourceId), before.map((item) => item.source.sourceId));
  const moved = await resolveFileSources({ ...original, inspect: { ...inspect, Name: "/other", Config: { Labels: { "com.docker.compose.project": "other", "com.docker.compose.service": "web" } } } });
  assert.equal(moved.some((item, index) => item.source.sourceId === before[index].source.sourceId), false);
});
