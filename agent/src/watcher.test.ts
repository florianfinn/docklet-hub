import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DockerEngine } from "./engine.js";
import { cosignArguments, loadWatcherConfig, validateRegistry } from "./watcher.js";
import { legacyEnvKeysInUse } from "./request-keys.js";

const DIGEST = `ghcr.io/florianfinn/docklet-hub-agent@sha256:${"c".repeat(64)}`;

test("the defaults cover the regular case without a single environment variable", () => {
  const config = loadWatcherConfig({});
  assert.equal(config.socketPath, "/var/run/docker.sock");
  assert.equal(config.stateDirectory, "/state/selbstupdate");
  assert.equal(config.cosignImage, "ghcr.io/sigstore/cosign/cosign:v3.1.3");
  assert.equal(config.signatureIssuer, "https://token.actions.githubusercontent.com");
  // Without a mounted Docker configuration cosign runs without a login — the
  // state when the package is public. The pull itself needs no configuration
  // value here: which login the CLI uses is in the environment as
  // DOCKER_CONFIG and is read by the CLI itself.
  assert.equal(config.dockerConfigHostPath, null);
});

test("unusable numeric values fall back to the default instead of becoming 0", () => {
  // A tick of 0 would be an endless loop without a pause, a start deadline of 0
  // a gate that rolls back every healthy agent.
  const config = loadWatcherConfig({
    DOCKER_AGENT_WATCHER_TICK_MS: "0",
    DOCKER_AGENT_WATCHER_START_DEADLINE_MS: "later"
  });
  assert.equal(config.tickMs, 2000);
  assert.equal(config.startDeadlineMs, 120_000);
});

// TRANSITION (v0.18.0): the seven keys are under their old name in the
// hosts' compose files. If the fallback goes away, a watcher there silently
// runs with default values — and the signature check with the wrong
// identity.
test("the old environment keys are still read, the new one takes precedence", () => {
  const legacy = loadWatcherConfig({
    "DOCKER_AGENT_SELBSTUPDATE_DIR": "/alt/state",
    "DOCKER_AGENT_WATCHER_TAKT_MS": "7",
    "DOCKER_AGENT_WATCHER_STARTFRIST_MS": "9",
    "DOCKER_AGENT_SIGNATUR_ISSUER": "https://issuer.example",
    "DOCKER_AGENT_SIGNATUR_IDENTITAET": "https://identity.example/",
    "DOCKER_AGENT_DOCKERCFG_HOST_PFAD": "/alt/.docker",
    "DOCKER_AGENT_WATCHER_PRUEFTAKT_MS": "11"
  });
  assert.equal(legacy.stateDirectory, "/alt/state");
  assert.equal(legacy.tickMs, 7);
  assert.equal(legacy.startDeadlineMs, 9);
  assert.equal(legacy.signatureIssuer, "https://issuer.example");
  assert.equal(legacy.identityPrefix, "https://identity.example/");
  assert.equal(legacy.dockerConfigHostPath, "/alt/.docker");
  assert.equal(legacy.checkTickMs, 11);

  const both = loadWatcherConfig({ "DOCKER_AGENT_WATCHER_TAKT_MS": "7", DOCKER_AGENT_WATCHER_TICK_MS: "3" });
  assert.equal(both.tickMs, 3);
  assert.deepEqual(legacyEnvKeysInUse({ "DOCKER_AGENT_WATCHER_TAKT_MS": "7", DOCKER_AGENT_WATCHER_TICK_MS: "3" }), []);
  assert.deepEqual(legacyEnvKeysInUse({ "DOCKER_AGENT_WATCHER_TAKT_MS": "7" }), ["DOCKER_AGENT_WATCHER_TAKT_MS"]);
});

test("cosign checks the digest against the configured identity plus image version", () => {
  const config = loadWatcherConfig({});
  const args = cosignArguments(config, DIGEST, "v0.12.0");

  assert.deepEqual(args.slice(0, 4), ["run", "--rm", "--user", "0"]);
  const identity = args[args.indexOf("--certificate-identity") + 1];
  assert.equal(
    identity,
    "https://github.com/florianfinn/docklet-hub/.github/workflows/release.yml@refs/tags/v0.12.0"
  );
  // The digest is checked, not the moving tag — otherwise the check would
  // say nothing about what was actually fetched.
  assert.equal(args.at(-1), DIGEST);
  // Without a configured Docker config none is mounted either.
  assert.equal(args.includes("-v"), false);
});

