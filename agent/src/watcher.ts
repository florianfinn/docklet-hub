// The watcher (#36): the second container next to the agent, which performs
// the agent's update.
//
// It has NO secret, NO port and NO route. Its entire input is a file in the
// shared `/state` (self-update-state.ts). That is the reason why, despite the
// docker.sock, it has a smaller attack surface than the agent: it cannot be
// addressed from outside.
//
// It is started via its own `command` of the same image — the same pattern as
// the WireGuard sidecar.

import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { DockerEngine } from "./engine.js";
import { parseImageRef } from "./image-ref.js";
import { recreateContainer } from "./recreate.js";
import { executeSelfUpdateFrom, type SelfUpdateOps } from "./self-update.js";
import {
  readStart,
  takeJob,
  finishJob,
  writeAvailable,
  startConfirmed,
  type AvailableFinding
} from "./self-update-state.js";
import { loadRegistration, registryHostOf } from "./registry-login.js";
import { envWithLegacyName, legacyEnvKeysInUse } from "./request-keys.js";
import { localManifestDigest, repoOfRef } from "./update.js";

export type WatcherConfig = {
  socketPath: string;
  stateDirectory: string;
  tickMs: number;
  startDeadlineMs: number;
  cosignImage: string;
  signatureIssuer: string;
  // Prefix of the expected signature identity; the version is appended.
  //
  // ⚠️ The REPOSITORY is fixed here and deliberately NOT read from the image.
  // For the version label reading is harmless — the signature confirms exactly
  // that label, so an image cannot claim a version nobody signed. For the
  // repository that does NOT hold: whoever can write to the registry could
  // place an image with `source=github.com/fremd/repo` and sign it with their
  // own workflow. The check would then run against the attacker's identity and
  // pass. The repository is therefore configuration; only the version comes
  // from the image.
  identityPrefix: string;
  // Host path of a Docker configuration that gets mounted into cosign for
  // access to a private registry. `null` if the package is public — then
  // cosign needs no login.
  //
  // ⚠️ HOST path, not container path: the value goes into a `docker run -v`,
  // and the daemon resolves bind mounts against the host's file system. The
  // path under which THIS container sees the same file is a separate question
  // — it is in the environment as `DOCKER_CONFIG` and is read by the docker
  // CLI itself.
  dockerConfigHostPath: string | null;
  // And this is exactly that: the path under which THIS container sees the
  // configuration. For the pull the CLI reads it itself; for the preliminary
  // question to the registry we read it (registry-login.ts).
  dockerConfigPath: string | null;
  // How often the registry is asked whether something newer sits under the own
  // ref. Deliberately sluggish: the answer changes with releases, not with
  // seconds, and every question is a network trip to the outside.
  checkTickMs: number;
};

const STANDARD_IDENTITY =
  "https://github.com/florianfinn/docklet-hub/.github/workflows/release.yml@refs/tags/";

function number(value: string | undefined, standard: number): number {
  const loaded = Number.parseInt(value ?? "", 10);
  return Number.isFinite(loaded) && loaded > 0 ? loaded : standard;
}

