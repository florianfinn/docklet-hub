// Compose file as the source of truth (stage plan 6.2, stage 5c).
//
// The direction decision of rev. 3 does NOT reverse that containers come from a
// structured model — it separates input and artifact:
//
//   Spec (spec.ts)  =  the input. Validated, hardening enforced, no field for
//                      privileged/capabilities/devices.
//   compose.yaml    =  the artifact. Readable, backup-able, editable by hand,
//                      and the same file an SSH user uses.
//
// Free YAML as INPUT remains the gated special path (stage 7). What is produced
// here is generated YAML from checked fields — the attack surface still does
// not come into existence, because there is no field for it.
//
// This module is deliberately pure: no file system, no process start. That
// makes the most delicate part — what exactly is written into the file and what
// is read out of it — fully testable without Docker.

import { normalizePath } from "./hardening.js";
import { LOG_MAX_FILE, LOG_MAX_SIZE, type ContainerSpec, type SpecPort, type SpecVolume } from "./spec.js";

// Deliberately the same narrowness as the container name in spec.ts: directory
// name and container name are the same. A name that is no good as a directory
// is no good as a container name here either.
const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,62}$/;

export const COMPOSE_FILE_NAME = "compose.yaml";
// S12: the only additional Compose file the agent creates itself. During a
// rollback it briefly pins a service to the previous image id.
export const UPDATE_ROLLBACK_OVERRIDE_FILE_NAME = ".dashboard-update-rollback.yaml";

// Written by the agent into every project the hub creates (project-marker.ts).
export const PROJECT_MARKER_FILE_NAME = ".docklet-hub-project";

// The label by which a stack created by the dashboard can be recognized. Not a
// security feature — the authoritative information is the pointer row in the
// DB — but it makes the origin visible in `docker ps`.
export const MANAGED_LABEL = "io.github.florianfinn.docklet-hub.managed";

export type ComposeLocation = {
  projectDir: string;
  filePath: string;
  serviceName: string;
};

export function isValidProjectName(name: unknown): name is string {
  return typeof name === "string" && PROJECT_NAME_PATTERN.test(name);
}

// A Compose file name is a pure FILE name: no directory level, no step back,
// nothing empty.
//
// The check is its own function here because the name now comes from two
// sources — on adoption from the label (composeFileNameOf already checks it
// there) and later from the agent's copy of the allowlist. The second source
// had no check until the review follow-up.
export function isValidComposeFileName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name === "." || name === ".." || name === PROJECT_MARKER_FILE_NAME) return false;
  // No control characters. Checked via character codes instead of a regex: a
  // literal range in the source would itself be a control character in the
  // file again.
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

// A path must lie STRICTLY below the base path. Same rule and same reasoning as
// the bind allowlist in hardening.ts: the base path itself does not count.
export function isInsideBase(candidate: string, basePath: string): boolean {
  const normalized = normalizePath(candidate);
  const base = normalizePath(basePath);
  return normalized.startsWith(base + "/") && normalized !== base;
}

// A container's location follows from its name, not from anything the caller
// states. That is the traversal guard at the root: there is no way to give the
// agent a path that it then writes to.
export function locationFor(name: string, basePath: string): ComposeLocation | null {
  if (!isValidProjectName(name)) return null;
  const projectDir = `${normalizePath(basePath)}/${name}`;
  // Belt and braces: the pattern allows neither "/" nor "..", but the guarantee
  // that counts here should not depend on a regex somewhere else.
  if (!isInsideBase(projectDir, basePath)) return null;
  return { projectDir, filePath: `${projectDir}/${COMPOSE_FILE_NAME}`, serviceName: name };
}

// Where a running container comes from — read off the labels the Docker daemon
// itself set when Compose created it.
//
// That is the core of the solution for 6.3.1: the agent does NOT let the
// caller name the project directory (that would be a traversal path) but reads
// it off the container. The information is thereby self-proving — and it
// survives every external recreate, because it is attached to the container
// and not to a stored id.
//
// The return value is still checked against the base path: a container that
// Dockge created elsewhere should not make the agent write outside of
// /home/docker.
export type ComposeContext = {
  projectDir: string;
  serviceName: string;
  project: string;
  composeFileName: string;
};

