import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryArchive } from "./archive-test-support.js";
import type { RawInspect } from "./engine.js";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "file-access-runtime-"));
Object.assign(process.env, {
  DOCKER_AGENT_SECRET: "s".repeat(64), DOCKER_AGENT_BIND_BASE_PATH: base,
  DOCKER_AGENT_REGISTRY_FILE: path.join(base, "state/registry.json"),
  DOCKER_AGENT_AUDIT_FILE: path.join(base, "state/audit.jsonl"),
  DOCKER_AGENT_MONITOR_FILE: path.join(base, "state/monitor.json")
});
const { engine, registry } = await import("./runtime/state.js");
const { fileSources } = await import("./runtime/file-sources.js");
const { checkWebftpAccess } = await import("./runtime/access.js");
after(() => fs.rmSync(base, { recursive: true, force: true }));

type Mounts = Array<NonNullable<RawInspect["Mounts"]>[number] & { Mode?: string; Propagation?: string }>;
async function fixture(t: TestContext, freshMounts: (mounts: Mounts) => Mounts) {
  const mounts: Mounts = [
    { Type: "volume", Name: "example-data", Source: "/var/lib/docker/volumes/example-data/_data", Destination: "/data", Driver: "local", Mode: "rw", RW: true, Propagation: "" },
    { Type: "bind", Source: "/srv/example/share", Destination: "/share", Mode: "rw", RW: true, Propagation: "rprivate" },
    { Type: "bind", Source: "/srv/example/external", Destination: "/ext", Mode: "rw", RW: true, Propagation: "rprivate" }
  ];
  const raw: RawInspect = { Id: "target", Name: "/example-app", Config: { Image: "example/app:1.0" }, Mounts: mounts };
  registry.replaceAll([{ containerId: "target", containerName: "example-app", imageRef: "example/app:1.0", allowed: true }]);
  t.mock.method(engine, "inspect", async () => raw);
  t.mock.method(engine, "info", async () => ({ DockerRootDir: "/var/lib/docker" }));
  t.mock.method(engine, "listContainerIds", async () => ["target"]);
  t.mock.method(engine, "inspectVolume", async (name: string) => ({ Name: name, Driver: "local", Mountpoint: mounts[0].Source, Options: null }));
  const archive = new MemoryArchive();
  archive.directory("/share"); archive.directory("/ext"); archive.file("/data/value.txt", "volume content");
  t.mock.method(engine, "statArchive", archive.statArchive.bind(archive));
  t.mock.method(engine, "openArchiveStream", archive.openArchiveStream.bind(archive));
  const sources = await fileSources("target", null);
  assert.equal(sources.ok, true);
  if (!sources.ok) throw new Error("fixture sources unavailable");
  const volume = sources.resolved.find((item) => item.source.kind === "volume")!;
  assert.equal(volume.source.readable, true);
  assert.equal(sources.visibleRoots.has(volume.source.sourceId), false);
  let inspections = 0;
  t.mock.method(engine, "inspect", async () => ++inspections < 3 ? raw : { ...raw, Mounts: freshMounts(mounts) });
  return { archive, mounts, access: () => checkWebftpAccess("target", { mutating: false, action: "webftp-read", actor: null, sourceId: volume.source.sourceId }) };
}

test("named volume listing accepts reordered mounts between source discovery and fresh authorization", async (t) => {
  const f = await fixture(t, (mounts) => [mounts[1], mounts[2], mounts[0]]);
  const access = await f.access();
  assert.equal(access.ok, true, JSON.stringify(access));
  if (!access.ok) return;
  const listing = await access.files.list("/data");
  assert.equal(listing.ok, true);
  if (!listing.ok) return;
  assert.deepEqual(listing.list.entries.map((entry) => entry.name), ["value.txt"]);
  assert.equal(f.archive.calls.some((call) => call.method === "GET" && call.id === "target" && call.target === "/data"), true);
  assert.deepEqual(f.mounts.map((mount) => mount.Destination), ["/data", "/share", "/ext"]);
});

test("mount object property order does not change named volume access", async (t) => {
  const f = await fixture(t, (mounts) => mounts.map((mount) => Object.fromEntries(Object.entries(mount).reverse())));
  assert.equal((await f.access()).ok, true);
});

for (const [property, value] of [
  ["Type", "bind"], ["Name", "other-data"], ["Source", "/var/lib/docker/volumes/other-data/_data"],
  ["Destination", "/other-data"], ["Driver", "other-driver"], ["Mode", "ro"], ["RW", false], ["Propagation", "rshared"]
] as const) test(`fresh mount changes to ${property} still reject named volume access`, async (t) => {
  const f = await fixture(t, (mounts) => [mounts[2], { ...mounts[0], [property]: value }, mounts[1]]);
  assert.deepEqual(await f.access(), { ok: false, status: 409, reason: "file-replaced" });
  assert.equal(f.archive.calls.some((call) => call.method === "GET"), false);
});

for (const change of ["added", "removed", "duplicated", "unrelated-changed"] as const)
  test(`a ${change} mount still rejects named volume access`, async (t) => {
    const f = await fixture(t, (mounts) => change === "added" ? [...mounts, { Type: "bind", Source: "/srv/example/extra", Destination: "/extra", RW: true }]
      : change === "removed" ? mounts.slice(0, 2) : change === "duplicated" ? [...mounts, mounts[0]]
        : [mounts[0], { ...mounts[1], RW: false }, mounts[2]]);
    assert.deepEqual(await f.access(), { ok: false, status: 409, reason: "file-replaced" });
    assert.equal(f.archive.calls.some((call) => call.method === "GET"), false);
  });