// ⚠️ THE `DOCKER_AGENT_*` NAMES ON THE LEFT ARE NOT IDENTIFIERS BUT
// ENVIRONMENT KEYS — and therefore data. They appear exactly like this in
// `deploy/unraid/docker-compose.yml`, in `deploy/remote-wireguard/
// docker-compose.yml` and in the README table, i.e. in files that live on the
// hosts and are NOT rolled out with this repo.
//
// Whoever renames one of them to English does not change the name of a
// variable but breaks the agreement with the operator: `env.X` is then
// `undefined`, the fallback below kicks in, and the agent keeps running with
// the default. No error, no message, green run — visible only in that a
// configured setting no longer has any effect.
//
// That is why they were deliberately left as they were during the switch to
// English identifiers (#418). A change only works together with the hosts'
// Compose files and a transition that reads BOTH names — that is a package of
// its own, not a by-catch.
export function loadWatcherConfig(env: NodeJS.ProcessEnv): WatcherConfig {
  return {
    socketPath: env.DOCKER_SOCKET_PATH ?? "/var/run/docker.sock",
    stateDirectory: envWithLegacyName(env, "DOCKER_AGENT_SELF_UPDATE_DIR") ?? "/state/selbstupdate",
    tickMs: number(envWithLegacyName(env, "DOCKER_AGENT_WATCHER_TICK_MS"), 2000),
    // Generous: at startup the agent loads the allowlist, checks its own
    // mounts and registers with the hub if necessary. Too tight a deadline
    // would roll back a healthy agent — the most expensive mistake this gate
    // can make.
    startDeadlineMs: number(envWithLegacyName(env, "DOCKER_AGENT_WATCHER_START_DEADLINE_MS"), 120_000),
    cosignImage: env.DOCKER_AGENT_COSIGN_IMAGE ?? "ghcr.io/sigstore/cosign/cosign:v3.1.3",
    signatureIssuer:
      envWithLegacyName(env, "DOCKER_AGENT_SIGNATURE_ISSUER") ?? "https://token.actions.githubusercontent.com",
    identityPrefix: envWithLegacyName(env, "DOCKER_AGENT_SIGNATURE_IDENTITY") ?? STANDARD_IDENTITY,
    dockerConfigHostPath: envWithLegacyName(env, "DOCKER_AGENT_DOCKERCFG_HOST_PATH")?.trim() || null,
    dockerConfigPath: env.DOCKER_CONFIG?.trim() || null,
    checkTickMs: number(envWithLegacyName(env, "DOCKER_AGENT_WATCHER_CHECK_TICK_MS"), 15 * 60_000)
  };
}

// The argument list for cosign. Extracted and exported because exactly this
// line carries the promise of the whole sequence — it belongs under test, not
// inside a loop.
export function cosignArguments(
  config: WatcherConfig,
  digestRef: string,
  version: string
): string[] {
  const args = ["run", "--rm", "--user", "0"];
  if (config.dockerConfigHostPath) {
    args.push("-e", "DOCKER_CONFIG=/dockercfg", "-v", `${config.dockerConfigHostPath}:/dockercfg:ro`);
  }
  args.push(
    config.cosignImage,
    "verify",
    "--certificate-oidc-issuer",
    config.signatureIssuer,
    "--certificate-identity",
    `${config.identityPrefix}${version}`,
    digestRef
  );
  return args;
}

// The preliminary question to the registry: is there currently a different
// digest under our own ref than the one we have here?
//
// ⚠️ This question is asked by the WATCHER and not the agent, and that is the
// whole content of #36 cut 2b. The agent asks via the engine API, and that
// asks without credentials — for a private package GHCR then answers
// `unauthorized`, which is why the display in the dashboard permanently showed
// "not determinable" on all three hosts. The watcher has the `config.json`
// mounted anyway; it asks the same question WITH credentials and stores the
// answer in the shared `/state`.
//
// The agent thus gets the information but NOT the token. That is the reason
// for the detour via the file: it is not supposed to hold a registry token it
// needs for none of its tasks.
//
// ⚠️ The question goes through the ENGINE API and not directly to the
// registry. That is not a detour but a prerequisite: the watcher runs with
// `network_mode: none` and has no route to the outside at all itself. The
// daemon takes that route — all it needs is the header we give it.
export async function validateRegistry(
  engine: DockerEngine,
  config: WatcherConfig,
  imageRef: string
): Promise<AvailableFinding> {
  const checkedAt = new Date().toISOString();
  const parsedRef = parseImageRef(imageRef);
  if (!parsedRef) {
    return { imageRef, remoteDigest: null, checkedAt, reason: "image-ref-unreadable" };
  }
  const registration = loadRegistration(config.dockerConfigPath, registryHostOf(repoOfRef(imageRef)));
  // Without credentials the question is asked anyway: for a public package the
  // registry also answers anonymously, and then an answer is better than an
  // error message about a missing file.
  const digest = await engine.remoteManifestDigest(
    parsedRef.fullRef,
    registration.ok ? registration.auth : undefined
  );
  return {
    imageRef,
    remoteDigest: digest,
    checkedAt,
    reason: digest
      ? null
      : registration.ok
        ? "registry-no-response"
        : `no-login:${registration.reason}`
  };
}