// Why there is no unambiguous Compose reference.
//
// ⚠️ These reasons go as `error` to the main API and from there into a sentence
// for the operator. They must therefore NEVER overlap with a reason of the
// server-side pre-check: that is exactly where #468 failed — the agent's
// refusal carried the same name as the server's, and the associated sentence
// ("needs an unambiguously anchored Compose file") sent the search to a place
// where everything was demonstrably in order.
export type ComposeContextReason =
  // The container does not come from Compose at all, or the labels are
  // incomplete.
  | "compose-anchor-labels-missing"
  // It comes from Compose, but its project directory lies outside the base
  // path. Live case (#468): the same files reachable via two paths — Unraid
  // user share vs. cache disk —, the container carries one, the agent manages
  // the other.
  | "compose-anchor-outside-base-path"
  // The directory is right, but `config_files` does not name exactly one file
  // directly in it.
  | "compose-anchor-file-ambiguous";

export type ComposeContextFinding =
  | { ok: true; context: ComposeContext }
  // `projectDir` is the RAW value from the label, if present. It is here so that
  // the message can NAME the path instead of asserting it — without it,
  // "outside the base path" cannot be verified by the operator.
  | { ok: false; reason: ComposeContextReason; projectDir: string | null };

export function composeContextFindingOf(
  labels: Record<string, string> | undefined,
  basePath: string
): ComposeContextFinding {
  const workingDir = labels?.["com.docker.compose.project.working_dir"];
  const service = labels?.["com.docker.compose.service"];
  const project = labels?.["com.docker.compose.project"];
  if (!workingDir || !service || !project) {
    return {
      ok: false,
      reason: "compose-anchor-labels-missing",
      projectDir: workingDir ? normalizePath(workingDir) : null
    };
  }
  if (!isInsideBase(workingDir, basePath)) {
    return {
      ok: false,
      reason: "compose-anchor-outside-base-path",
      projectDir: normalizePath(workingDir)
    };
  }

  const projectDir = normalizePath(workingDir);
  const composeFileName = composeFileNameOf(labels, projectDir);
  if (!composeFileName) {
    return { ok: false, reason: "compose-anchor-file-ambiguous", projectDir };
  }

  return { ok: true, context: { projectDir, serviceName: service, project, composeFileName } };
}

export function composeContextOf(
  labels: Record<string, string> | undefined,
  basePath: string
): ComposeContext | null {
  const finding = composeContextFindingOf(labels, basePath);
  return finding.ok ? finding.context : null;
}

// The file name comes from the same source as the directory: the labels the
// daemon set. Up to 5c it was the constant COMPOSE_FILE_NAME — but in the
// inventory all three usual names occur (compose.yaml, docker-compose.yml,
// docker-compose.yaml).
//
// `config_files` is a COMMA-separated list of absolute paths (several files if
// started with overrides). Only the case with exactly one file lying directly
// in the project directory is accepted:
//
//   * Several files would mean that the truth is spread over files that a
//     later `--file` call with only one of them would resolve differently.
//     Better not to touch it at all than halfway.
//   * A path outside the project directory would be a way to point the agent
//     at a foreign file — the same traversal guard as for the directory.
function composeFileNameOf(
  labels: Record<string, string>,
  projectDir: string
): string | null {
  const raw = labels["com.docker.compose.project.config_files"];
  if (!raw) return null;

  const files = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  // A successful S12 rollback was created with exactly this second file.
  // Compose writes both paths permanently into the container label, even after
  // the agent has removed the override. This one fixed exception stays
  // unambiguous; arbitrary or further overrides are still conservatively
  // refused.
  if (files.length === 2) {
    const override = normalizePath(files[1]);
    if (override !== `${projectDir}/${UPDATE_ROLLBACK_OVERRIDE_FILE_NAME}`) return null;
  } else if (files.length !== 1) {
    return null;
  }

  const normalized = normalizePath(files[0]);
  const prefix = `${projectDir}/`;
  if (!normalized.startsWith(prefix)) return null;

  const fileName = normalized.slice(prefix.length);
  // No further directory level: the file lies directly in the project directory.
  if (!fileName || fileName.includes("/")) return null;
  return fileName;
}

// --- Writing --------------------------------------------------------------

// YAML scalars are single-quoted without exception. Single quotes know no
// escape sequences in YAML — so there is no way to create structure from
// within a value; the only special character is the quote itself, which is
// doubled.
//
// The "$" is doubled as well, because Compose interpolates the file BEFORE YAML
// parsing. Without that, a password with "$" would be a reference to an
// environment variable — the value would silently arrive empty in the
// container, or, worse, with the content of a foreign variable.
function yamlString(value: string): string {
  return `'${value.replace(/'/g, "''").replace(/\$/g, "$$$$")}'`;
}

