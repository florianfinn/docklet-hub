import { MAX_MONITOR_STREAMS, MAX_OPEN_STREAMS } from "contract";
import path from "node:path";
import { AgentAuditLog } from "../audit.js";
import { type BootstrapLogin } from "../bootstrap-registration.js";
import { loadConfig } from "../config.js";
import {
  DockerEngine
} from "../engine.js";
import {
  normalizePath
} from "../hardening.js";
import { SecretValidation } from "../secret.js";
import {
  ExecSessions
} from "../exec.js";
import { KeyedMutex, StreamLimit } from "../concurrency.js";
import { StatsRingBuffer } from "../stats.js";
import { AgentRegistry } from "../registry.js";
import { ComposeSelectionStore } from "../compose-selection.js";
import { MonitorRegistry } from "../monitor-registry.js";
import {
  carriesSecret,
  pickOwnContainerId,
  type IdCandidate
} from "../own-container-id.js";

import { SelfHealingConfigStore } from "../self-healing-config.js";

export const config = loadConfig();
export const selfHealingConfig = new SelfHealingConfigStore(path.join(path.dirname(config.registryFile), "self-healing-config.json"));
export const engine = new DockerEngine({ socketPath: config.socketPath });
export const registry = new AgentRegistry(config.registryFile);
export const composeSelections = new ComposeSelectionStore(path.join(path.dirname(config.registryFile), "compose-selections.json"));
// Second, separate list for the watch-only class (D1, W1). Completely
// independent of the allowlist and of gate() — observing, not controlling.
export const monitors = new MonitorRegistry(config.monitorFile);
export const audit = new AgentAuditLog(config.auditFile);
// The shared secret including the transition value for rotation (#19). The
// check sits in a module of its own because it can be proven with tests there.
export const secretCheck = new SecretValidation(config.sharedSecret, config.sharedSecretAlt);
// S13: stats are collected once every ten seconds and afterwards only read
// from this ring buffer. A UI list request thus no longer produces N new
// engine stats requests.
export const statsHistory = new StatsRingBuffer(60);
// One lock instance for ALL project-related mutations: stack actions,
// raw apply, spec apply, recreate/remove and individual start/stop/restart paths.
export const stackLocks = new KeyedMutex();
// Open shell sessions (S16 — K1d, §20.1). Deliberately in memory only: a
// session does not survive an agent restart, and it is not supposed to.
export const execSessions = new ExecSessions();
// Cap for the observable streams (R3): log stream, log file stream,
// pull stream and since #86 the observable raw apply.
//
// ⚠️ 32 INSTEAD OF EIGHT since v0.29.1. Since #183 the hub shows the log of a
// whole stack, and every container in it occupies a stream of its own. With
// eight slots for all humans together it had to cap at four per stack; a
// stack like an *arr bundle has more. 32 stays far below
// `MAX_CONNECTIONS` (512, connection-limits.ts), and the backlog per stream
// is capped (`MAX_STREAM_BACKLOG_BYTES`, ndjson-line.ts).
//
// ⚠️ The raw apply is the longest-lived of them all (up to ten minutes) and
// the only one that a dropped connection does not end: it runs to completion
// even when nobody is listening any more. Its slot still ends with the
// connection — it is released via `close`, not via completion.
// The value is shared with the hub since #272 (`contract/src/agent/limits.ts`).
export { MAX_OPEN_STREAMS, MAX_MONITOR_STREAMS };
export const openStreams = new StreamLimit(MAX_OPEN_STREAMS);
// The internal continuous stream counts SEPARATELY. Two reasons: it must never
// fail because of open browser logs (otherwise monitoring drops out while
// someone reads logs), and a tunnel break leaves the old connection lying
// around until TCP gives up on it — the successor needs room next to it. Hence
// a separate, small cap instead of none at all: the main API does not get a
// free pass here either.
export const monitorStreams = new StreamLimit(MAX_MONITOR_STREAMS);

// State of the bootstrap registration, so /health can report it (R9). The
// initial value is the state BEFORE the first attempt: registration only
// starts once the listener is up (S18/U4), and between `listen` and that
// moment someone could already query /health — precisely the dashboard that
// is connecting the host right now.
export let bootstrapRegistration: BootstrapLogin = {
  stop: () => {},
  state: () => ({ phase: config.registrationUrl && config.registrationToken ? "running" : "off", attempts: 0 })
};

// The start-up in index.ts replaces the placeholder once the HTTP port listens;
// an imported binding cannot be assigned from there.
export function setBootstrapRegistration(registration: BootstrapLogin): void {
  bootstrapRegistration = registration;
}

// The hardening check needs the base path of the allowlist (stage 5a) and
// since S23 the own operating directories of THIS host.
//
// ⚠️ `selfPaths` is deliberately mutable: `addOwnMounts()` appends the actual
// bind sources of the agent container at startup. Without that, the
// protection on a foreign host depends solely on an environment variable —
// and an agent rolled out before S23 does not have it, without anyone noticing.
export const hardeningOptions = { bindBasePath: config.bindBasePath, selfPaths: config.selfPaths };

