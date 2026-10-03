import assert from "node:assert/strict";
import test from "node:test";
import { violationKey } from "./compose-raw.js";
import { selfCheckViolations, type InspectedContainer } from "./hardening.js";
import { externalSourceAcceptances, externalSourcesOf, mountSourcesOf } from "./mount-sources.js";

const Project = "/home/docker/notes";

// The shape `docker compose config --format json` emits: relative sources are
// already resolved against the project directory.
const config = {
  services: {
    app: {
      image: "example/notes:1.0",
      volumes: [
        { type: "bind", source: "/home/docker/notes/data", target: "/data" },
        { type: "bind", source: "/home/docker/notes", target: "/srv", read_only: true },
        { type: "bind", source: "/mnt/user/media", target: "/media", read_only: true },
        { type: "volume", source: "cache", target: "/cache" },
        { type: "volume", target: "/tmp/anon" },
        { type: "tmpfs", target: "/run" }
      ]
    },
    worker: {
      image: "example/notes:1.0",
      volumes: [
        { type: "bind", source: "/mnt/user/media", target: "/media" },
        { type: "bind", source: "/home/docker/notes-backup/../shared", target: "/shared" },
        { type: "volume", source: "library", target: "/library" }
      ]
    }
  },
  volumes: {
    cache: { name: "notes_cache" },
    library: { name: "media-library", external: true }
  }
};

test("each mount is classified by where its data lives", () => {
  assert.deepEqual(mountSourcesOf(config, ["app", "worker"], Project), [
    { service: "app", kind: "project", source: "/home/docker/notes/data", target: "/data", readOnly: false, shared: false },
    { service: "app", kind: "project", source: "/home/docker/notes", target: "/srv", readOnly: true, shared: false },
    { service: "app", kind: "external", source: "/mnt/user/media", target: "/media", readOnly: true, shared: false },
    { service: "app", kind: "volume", source: "notes_cache", target: "/cache", readOnly: false, shared: false },
    { service: "app", kind: "volume", source: null, target: "/tmp/anon", readOnly: false, shared: false },
    { service: "worker", kind: "external", source: "/mnt/user/media", target: "/media", readOnly: false, shared: false },
    { service: "worker", kind: "external", source: "/home/docker/shared", target: "/shared", readOnly: false, shared: false },
    { service: "worker", kind: "volume", source: "media-library", target: "/library", readOnly: false, shared: true }
  ]);
});

test("a neighbour directory with the same prefix is external", () => {
  const sources = mountSourcesOf(
    { services: { app: { volumes: [{ type: "bind", source: "/home/docker/notes2/data", target: "/data" }] } } },
    ["app"],
    Project
  );
  assert.equal(sources[0]?.kind, "external");
});

test("external sources are confirmed once per host path", () => {
  assert.deepEqual(externalSourcesOf(mountSourcesOf(config, ["app", "worker"], Project)), [
    "/home/docker/shared",
    "/mnt/user/media"
  ]);
});

test("unreadable or missing volume lists yield no sources", () => {
  assert.deepEqual(mountSourcesOf(null, ["app"], Project), []);
  assert.deepEqual(mountSourcesOf({ services: { app: { volumes: "x" } } }, ["app"], Project), []);
  assert.deepEqual(mountSourcesOf({ services: { app: { volumes: [{ type: "bind", source: "/x" }] } } }, ["app"], Project), []);
});

test("a confirmed external source accepts exactly its own bind-outside-base finding", () => {
  const sources = mountSourcesOf(
    {
      services: {
        app: {
          volumes: [
            { type: "bind", source: "/mnt/user/media", target: "/media" },
            { type: "bind", source: "/etc/ssl", target: "/ssl", read_only: true },
            { type: "bind", source: "/home/docker/notes/data", target: "/data" }
          ]
        }
      }
    },
    ["app"],
    Project
  );
  const container: InspectedContainer = {
    id: "c1",
    name: "notes-app-1",
    image: "example/notes:1.0",
    privileged: false,
    capAdd: [],
    capDrop: ["ALL"],
    securityOpt: ["no-new-privileges:true"],
    pidMode: "",
    ipcMode: "",
    networkMode: "bridge",
    binds: ["/mnt/user/media:/media", "/etc/ssl:/ssl:ro", "/home/docker/notes/data:/data"],
    devices: [],
    memoryLimitBytes: 0,
    pidsLimit: null,
    cpuLimited: false,
    logDriver: "json-file",
    logOptions: {}
  };
  // The key format of rawOps.violationsOf.
  const findings = selfCheckViolations(container, { bindBasePath: "/home/docker" }).map((violation) =>
    violationKey("app", `${violation.rule} — ${violation.hostPath ?? violation.detail}`)
  );
  const accepted = new Set(externalSourceAcceptances(sources));

  assert.deepEqual(findings.filter((key) => accepted.has(key)), ["app:bind-outside-base — /mnt/user/media"]);
  assert.deepEqual(findings.filter((key) => !accepted.has(key)), ["app:sensitive-host-path — /etc/ssl"]);
});