function portLine(port: SpecPort): string {
  return yamlString(`${port.hostIp}:${port.hostPort}:${port.containerPort}/${port.protocol}`);
}

function volumeLine(volume: SpecVolume): string {
  return yamlString(`${volume.source}:${volume.target}${volume.readOnly ? ":ro" : ""}`);
}

export type EmitOptions = {
  // The ref comes in separately, because which one applies is decided
  // outside: for existing containers the agent's allowlist, not the spec
  // (stage plan 3.6). Same separation as in buildSpecPayload.
  imageRef: string;
};

export function emitComposeYaml(spec: ContainerSpec, options: EmitOptions): string {
  const lines: string[] = [];
  const service = spec.name;

  lines.push("# Generated by the dashboard (Docker management, stage 5c).");
  lines.push("#");
  lines.push("# This file is the source of truth for this container. It may be edited");
  lines.push("# by hand — the dashboard detects that by its hash on the next write");
  lines.push("# attempt and does not overwrite blindly. Conversely:");
  lines.push("# what is written here has NOT been validated by the dashboard; what gets");
  lines.push("# checked is the running container (hardening as a continuous check, stage 4).");
  lines.push("");
  lines.push("services:");
  lines.push(`  ${service}:`);
  lines.push(`    container_name: ${yamlString(spec.name)}`);
  lines.push(`    image: ${yamlString(options.imageRef)}`);
  // Otherwise Compose pulls on its own when the image is missing locally. The
  // moment foreign code arrives on the host should remain an explicit and
  // logged step of the agent, not a side effect of an "up".
  lines.push("    pull_policy: never");
  lines.push(`    restart: ${yamlString(spec.restartPolicy)}`);

  if (spec.env.length > 0) {
    lines.push("    environment:");
    for (const entry of spec.env) {
      lines.push(`      ${yamlString(entry.key)}: ${yamlString(entry.value)}`);
    }
  }
  if (spec.ports.length > 0) {
    lines.push("    ports:");
    for (const port of spec.ports) lines.push(`      - ${portLine(port)}`);
  }
  if (spec.volumes.length > 0) {
    lines.push("    volumes:");
    for (const volume of spec.volumes) lines.push(`      - ${volumeLine(volume)}`);
  }
  if (spec.networks.length > 0) {
    lines.push("    networks:");
    for (const network of spec.networks) lines.push(`      - ${yamlString(network)}`);
  }

  lines.push("    labels:");
  lines.push(`      ${MANAGED_LABEL}: 'true'`);

  // --- From here on: not configurable, always like this --------------------
  // Word for word the guarantee of buildSpecPayload (spec.ts). The spec has no
  // field that could influence these lines.
  lines.push("    cap_drop:");
  lines.push("      - ALL");
  lines.push("    security_opt:");
  lines.push("      - 'no-new-privileges:true'");
  // The three limits are the ONLY lines in this block that may be missing —
  // `null` means "no limit" and is written as an omitted line, not as
  // `mem_limit: 0`. The difference is not one of notation: for Compose
  // `cpus: 0` would be a set limit of zero CPUs, and `mem_limit: 0m` one of
  // zero bytes.
  if (spec.resources.memoryMb !== null) {
    lines.push(`    mem_limit: ${Math.round(spec.resources.memoryMb)}m`);
  }
  if (spec.resources.cpus !== null) {
    lines.push(`    cpus: ${spec.resources.cpus}`);
  }
  if (spec.resources.pidsLimit !== null) {
    lines.push(`    pids_limit: ${Math.round(spec.resources.pidsLimit)}`);
  }
  // Log rotation as the default (S9/K4b, §21.6). Docker's default for
  // json-file is NO rotation — without these four lines every newly created
  // container would come into being with exactly the finding that
  // `logging-unbounded` reports. Like cap_drop/security_opt above: not
  // configurable, always like this.
  lines.push("    logging:");
  lines.push("      driver: json-file");
  lines.push("      options:");
  lines.push(`        max-size: ${yamlString(LOG_MAX_SIZE)}`);
  lines.push(`        max-file: ${yamlString(LOG_MAX_FILE)}`);

  if (spec.networks.length > 0) {
    // Without "external: true" Compose would create its own networks
    // "<project>_<name>" instead of using the existing ones — the container
    // would then hang next to Traefik instead of in its network and would be
    // unreachable.
    lines.push("");
    lines.push("networks:");
    for (const network of spec.networks) {
      lines.push(`  ${yamlString(network)}:`);
      lines.push("    external: true");
    }
  }

  lines.push("");
  return lines.join("\n");
}

