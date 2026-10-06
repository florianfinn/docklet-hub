// Configuration of the agent. Deliberately without zod or similar — the agent
// should have no runtime dependencies, and the handful of values can be
// checked by hand. Fail closed: if the secret is missing, the agent does not
// start at all.

import { envWithLegacyName } from "./request-keys.js";

export type AgentConfig = {
  socketPath: string;
  listenHost: string;
  listenPort: number;
  sharedSecret: string;
  // Transition value for changing the secret (#19). `null` as long as no
  // rotation is running — and that is the normal state.
  //
  // Without it a change is a synchronous intervention on two hosts: as long
  // as the main API still sends the old value and the agent already expects
  // the new one, it answers EVERY request with 401 — on the only path that
  // leads to the socket. The result is that nobody rotates.
  sharedSecretAlt: string | null;
  registryFile: string;
  // Second, separate list for the watch-only class (D1, W1). Deliberately a
  // file of its own next to the allowlist — not the same structure, not the
  // same right.
  monitorFile: string;
  auditFile: string;
  // The channel to the watcher (#36). A directory in the /state volume that
  // the agent writes and the watcher reads — the same setting must be on both
  // sides, otherwise they talk past each other and the button does nothing.
  selfUpdateDir: string;
  readOnly: boolean;
  // Allowlist for bind mounts (stage plan 3.8, fixed in stage 5a): an
  // absolute host bind must lie STRICTLY below this path. Derived from the
  // actual state of the server — 49 of 53 binds lie under /home/docker, the
  // rest are docker.sock.
  bindBasePath: string;
  // S23: the host directories that carry the operation of the management on
  // THIS host. A container that reaches one of them carries a delegation lock
  // (`dashboard-self-mount`).
  //
  // ⚠️ Before S23 this was a constant with the LOCAL paths
  // (/home/docker/dashboard-state|-repo). On a remote host it never matched,
  // and so one of the five delegation locks was switched off there. The list
  // is now derived from the own base path and extended at runtime by the
  // actual mounts of the agent container (see `addOwnMounts` in
  // runtime/state.ts) — on a remote host that is above all the bootstrap
  // directory holding its secret and the WireGuard key.
  selfPaths: string[];
  // S18/U4: bootstrap agents must listen on their assigned tunnel address.
  // Local, unpublished agents may still use 0.0.0.0 in the isolated Docker
  // network.
  requireTunnelBind: boolean;
  tunnelCidr: string;
  registrationUrl: string | null;
  registrationToken: string | null;
};

