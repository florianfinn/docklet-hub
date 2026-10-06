import path from "node:path";
import { legacyEnvKeysInUse } from "./request-keys.js";
import { startBootstrapRegistration } from "./bootstrap-registration.js";
import { composeAvailable } from "./compose-cli.js";
import { describeLimits, createServer, CONNECTION_LIMITS } from "./connection-limits.js";
import { reportStart } from "./self-update-state.js";
import { AGENT_VERSION } from "./version.js";

import {
  config,
  registry,
  audit,
  ownContainerId,
  HOSTNAME_CANDIDATE,
  determineOwnContainerId,
  addOwnMounts,
  setBootstrapRegistration
} from "./runtime/state.js";
import { collectStats, composeBasePath } from "./runtime/containers.js";
import { handleRequest } from "./dispatch.js";

// ⚠️ Via `createServer` instead of `http.createServer` (R5). The difference is
// not cosmetic: `connectionsCheckingInterval` can ONLY be set on creation, and
// without it the deadlines below would be numbers nobody looks after. The
// reasoning for each value is in connection-limits.ts. The handler itself is
// in dispatch.ts.
const server = createServer(handleRequest);

// Fail fast: without a writable audit log the agent does not start. An agent
// that executes actions without a record is worse than one that is missing.
try {
  audit.assertWritable();
} catch (error) {
  console.error(
    "[agent] audit log is not writable — startup aborted. " +
      `Path: ${config.auditFile}. Check the permissions of the /state volume.`,
    error
  );
  process.exit(1);
}

server.listen(config.listenPort, config.listenHost, async () => {
  console.log(
    `[agent] listening on ${config.listenHost}:${config.listenPort}, ` +
      `readOnly=${config.readOnly}, allowlist entries=${registry.size()}`
  );

  // R5: the transport limits into the startup log. `maxConnections` is derived
  // from the descriptor budget of THIS container and is therefore stated nowhere
  // else — neither in the configuration nor in the source code.
  console.log(`[agent] connection limits: ${describeLimits(CONNECTION_LIMITS)}`);

  // TRANSITION (v0.18.0): seven environment keys became English and are still
  // read under their old name. The line names what still has to be switched in
  // the host's compose file — otherwise it is never noticed.
  const legacyKeys = legacyEnvKeysInUse(process.env);
  if (legacyKeys.length > 0) {
    console.log(`[agent] deprecated environment keys, please rename (README, setup): ${legacyKeys.join(", ")}`);
  }

  // #36: the start report for the watcher. It sits HERE and not earlier,
  // because it is meant to mean "I am accepting requests" and not "my process
  // has started" — the watcher rolls back exactly when it does not appear.
  //
  // It is written on EVERY start, not only after an update: the watcher
  // compares its timestamp against the start of its swap, and a file that only
  // sometimes comes into existence is no good for that. A failure while
  // writing does not stop the agent — then at worst a self-update falls into
  // the rollback path, and that is the more harmless kind of failure.
  try {
    reportStart(config.selfUpdateDir, {
      version: AGENT_VERSION,
      // ⚠️ The hostname candidate and NOT the confirmed id: this report is
      // created at the beginning of the start, before the engine has to be
      // reachable for it. The watcher compares it via the timestamp anyway, not
      // via the id — and a start report that hangs on a slow daemon would be
      // gone exactly at the moment it is needed.
      containerId: ownContainerId() ?? HOSTNAME_CANDIDATE ?? "unknown",
      time: new Date().toISOString()
    });
  } catch (failure) {
    console.warn(
      "[agent] start report for the watcher not writable:",
      failure instanceof Error ? failure.message : failure
    );
  }

  // An open rotation window is a state one wants to end, not a permanent
  // state — that is why it is in the log at startup and not only in /health.
  if (config.sharedSecretAlt !== null) {
    console.log(
      "[agent] secret rotation in progress: DOCKER_AGENT_SECRET_ALT is accepted as well. " +
        "Remove it once the main API has switched over (counter `secondarySecret.used` in /health)."
    );
  }

  // S23: collect the own mounts BEFORE the first hardening response. The call
  // runs against the same engine as everything else; if it fails, the
  // configured list stays (never empty).
  // ⚠️ FIRST confirm, then harden: `addOwnMounts()` reads the mounts of the own
  // id, and with a wrong one the self-protection protects the paths of a
  // foreign container. On remote-host those would have been the ones of the tunnel
  // sidecar — the mistake goes unnoticed, because the counter in the log looks
  // plausible.
  await determineOwnContainerId();
  await addOwnMounts();

  // Try a first sample immediately; afterwards 60 points of 10 seconds each
  // hold the last ten minutes of history. The timer is not a second
  // persistence or monitor source and must not prevent a clean process
  // shutdown.
  void collectStats();
  const statsTimer = setInterval(() => void collectStats(), 10_000);
  statsTimer.unref();

  // S18/U4: register only once the own HTTP port is really listening. The
  // server checks it from its side via /health; a mere WG handshake is not
  // enough. The marker lives in the agent state and prevents a used-up one-time
  // token from being sent again after every restart.
  setBootstrapRegistration(startBootstrapRegistration(
    {
      registrationUrl: config.registrationUrl,
      registrationToken: config.registrationToken,
      stateFile: path.join(path.dirname(config.registryFile), "bootstrap-registered.json"),
      listenHost: config.listenHost,
      listenPort: config.listenPort,
      readOnly: config.readOnly
    },
    {
      // R9: the end of the registration belongs in the audit log and not only on
      // the console. A console line on the target host is gone with the next
      // `up -d --force-recreate` — and "since when is this host not registered?"
      // is exactly the question one asks weeks later.
      onEnd: (state, reason) => {
        audit.write({
          action: "bootstrap-registration",
          containerId: null,
          containerName: null,
          actor: null,
          outcome: reason === "registered" ? "allowed" : "error",
          reason: `${reason} attempts=${state.attempts}`
        });
      }
    }
  ));

  // Stage 5c needs the Docker CLI including the compose plugin. If it is
  // missing, only the first create attempt fails — i.e. in the middle of
  // operation instead of at deploy. The agent starts anyway: reading,
  // start/stop/restart and pull continue without compose, and an agent that no
  // longer runs at all because of a missing additional capability would be the
  // worse kind of failure.
  if (await composeAvailable()) {
    console.log(`[agent] docker compose available, compose base path ${composeBasePath}`);
  } else {
    console.error(
      "[agent] WARNING: `docker compose` cannot be invoked. Creating and " +
        "editing containers (stage 5c) will fail. " +
        "Check docker-cli/docker-cli-compose in the image and the socket mount."
    );
  }
});