// Which host directories has the agent mounted ITSELF? What it sees, another
// container must not be allowed to see — that is the same statement as
// dashboard-state/-repo, just without having to know them by name.
//
// Failure is not a startup error: then the derived and configured list
// remains (never empty). But it is logged loudly, because silently protecting
// less is exactly the failure shape this track has caught several times.
// ⚠️ CRUCIAL: the agent mounts ITS WHOLE WORKING TREE (`bindBasePath`, the
// Compose directories of all managed containers). That is its job, not its
// secret. If this path were treated as "own", EVERY container with a bind
// below it would be a delegation lock — that is, practically the entire
// inventory.
//
// That is why only what lies TRULY BELOW the base path counts (that is where
// the agent's project directory with .env and wg0.conf sits) or entirely
// outside it — never the base path itself and never an ancestor of it.
export function isUsableSelfPath(pathname: string): boolean {
  if (!pathname.startsWith("/") || pathname === "/") return false;
  // The socket is already a core rule of its own; listing it here would only
  // make the explanation worse.
  if (pathname === "/var/run/docker.sock" || pathname === "/run/docker.sock") return false;
  if (pathname === config.bindBasePath) return false;
  // Ancestor of the base path, e.g. "/mnt/user" for base "/mnt/user/docker".
  if (config.bindBasePath.startsWith(pathname + "/")) return false;
  return true;
}

// The own container id — PROVEN, not guessed (see own-container-id.ts).
//
// ⚠️ Until v0.13.0 this was `process.env.HOSTNAME`. With `network_mode:
// container:<X>` that is the id of the namespace PROVIDER, not the own one; on
// 2026-08-26 on remote-host that made the tunnel sidecar get swapped instead of the
// agent. The value is therefore proven against the engine once at startup and
// stays `null` if that does not succeed unambiguously.
export let ownContainerIdValue: string | null = null;

export function ownContainerId(): string | null {
  return ownContainerIdValue;
}

// The hostname is still fine as the FIRST candidate: in the normal case (own
// namespace) it matches, and then the proof costs exactly one `inspect`.
// It is just no longer proof, only a guess.
export const HOSTNAME_CANDIDATE = (process.env.HOSTNAME ?? "").trim();

export async function determineOwnContainerId(): Promise<void> {
  const secret = config.sharedSecret;
  try {
    if (HOSTNAME_CANDIDATE) {
      const guess = await engine.inspect(HOSTNAME_CANDIDATE).catch(() => null);
      if (guess && carriesSecret(guess.Config?.Env ?? [], secret)) {
        ownContainerIdValue = guess.Id ?? HOSTNAME_CANDIDATE;
        return;
      }
    }

    // The hostname points elsewhere (or nowhere). Now only the list helps —
    // it is not expensive, it runs exactly once at startup.
    const candidates: IdCandidate[] = [];
    for (const id of await engine.listContainerIds()) {
      const detail = await engine.inspect(id).catch(() => null);
      if (!detail) continue;
      candidates.push({ id: detail.Id ?? id, envLines: detail.Config?.Env ?? [] });
    }
    const result = pickOwnContainerId(candidates, secret);
    ownContainerIdValue = result.id;
    if (!result.id) {
      console.warn(
        `[agent] own container id not determinable (${result.reason}) — self-update and self-protection will refuse`
      );
    } else if (result.id !== HOSTNAME_CANDIDATE) {
      // The interesting case, and the only one worth a line: the hostname
      // pointed at a foreign container.
      console.log(
        `[agent] own container id determined via environment — the hostname (${HOSTNAME_CANDIDATE || "empty"}) belongs to another container`
      );
    }
  } catch (error) {
    ownContainerIdValue = null;
    console.warn("[agent] own container id not determinable:", error);
  }
}

export async function addOwnMounts(): Promise<void> {
  const ownId = ownContainerId();
  if (!ownId) {
    console.warn("[hardening] own container id unknown — self-protection from configuration only");
    return;
  }
  try {
    const self = await engine.inspect(ownId);
    const candidates: string[] = [];

    // The own project directory is the place that matters: that is where the
    // compose file, `.env` with the agent secret and `wg0.conf` with the
    // WireGuard key live. Whoever can read it IS this agent.
    //
    // Read from the own labels — here the T6 warning (Config.Labels mixes image
    // and container labels) is not critical: it is our own image, and an
    // additionally protected path can only lock more, never less.
    const workingDirectory = self.Config?.Labels?.["com.docker.compose.project.working_dir"];
    if (typeof workingDirectory === "string" && workingDirectory.startsWith("/")) {
      candidates.push(normalizePath(workingDirectory));
    }
    for (const bind of self.HostConfig?.Binds ?? []) {
      const source = bind.split(":")[0] ?? "";
      if (source.startsWith("/")) candidates.push(normalizePath(source));
    }

    let updated = 0;
    for (const candidate of candidates) {
      if (!isUsableSelfPath(candidate)) continue;
      if (config.selfPaths.includes(candidate)) continue;
      config.selfPaths.push(candidate);
      updated += 1;
    }
    console.log(
      `[hardening] self-protection: ${config.selfPaths.length} path(s), ${updated} detected automatically`
    );
  } catch (error) {
    console.warn(
      "[hardening] own mounts not determinable — self-protection from configuration only:",
      error instanceof Error ? error.message : error
    );
  }
}
