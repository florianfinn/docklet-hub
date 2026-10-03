import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRegistry, type RegistryEntry } from "./registry.js";

function tempFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-registry-")), "registry.json");
}

const entry = {
  containerId: "abc123",
  containerName: "minecraft",
  imageRef: "itzg/minecraft-server@sha256:feed",
  allowed: true,
  secured: false
};

test("a missing file means an empty allowlist, not 'everything allowed'", () => {
  const registry = new AgentRegistry(path.join(os.tmpdir(), "gibt-es-nicht", "registry.json"));
  assert.equal(registry.size(), 0);
  assert.equal(registry.isAllowed("abc123"), false);
  assert.deepEqual(registry.allowedIds(), []);
});

test("a broken file does not lead to 'everything allowed' either", () => {
  const file = tempFile();
  fs.writeFileSync(file, "{kein valides json", "utf8");
  const registry = new AgentRegistry(file);
  assert.equal(registry.size(), 0);
  assert.equal(registry.isAllowed("abc123"), false);
});

test("entries survive a restart", () => {
  const file = tempFile();
  new AgentRegistry(file).replaceAll([entry]);
  const again = new AgentRegistry(file);
  assert.equal(again.isAllowed("abc123"), true);
  assert.equal(again.expectedImageRef("abc123"), entry.imageRef);
});

test("allowed=false does not count, but stays stored", () => {
  const file = tempFile();
  const registry = new AgentRegistry(file);
  registry.replaceAll([{ ...entry, allowed: false }]);
  assert.equal(registry.isAllowed("abc123"), false);
  assert.deepEqual(registry.allowedIds(), []);
  assert.equal(registry.expectedImageRef("abc123"), null);
  // The entry still exists — grants in the main API stay valid.
  assert.equal(registry.get("abc123")?.containerName, "minecraft");
});

test("observers may be read, but do not count as a management permission (#78)", () => {
  const file = tempFile();
  new AgentRegistry(file).replaceAll([{ ...entry, allowed: false, observeOnly: true }]);
  const registry = new AgentRegistry(file);
  assert.equal(registry.isObserveOnly("abc123"), true);
  assert.equal(registry.isAllowed("abc123"), false);
  assert.equal(registry.checkAccess("abc123", false), "allowed");
  assert.equal(registry.checkAccess("abc123", true), "observe-only");
  assert.deepEqual(registry.allowedIds(), []);
  assert.equal(registry.expectedImageRef("abc123"), null);
  assert.equal(registry.get("abc123")?.observeOnly, true);
});

test("the observer class takes precedence even with allowed=true", () => {
  const registry = new AgentRegistry(tempFile());
  registry.replaceAll([{ ...entry, observeOnly: true }]);
  assert.equal(registry.isObserveOnly("abc123"), true);
  assert.equal(registry.isAllowed("abc123"), false);
  assert.deepEqual(registry.allowedIds(), []);
  assert.equal(registry.expectedImageRef("abc123"), null);
});

test("a missing or invalid observeOnly grants no observer permission", () => {
  const registry = new AgentRegistry(tempFile());
  registry.replaceAll([
    { ...entry, containerId: "gesperrt", allowed: false },
    { ...entry, containerId: "invalid", allowed: false, observeOnly: "true" } as never
  ]);
  assert.equal(registry.isObserveOnly("gesperrt"), false);
  assert.equal(registry.isAllowed("gesperrt"), false);
  assert.equal(registry.checkAccess("gesperrt", false), "not-allowlisted");
  assert.equal(registry.checkAccess("gesperrt", true), "not-allowlisted");
  assert.equal(registry.get("invalid"), null);
});

test("externally managed entries stay controllable, only their definition is locked (#78)", () => {
  const file = tempFile();
  new AgentRegistry(file).replaceAll([{ ...entry, externallyManaged: true }]);
  const registry = new AgentRegistry(file);
  assert.equal(registry.isAllowed("abc123"), true);
  assert.equal(registry.isExternallyManaged("abc123"), true);
  assert.equal(registry.checkAccess("abc123", false), "allowed");
  assert.equal(registry.checkAccess("abc123", true), "allowed");
  assert.equal(registry.checkAccess("abc123", true, true), "externally-managed");
  assert.equal(registry.checkAccess("abc123", false, true), "externally-managed");
  assert.deepEqual(registry.allowedIds(), ["abc123"]);
  assert.equal(registry.get("abc123")?.externallyManaged, true);
});