// --- Reading --------------------------------------------------------------
//
// Reading does NOT use an own YAML parser but
// `docker compose config --format json` (compose-cli.ts). Two reasons:
//
//  1. The agent deliberately has no runtime dependencies. A YAML parser would
//     be the first dependency tree precisely in the component with
//     root-equivalent access.
//  2. Compose parses its own format completely — including interpolation,
//     `extends` and defaults. A home-made parser would necessarily be a second,
//     deviating interpretation of the same file. For a security question,
//     "almost the same interpretation" is the worst of all options.
//
// This function only translates the finished JSON into our spec.

type ComposeConfigService = {
  image?: unknown;
  container_name?: unknown;
  restart?: unknown;
  environment?: unknown;
  ports?: unknown;
  volumes?: unknown;
  networks?: unknown;
  mem_limit?: unknown;
  cpus?: unknown;
  pids_limit?: unknown;
};

export type ComposeReadResult =
  | { ok: true; spec: ContainerSpec; unsupportedKeys: string[] }
  | { ok: false; reason: string };

// Fields a file can contain but our spec does not represent. They are NOT
// silently discarded but reported: a UI that shows a read file as a complete
// spec although there is a `devices:` next to it lies to the operator (open
// point 3 from 6.2).
const KNOWN_SERVICE_KEYS = new Set([
  "image",
  "container_name",
  "restart",
  "environment",
  "ports",
  "volumes",
  "networks",
  "labels",
  "cap_drop",
  "security_opt",
  "mem_limit",
  "cpus",
  "pids_limit",
  "pull_policy",
  // Like cap_drop/security_opt: set by the emitter, not representable by the
  // spec — and therefore not an "unsupported key" when reading back (K4b).
  "logging",
  // Compose always fills these keys in the normalized output JSON, even if the
  // file does not name them.
  "command",
  "entrypoint"
]);

// All services of a file (stage 5d).
//
// Up to 5c the reader flatly refused files with several services
// ("mehrere-services"). That was honest as long as the model did not know
// stacks — but it made half the inventory unreadable: homepage,
// ftp_web_calender, tsrank and chibisafe have two services each, edge seven.
//
// The order is that of the file, so that a UI can show it stably.
export type ComposeService = {
  serviceName: string;
  spec: ContainerSpec;
  unsupportedKeys: string[];
};

export type ComposeServicesResult =
  | { ok: true; services: ComposeService[] }
  | { ok: false; reason: string };

export function servicesFromComposeConfig(config: unknown): ComposeServicesResult {
  const services = (config as { services?: Record<string, ComposeConfigService> } | null)?.services;
  if (!services || typeof services !== "object") return { ok: false, reason: "no-services" };

  const names = Object.keys(services);
  if (names.length === 0) return { ok: false, reason: "no-services" };

  const loaded: ComposeService[] = [];
  for (const name of names) {
    const read = readService(services[name], name);
    // A single service without an image does not make the whole file
    // unreadable. It is skipped and stands out by missing from the list —
    // better than a response that pretends it does not exist.
    if (read.ok) loaded.push({ serviceName: name, spec: read.spec, unsupportedKeys: read.unsupportedKeys });
  }
  if (loaded.length === 0) return { ok: false, reason: "no-readable-service" };
  return { ok: true, services: loaded };
}

export function specFromComposeConfig(config: unknown, serviceName: string): ComposeReadResult {
  const services = (config as { services?: Record<string, ComposeConfigService> } | null)?.services;
  if (!services || typeof services !== "object") return { ok: false, reason: "no-services" };

  // No more fallback to "the only service if the name does not match". Since
  // 5d the name comes from the labels of the running container and is thereby
  // a statement and not a guess — if it does not match, that is a finding.
  const service = services[serviceName];
  if (!service) return { ok: false, reason: "service-not-found" };
  return readService(service, serviceName);
}