function ipv4InCidr(address: string, cidr: string): boolean {
  const toNumber = (value: string): number | null => {
    const parts = value.split(".");
    if (parts.length !== 4) return null;
    let result = 0;
    for (const part of parts) {
      if (!/^\d{1,3}$/.test(part)) return null;
      const octet = Number(part);
      if (octet > 255) return null;
      result = (result * 256 + octet) >>> 0;
    }
    return result;
  };
  const [networkAddress, prefixText] = cidr.split("/");
  const addressNumber = toNumber(address);
  const networkNumber = toNumber(networkAddress);
  const prefix = Number(prefixText);
  if (addressNumber === null || networkNumber === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (addressNumber & mask) === (networkNumber & mask);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const sharedSecret = env.DOCKER_AGENT_SECRET ?? "";
  if (sharedSecret.length < 32) {
    throw new Error(
      "DOCKER_AGENT_SECRET is missing or too short (min. 32 characters). The agent does not start without it."
    );
  }

  // The transition value is subject to the same minimum length: a second,
  // weaker value would be a second, weaker way in.
  const sharedSecretAlt = env.DOCKER_AGENT_SECRET_ALT?.trim() || null;
  if (sharedSecretAlt !== null && sharedSecretAlt.length < 32) {
    throw new Error(
      "DOCKER_AGENT_SECRET_ALT is too short (min. 32 characters). Either a valid transition value or none at all."
    );
  }
  // Both values equal means: a transition window that is none. That is not
  // let through but stopped — otherwise someone believes the rotation is
  // already running and switches the main API over.
  if (sharedSecretAlt !== null && sharedSecretAlt === sharedSecret) {
    throw new Error(
      "DOCKER_AGENT_SECRET_ALT is identical to DOCKER_AGENT_SECRET. The transition value is the OLD value, not the same one."
    );
  }

  const listenHost = env.DOCKER_AGENT_HOST ?? "0.0.0.0";
  const requireTunnelBind = (env.DOCKER_AGENT_REQUIRE_TUNNEL_BIND ?? "").toLowerCase() === "true";
  const tunnelCidr = env.DOCKER_AGENT_TUNNEL_CIDR ?? "10.253.0.0/24";
  if (requireTunnelBind && !ipv4InCidr(listenHost, tunnelCidr)) {
    throw new Error(
      `DOCKER_AGENT_HOST must be a concrete address from ${tunnelCidr} while tunnel protection is enabled. ` +
        "0.0.0.0 and public addresses are rejected."
    );
  }

  const registrationUrl = env.DOCKER_AGENT_REGISTRATION_URL?.trim() || null;
  const registrationToken = env.DOCKER_AGENT_REGISTRATION_TOKEN?.trim() || null;
  if (Boolean(registrationUrl) !== Boolean(registrationToken)) {
    throw new Error("DOCKER_AGENT_REGISTRATION_URL and DOCKER_AGENT_REGISTRATION_TOKEN must be set together");
  }
  if (registrationToken && registrationToken.length < 32) {
    throw new Error("DOCKER_AGENT_REGISTRATION_TOKEN is too short (min. 32 characters)");
  }
  if (registrationUrl) {
    const parsed = new URL(registrationUrl);
    if (parsed.protocol !== "http:") {
      throw new Error("the registration endpoint must be addressed via http over the WireGuard network");
    }
    if (!ipv4InCidr(parsed.hostname, tunnelCidr)) {
      throw new Error("the registration endpoint must be on an address in the configured tunnel network");
    }
  }

  const bindBasePath = (env.DOCKER_AGENT_BIND_BASE_PATH ?? "/home/docker").replace(/\/+$/, "");

  // S23: the own operational directories of this host.
  //
  // Two sources, deliberately additive:
  //   1. Derived from the base path — on the local host that yields exactly
  //      the earlier constants (/home/docker/dashboard-state|-repo), so the
  //      behaviour does not change there.
  //   2. DOCKER_AGENT_SELF_PATHS — on a remote host the bootstrap directory.
  //      `.env` (agent secret) and `wg0.conf` (WireGuard key) live there;
  //      whoever can read them is the agent.
  //
  // At runtime the actual mounts of the agent container are added
  // (addOwnMounts in runtime/state.ts). Configuration alone would be the
  // weaker solution here: an agent rolled out before S23 does not have the
  // variable, and nobody notices.
  const selfPaths = [`${bindBasePath}/dashboard-state`, `${bindBasePath}/dashboard-repo`];
  for (const raw of (env.DOCKER_AGENT_SELF_PATHS ?? "").split(",")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // ⚠️ Check before trimming the slash: otherwise "/" becomes an empty
    // string that slips through as "nothing given" — a silent
    // misconfiguration instead of a loud one.
    if (!trimmed.startsWith("/") || trimmed.includes("..")) {
      throw new Error("DOCKER_AGENT_SELF_PATHS may only contain absolute paths without '..'");
    }
    const pathname = trimmed === "/" ? "/" : trimmed.replace(/\/+$/, "");
    // ⚠️ Neither "/" nor the base path nor an ancestor of it. All three would
    // turn EVERY container with a bind below the working tree into a
    // delegation lock — i.e. practically the entire existing setup. That is a
    // misconfiguration, not a particularly strict protection, and it shows up
    // loudly here instead of silently in operation.
    if (pathname === "/" || pathname === bindBasePath || bindBasePath.startsWith(pathname + "/")) {
      throw new Error(
        `DOCKER_AGENT_SELF_PATHS must contain neither '/' nor the bind base path (${bindBasePath}) ` +
          "nor a directory above it"
      );
    }
    if (!selfPaths.includes(pathname)) selfPaths.push(pathname);
  }
  return {
    socketPath: env.DOCKER_SOCKET_PATH ?? "/var/run/docker.sock",
    // Default deliberately loopback: the agent is reachable only via the
    // dedicated Docker network to the main API, never via a host port.
    listenHost,
    listenPort: Number.parseInt(env.DOCKER_AGENT_PORT ?? "8099", 10),
    sharedSecret,
    sharedSecretAlt,
    registryFile: env.DOCKER_AGENT_REGISTRY_FILE ?? "/state/registry.json",
    monitorFile: env.DOCKER_AGENT_MONITOR_FILE ?? "/state/monitors.json",
    auditFile: env.DOCKER_AGENT_AUDIT_FILE ?? "/state/audit.jsonl",
    selfUpdateDir: envWithLegacyName(env, "DOCKER_AGENT_SELF_UPDATE_DIR") ?? "/state/selbstupdate",
    // Break glass (stage plan 3.2): switches the agent to read-only
    // immediately, without a deploy of the main API. Anything other than
    // "true" counts as off.
    readOnly: (env.DOCKER_AGENT_READ_ONLY ?? "").toLowerCase() === "true",
    // Kept without a trailing slash; the check appends one itself.
    bindBasePath,
    selfPaths,
    requireTunnelBind,
    tunnelCidr,
    registrationUrl,
    registrationToken
  };
}
