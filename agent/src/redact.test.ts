import assert from "node:assert/strict";
import test from "node:test";
import { envKeysOf, envPlaintextOf, foreignManagementOf, redactKnownSecrets, splitEnvEntry, toContainerSummary } from "./redact.js";
import type { RawInspect } from "./engine.js";

const raw: RawInspect = {
  Id: "abc",
  Name: "/meinservice",
  Config: {
    Image: "nginx:1.27",
    Env: ["PATH=/usr/bin", "DB_PASSWORD=hunter2-sehr-geheim", "EMPTY=", "NUR_KEY"]
  },
  State: { Status: "running", Running: true, StartedAt: "2026-07-19T10:00:00Z" }
};

test("the summary contains NO env values by default", () => {
  const summary = toContainerSummary(raw);
  assert.equal(summary.env, undefined);
  assert.deepEqual(summary.envKeys, ["PATH", "DB_PASSWORD", "EMPTY", "NUR_KEY"]);
  // The value must not appear anywhere in the serialized object.
  assert.equal(JSON.stringify(summary).includes("hunter2"), false);
});

test("env plaintext only on explicit request", () => {
  const summary = toContainerSummary(raw, { includeEnvPlaintext: true });
  assert.equal(summary.env?.DB_PASSWORD, "hunter2-sehr-geheim");
});

test("the leading slash in the container name is dropped", () => {
  assert.equal(toContainerSummary(raw).name, "meinservice");
});

test("the summary makes an orphaned network namespace recognizable", () => {
  const sourceKey = "/var/run/docker/netns/current";
  const sidecar = toContainerSummary({
    ...raw,
    Id: "sidecar",
    HostConfig: { NetworkMode: "bridge" },
    NetworkSettings: { SandboxKey: sourceKey }
  });
  const consumer = toContainerSummary({
    ...raw,
    Id: "consumer",
    HostConfig: { NetworkMode: "container:sidecar" },
    NetworkSettings: { SandboxKey: "/var/run/docker/netns/old" }
  });

  assert.equal(consumer.networkMode, "container:sidecar");
  assert.equal(sidecar.sandboxKey, sourceKey);
  assert.notEqual(consumer.sandboxKey, sidecar.sandboxKey);
  assert.equal(toContainerSummary(raw).networkMode, null);
  assert.equal(toContainerSummary(raw).sandboxKey, null);
  assert.equal(toContainerSummary({ ...raw, NetworkSettings: { SandboxKey: "" } }).sandboxKey, null);
});

test("the summary carries the three hardening levels, but no details", () => {
  // S9: the rule names may go along with every docker.view, the details
  // (host paths, mount targets) may not — those hang on docker.registry.manage.
  const summary = toContainerSummary({
    ...raw,
    HostConfig: { Binds: ["/var/run/docker.sock:/var/run/docker.sock:ro", "/etc:/hostetc"] }
  });
  assert.deepEqual(summary.hardening.delegationLock, ["docker-socket-mount"]);
  assert.deepEqual(summary.hardening.warning, ["sensitive-host-path"]);
  // json-file without max-size — the default that K4b makes visible.
  assert.ok(summary.hardening.hint.includes("logging-unbounded"));
  // No path in the response.
  assert.equal(JSON.stringify(summary.hardening).includes("/var/run"), false);
  assert.equal(JSON.stringify(summary.hardening).includes("/etc"), false);
});

test("an unresolvable volume locks delegation without leaking the name", () => {
  const summary = toContainerSummary(raw, { unresolvedVolumes: ["proj_hostroot-geheim"] });
  assert.deepEqual(summary.hardening.delegationLock, ["volume-unresolved"]);
  assert.equal(JSON.stringify(summary).includes("proj_hostroot-geheim"), false);
});

test("a key that itself looks like a token is shortened", () => {
  const token = "a".repeat(60);
  assert.deepEqual(envKeysOf([`${token}=x`]), [`${token.slice(0, 8)}…`]);
});

