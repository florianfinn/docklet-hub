import assert from "node:assert/strict";
import test from "node:test";
import {
  NO_PROJECT_CONFIRMATIONS,
  projectAnswered,
  projectBlockerOf,
  projectInputOf
} from "../src/features/compose/project-state.ts";

// The confirmations of a new project (#3) as pure logic: the agent compares
// every list for exact set equality, so a stale tick blocks like a missing one.

const PREVIEW = {
  projectDir: "/home/docker/notes",
  stackName: "notes",
  valid: true,
  reason: null,
  errors: [],
  configError: null,
  services: ["app", "db"],
  imagesByService: { app: "example/notes:1.0", db: "example/db:2" },
  missingImages: ["example/db:2"],
  servicesWithoutImage: [],
  mountSources: [],
  externalSources: ["/mnt/user/media"]
};

const ALL = {
  services: new Set(["app", "db"]),
  images: new Set(["example/db:2"]),
  external: new Set(["/mnt/user/media"]),
  hardening: new Set()
};

test("a name and a fresh check come first", () => {
  assert.deepEqual(projectBlockerOf("  ", PREVIEW, true, ALL), { reason: "name-missing" });
  assert.deepEqual(projectBlockerOf("notes", null, false, ALL), { reason: "not-previewed" });
  assert.deepEqual(projectBlockerOf("notes", PREVIEW, false, ALL), { reason: "not-previewed" });
  assert.deepEqual(projectBlockerOf("notes", { ...PREVIEW, valid: false }, true, ALL), { reason: "invalid" });
});

test("every service, missing image and external source must be confirmed", () => {
  assert.deepEqual(projectBlockerOf("notes", PREVIEW, true, NO_PROJECT_CONFIRMATIONS), {
    reason: "unconfirmed-services",
    missing: ["app", "db"]
  });
  assert.deepEqual(projectBlockerOf("notes", PREVIEW, true, { ...ALL, images: new Set() }), {
    reason: "unconfirmed-images",
    missing: ["example/db:2"]
  });
  assert.deepEqual(projectBlockerOf("notes", PREVIEW, true, { ...ALL, external: new Set() }), {
    reason: "unconfirmed-external",
    missing: ["/mnt/user/media"]
  });
  assert.equal(projectBlockerOf("notes", PREVIEW, true, ALL), null);
});

test("unsurveyed images do not block, and a stale tick does", () => {
  const unsurveyed = { ...PREVIEW, missingImages: null };
  assert.equal(projectBlockerOf("notes", unsurveyed, true, { ...ALL, images: new Set() }), null);
  assert.deepEqual(
    projectBlockerOf("notes", PREVIEW, true, { ...ALL, external: new Set(["/mnt/user/media", "/srv/old"]) }),
    { reason: "stale-confirmation" }
  );
  assert.deepEqual(projectBlockerOf("notes", PREVIEW, true, { ...ALL, services: new Set(["app", "db", "web"]) }), {
    reason: "stale-confirmation"
  });
});

test("the request carries the trimmed name and every list", () => {
  assert.deepEqual(projectInputOf(" notes ", "services: {}\n", ALL), {
    name: "notes",
    content: "services: {}\n",
    confirmNew: ["app", "db"],
    acknowledgeImagePull: ["example/db:2"],
    acknowledgeHardening: [],
    confirmExternalSources: ["/mnt/user/media"]
  });
});

test("a follow-up question takes the agent's list unchanged", () => {
  const external = projectAnswered(NO_PROJECT_CONFIRMATIONS, { kind: "external-sources", sources: ["/srv/media"] });
  assert.deepEqual([...(external?.external ?? [])], ["/srv/media"]);
  const hardening = projectAnswered(ALL, { kind: "hardening", newViolations: ["app:privileged"], rolledBack: true });
  assert.deepEqual([...(hardening?.hardening ?? [])], ["app:privileged"]);
  assert.deepEqual([...(hardening?.external ?? [])], ["/mnt/user/media"]);
  const services = projectAnswered(NO_PROJECT_CONFIRMATIONS, { kind: "services", added: ["app"], removed: [] });
  assert.deepEqual([...(services?.services ?? [])], ["app"]);
  assert.equal(projectAnswered(ALL, { kind: "start-failed", detail: "x", rolledBack: true }), null);
});