function readService(
  service: ComposeConfigService | undefined,
  serviceName: string
): ComposeReadResult {
  if (!service || typeof service !== "object") return { ok: false, reason: "service-not-found" };

  // Unescape here too: the same interpolation applies to the whole file, not
  // only to environment.
  const name = typeof service.container_name === "string"
    ? unescapeDollar(service.container_name)
    : serviceName;
  const image = typeof service.image === "string" ? unescapeDollar(service.image) : "";
  if (!image) return { ok: false, reason: "no-image" };

  const unsupportedKeys = Object.keys(service)
    .filter((key) => !KNOWN_SERVICE_KEYS.has(key))
    // Compose sets many keys to null when they are unset. A set `devices: []`
    // is no deviation either.
    .filter((key) => {
      const value = (service as Record<string, unknown>)[key];
      if (value === null || value === undefined) return false;
      if (Array.isArray(value) && value.length === 0) return false;
      if (typeof value === "object" && Object.keys(value as object).length === 0) return false;
      return true;
    })
    .sort();

  const spec: ContainerSpec = {
    name,
    imageRef: image,
    env: readEnvironment(service.environment),
    ports: readPorts(service.ports),
    volumes: readVolumes(service.volumes),
    networks: readNetworks(service.networks),
    restartPolicy: readRestart(service.restart),
    // ⚠️ If a limit is missing in the file, it is `null` and NOT 0. Until the
    // limits became optional, a 0 came out here for half the inventory — no
    // grown container carries `pids_limit` — and on the next edit it came back
    // as "muss 16-16384 sein" to an operator who had not touched anything.
    resources: {
      memoryMb: limitFromBytes(service.mem_limit),
      cpus: limit(service.cpus),
      pidsLimit: limitRounded(service.pids_limit)
    }
  };

  return { ok: true, spec, unsupportedKeys };
}

// The counterpart to the doubling in the emitter.
//
// ⚠️ Found live 2026-07-21: `docker compose config` returns dollar signs
// ESCAPED ("$$USER") so that its own output is a valid Compose file again. The
// value arrives correctly at the container — but whoever takes the output for
// plain text escapes again on the next write: "$" → "$$" → "$$$$". The value
// grows with every edit, and precisely for env values, i.e. passwords.
//
// The replacement runs as a function, because "$" in the replacement STRING of
// String.replace itself has a special meaning — exactly the same trap one level
// deeper.
function unescapeDollar(value: string): string {
  return value.replace(/\$\$/g, () => "$");
}

// A limit from the Compose output: if it is missing, it is `null`. `toNumber`
// stays alongside, because for ports and ordinal numbers it is still right
// that something unreadable becomes 0.
function limit(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function limitRounded(value: unknown): number | null {
  const raw = limit(value);
  return raw === null ? null : Math.round(raw);
}

function limitFromBytes(value: unknown): number | null {
  const raw = limit(value);
  return raw === null ? null : Math.round(raw / (1024 * 1024));
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function readEnvironment(value: unknown): Array<{ key: string; value: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => ({
      key,
      value: entry === null || entry === undefined ? "" : unescapeDollar(String(entry))
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function readPorts(value: unknown): SpecPort[] {
  if (!Array.isArray(value)) return [];
  const ports: SpecPort[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const port = entry as Record<string, unknown>;
    const containerPort = Math.round(toNumber(port.target));
    const hostPort = Math.round(toNumber(port.published));
    if (!containerPort || !hostPort) continue;
    ports.push({
      containerPort,
      hostPort,
      protocol: port.protocol === "udp" ? "udp" : "tcp",
      // Without a value Docker binds to all interfaces. This is a READ
      // operation: the value is reported as it is, not glossed over. The
      // decision that NEW ports default to 127.0.0.1 is made in spec
      // validation, not here.
      hostIp: typeof port.host_ip === "string" && port.host_ip ? port.host_ip : "0.0.0.0"
    });
  }
  return ports;
}

function readVolumes(value: unknown): SpecVolume[] {
  if (!Array.isArray(value)) return [];
  const volumes: SpecVolume[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const volume = entry as Record<string, unknown>;
    const source = typeof volume.source === "string" ? unescapeDollar(volume.source) : "";
    const target = typeof volume.target === "string" ? unescapeDollar(volume.target) : "";
    if (!source || !target) continue;
    volumes.push({
      type: volume.type === "bind" ? "bind" : "named",
      source,
      target,
      readOnly: volume.read_only === true
    });
  }
  return volumes;
}

function readNetworks(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  return Object.keys(value as Record<string, unknown>);
}

function readRestart(value: unknown): ContainerSpec["restartPolicy"] {
  if (value === "always" || value === "unless-stopped" || value === "on-failure" || value === "no") {
    return value;
  }
  return "no";
}