test("splitEnvEntry handles values with = correctly", () => {
  assert.deepEqual(splitEnvEntry("URL=postgres://u:p@h/db?x=1"), {
    key: "URL",
    value: "postgres://u:p@h/db?x=1"
  });
  assert.deepEqual(splitEnvEntry("OHNE_WERT"), { key: "OHNE_WERT", value: "" });
});

test("envPlaintextOf keeps empty values", () => {
  assert.deepEqual(envPlaintextOf(["A=", "B=1"]), { A: "", B: "1" });
});

test("known secrets are removed from text", () => {
  const text = "verbinde mit hunter2-sehr-geheim ... fehlgeschlagen";
  const out = redactKnownSecrets(text, ["hunter2-sehr-geheim"]);
  assert.equal(out.includes("hunter2"), false);
  assert.ok(out.includes("••••"));
});

test("very short secrets are NOT replaced", () => {
  // Otherwise a value like "1" breaks up every text without protecting anything.
  const text = "port 1 von 10";
  assert.equal(redactKnownSecrets(text, ["1"]), text);
});

test("redactKnownSecrets replaces all occurrences", () => {
  const out = redactKnownSecrets("x geheimwert y geheimwert", ["geheimwert"]);
  assert.equal(out.includes("geheimwert"), false);
});

// --- Compose membership (tree view, user request 2026-07-26) ----------------

test("the summary carries project and service from the compose labels", () => {
  const summary = toContainerSummary({
    ...raw,
    Config: { ...raw.Config, Labels: { "com.docker.compose.project": "edge", "com.docker.compose.service": "traefik" } }
  });
  assert.deepEqual(summary.compose, { project: "edge", service: "traefik" });
});

test("without compose labels the membership is null, not an empty object", () => {
  assert.equal(toContainerSummary(raw).compose, null);
});

test("half an anchor does not count: only project without service is null", () => {
  // Otherwise a group without a service name would come into being — it would
  // look like membership, but could neither be labelled nor assigned.
  const summary = toContainerSummary({
    ...raw,
    Config: { ...raw.Config, Labels: { "com.docker.compose.project": "edge" } }
  });
  assert.equal(summary.compose, null);
});

test("ONLY project and service travel along from the labels", () => {
  const summary = toContainerSummary({
    ...raw,
    Config: {
      ...raw.Config,
      Labels: {
        "com.docker.compose.project": "edge",
        "com.docker.compose.service": "traefik",
        "traefik.http.middlewares.auth.basicauth.users": "admin:$apr1$geheim"
      }
    }
  });
  assert.equal(JSON.stringify(summary).includes("geheim"), false);
});

// --- External management (S23) ----------------------------------------------

test("foreignManagementOf recognizes a container run by Unraid", () => {
  assert.deepEqual(foreignManagementOf({ "net.unraid.docker.managed": "dockerman" }), {
    manager: "unraid"
  });
});

test("foreignManagementOf reports nothing for an ordinary container", () => {
  assert.equal(foreignManagementOf({ "com.docker.compose.project": "arr_stack" }), null);
  assert.equal(foreignManagementOf({}), null);
  assert.equal(foreignManagementOf(null), null);
  // An empty value is not a claim.
  assert.equal(foreignManagementOf({ "net.unraid.docker.managed": "  " }), null);
});

test("the summary classifies the mutability of the running ref", () => {
  const summary = toContainerSummary({
    Id: "abc",
    Name: "/web",
    Config: { Image: "nginx:latest", Env: [] },
    State: { Status: "running", Running: true }
  } as never);
  assert.equal(summary.imageMutability, "floating");

  const pinned = toContainerSummary({
    Id: "def",
    Name: "/api",
    Config: { Image: `ghcr.io/u/app@sha256:${"a".repeat(64)}`, Env: [] },
    State: { Status: "running", Running: true }
  } as never);
  assert.equal(pinned.imageMutability, "pinned");
});