test("externallyManaged grants nothing without allowed, and observeOnly stays narrower", () => {
  const registry = new AgentRegistry(tempFile());
  registry.replaceAll([
    { ...entry, containerId: "gesperrt", allowed: false, externallyManaged: true },
    { ...entry, containerId: "beobachter", observeOnly: true, externallyManaged: true },
    { ...entry, containerId: "invalid", externallyManaged: "true" } as never
  ]);
  assert.equal(registry.isExternallyManaged("gesperrt"), false);
  assert.equal(registry.checkAccess("gesperrt", false), "not-allowlisted");
  assert.equal(registry.checkAccess("gesperrt", true, true), "not-allowlisted");
  assert.equal(registry.checkAccess("beobachter", true), "observe-only");
  assert.equal(registry.checkAccess("beobachter", true, true), "observe-only");
  assert.equal(registry.get("invalid"), null);
});

test("without externallyManaged a definition action locks nothing", () => {
  const registry = new AgentRegistry(tempFile());
  registry.replaceAll([entry]);
  assert.equal(registry.checkAccess("abc123", true, true), "allowed");
});

test("incomplete entries are discarded instead of half taken over", () => {
  const file = tempFile();
  const registry = new AgentRegistry(file);
  registry.replaceAll([
    entry,
    { containerId: "ohne-rest" } as never,
    { containerId: "", containerName: "x", imageRef: "y", allowed: true } as never
  ]);
  assert.equal(registry.size(), 1);
  assert.equal(registry.isAllowed("abc123"), true);
});

test("an entry without secured (older file) counts as normal, not broken (stage 5e)", () => {
  const file = tempFile();
  // A file written before 5e does not know the field. It must not be
  // discarded — otherwise half the allowlist drops away on the first deploy.
  fs.writeFileSync(
    file,
    JSON.stringify([{ containerId: "abc123", containerName: "minecraft", imageRef: "x:1", allowed: true }]),
    "utf8"
  );
  const registry = new AgentRegistry(file);
  assert.equal(registry.isAllowed("abc123"), true);
  assert.equal(registry.get("abc123")?.secured, false);
});

test("a non-boolean secured value is a shape error and is discarded", () => {
  const file = tempFile();
  fs.writeFileSync(
    file,
    JSON.stringify([{ ...entry, secured: "ja" }]),
    "utf8"
  );
  const registry = new AgentRegistry(file);
  assert.equal(registry.size(), 0);
});

test("secured=true survives a restart (stage 5e)", () => {
  const file = tempFile();
  new AgentRegistry(file).replaceAll([{ ...entry, secured: true }]);
  assert.equal(new AgentRegistry(file).get("abc123")?.secured, true);
});

test("replaceAll replaces completely instead of adding", () => {
  const file = tempFile();
  const registry = new AgentRegistry(file);
  registry.replaceAll([entry]);
  registry.replaceAll([{ ...entry, containerId: "neu" }]);
  // A container removed from the allowlist really has to be gone.
  assert.equal(registry.isAllowed("abc123"), false);
  assert.equal(registry.isAllowed("neu"), true);
});

test("several stack ids are moved in one batch", () => {
  const file = tempFile();
  const registry = new AgentRegistry(file);
  registry.replaceAll([
    { ...entry, containerId: "alt-web", containerName: "web" },
    { ...entry, containerId: "alt-db", containerName: "db" }
  ]);

  assert.equal(
    registry.replaceContainerIds(new Map([
      ["alt-web", "neu-web"],
      ["alt-db", "neu-db"]
    ])),
    true
  );
  assert.equal(registry.isAllowed("alt-web"), false);
  assert.equal(registry.isAllowed("alt-db"), false);
  assert.equal(registry.get("neu-web")?.containerName, "web");
  assert.equal(registry.get("neu-db")?.containerName, "db");

  const again = new AgentRegistry(file);
  assert.equal(again.isAllowed("neu-web"), true);
  assert.equal(again.isAllowed("neu-db"), true);
});

test("a batch with a target collision does not change the registry", () => {
  const file = tempFile();
  const registry = new AgentRegistry(file);
  registry.replaceAll([
    { ...entry, containerId: "alt", containerName: "alt" },
    { ...entry, containerId: "belegt", containerName: "belegt" }
  ]);

  assert.equal(registry.replaceContainerIds(new Map([["alt", "belegt"]])), false);
  assert.equal(registry.isAllowed("alt"), true);
  assert.equal(registry.get("belegt")?.containerName, "belegt");
});

test("compose entries are grouped by path, fixed project name and file", () => {
  const registry = new AgentRegistry(tempFile());
  const compose = {
    projectDir: "/home/docker/homepage",
    projectName: "homepage-prod",
    serviceName: "web",
    composeFileName: "compose.yaml",
    origin: "adopted" as const
  };
  registry.replaceAll([
    { ...entry, containerId: "web", compose },
    { ...entry, containerId: "db", compose: { ...compose, serviceName: "db" } },
    { ...entry, containerId: "fremd", compose: { ...compose, projectName: "homepage-test" } }
  ]);

  assert.deepEqual(
    registry
      .entriesForCompose("/home/docker/homepage", "homepage-prod", "compose.yaml")
      .map((value) => value.containerId)
      .sort(),
    ["db", "web"]
  );
});

