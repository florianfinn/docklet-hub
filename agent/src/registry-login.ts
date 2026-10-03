// Read the login for a registry from the Docker configuration (#36).
//
// ⚠️ The reason for this module is a separation that was measured live: the
// DAEMON has no credentials. They live in the `config.json` of the user who
// calls the CLI; the CLI reads them and attaches them as `X-Registry-Auth` to
// the request it then sends to the daemon. A request WITHOUT this header asks
// anonymously — for a private package GHCR then answers with `unauthorized`,
// and not only for the pull but also for the harmless question "which digest
// does this tag currently carry?".
//
// Measured on the proxy (2026-08-26), same ref, same daemon:
//
//   without header   {"message":"Head \"https://ghcr.io/v2/…\": unauthorized"}
//   with header      {"Descriptor":{"digest":"sha256:7a4841…"}}
//
// The WATCHER has the `config.json` mounted anyway — for cosign and for the
// pull through the CLI. With the same data it can also ask the pre-check
// question. The AGENT still does NOT get it: it would then hold a registry
// token it needs for none of its tasks.

import fs from "node:fs";
import path from "node:path";
import type { EngineRegistryAuth } from "./engine.js";

export type RegistrationFinding =
  | { ok: true; auth: EngineRegistryAuth }
  // Separate reasons and not a bare `null`: "no configuration is mounted
  // here" and "the configuration uses a helper program we do not call" are
  // different tasks for the operator.
  | {
      ok: false;
      reason: "no-configuration" | "unreadable" | "no-entry" | "credential-helper";
    };

// Docker Hub is stored in `config.json` under a historical key, not under the
// name one sees in the image ref.
const HUB_KEY = ["https://index.docker.io/v1/", "index.docker.io", "docker.io"];

// The registry host from a repository name. The rule is the Docker CLI's:
// the first segment is a host exactly when it contains a dot or a colon or is
// `localhost` — otherwise it is a user name on Docker Hub (`florianfinn/foo`).
export function registryHostOf(repository: string): string {
  const firstSegment = repository.split("/")[0] ?? "";
  const isHost = firstSegment.includes(".") || firstSegment.includes(":") || firstSegment === "localhost";
  return isHost ? firstSegment : "docker.io";
}

function keyCandidates(registryHost: string): string[] {
  if (HUB_KEY.includes(registryHost)) return HUB_KEY;
  return [registryHost, `https://${registryHost}`, `https://${registryHost}/`];
}

// From an already parsed configuration. Separate from the file so that the
// evaluation stays testable without a file system.
export function registrationFrom(config: unknown, registryHost: string): RegistrationFinding {
  if (!config || typeof config !== "object") return { ok: false, reason: "unreadable" };
  const root = config as Record<string, unknown>;

  // ⚠️ A helper program (`credsStore`/`credHelpers`) is deliberately NOT
  // called. That would be executing a program whose name is decided by a
  // configuration file — in the container that holds the docker.sock. The
  // price for that is one piece of information less, not a wrong one.
  const helpers = root.credHelpers;
  const helperForHost =
    helpers && typeof helpers === "object"
      ? keyCandidates(registryHost).some((key) =>
          Object.prototype.hasOwnProperty.call(helpers, key)
        )
      : false;

  const auths = root.auths;
  const entry =
    auths && typeof auths === "object"
      ? (keyCandidates(registryHost)
          .map((key) => (auths as Record<string, unknown>)[key])
          .find((value) => value && typeof value === "object") as Record<string, unknown> | undefined)
      : undefined;

  if (!entry) {
    if (helperForHost || typeof root.credsStore === "string") {
      return { ok: false, reason: "credential-helper" };
    }
    return { ok: false, reason: "no-entry" };
  }

  if (typeof entry.auth === "string" && entry.auth) {
    const raw = Buffer.from(entry.auth, "base64").toString("utf8");
    const separator = raw.indexOf(":");
    // A password may contain colons, a user name may not — the FIRST
    // separator counts.
    if (separator > 0) {
      return {
        ok: true,
        auth: {
          username: raw.slice(0, separator),
          password: raw.slice(separator + 1),
          serverAddress: registryHost
        }
      };
    }
  }

  if (typeof entry.username === "string" && typeof entry.password === "string") {
    return {
      ok: true,
      auth: { username: entry.username, password: entry.password, serverAddress: registryHost }
    };
  }

  // An entry without usable fields comes about exactly when a helper program
  // holds the data and the file only contains the placeholder.
  return { ok: false, reason: helperForHost || root.credsStore ? "credential-helper" : "no-entry" };
}

// `directory` is the value of DOCKER_CONFIG, i.e. the path under which THIS
// container sees the file. Not to be confused with the HOST path cosign gets
// as a bind mount: the one is read, the other is passed on.
export function loadRegistration(directory: string | null, registryHost: string): RegistrationFinding {
  if (!directory) return { ok: false, reason: "no-configuration" };
  let content: string;
  try {
    content = fs.readFileSync(path.join(directory, "config.json"), "utf8");
  } catch {
    return { ok: false, reason: "no-configuration" };
  }
  try {
    return registrationFrom(JSON.parse(content) as unknown, registryHost);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}