function executeFrom(file: string, args: string[], timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (failure, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      // No reject: a non-zero return value is a statement here ("signature
      // does not match") and not a malfunction.
      resolve({ code: failure ? 1 : 0, output });
    });
  });
}

export function buildOps(
  engine: DockerEngine,
  config: WatcherConfig,
  ownRepo: string | null
): SelfUpdateOps {
  return {
    // ⚠️ Via the docker CLI and NOT via the engine API — the only difference
    // that matters here.
    //
    // The Docker DAEMON has no credentials. They live in the `config.json` of
    // the user who invokes the CLI (the one-time `docker login` from the
    // README); the CLI reads them and attaches them as `X-Registry-Auth` to
    // the request it then sends to the daemon. A call directly against
    // `/images/create` — which is how the agent pulls for managed containers
    // — lacks this header and therefore pulls ANONYMOUSLY. With a public image
    // that goes unnoticed; measured on the proxy, GHCR answers `unauthorized`
    // for this package.
    //
    // The CLI is in the image anyway (Dockerfile: docker-cli), and which login
    // it uses is in the environment as `DOCKER_CONFIG`. So the watcher needs
    // NO token of its own: it pulls with the same login the host has been
    // using since its first deploy.
    async pull(imageRef) {
      const parsedRef = parseImageRef(imageRef);
      if (!parsedRef) throw new Error(`image ref unreadable: ${imageRef}`);
      if (ownRepo && repoOfRef(imageRef) !== ownRepo) {
        // The watcher swaps in only its OWN image. Against a taken-over agent
        // that is no barrier — it holds the socket anyway — but it prevents
        // the watcher from becoming a second, more convenient route there.
        throw new Error(`foreign repository rejected: ${repoOfRef(imageRef)}`);
      }
      const { code, output } = await executeFrom("docker", ["pull", "--quiet", parsedRef.fullRef], 10 * 60_000);
      if (code !== 0) {
        throw new Error(output.split("\n").slice(-2).join(" ").slice(0, 400) || "docker pull failed");
      }
    },
    async imageId(imageRef) {
      return engine.imageId(imageRef);
    },
    async imageFinding(imageId, imageRef) {
      const raw = await engine.inspectImage(imageId);
      const version = raw?.Config?.Labels?.["org.opencontainers.image.version"] ?? null;
      // The digest comes from the RepoDigests of the PULLED image, not from
      // asking the registry again: between pull and check something else could
      // otherwise hide behind `:latest`, and the image verified would then be
      // one that is not even here.
      const digest = localManifestDigest(raw?.RepoDigests, imageRef);
      return {
        version: typeof version === "string" ? version : null,
        digestRef: digest ? `${repoOfRef(imageRef)}@${digest}` : null
      };
    },
    async checkSignature(digestRef, version) {
      const args = cosignArguments(config, digestRef, version);
      const { code, output } = await executeFrom("docker", args, 5 * 60_000);
      if (code === 0) return { ok: true, reason: null };
      return { ok: false, reason: output.split("\n").slice(-3).join(" ").slice(0, 400) || "cosign failed" };
    },
    async inspect(containerId) {
      return engine.inspect(containerId);
    },
    async swap(raw, imageRef, expectedImageId) {
      const result = await recreateContainer(engine, raw, {
        imageRef,
        expectedImageId: expectedImageId
      });
      return result.newContainerId;
    },
    async waitForStart(expectedVersion, sinceMs) {
      const deadline = Date.now() + config.startDeadlineMs;
      while (Date.now() < deadline) {
        if (startConfirmed(readStart(config.stateDirectory), expectedVersion, sinceMs)) {
          return { ok: true, reason: null };
        }
        await sleep(config.tickMs);
      }
      return {
        ok: false,
        reason: `no start report for ${expectedVersion} within ${Math.round(
          config.startDeadlineMs / 1000
        )}s`
      };
    },
    logLine(line) {
      console.log(line);
    },
    now() {
      return Date.now();
    }
  };
}