test("the repository of the identity comes from the configuration, not from the image", () => {
  // The difference to the version label: an image can claim to come from a
  // foreign repository and be signed with its workflow. The check would then
  // run against the attacker's identity and pass.
  const config = loadWatcherConfig({
    DOCKER_AGENT_SIGNATURE_IDENTITY:
      "https://github.com/anderer/pfad/.github/workflows/release.yml@refs/tags/"
  });
  const args = cosignArguments(config, DIGEST, "v1.0.0");
  assert.equal(
    args[args.indexOf("--certificate-identity") + 1],
    "https://github.com/anderer/pfad/.github/workflows/release.yml@refs/tags/v1.0.0"
  );
});

test("a configured Docker configuration is mounted read-only", () => {
  const config = loadWatcherConfig({ DOCKER_AGENT_DOCKERCFG_HOST_PATH: "/home/codex/.docker" });
  const args = cosignArguments(config, DIGEST, "v0.12.0");
  assert.ok(args.includes("-e"));
  assert.ok(args.includes("DOCKER_CONFIG=/dockercfg"));
  assert.equal(args[args.indexOf("-v") + 1], "/home/codex/.docker:/dockercfg:ro");
});

// --- The upfront question to the registry (#36, cut 2b) ---------------------

function configWith(dockerConfigPath: string | null): ReturnType<typeof loadWatcherConfig> {
  return { ...loadWatcherConfig({}), dockerConfigPath };
}

/** Only the one method that matters here — plus recording. */
function engineFake(digest: string | null) {
  const seen: { ref: string; auth: unknown }[] = [];
  const engine = {
    async remoteManifestDigest(ref: string, auth?: unknown) {
      seen.push({ ref, auth });
      return digest;
    }
  } as unknown as DockerEngine;
  return { engine, seen };
}

function writeDockerConfig(content: unknown): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-dockercfg-"));
  fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify(content), "utf8");
  return directory;
}

test("the login from the mounted configuration travels along with the registry question", async (t) => {
  // ⚠️ That is the whole point of 2b. Without this header the daemon asks
  // anonymously, and GHCR answers `unauthorized` for a private package —
  // measured live on the proxy, and the reason why the update display in the
  // dashboard permanently showed "not determinable" on all three hosts.
  const directory = writeDockerConfig({
    auths: { "ghcr.io": { auth: Buffer.from("florianfinn:ghp_x", "utf8").toString("base64") } }
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const { engine, seen } = engineFake(`sha256:${"a".repeat(64)}`);
  const finding = await validateRegistry(
    engine,
    configWith(directory),
    "ghcr.io/florianfinn/docklet-hub-agent:latest"
  );

  assert.deepEqual(seen[0]?.auth, {
    username: "florianfinn",
    password: "ghp_x",
    serverAddress: "ghcr.io"
  });
  assert.equal(finding.remoteDigest, `sha256:${"a".repeat(64)}`);
  assert.equal(finding.reason, null);
  assert.equal(finding.imageRef, "ghcr.io/florianfinn/docklet-hub-agent:latest");
});

test("without a configuration the question is still asked — and the failure named", async () => {
  // For a public package the registry also answers anonymously. Only when
  // NOTHING comes back is the missing login the information the operator
  // needs — "no digest" alone would be none.
  const { engine, seen } = engineFake(null);
  const finding = await validateRegistry(
    engine,
    configWith(null),
    "ghcr.io/florianfinn/docklet-hub-agent:latest"
  );

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.auth, undefined);
  assert.equal(finding.remoteDigest, null);
  assert.equal(finding.reason, "no-login:no-configuration");
});

test("an unreadable ref does not even ask the registry", async () => {
  const { engine, seen } = engineFake("sha256:egal");
  const finding = await validateRegistry(engine, configWith(null), "::kaputt::");
  assert.equal(seen.length, 0);
  assert.equal(finding.reason, "image-ref-unreadable");
  assert.equal(finding.remoteDigest, null);
});