// v0.18.1: the file on the volume comes from an agent BEFORE v0.17.0 and carries
// `freigaben`, `freigabePfad` and `compose.herkunft`. Found live on
// 2026-09-04: 13 entries in the file, 6 loaded — every entry with a
// compose anchor dropped out, and all shares were missing.
test("an allowlist file with the old keys is loaded completely (v0.18.1)", () => {
  const file = tempFile();
  fs.writeFileSync(
    file,
    JSON.stringify([
      {
        containerId: "alt111",
        containerName: "homepage",
        imageRef: "ghcr.io/x/homepage:1",
        allowed: true,
        secured: false,
        "freigaben": ["/home/docker/homepage/config"],
        "freigabePfad": "/home/docker/homepage/data",
        compose: {
          projectDir: "/home/docker/homepage",
          serviceName: "homepage",
          composeFileName: "docker-compose.yml",
          "herkunft": "adoptiert"
        }
      },
      {
        containerId: "alt222",
        containerName: "adguardhome",
        imageRef: "adguard/adguardhome:v0.107",
        allowed: true,
        secured: true
      }
    ]),
    "utf8"
  );
  const registry = new AgentRegistry(file);
  assert.equal(registry.size(), 2, "both entries must be loaded, including the one with a compose anchor");
  const loaded = registry.get("alt111");
  assert.deepEqual(loaded?.shares, ["/home/docker/homepage/config", "/home/docker/homepage/data"]);
  assert.equal(loaded?.compose?.origin, "adopted");
  assert.equal("freigaben" in (loaded ?? {}), false);

  // Only the new form is written — a second start reads it without the
  // transition, and no old key stays behind in the file.
  registry.replaceAll([registry.get("alt111")!, registry.get("alt222")!]);
  const raw = fs.readFileSync(file, "utf8");
  assert.equal(raw.includes("freigaben"), false);
  assert.equal(raw.includes("herkunft"), false);
  assert.equal(raw.includes("adoptiert"), false);
  assert.ok(raw.includes("\"shares\""));
  assert.ok(raw.includes("\"origin\""));
  assert.equal(new AgentRegistry(file).get("alt111")?.compose?.origin, "adopted");
});

// #80: `compose.origin` is the ONLY value of this agent that the caller not
// only reads but SENDS in every entry of `PUT /registry`. An unknown wording
// makes the whole entry invalid via `isRegistryCompose`, `replaceAll` filters
// it out without an error, and the route still acknowledges with 200 — every
// container locked, without a message. That is why the transition lives in
// `fromLegacyForms` and thus also on the path of `replaceAll`, not only on
// that of `load()`.
test("an 'adoptiert' sent via replaceAll is read and stored as 'adopted' (#80)", () => {
  const file = tempFile();
  const registry = new AgentRegistry(file);
  registry.replaceAll([
    {
      ...entry,
      containerId: "gesendet",
      compose: {
        projectDir: "/home/docker/homepage",
        projectName: "homepage",
        serviceName: "web",
        composeFileName: "compose.yaml",
        // The wording that a version not yet updated sends. Typed as data,
        // because the type no longer knows it.
        origin: "adoptiert"
      } as unknown as RegistryEntry["compose"]
    }
  ]);

  assert.equal(registry.size(), 1, "the entry must NOT be silently filtered out");
  assert.equal(registry.get("gesendet")?.compose?.origin, "adopted");
  assert.equal(fs.readFileSync(file, "utf8").includes("adoptiert"), false, "only the new wording is written");
});

test("an unknown origin wording still makes the entry invalid", () => {
  const registry = new AgentRegistry(tempFile());
  registry.replaceAll([
    {
      ...entry,
      containerId: "unbekannt",
      compose: {
        projectDir: "/home/docker/homepage",
        serviceName: "web",
        composeFileName: "compose.yaml",
        origin: "imported"
      } as unknown as RegistryEntry["compose"]
    }
  ]);
  assert.equal(registry.size(), 0, "no default to 'dashboard' — the writing case must not be reachable by omission");
});

test("if a field is present under both names, the new one wins", () => {
  const file = tempFile();
  fs.writeFileSync(
    file,
    JSON.stringify([
      {
        containerId: "beide1",
        containerName: "x",
        imageRef: "x:1",
        allowed: true,
        shares: ["/neu"],
        "freigaben": ["/alt"]
      }
    ]),
    "utf8"
  );
  assert.deepEqual(new AgentRegistry(file).get("beide1")?.shares, ["/neu"]);
});