// Read the own image ref from the own container. Watcher and agent run from
// the SAME image — the watcher's ref is thus the reliable answer to which
// repository is eligible here at all.
//
// ⚠️ The ref and not just the repository: the preliminary question to the
// registry applies to exactly one tag. Storing it under the repository would
// mean showing the state of `:latest` also to whoever is pinned to
// `:v0.13.1`.
async function ownImageRef(engine: DockerEngine): Promise<string | null> {
  const ownId = (process.env.HOSTNAME ?? "").trim();
  if (!ownId) return null;
  try {
    const self = await engine.inspect(ownId);
    const ref = self.Config?.Image;
    return typeof ref === "string" && ref ? ref : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const config = loadWatcherConfig(process.env);
  // TRANSITION (v0.18.0), see index.ts: name the old environment keys.
  const legacyKeys = legacyEnvKeysInUse(process.env);
  if (legacyKeys.length > 0) {
    console.log(`[watcher] deprecated environment keys, please rename (README, setup): ${legacyKeys.join(", ")}`);
  }
  const engine = new DockerEngine({ socketPath: config.socketPath });
  const ownRef = await ownImageRef(engine);
  const ownRepo = ownRef ? repoOfRef(ownRef) : null;
  const ops = buildOps(engine, config, ownRepo);

  console.log(
    `[watcher] watching ${config.stateDirectory}, tick ${config.tickMs}ms, ` +
      `start deadline ${Math.round(config.startDeadlineMs / 1000)}s, repository ${ownRepo ?? "unknown"}, ` +
      `registry check every ${Math.round(config.checkTickMs / 60_000)}min`
  );
  if (!ownRepo) {
    console.warn(
      "[watcher] own repository not determinable (HOSTNAME empty?) — " +
        "digest resolution and therefore signature verification will fail"
    );
  }

  // 0 means "right on the first pass". Asking only after the interval would
  // mean that the display knows nothing for a quarter of an hour after every
  // restart of the watcher.
  let nextValidation = 0;
  let lastReason: string | null | undefined;

  for (;;) {
    const job = takeJob(config.stateDirectory);
    if (job) {
      console.log(`[watcher] job ${job.jobId} from ${job.requestedBy}`);
      try {
        const status = await executeSelfUpdateFrom(ops, job);
        finishJob(config.stateDirectory, status);
        console.log(`[watcher] job ${job.jobId}: ${status.outcome} ${status.reason ?? ""}`);
      } catch (failure) {
        // Nothing may get through up to here: an unhandled error would leave
        // the in-progress job file in place, and every following button press
        // would get "already running" forever.
        const text = failure instanceof Error ? failure.message : String(failure);
        finishJob(config.stateDirectory, {
          jobId: job.jobId,
          outcome: "failed",
          reason: `unexpected: ${text}`,
          fromVersion: job.runningVersion,
          toVersion: null,
          fromImageId: job.runningImageId,
          toImageId: null,
          digest: null,
          startedAt: job.requestedAt,
          finishedAt: new Date().toISOString()
        });
        console.error(`[watcher] job ${job.jobId} failed unexpectedly: ${text}`);
      }
      // After a swap the local digest has changed. Asking again right away is
      // cheaper than a display that for a quarter of an hour offers an update
      // that has just been installed.
      nextValidation = 0;
    } else if (ownRef && Date.now() >= nextValidation) {
      nextValidation = Date.now() + config.checkTickMs;
      try {
        const finding = await validateRegistry(engine, config, ownRef);
        writeAvailable(config.stateDirectory, finding);
        // Only log on a CHANGE: the same line every 15 minutes would be a log
        // nobody reads any more.
        if (finding.reason !== lastReason) {
          lastReason = finding.reason;
          console.log(
            finding.reason
              ? `[watcher] registry check without digest: ${finding.reason}`
              : `[watcher] registry check: ${finding.remoteDigest}`
          );
        }
      } catch (failure) {
        // A failed preliminary question is a missing piece of information and
        // no reason to stop the job channel.
        console.warn(
          `[watcher] registry check failed: ${
            failure instanceof Error ? failure.message : String(failure)
          }`
        );
      }
    }
    await sleep(config.tickMs);
  }
}

// Only start when this file is the entry module — otherwise an import in a
// test would kick off the endless loop.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
